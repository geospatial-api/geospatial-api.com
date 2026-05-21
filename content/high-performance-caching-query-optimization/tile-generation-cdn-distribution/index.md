---
layout: layouts/page.njk
title: "Tile Generation & CDN Distribution for Geospatial APIs"
description: "Generate and serve vector tiles using PostGIS ST_AsMVT and CDN edge caching. Configure Cache-Control headers for sub-50ms tile delivery at global scale."
---

# Tile Generation & CDN Distribution for Geospatial APIs

Delivering responsive, high-fidelity maps at scale requires a tightly orchestrated pipeline between spatial databases, application servers, and edge networks. **Tile Generation & CDN Distribution** forms the backbone of modern geospatial API architecture, enabling developers to serve millions of concurrent map requests without overwhelming backend infrastructure. When implemented correctly, this pipeline transforms raw PostGIS geometries into lightweight, cacheable vector tiles that edge networks can distribute globally with sub-50ms latency. This workflow sits at the core of our broader strategy for [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/), where database efficiency, application-level streaming, and edge caching converge to eliminate redundant computation and network bottlenecks.

## Prerequisites & Infrastructure Baseline

Before deploying a production-ready tile pipeline, your stack must satisfy several architectural and database-level requirements. Skipping these often results in thread exhaustion, cache fragmentation, or inconsistent tile rendering across zoom levels.

