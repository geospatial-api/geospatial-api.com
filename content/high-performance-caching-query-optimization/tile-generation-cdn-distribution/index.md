---
layout: layouts/page.njk
title: "Spatial Tile Generation and CDN Distribution"
description: "Generate and serve vector tiles using PostGIS ST_AsMVT and CDN edge caching. Configure Cache-Control headers for sub-50ms tile delivery at global scale."
slug: "tile-generation-cdn-distribution"
type: "cluster"
breadcrumb: "High-Performance Caching & Query Optimization → Tile Generation & CDN Distribution"
datePublished: "2024-11-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Spatial Tile Generation and CDN Distribution",
      "description": "Generate and serve vector tiles using PostGIS ST_AsMVT and CDN edge caching. Configure Cache-Control headers for sub-50ms tile delivery at global scale.",
      "datePublished": "2024-11-01",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "/"},
        {"@type": "ListItem", "position": 2, "name": "High-Performance Caching & Query Optimization", "item": "/high-performance-caching-query-optimization/"},
        {"@type": "ListItem", "position": 3, "name": "Tile Generation & CDN Distribution", "item": "/high-performance-caching-query-optimization/tile-generation-cdn-distribution/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Generate and Distribute Vector Tiles with PostGIS and a CDN",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Parse and validate tile coordinates"},
        {"@type": "HowToStep", "position": 2, "name": "Calculate Web Mercator bounding box"},
        {"@type": "HowToStep", "position": 3, "name": "Execute ST_AsMVT spatial query"},
        {"@type": "HowToStep", "position": 4, "name": "Stream binary response with Cache-Control headers"},
        {"@type": "HowToStep", "position": 5, "name": "Configure CDN caching for the tile path pattern"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What Cache-Control header should I use for vector tiles?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use 'Cache-Control: public, max-age=86400, immutable' for static layers. For layers updated hourly, use 'max-age=3600, stale-while-revalidate=86400'."
          }
        },
        {
          "@type": "Question",
          "name": "Why does ST_AsMVT return empty results for some tiles?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Empty results typically occur when the WHERE clause uses a mismatched SRID, bypassing the GiST index and returning no features. Ensure the envelope is transformed to match the geometry column's SRID before filtering."
          }
        },
        {
          "@type": "Question",
          "name": "How do I invalidate CDN tiles after a data update?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Tag tiles by layer name using CDN cache tags (Cloudflare Cache-Tag header, Fastly Surrogate-Key). Issue a tag-based purge after data updates rather than purging individual z/x/y paths."
          }
        }
      ]
    },
    {
      "@type": "Article",
      "headline": "Spatial Tile Generation and CDN Distribution",
      "datePublished": "2024-11-01",
      "dateModified": "2026-06-23"
    }
  ]
}
</script>

← Back to [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/)

# Tile Generation & CDN Distribution for Geospatial APIs

Delivering interactive maps at scale requires a coordinated pipeline between your spatial database, application server, and edge network. This page covers how to generate Mapbox Vector Tiles directly from PostGIS using `ST_AsMVT`, configure FastAPI to stream binary tile responses, and wire a CDN to absorb the bulk of requests before they ever reach your origin — achieving consistent sub-50ms tile delivery worldwide. This workflow sits at the heart of the broader [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/) stack, where database efficiency, async streaming, and edge caching converge to eliminate redundant computation.

---

## Prerequisites & Environment

Before deploying a production-ready tile pipeline, verify these infrastructure requirements. Skipping them leads to thread exhaustion, cache fragmentation, or inconsistent tile rendering across zoom levels.

| Requirement | Minimum version | Why it matters |
|---|---|---|
| PostgreSQL | 14+ | Improved parallel query execution for spatial aggregation |
| PostGIS | 3.2+ | Critical `ST_AsMVT` memory and geometry aggregation fixes |
| FastAPI | 0.100+ | Lifespan-based connection pool management |
| asyncpg | 0.29+ | Non-blocking pool, binary protocol for PostGIS types |
| CDN provider | Any (Cloudflare / CloudFront / Fastly) | Must cache `application/vnd.mapbox-vector-tile` MIME type |

