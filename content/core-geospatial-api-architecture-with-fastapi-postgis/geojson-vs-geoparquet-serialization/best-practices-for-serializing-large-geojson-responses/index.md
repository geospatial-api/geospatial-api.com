---
layout: layouts/page.njk
title: "Best Practices for Serializing Large GeoJSON Responses in FastAPI"
description: "Stream large GeoJSON responses from PostGIS using ST_AsGeoJSON, FastAPI StreamingResponse, and gzip compression. Reduce peak RAM by up to 90% and cut TTFB from seconds to milliseconds."
slug: best-practices-for-serializing-large-geojson-responses
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "GeoJSON vs GeoParquet Serialization"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/"
  - label: "Best Practices for Serializing Large GeoJSON Responses"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/best-practices-for-serializing-large-geojson-responses/"
datePublished: "2025-01-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Best Practices for Serializing Large GeoJSON Responses in FastAPI",
      "description": "Stream large GeoJSON responses from PostGIS using ST_AsGeoJSON, FastAPI StreamingResponse, and gzip compression to reduce peak RAM by up to 90%.",
      "datePublished": "2025-01-15",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/best-practices-for-serializing-large-geojson-responses/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 2, "name": "GeoJSON vs GeoParquet Serialization", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/" },
        { "@type": "ListItem", "position": 3, "name": "Best Practices for Serializing Large GeoJSON Responses", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/best-practices-for-serializing-large-geojson-responses/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Stream Large GeoJSON Responses from PostGIS",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Offload serialization to PostGIS with ST_AsGeoJSON" },
        { "@type": "HowToStep", "position": 2, "name": "Apply geometry simplification and spatial filters before streaming" },
        { "@type": "HowToStep", "position": 3, "name": "Build an async generator with FastAPI StreamingResponse" },
        { "@type": "HowToStep", "position": 4, "name": "Enable GZipMiddleware for on-the-fly compression" },
        { "@type": "HowToStep", "position": 5, "name": "Verify with curl and EXPLAIN ANALYZE" }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does buffering a large GeoJSON FeatureCollection crash my FastAPI server?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Python materializes the entire result set as a list of dicts before json.dumps() serializes it. For 100k+ features this can consume several gigabytes of heap, triggering OOM kills. Streaming with an async generator keeps heap usage flat regardless of result-set size."
          }
        },
        {
          "@type": "Question",
          "name": "When should I switch from GeoJSON streaming to GeoParquet for large datasets?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Switch when payloads consistently exceed 100 MB, when clients perform columnar analytics (aggregations, joins, arrow-native reads), or when you need efficient partial column reads. GeoJSON remains the right choice for interactive web maps and feature-level API responses below that threshold."
          }
        },
        {
          "@type": "Question",
          "name": "Does FastAPI StreamingResponse work with HTTP/2 multiplexing?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. FastAPI's StreamingResponse uses chunked transfer encoding on HTTP/1.1 and DATA frames on HTTP/2. Both transports support incremental delivery. Ensure your reverse proxy (Nginx, Caddy) does not buffer the entire response before forwarding — set proxy_buffering off in Nginx."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/)

# Best practices for serializing large GeoJSON responses

**Problem:** returning a 100k-feature PostGIS result set as a buffered `FeatureCollection` consumes gigabytes of heap, blocks the event loop, and delays the first byte until the entire payload is ready.

## Context & when to use this approach

This pattern applies whenever a single FastAPI endpoint must deliver more features than fit comfortably in memory — typically above 10,000 rows — while keeping responses RFC 7946-compliant and consumable by standard web-mapping clients (Leaflet, MapLibre, OpenLayers).

The approach works well when:

- Clients consume the response incrementally (progressive rendering, fetch-and-parse pipelines, or stream-aware loaders like `oboe.js`).
- The dataset is spatially filtered per request — a bounding box, radius, or polygon intersection narrows rows before any bytes leave the database.
- Response time matters more than columnar analytics. When clients need aggregations, joins, or arrow-native reads on datasets consistently larger than 100 MB, the [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision matrix explains when to pivot to a binary columnar format instead.

Two preconditions must be in place before implementing the streaming pattern. First, PostGIS must be installed and the target table must have a geometry column indexed with `GIST`. Second, the FastAPI application must use an async database driver (`asyncpg` or `psycopg3`) — synchronous drivers block the event loop and negate the benefits of streaming.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Data flow from PostGIS through FastAPI async generator to HTTP client with gzip compression" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Large GeoJSON streaming pipeline</title>
  <desc>Diagram showing how a spatial SQL query flows from PostGIS through an asyncpg cursor into a FastAPI async generator, is compressed by GZipMiddleware, and delivered as chunked HTTP to the client.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Boxes -->
  <rect x="10" y="70" width="140" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="80" y="96" text-anchor="middle" font-size="13" fill="currentColor" font-family="monospace">PostGIS</text>
  <text x="80" y="114" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">ST_AsGeoJSON()</text>
  <rect x="200" y="55" width="160" height="90" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="280" y="82" text-anchor="middle" font-size="13" fill="currentColor" font-family="monospace">asyncpg cursor</text>
  <text x="280" y="100" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">row-by-row fetch</text>
  <text x="280" y="118" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">async generator</text>
  <text x="280" y="136" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">orjson.dumps()</text>
  <rect x="410" y="70" width="140" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="480" y="96" text-anchor="middle" font-size="13" fill="currentColor" font-family="monospace">GZipMiddleware</text>
  <text x="480" y="114" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">on-the-fly compress</text>
  <rect x="600" y="70" width="110" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="655" y="96" text-anchor="middle" font-size="13" fill="currentColor">HTTP client</text>
  <text x="655" y="114" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">chunked transfer</text>
  <!-- Arrows -->
  <line x1="150" y1="100" x2="198" y2="100" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <line x1="360" y1="100" x2="408" y2="100" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <line x1="550" y1="100" x2="598" y2="100" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <!-- Labels above arrows -->
  <text x="174" y="92" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">rows</text>
  <text x="384" y="92" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">bytes</text>
  <text x="574" y="92" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">gzip</text>
  <!-- Memory label -->
  <text x="360" y="185" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.55">heap stays flat — no full FeatureCollection materialized in Python</text>
</svg>

## Runnable implementation

The example below wires all three layers together: PostGIS-native geometry formatting, an `asyncpg` server-side cursor for constant-memory row delivery, and FastAPI's `StreamingResponse` to push chunks to the client as they arrive. Install dependencies first:

```
pip install fastapi uvicorn asyncpg orjson
```

```python
import orjson
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.gzip import GZipMiddleware
import asyncpg

DATABASE_URL = "postgresql://user:pass@localhost:5432/geodb"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Connection pool: keep min_size low to avoid idle connections on startup
    app.state.pool = await asyncpg.create_pool(
        dsn=DATABASE_URL, min_size=2, max_size=10
    )
    yield
    await app.state.pool.close()


app = FastAPI(lifespan=lifespan)

# Compress responses larger than 1 KB automatically.
# For datasets >500 MB consider brotli via a reverse proxy instead.
app.add_middleware(GZipMiddleware, minimum_size=1000)


async def geojson_stream(minx: float, miny: float, maxx: float, maxy: float, pool: asyncpg.Pool):
    """
    Async generator that yields valid GeoJSON FeatureCollection bytes
    without ever holding the full result set in Python memory.
    """
    # ST_SimplifyPreserveTopology removes vertices while keeping valid topology.
    # Tolerance 0.0001 degrees ≈ 10 m at mid-latitudes — adjust for your zoom level.
    # ST_MakeEnvelope constructs the bounding box in SRID 4326 for the spatial filter.
    query = """
        SELECT
            id,
            name,
            ST_AsGeoJSON(
                ST_SimplifyPreserveTopology(geom, 0.0001)
            ) AS geom_json
        FROM spatial_table
        WHERE ST_Intersects(
            geom,
            ST_MakeEnvelope($1, $2, $3, $4, 4326)
        )
        ORDER BY id   -- stable order enables keyset pagination on next page
    """

    yield b'{"type":"FeatureCollection","features":['
    first = True

    async with pool.acquire() as conn:
        # cursor() fetches rows in server-side batches (default 50).
        # Python heap stays near zero regardless of total result-set size.
        async for row in conn.cursor(query, minx, miny, maxx, maxy):
            if not first:
                yield b","
            feature = {
                "type": "Feature",
                "id": row["id"],
                "geometry": orjson.loads(row["geom_json"]),
                "properties": {"name": row["name"]},
            }
            # orjson produces UTF-8 bytes directly — no .encode() needed.
            yield orjson.dumps(feature)
            first = False

    yield b"]}"


@app.get("/api/features")
async def get_features(
    bbox: str = Query(
        ...,
        description="Bounding box as minx,miny,maxx,maxy in EPSG:4326",
        example="-0.5,51.3,0.3,51.6",
    )
):
    parts = bbox.split(",")
    if len(parts) != 4:
        raise HTTPException(status_code=400, detail="bbox must be minx,miny,maxx,maxy")
    try:
        minx, miny, maxx, maxy = map(float, parts)
    except ValueError:
        raise HTTPException(status_code=400, detail="bbox values must be numeric")

    return StreamingResponse(
        geojson_stream(minx, miny, maxx, maxy, app.state.pool),
        media_type="application/geo+json",  # RFC 7946 MIME type
    )
```

For large result sets that need page-by-page traversal without `OFFSET` degradation, pair this endpoint with the [cursor-based pagination for spatial queries](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/) pattern — replace `ORDER BY id` with a keyset predicate (`WHERE id > $5`) and return the last seen ID in a `Link: <next>` header.

For validating that incoming bounding-box or geometry parameters are well-formed before the query runs, the [strict Pydantic validation for geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) cluster covers model-level coercion of WKT, WKB, and GeoJSON geometry inputs.

## Key parameters and options

| Parameter / setting | Default | Notes |
|---|---|---|
| `GZipMiddleware minimum_size` | 1000 bytes | Set lower if most responses are small; higher compresses only truly large payloads |
| `ST_SimplifyPreserveTopology` tolerance | project-specific | 0.0001° ≈ 10 m; scale up for lower zoom, down for detail views |
| `asyncpg.create_pool min_size / max_size` | 2 / 10 | Tune to your concurrency target; each connection holds a server-side cursor slot |
| `conn.cursor()` prefetch | 50 (asyncpg default) | Increase to 500–1000 for very large rows to reduce round trips |
| `media_type` | `application/geo+json` | Required for proxies and browsers to handle the MIME type correctly |
| `orjson.dumps` option | none needed | Handles `bytes`, `datetime`, and `UUID` natively; pass `orjson.OPT_NON_STR_KEYS` for integer-keyed dicts |

## Gotchas and failure modes

- **Trailing comma breaks JSON validity.** The `first` flag guards the comma separator between features. If you skip it and concatenate commas naively, parsers reject the response with `Unexpected token }`. Test every edge case including the zero-feature case — the generator must yield `[]` not `[,]`.

- **`ST_AsGeoJSON` returns a geometry object, not a Feature.** The function output is `{"type":"Point","coordinates":[...]}` — you must wrap it in `{"type":"Feature","geometry":...,"properties":{...}}` yourself. Forgetting the wrapper produces invalid GeoJSON that MapLibre silently drops.

- **Reverse proxy buffering swallows the stream.** Nginx's default `proxy_buffering on` waits for the full response before forwarding. Add `proxy_buffering off;` to your location block, or the client sees no TTFB improvement despite the async generator.

- **OOM during `ST_Simplify` on complex polygons.** `ST_Simplify` (without `PreserveTopology`) can produce self-intersecting rings that PostGIS then tries to repair in memory, spiking RAM. Always use `ST_SimplifyPreserveTopology` for polygon layers.

- **Missing GIST index causes sequential scan.** `ST_Intersects` falls back to a sequential scan without a `GIST` index on the geometry column, turning a millisecond query into a minutes-long one. Verify with `EXPLAIN ANALYZE` before deploying.

- **`asyncpg.cursor()` requires an explicit transaction.** In asyncpg, server-side cursors must live inside a transaction. The `conn.cursor()` convenience method opens one implicitly, but if you manage transactions manually with `conn.transaction()`, ensure the cursor is created inside the `async with` block.

## Verification

Confirm streaming and compression work correctly before deploying:

```bash
# 1. Check that chunked transfer encoding is active and MIME type is correct
curl -v -H "Accept-Encoding: gzip" \
  "http://localhost:8000/api/features?bbox=-0.5,51.3,0.3,51.6" \
  --output /dev/null 2>&1 | grep -E "Transfer-Encoding|Content-Encoding|Content-Type"
# Expected:
#   Content-Encoding: gzip
#   Transfer-Encoding: chunked
#   Content-Type: application/geo+json

# 2. Decompress and count features to verify zero trailing-comma errors
curl -s -H "Accept-Encoding: gzip" \
  "http://localhost:8000/api/features?bbox=-0.5,51.3,0.3,51.6" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['features']), 'features')"

# 3. Confirm the query uses a GIST index (look for "Index Scan using" in output)
psql $DATABASE_URL -c "
  EXPLAIN ANALYZE
  SELECT id FROM spatial_table
  WHERE ST_Intersects(geom, ST_MakeEnvelope(-0.5,51.3,0.3,51.6,4326));"
```

For a deeper look at reading `EXPLAIN ANALYZE` output for spatial queries — including how to spot sequential scans replaced by bitmap index scans — see [reading EXPLAIN ANALYZE for spatial query optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/).

---

**Related**

- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — decision matrix for choosing between text and binary columnar formats
- [Cursor-based pagination for spatial queries](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/) — keyset pagination that pairs with streaming for paginated GeoJSON endpoints
- [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — the full cursor strategy reference including PostGIS-specific ordering considerations
- [Strict Pydantic validation for geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — validate bbox and geometry inputs before they reach the streaming query
- [Reading EXPLAIN ANALYZE for spatial query optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/) — verify that ST_Intersects uses your GIST index

← Back to [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/)