- **PostgreSQL 14+ with PostGIS 3.2+**: Native `ST_AsMVT` support requires PostGIS 3.0+, but 3.2+ introduces critical performance improvements for geometry aggregation and memory management. Review the official [PostGIS documentation for ST_AsMVT](https://postgis.net/docs/ST_AsMVT.html) to understand version-specific optimizations.
- **FastAPI 0.90+ with `asyncpg`**: Asynchronous database drivers prevent thread blocking during concurrent tile requests. Synchronous adapters like `psycopg2` will quickly exhaust worker pools under map-heavy traffic.
- **CDN Provider Configuration**: Cloudflare, AWS CloudFront, or Fastly must be explicitly configured to cache binary responses with the `application/vnd.mapbox-vector-tile` MIME type. Some CDNs default to bypassing unknown binary payloads.
- **Spatial Indexes**: GIST indexes on all geometry columns used in tile queries are non-negotiable. Without them, bounding box filters degrade into full table scans.
- **Coordinate System Alignment**: Source data should be stored in EPSG:4326 (WGS 84) or EPSG:3857 (Web Mercator). While PostGIS handles on-the-fly transformation via `ST_Transform`, pre-transformed data reduces CPU overhead during high-concurrency tile generation.

## The Deterministic Tile Pipeline

The tile generation workflow follows a stateless, repeatable sequence designed for horizontal scaling. Each step isolates a specific transformation, ensuring predictable latency and straightforward debugging.

1. **Request Parsing & Validation**: Extract `z`, `x`, and `y` parameters from the URL path. Validate against Web Mercator bounds (`0 ≤ x < 2^z`, `0 ≤ y < 2^z`) and enforce a maximum zoom level (typically 18–22 depending on dataset precision).
2. **Bounding Box Calculation**: Convert tile coordinates into geographic extents using standard Web Mercator projection formulas. The resulting polygon defines the spatial filter for the database query.
3. **Spatial Query Execution**: Execute a PostGIS query that filters features intersecting the bounding box, applies layer-specific attribute filtering, and optionally aggregates complex geometries using `ST_Union` or `ST_Collect`.
4. **Vector Tile Encoding**: Serialize the filtered result set into Protocol Buffers using `ST_AsMVT`. This step compresses coordinate deltas, strips redundant metadata, and produces the final `.pbf` payload.
5. **Response Streaming**: Return the binary payload with immutable cache headers. Streaming avoids loading the entire tile into application memory, reducing GC pressure and preventing OOM crashes during peak traffic.
6. **Edge Distribution**: The CDN intercepts the origin response, caches it at the nearest Point of Presence (PoP), and serves subsequent identical requests without hitting the application layer.

## FastAPI & PostGIS Implementation

The following pattern demonstrates a production-tested endpoint that generates vector tiles directly from PostGIS. It uses `asyncpg` for non-blocking I/O, calculates bounding boxes deterministically, and streams the binary response to minimize memory allocation.

```python
import math
from typing import Optional
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
import asyncpg

app = FastAPI(title="Geospatial Tile API")

# Precompute tile size constants for Web Mercator
TILE_SIZE = 40075016.68557849  # Earth circumference in meters
ORIGIN_SHIFT = TILE_SIZE / 2

def tile_to_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Convert tile coordinates to Web Mercator bounding box (minx, miny, maxx, maxy)."""
    n = 2.0 ** z
    x_min = (x / n) * TILE_SIZE - ORIGIN_SHIFT
    y_max = ORIGIN_SHIFT - (y / n) * TILE_SIZE
    x_max = ((x + 1) / n) * TILE_SIZE - ORIGIN_SHIFT
    y_min = ORIGIN_SHIFT - ((y + 1) / n) * TILE_SIZE
    return x_min, y_min, x_max, y_max

@app.get("/tiles/{z}/{x}/{y}.pbf")
async def get_tile(
    z: int,
    x: int,
    y: int,
    layer: str = Query("default", description="Target PostGIS layer/table"),
    pool: asyncpg.Pool = None  # Injected via lifespan or dependency
):
    if z < 0 or z > 20 or x < 0 or x >= 2**z or y < 0 or y >= 2**z:
        raise HTTPException(status_code=400, detail="Invalid tile coordinates")

    minx, miny, maxx, maxy = tile_to_bounds(z, x, y)

    # Parameterized query prevents SQL injection and allows plan caching
    # ST_AsMVT is an aggregate over a subquery that uses ST_AsMVTGeom for clipping
    query = """
        SELECT ST_AsMVT(q, 'features', 4096, 'geom') AS tile
        FROM (
            SELECT
                ST_AsMVTGeom(
                    ST_Transform(geom, 3857),
                    ST_MakeEnvelope($1, $2, $3, $4, 3857),
                    4096, 256, true
                ) AS geom,
                id,
                name,
                category
            FROM spatial_features
            WHERE geom && ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 3857), 4326)
              AND category = $5
        ) AS q
        WHERE q.geom IS NOT NULL
    """

    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, minx, miny, maxx, maxy, layer)
        if not row or not row["tile"]:
            raise HTTPException(status_code=404, detail="No features found for tile")

    # Stream binary MVT payload
    return StreamingResponse(
        iter([row["tile"]]),
        media_type="application/vnd.mapbox-vector-tile",
        headers={
            "Cache-Control": "public, max-age=86400, immutable"
        }
    )
```

This implementation adheres to the [Mapbox Vector Tile Specification](https://github.com/mapbox/vector-tile-spec), ensuring compatibility with Leaflet, MapLibre GL, and OpenLayers. Key reliability considerations include:
- **Parameterized Queries**: Prevents injection and enables PostgreSQL to reuse execution plans across identical tile requests.
- **Memory-Efficient Streaming**: `StreamingResponse` iterates over a single-byte buffer, keeping application memory footprint flat regardless of tile complexity.
- **Graceful 404 Handling**: Empty tiles return explicit HTTP status codes rather than empty binaries, allowing clients to skip rendering and reduce network chatter.

## HTTP Caching Strategy & Edge Invalidation

Vector tiles are inherently cacheable because they are deterministic: identical `z/x/y` coordinates and query parameters will always produce the same binary output. Proper cache headers are critical to offload traffic from your origin. Implementing Using HTTP cache-control headers for geospatial tiles ensures your CDN respects immutability while allowing graceful revalidation when underlying data updates.

For static or slowly changing datasets, use `Cache-Control: public, max-age=604800, immutable`. For frequently updated layers, pair `max-age=3600` with `stale-while-revalidate=86400` so the CDN serves cached tiles while asynchronously fetching fresh data in the background. Avoid `no-cache` or `private` directives unless serving user-specific, dynamically styled layers.

## Reverse Proxy Routing & Load Distribution

Before requests reach your FastAPI application, they typically traverse a reverse proxy or API gateway. Proper routing configuration prevents tile fragmentation, enforces rate limits, and handles TLS termination. When Configuring Nginx reverse proxy for geospatial routing, focus on path-based routing (`/tiles/{z}/{x}/{y}.pbf`), gzip passthrough, and upstream keepalive connections.

A typical Nginx block should:
- Strip query parameters that don't affect tile geometry (e.g., `?callback=`, `?v=1.2`)
- Forward only the canonical tile path to the application server
- Enable `proxy_buffering off` for streaming responses to prevent Nginx from buffering large `.pbf` payloads into RAM
- Set `proxy_http_version 1.1` and `proxy_set_header Connection ""` to leverage HTTP/1.1 keepalive pools

## Scaling Database Connections & Query Caching

As concurrent tile requests scale into the thousands, database connection limits become the primary bottleneck. PostgreSQL's default `max_connections` setting (usually 100) will quickly exhaust under map-heavy workloads. Implementing [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) decouples application concurrency from database connections, allowing thousands of async requests to queue efficiently without spawning new TCP handshakes.

For hot tiles (e.g., major metropolitan areas at zoom levels 10–14), consider layering [Redis Caching for Spatial Queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) between FastAPI and PostGIS. Redis can store serialized MVT payloads keyed by `z/x/y/layer`, bypassing the database entirely for high-frequency requests. When using Redis for tile caching:
- Set TTLs aligned with your data refresh cadence
- Use `GET`/`SET` with binary-safe commands (`GET` returns raw bytes)
- Monitor hit rates; if cache misses exceed 30%, your tile key granularity or data update frequency may need adjustment

## Monitoring & Observability

A tile pipeline without telemetry is a black box. Instrument your endpoints with structured logging and metrics:
- **Latency Percentiles**: Track p50, p95, and p99 for `GET /tiles/{z}/{x}/{y}.pbf`
- **Cache Hit Ratio**: Monitor CDN and Redis hit rates separately
- **PostGIS Query Duration**: Use `pg_stat_statements` to identify slow bounding box queries
- **Error Rates**: Alert on 5xx spikes, which often indicate connection pool exhaustion or PostGIS memory limits

## Conclusion

Tile Generation & CDN Distribution is not a single feature but an architectural discipline. By aligning spatial indexes, async application servers, deterministic bounding box queries, and edge caching strategies, you can serve millions of map requests with predictable sub-50ms latency. The pipeline outlined here scales horizontally: add more FastAPI workers behind a reverse proxy, tune PgBouncer for connection reuse, and let your CDN absorb the bulk of repetitive tile requests. As your geospatial dataset grows, revisit query plans, monitor cache fragmentation, and adjust `max-age` directives to match your data refresh cadence. A well-tuned tile pipeline pays compounding returns in infrastructure cost savings and user experience.