---
layout: layouts/page.njk
title: "Best practices for serializing large GeoJSON responses"
description: "Serialize large GeoJSON responses from PostGIS using ST_AsGeoJSON, FastAPI StreamingResponse, and gzip compression to reduce peak RAM usage by up to 90%."
---

# Best practices for serializing large GeoJSON responses

The most reliable approach for handling large spatial payloads combines **database-native formatting**, **HTTP streaming**, and **payload compression**. Instead of materializing full `FeatureCollection` objects in Python memory, offload JSON generation to PostGIS using `ST_AsGeoJSON`, stream rows via FastAPI’s `StreamingResponse` with an async generator, and enforce `gzip` at the middleware layer. This pattern reduces peak RAM by 70–90%, prevents OOM crashes on datasets exceeding 100k features, and drops Time-To-First-Byte (TTFB) from seconds to milliseconds.

## 1. Offload Serialization to PostGIS

GeoJSON serialization should occur at the database boundary, not in application code. Python’s `dict` construction and standard `json` serialization introduce significant CPU and memory overhead when handling millions of coordinate tuples. PostGIS provides [`ST_AsGeoJSON(geom)`](https://postgis.net/docs/ST_AsGeoJSON.html), which outputs RFC-compliant JSON directly from the query planner, bypassing Python entirely.

Pair this function with geometry reduction operators to shrink payloads before transmission:
- `ST_SimplifyPreserveTopology(geom, tolerance)` removes redundant vertices while maintaining valid topology.
- `ST_SnapToGrid(geom, grid_size)` reduces coordinate precision to match expected client zoom levels.
- Always apply spatial filters (`ST_Intersects`, `ST_DWithin`, or bounding box checks) before serialization. Transmitting out-of-bounds geometries wastes bandwidth and defeats client-side clipping optimizations.

When designing your [Core Geospatial API Architecture with FastAPI & PostGIS](/core-geospatial-api-architecture-with-fastapi-postgis/), enforce keyset pagination at the query level. Traditional `OFFSET/LIMIT` degrades linearly as the database scans deeper into the table. Keyset pagination (`WHERE id > last_seen_id ORDER BY id LIMIT 10000`) maintains constant query performance regardless of dataset depth and integrates cleanly with streaming generators.

## 2. Stream Features, Never Buffer

FastAPI’s [`StreamingResponse`](https://fastapi.tiangolo.com/advanced/custom-response/#streamingresponse) accepts an async generator that yields byte strings. To produce valid GeoJSON without buffering, you must manually manage the JSON array structure: yield the opening object, stream each feature followed by a comma, and close the array once iteration completes.

Avoid the standard `json` module for Python-side serialization. `orjson` is 3–5x faster, natively handles `bytes` and `datetime` objects, and produces UTF-8 `bytes` directly—eliminating the `.encode()` step required by the standard library. When combined with an async database cursor, this architecture ensures memory usage remains flat regardless of result set size.

## 3. Production-Ready Streaming Implementation

The following example demonstrates a memory-efficient GeoJSON stream using `asyncpg`, `orjson`, and FastAPI. It safely handles trailing commas, applies spatial filtering, and returns a valid `FeatureCollection`.

```python
import orjson
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query
from fastapi.responses import StreamingResponse
from fastapi.middleware.gzip import GZipMiddleware
import asyncpg

DATABASE_URL = "postgresql://user:pass@localhost:5432/geodb"

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(dsn=DATABASE_URL, min_size=2, max_size=10)
    yield
    await app.state.pool.close()

app = FastAPI(lifespan=lifespan)
# Compress responses >1KB automatically
app.add_middleware(GZipMiddleware, minimum_size=1000)

async def geojson_stream(bbox: str, pool: asyncpg.Pool):
    # Parse bounding box safely in production
    minx, miny, maxx, maxy = map(float, bbox.split(","))
    
    query = """
        SELECT ST_AsGeoJSON(
            ST_Transform(
                ST_SimplifyPreserveTopology(geom, 0.0001), 
                4326
            )
        ) AS feature
        FROM spatial_table
        WHERE ST_Intersects(
            geom, 
            ST_MakeEnvelope($1, $2, $3, $4, 4326)
        )
        ORDER BY id
    """
    
    yield b'{"type":"FeatureCollection","features":['
    first = True
    
    async with pool.acquire() as conn:
        async for row in conn.cursor(query, minx, miny, maxx, maxy):
            if not first:
                yield b','
            # ST_AsGeoJSON returns text; encode to bytes for StreamingResponse
            yield row["feature"].encode("utf-8")
            first = False
            
    yield b']}'

@app.get("/api/features")
async def get_features(bbox: str = Query(..., description="minx,miny,maxx,maxy")):
    return StreamingResponse(
        geojson_stream(bbox, app.state.pool),
        media_type="application/geo+json"
    )
```

**Key implementation notes:**
- The `first` flag prevents a trailing comma, which would invalidate the JSON.
- `ST_Transform(..., 4326)` guarantees WGS84 coordinates, matching client expectations.
- `asyncpg.cursor()` fetches rows in batches, keeping Python heap usage near zero.
- `media_type="application/geo+json"` signals proper MIME handling to proxies and browsers.

## 4. Compression, Validation & Format Boundaries

Enable `GZipMiddleware` to compress the stream on-the-fly. Modern HTTP clients automatically negotiate `Content-Encoding: gzip`, typically reducing a 50MB GeoJSON payload to ~8MB without application changes. For larger datasets, consider `brotli` or `zstd` via reverse proxies (Nginx/Caddy), which offer better compression ratios for repetitive coordinate strings.

Always validate output against [RFC 7946](https://www.rfc-editor.org/rfc/rfc7946) to ensure coordinate order (longitude, latitude), CRS handling, and feature structure match client expectations. GeoJSON does not support topology, raster data, or complex attribute types; forcing these into the format creates fragile APIs.

When payloads consistently exceed 100MB or require analytical operations (aggregations, joins, tiling), evaluate whether GeoJSON remains the right transport format. The [GeoJSON vs GeoParquet Serialization](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) comparison outlines when to pivot to columnar formats for batch processing, while reserving GeoJSON strictly for interactive web mapping and lightweight feature delivery.