Your geometry column must have a GiST spatial index in place. Without it, the tile bounding box filter degrades into a full table scan — see [Query Plan Analysis & Index Tuning](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) for how to create and verify those indexes using `EXPLAIN ANALYZE`. Source data should be stored in EPSG:4326 (WGS 84) or EPSG:3857 (Web Mercator); although `ST_Transform` handles on-the-fly reprojection, pre-transformed data reduces CPU overhead under concurrent tile generation.

---

## Decision Matrix: Tile Caching Layers

The tile pipeline has three independent caching surfaces. Understanding where each layer fits prevents over-engineering and clarifies cache invalidation scope.

| Layer | Scope | Latency reduction | Invalidation mechanism | Best for |
|---|---|---|---|---|
| CDN edge cache | Global PoP network | ~40–120 ms → ~5–15 ms | Cache-Tag purge or TTL expiry | Static or infrequently updated layers |
| Redis tile cache | Application server | ~5–30 ms → ~0.3–1 ms | Key-based `DEL`, pattern `SCAN` + `DEL` | Hot tiles (metro areas, zoom 10–14) |
| PostgreSQL query cache | Database (shared_buffers) | ~50–500 ms → ~2–10 ms | Automatic (LRU) | Repeated identical bounding box queries |

For most production workloads, combine CDN caching for the broad request volume with [Redis Caching for Spatial Queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) for the hottest tiles. PostgreSQL's internal caching handles repeated identical queries automatically once buffer hit rates are high.

---

## Architecture: The Tile Request Pipeline

The diagram below shows the full request path from map client through CDN, application layer, Redis, and PostGIS.

<svg viewBox="0 0 780 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Vector tile request pipeline: client → CDN → FastAPI → Redis → PostGIS, with cache hit paths returning early" style="width:100%;max-width:780px;font-family:inherit;">
  <title>Vector tile request pipeline</title>
  <desc>Shows how a map client request traverses CDN edge, FastAPI application, Redis tile cache, and PostGIS ST_AsMVT, with cache hits short-circuiting the chain at each layer.</desc>
  <!-- Background -->
  <rect width="780" height="320" fill="none"/>
  <!-- Nodes -->
  <!-- Client -->
  <rect x="20" y="130" width="100" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="70" y="148" text-anchor="middle" font-size="12" fill="currentColor">Map Client</text>
  <text x="70" y="163" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">Leaflet / MapLibre</text>
  <!-- CDN -->
  <rect x="160" y="110" width="110" height="84" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="215" y="132" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">CDN Edge</text>
  <text x="215" y="150" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">Cache-Control</text>
  <text x="215" y="164" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">max-age / s-maxage</text>
  <text x="215" y="178" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">Cache-Tag purge</text>
  <!-- FastAPI -->
  <rect x="320" y="110" width="110" height="84" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="375" y="132" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">FastAPI</text>
  <text x="375" y="150" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">asyncpg pool</text>
  <text x="375" y="164" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">coord validation</text>
  <text x="375" y="178" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">stream response</text>
  <!-- Redis -->
  <rect x="480" y="110" width="110" height="84" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="535" y="132" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Redis</text>
  <text x="535" y="150" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">Binary GET/SET</text>
  <text x="535" y="164" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">key: z/x/y/layer</text>
  <text x="535" y="178" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">TTL aligned to data</text>
  <!-- PostGIS -->
  <rect x="640" y="110" width="120" height="84" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="700" y="132" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">PostGIS</text>
  <text x="700" y="150" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">ST_AsMVT</text>
  <text x="700" y="164" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">ST_AsMVTGeom</text>
  <text x="700" y="178" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">GiST bbox filter</text>
  <!-- Main request arrow: Client → CDN -->
  <line x1="120" y1="152" x2="158" y2="152" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- CDN → FastAPI -->
  <line x1="270" y1="152" x2="318" y2="152" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- FastAPI → Redis -->
  <line x1="430" y1="152" x2="478" y2="152" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Redis → PostGIS -->
  <line x1="590" y1="152" x2="638" y2="152" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- CDN cache hit return path -->
  <path d="M215 110 Q215 70 70 70 Q70 110 70 130" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="5,3" opacity="0.6"/>
  <text x="143" y="62" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">CDN hit</text>
  <!-- Redis cache hit return path -->
  <path d="M535 110 Q535 46 375 46 Q215 46 215 110" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="5,3" opacity="0.6"/>
  <text x="375" y="38" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">Redis hit → skip PostGIS</text>
  <!-- Labels below nodes -->
  <text x="215" y="212" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">~5–15 ms</text>
  <text x="375" y="212" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">~2–5 ms overhead</text>
  <text x="535" y="212" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">~0.3–1 ms</text>
  <text x="700" y="212" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">~20–200 ms</text>
  <!-- Arrow marker -->
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- Legend -->
  <line x1="30" y1="270" x2="60" y2="270" stroke="currentColor" stroke-width="1.5"/>
  <text x="65" y="274" font-size="10" fill="currentColor" opacity="0.7">Request path</text>
  <line x1="160" y1="270" x2="190" y2="270" stroke="currentColor" stroke-width="1" stroke-dasharray="5,3" opacity="0.6"/>
  <text x="195" y="274" font-size="10" fill="currentColor" opacity="0.7">Cache hit short-circuit</text>
</svg>

---

## Step-by-Step Implementation

### 1. Install dependencies

```bash
pip install fastapi uvicorn asyncpg redis
```

PostGIS 3.2+ must be enabled in your database:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
SELECT postgis_full_version();
```

### 2. Define the tile coordinate-to-bounds conversion

Web Mercator tile coordinates map to EPSG:3857 bounding boxes via a deterministic formula. Implement this once and reuse it across all tile endpoints:

```python
TILE_CIRCUMFERENCE_M = 40075016.68557849  # Earth circumference in meters (EPSG:3857)
ORIGIN_SHIFT = TILE_CIRCUMFERENCE_M / 2

def tile_to_bounds_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Convert tile Z/X/Y to Web Mercator bbox (minx, miny, maxx, maxy) in EPSG:3857."""
    n = 2.0 ** z
    x_min = (x / n) * TILE_CIRCUMFERENCE_M - ORIGIN_SHIFT
    y_max = ORIGIN_SHIFT - (y / n) * TILE_CIRCUMFERENCE_M
    x_max = ((x + 1) / n) * TILE_CIRCUMFERENCE_M - ORIGIN_SHIFT
    y_min = ORIGIN_SHIFT - ((y + 1) / n) * TILE_CIRCUMFERENCE_M
    return x_min, y_min, x_max, y_max
```

### 3. Build the PostGIS tile query

`ST_AsMVT` aggregates geometries clipped and scaled to the tile grid. `ST_AsMVTGeom` handles the clipping and coordinate scaling into the 0–4096 tile coordinate space. The `WHERE` clause must use the geometry column's native SRID for the GiST index to engage — this is the most common source of slow tile queries.

For layers with geometry stored in EPSG:4326:

```sql
SELECT ST_AsMVT(q, $5, 4096, 'geom') AS tile
FROM (
    SELECT
        ST_AsMVTGeom(
            ST_Transform(geom, 3857),
            ST_MakeEnvelope($1, $2, $3, $4, 3857),
            4096, 256, true       -- extent, buffer, clip_geom
        ) AS geom,
        id,
        name,
        category
    FROM spatial_features
    WHERE geom && ST_Transform(
        ST_MakeEnvelope($1, $2, $3, $4, 3857), 4326
    )
) AS q
WHERE q.geom IS NOT NULL
```

The `256`-unit buffer clips geometries extending slightly beyond the tile boundary, which prevents visual gaps at tile edges on the client side. Adjust this value if your features span large areas relative to the tile size.

### 4. Configure the asyncpg connection pool

Use FastAPI's lifespan context to initialise the pool once at startup and close it cleanly on shutdown. Sync database adapters like `psycopg2` block the event loop and exhaust worker threads under concurrent tile load — asyncpg's binary protocol avoids both problems. For managing the connection pool under heavy traffic, review the [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) guide, which covers PgBouncer transaction-mode pooling for spatial workloads.

```python
from contextlib import asynccontextmanager
import asyncpg, os

@asynccontextmanager
async def lifespan(app):
    dsn = os.getenv("DATABASE_URL")
    app.state.pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=5,
        max_size=20,
        command_timeout=10,   # abort slow tile queries rather than queue indefinitely
    )
    yield
    await app.state.pool.close()
```

### 5. Wire the tile endpoint

```python
import math
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
import asyncpg

app = FastAPI(title="Geospatial Tile API", lifespan=lifespan)

@app.get("/tiles/{z}/{x}/{y}.pbf")
async def get_tile(
    z: int,
    x: int,
    y: int,
    layer: str = Query("features", description="PostGIS layer name (table)"),
):
    # Reject out-of-range coordinates before touching the database
    if z < 0 or z > 20 or x < 0 or x >= 2**z or y < 0 or y >= 2**z:
        raise HTTPException(status_code=400, detail="Invalid tile coordinates")

    minx, miny, maxx, maxy = tile_to_bounds_3857(z, x, y)

    tile_query = """
        SELECT ST_AsMVT(q, $5, 4096, 'geom') AS tile
        FROM (
            SELECT
                ST_AsMVTGeom(
                    ST_Transform(geom, 3857),
                    ST_MakeEnvelope($1, $2, $3, $4, 3857),
                    4096, 256, true
                ) AS geom,
                id, name, category
            FROM spatial_features
            WHERE geom && ST_Transform(
                ST_MakeEnvelope($1, $2, $3, $4, 3857), 4326
            )
        ) AS q
        WHERE q.geom IS NOT NULL
    """

    async with app.state.pool.acquire() as conn:
        row = await conn.fetchrow(tile_query, minx, miny, maxx, maxy, layer)

    if not row or not row["tile"]:
        # Return a valid empty MVT rather than 404 — map clients treat 404 as an error
        # and log aggressively for sparsely populated tiles
        return Response(
            content=b"",
            media_type="application/vnd.mapbox-vector-tile",
            headers={
                "Cache-Control": "public, max-age=86400",
                "Cache-Tag": f"tiles,layer-{layer}",
            },
        )

    return Response(
        content=bytes(row["tile"]),
        media_type="application/vnd.mapbox-vector-tile",
        headers={
            "Cache-Control": "public, max-age=86400, immutable",
            "Cache-Tag": f"tiles,layer-{layer}",
            "Vary": "",   # remove implicit Vary: Accept so the CDN doesn't fragment the cache
        },
    )
```

The `Cache-Tag` header enables tag-based CDN purge: after a data update to a specific layer, issue a single purge for `layer-{name}` rather than iterating over thousands of z/x/y paths.

---

## Production Code Example

Below is the complete, copy-runnable implementation combining the pool, coordinate conversion, Redis tile cache, and the tile endpoint. The Redis layer sits between FastAPI and PostGIS, serving serialised MVT payloads for hot tiles without touching the database.

```python
import math, os
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
import asyncpg
import redis.asyncio as aioredis

TILE_CIRCUMFERENCE_M = 40075016.68557849
ORIGIN_SHIFT = TILE_CIRCUMFERENCE_M / 2

def tile_to_bounds_3857(z, x, y):
    n = 2.0 ** z
    x_min = (x / n) * TILE_CIRCUMFERENCE_M - ORIGIN_SHIFT
    y_max = ORIGIN_SHIFT - (y / n) * TILE_CIRCUMFERENCE_M
    x_max = ((x + 1) / n) * TILE_CIRCUMFERENCE_M - ORIGIN_SHIFT
    y_min = ORIGIN_SHIFT - ((y + 1) / n) * TILE_CIRCUMFERENCE_M
    return x_min, y_min, x_max, y_max

@asynccontextmanager
async def lifespan(app):
    app.state.pool = await asyncpg.create_pool(
        dsn=os.getenv("DATABASE_URL"), min_size=5, max_size=20, command_timeout=10
    )
    app.state.redis = aioredis.from_url(
        os.getenv("REDIS_URL", "redis://localhost:6379"),
        decode_responses=False,     # tiles are binary; never decode
    )
    yield
    await app.state.pool.close()
    await app.state.redis.aclose()

app = FastAPI(title="Geospatial Tile API", lifespan=lifespan)

TILE_TTL = 3600  # Redis TTL in seconds — align with your data refresh cadence

@app.get("/tiles/{z}/{x}/{y}.pbf")
async def get_tile(
    z: int, x: int, y: int,
    layer: str = Query("features"),
):
    if z < 0 or z > 20 or x < 0 or x >= 2**z or y < 0 or y >= 2**z:
        raise HTTPException(status_code=400, detail="Invalid tile coordinates")

    cache_key = f"tile:{layer}:{z}:{x}:{y}"
    cached = await app.state.redis.get(cache_key)
    if cached is not None:
        return Response(
            content=cached,
            media_type="application/vnd.mapbox-vector-tile",
            headers={
                "Cache-Control": "public, max-age=86400, immutable",
                "Cache-Tag": f"tiles,layer-{layer}",
                "X-Cache": "HIT",
            },
        )

    minx, miny, maxx, maxy = tile_to_bounds_3857(z, x, y)
    query = """
        SELECT ST_AsMVT(q, $5, 4096, 'geom') AS tile
        FROM (
            SELECT
                ST_AsMVTGeom(
                    ST_Transform(geom, 3857),
                    ST_MakeEnvelope($1,$2,$3,$4,3857),
                    4096, 256, true
                ) AS geom, id, name, category
            FROM spatial_features
            WHERE geom && ST_Transform(ST_MakeEnvelope($1,$2,$3,$4,3857), 4326)
        ) AS q
        WHERE q.geom IS NOT NULL
    """

    async with app.state.pool.acquire() as conn:
        row = await conn.fetchrow(query, minx, miny, maxx, maxy, layer)

    tile_bytes = bytes(row["tile"]) if row and row["tile"] else b""

    if tile_bytes:
        await app.state.redis.set(cache_key, tile_bytes, ex=TILE_TTL)

    return Response(
        content=tile_bytes,
        media_type="application/vnd.mapbox-vector-tile",
        headers={
            "Cache-Control": "public, max-age=86400" + (", immutable" if tile_bytes else ""),
            "Cache-Tag": f"tiles,layer-{layer}",
            "X-Cache": "MISS",
            "Vary": "",
        },
    )
```

---

## Verification & Testing

### Fetch a tile from the running server

```bash
# Download a tile at zoom 10, tile 512/341 (central Europe)
curl -v -o tile.pbf \
  "http://localhost:8000/tiles/10/512/341.pbf?layer=features"

# Verify it is a valid Protocol Buffer (non-zero binary)
wc -c tile.pbf
# Expected: > 0 bytes for a populated area
file tile.pbf
# Expected: data (binary)
```

### Confirm the GiST index is used

Run `EXPLAIN ANALYZE` on the bounding box filter to verify index usage. Missing a GiST index is the single most common cause of slow tile generation.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, name
FROM spatial_features
WHERE geom && ST_Transform(
    ST_MakeEnvelope(
        1113194.9, 6274861.4,   -- minx, miny (EPSG:3857 for z10 tile 512/341)
        1172006.4, 6340869.2,   -- maxx, maxy
        3857
    ), 4326
);
-- Look for: "Index Scan using spatial_features_geom_idx"
-- Red flag:  "Seq Scan" with a large row count means the index is missing or not being used
```

### Unit test skeleton

```python
import pytest
from httpx import AsyncClient, ASGITransport
from your_app import app   # replace with your module

@pytest.mark.asyncio
async def test_tile_valid_coordinates():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/tiles/10/512/341.pbf?layer=features")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/vnd.mapbox-vector-tile"
    assert "public" in resp.headers["cache-control"]

@pytest.mark.asyncio
async def test_tile_invalid_coordinates():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/tiles/10/9999/9999.pbf")
    assert resp.status_code == 400
```

---

## Failure Modes & Edge Cases

1. **CDN bypasses binary tile responses.** Some CDN configurations skip caching for unknown MIME types. Explicitly allow `application/vnd.mapbox-vector-tile` in your CDN cache rules. On Cloudflare, add a Cache Rule matching the `/tiles/*` path with "Cache Everything" enabled.

2. **`Vary: Accept-Encoding` fragmenting the cache.** If FastAPI or an upstream middleware adds `Vary: Accept-Encoding`, the CDN treats gzip and non-gzip responses as separate cache entries, halving effective hit rates. Set `"Vary": ""` explicitly on tile responses, or disable automatic compression for `.pbf` paths.

3. **GiST index not used due to SRID mismatch.** If the `ST_Transform` in the `WHERE` clause produces an SRID that does not match the geometry column, PostgreSQL falls back to a sequential scan. Verify with `SELECT Find_SRID('public', 'spatial_features', 'geom')` and align the transform accordingly.

4. **`ST_AsMVT` returns `NULL` instead of empty bytes.** Accessing `row["tile"]` on a row where all features were clipped out of bounds can return `None` rather than an empty bytes value. Always guard with `if row and row["tile"]` before calling `bytes()`.

5. **asyncpg pool exhaustion under burst load.** If `max_size` is set too low relative to concurrent tile requests, `asyncpg` raises `asyncpg.exceptions.TooManyConnectionsError`. Increase `max_size` or, for workloads exceeding 500 concurrent requests, front the database with PgBouncer in transaction mode as described in [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

6. **Empty tile 404 causing client error loops.** Map clients like MapLibre GL and OpenLayers interpret 404 responses for tile URLs as hard errors and may disable the layer or log continuously. Return `200` with empty content (`b""`) and a valid `Cache-Control` header so the CDN caches the empty result and the client renders a blank (not broken) tile.

7. **Redis storing decoded strings for binary tiles.** Using `decode_responses=True` on the Redis connection will corrupt binary MVT payloads during storage and retrieval. Always initialise the Redis client with `decode_responses=False` when caching tile bytes.

---

## Performance Notes

**Latency by layer.** Cold requests hitting PostGIS typically return in 20–200 ms depending on geometry complexity and zoom level. Redis hits reduce this to 0.3–1 ms; CDN hits to 5–15 ms including network round-trip to the nearest PoP.

**Index impact.** A GiST index on `geom` reduces bounding box query time from full table scans (hundreds of milliseconds on tables > 1 M rows) to 1–5 ms index scans. On the [Query Plan Analysis & Index Tuning](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) page, use `EXPLAIN (ANALYZE, BUFFERS)` to measure buffer hit rates and confirm the index is engaged at each zoom level.

**Zoom level selectivity.** Low zoom levels (z ≤ 8) cover enormous bounding boxes and may return millions of features. Apply zoom-dependent simplification using `ST_Simplify` before `ST_AsMVTGeom`, or use pre-generated tile layers stored in a tile cache like Martin or pg_tileserv to avoid real-time aggregation at coarse zoom levels.

**Async vs sync trade-offs.** A synchronous FastAPI endpoint backed by `psycopg2` blocks one worker thread per request. With 4 Uvicorn workers and 100 concurrent tile requests, you will exhaust the thread pool immediately. asyncpg's non-blocking pool allows a single worker to handle hundreds of concurrent in-flight queries without spawning threads.

**CDN cache hit ratio.** Monitor CDN hit rates broken down by zoom level. Zoom levels 10–14 over populated areas should reach 85–95% hit ratios within minutes of a cold start. Zoom levels 0–6 (global) hit 99%+ quickly. Zoom 18+ requests are often unique and benefit less from CDN caching; consider Redis as the primary cache for fine-grained zoom levels.

---

## HTTP Caching Strategy & Edge Invalidation

Vector tiles are deterministic: identical `z/x/y/layer` parameters always produce identical binary output given the same underlying data. This makes them ideal CDN cache targets.

| Data change frequency | Recommended headers | Invalidation method |
|---|---|---|
| Static (never changes) | `public, max-age=31536000, immutable` | None needed |
| Weekly updates | `public, max-age=604800` | `Cache-Tag` purge on deploy |
| Daily updates | `public, max-age=86400` | `Cache-Tag` purge after ETL job |
| Hourly updates | `public, max-age=3600, stale-while-revalidate=86400` | `Cache-Tag` purge after ingestion |
| Near-real-time | `public, max-age=60, stale-while-revalidate=300` | Redis TTL-based expiry |

Tag-based purge is far faster than path-based purge. Emit `Cache-Tag: tiles,layer-{layer_name}` on every response. When a data update completes for a specific layer, issue a single tag purge for `layer-{layer_name}` — this invalidates all affected tiles simultaneously regardless of their z/x/y coordinates.

---

<details>
<summary>Why does my tile endpoint return 200 with empty content for populated areas?</summary>

The most common cause is an SRID mismatch in the `WHERE` clause. If your geometry column is in EPSG:4326 but the envelope is not transformed back to 4326 before the `&&` operator, the spatial filter may return no rows even for populated tiles. Run `SELECT Find_SRID('public', 'spatial_features', 'geom')` and confirm your `ST_Transform` target SRID matches the column's SRID exactly.

</details>

<details>
<summary>How do I serve multiple layers from one endpoint?</summary>

Pass the layer name as a query parameter (`?layer=roads`) and use it as the `$5` argument to `ST_AsMVT`. Validate the layer name against an allowlist before interpolating it into the query — even though it is passed as a parameter to `ST_AsMVT`, the table name in the `FROM` clause must not be built via string concatenation. Use a mapping dict (`ALLOWED_LAYERS = {"roads": "road_features", ...}`) and look up the actual table name server-side.

</details>

<details>
<summary>What is the correct way to purge Cloudflare tile caches after a data update?</summary>

Use Cloudflare's Cache-Tag purge API. Include the `Cache-Tag: layer-{name}` response header on every tile response, then call `POST /zones/{zone_id}/purge_cache` with `{"tags": ["layer-roads"]}` after each data update. This purges all z/x/y tiles for that layer simultaneously. You must enable Cloudflare's Cache Rules to include the tag header, and the zone plan must support tag-based purge (Business or Enterprise).

</details>

---

## Related

- [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/) — parent section covering the full caching stack
- [Redis Caching for Spatial Queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — binary tile caching, TTL strategies, and cache invalidation patterns
- [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — decoupling application concurrency from database connection limits
- [Query Plan Analysis & Index Tuning](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — verifying GiST index usage with `EXPLAIN ANALYZE` for spatial queries
- [Bounding Box Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — `ST_Within` and `ST_Intersects` patterns that underpin the tile bounding box filter

← Back to [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/)
