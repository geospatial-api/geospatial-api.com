---
layout: layouts/page.njk
title: "High-Performance Caching & Query Optimization for Geospatial APIs"
description: "Production strategies for PostGIS query optimization, Redis spatial caching, PgBouncer connection pooling, vector tile generation, and CDN edge distribution in FastAPI-based geospatial services."
slug: "high-performance-caching-query-optimization"
type: "pillar"
breadcrumb: "Caching & Query Optimization"
datePublished: "2025-04-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "@id": "https://geospatial-api.com/high-performance-caching-query-optimization/#article",
      "headline": "High-Performance Caching & Query Optimization for Geospatial APIs",
      "description": "Production strategies for PostGIS query optimization, Redis spatial caching, PgBouncer connection pooling, vector tile generation, and CDN edge distribution in FastAPI-based geospatial services.",
      "datePublished": "2025-04-01",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com", "url": "https://geospatial-api.com" }
    },
    {
      "@type": "Article",
      "@id": "https://geospatial-api.com/high-performance-caching-query-optimization/#mainArticle",
      "headline": "High-Performance Caching & Query Optimization for Geospatial APIs",
      "datePublished": "2025-04-01",
      "dateModified": "2026-06-23"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Caching & Query Optimization", "item": "https://geospatial-api.com/high-performance-caching-query-optimization/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Optimize a Geospatial API for Production Performance",
      "step": [
        { "@type": "HowToStep", "name": "Add GiST indexes and run ANALYZE on spatial columns", "position": 1 },
        { "@type": "HowToStep", "name": "Profile queries with EXPLAIN (ANALYZE, BUFFERS) and fix planner misestimates", "position": 2 },
        { "@type": "HowToStep", "name": "Normalize spatial cache keys to tile/grid resolution and store in Redis", "position": 3 },
        { "@type": "HowToStep", "name": "Generate MVT vector tiles via ST_AsMVT and push to CDN edge", "position": 4 },
        { "@type": "HowToStep", "name": "Front FastAPI with PgBouncer in transaction-pooling mode", "position": 5 }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does PostGIS ignore my GiST index?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The planner skips GiST indexes when the spatial column is wrapped in a function, when table statistics are stale (run ANALYZE), or when the estimated selectivity is so low that a sequential scan appears cheaper. Use EXPLAIN (ANALYZE, BUFFERS) to confirm which path the planner chose, then verify operator compatibility and consider SET enable_seqscan = off in a test session to force the index path."
          }
        },
        {
          "@type": "Question",
          "name": "What Redis data structure should hold serialized GeoJSON?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use plain Redis strings (SET/GET) with a normalized bounding-box or tile-coordinate key. Compress payloads with zstd or gzip before storing — GeoJSON compresses 60–80% — and set TTLs matched to data volatility (e.g. 300 s for live tracking, 86400 s for static administrative boundaries)."
          }
        },
        {
          "@type": "Question",
          "name": "When should I pre-generate tiles versus query on demand?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Pre-generate tiles for zoom levels 0–12 where geometry complexity is high and request volume is predictable. Serve zoom levels 13–18 on demand via ST_AsMVT and cache at the CDN edge with stale-while-revalidate. Dynamic layers that change faster than the CDN TTL must always be served on demand."
          }
        }
      ]
    }
  ]
}
</script>

# High-Performance Caching & Query Optimization for Geospatial APIs

Geospatial APIs impose constraints that ordinary CRUD services never encounter: multi-dimensional index traversal, coordinate-heavy serialization, and spatial predicate evaluation that can touch millions of geometry vertices per query. This guide targets backend engineers and GIS platform architects who need to move a FastAPI + PostGIS service from "works in staging" to "holds sub-50 ms p99 under production load" — covering the four sub-systems that make or break spatial throughput: query planning, intelligent caching, serialization efficiency, and connection management.

## Architectural Blueprint

The four performance layers stack vertically. A request that misses the CDN falls through to the Redis cache; a Redis miss triggers a PostGIS query; every PostGIS query competes for a pooled connection. Each fallthrough multiplies latency, so the goal is to intercept as high in the stack as the data's freshness requirements allow.

<svg viewBox="0 0 680 420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four-layer geospatial API performance architecture diagram" style="width:100%;max-width:680px;display:block;margin:1.5rem auto;">
  <title>Geospatial API Performance Architecture</title>
  <desc>Diagram showing four stacked layers: CDN Edge, Redis Cache, FastAPI Application, and PostGIS Database, with request and response arrows showing the fallthrough path.</desc>
  <defs>
    <marker id="arrowD" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
    <marker id="arrowU" markerWidth="8" markerHeight="8" refX="2" refY="3" orient="auto">
      <path d="M8,0 L8,6 L0,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Layer boxes -->
  <!-- CDN Edge -->
  <rect x="60" y="20" width="560" height="72" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
  <rect x="60" y="20" width="560" height="72" rx="8" fill="currentColor" opacity="0.06"/>
  <text x="340" y="48" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="currentColor">CDN Edge</text>
  <text x="340" y="66" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor" opacity="0.7">Cache-Control headers · stale-while-revalidate · tile binaries (PNG / MVT)</text>
  <text x="340" y="83" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="currentColor" opacity="0.55">HIT rate target: ≥ 90 % for tile workloads</text>
  <!-- Redis Cache -->
  <rect x="60" y="112" width="560" height="72" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
  <rect x="60" y="112" width="560" height="72" rx="8" fill="currentColor" opacity="0.06"/>
  <text x="340" y="140" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="currentColor">Redis Cache</text>
  <text x="340" y="158" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor" opacity="0.7">Normalized bbox / H3 keys · compressed GeoJSON · per-TTL eviction policy</text>
  <text x="340" y="175" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="currentColor" opacity="0.55">HIT rate target: ≥ 70 % for query workloads</text>
  <!-- FastAPI Application -->
  <rect x="60" y="204" width="560" height="72" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
  <rect x="60" y="204" width="560" height="72" rx="8" fill="currentColor" opacity="0.06"/>
  <text x="340" y="232" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="currentColor">FastAPI Application</text>
  <text x="340" y="250" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor" opacity="0.7">Async route handlers · Pydantic geometry validators · StreamingResponse</text>
  <text x="340" y="267" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="currentColor" opacity="0.55">asyncpg pool · dependency-injected cache client</text>
  <!-- PostGIS / PgBouncer -->
  <rect x="60" y="296" width="560" height="72" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
  <rect x="60" y="296" width="560" height="72" rx="8" fill="currentColor" opacity="0.06"/>
  <text x="340" y="324" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="currentColor">PostGIS + PgBouncer</text>
  <text x="340" y="342" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor" opacity="0.7">GiST indexes · EXPLAIN ANALYZE · transaction-mode pooling</text>
  <text x="340" y="359" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="currentColor" opacity="0.55">pool_size = 2–3 × CPU cores · work_mem tuned per query type</text>
  <!-- Fallthrough arrows (left side, downward) -->
  <line x1="30" y1="92" x2="30" y2="112" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrowD)"/>
  <line x1="30" y1="184" x2="30" y2="204" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrowD)"/>
  <line x1="30" y1="276" x2="30" y2="296" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrowD)"/>
  <!-- Return arrows (right side, upward) -->
  <line x1="650" y1="296" x2="650" y2="276" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrowU)"/>
  <line x1="650" y1="204" x2="650" y2="184" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrowU)"/>
  <line x1="650" y1="112" x2="650" y2="92" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrowU)"/>
  <!-- Labels for arrows -->
  <text x="18" y="104" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="currentColor" opacity="0.5" transform="rotate(-90,18,104)">MISS</text>
  <text x="18" y="196" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="currentColor" opacity="0.5" transform="rotate(-90,18,196)">MISS</text>
  <text x="18" y="288" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="currentColor" opacity="0.5" transform="rotate(-90,18,288)">MISS</text>
  <text x="662" y="288" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="currentColor" opacity="0.5" transform="rotate(90,662,288)">FILL</text>
  <text x="662" y="196" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="currentColor" opacity="0.5" transform="rotate(90,662,196)">FILL</text>
  <text x="662" y="104" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="currentColor" opacity="0.5" transform="rotate(90,662,104)">FILL</text>
  <!-- Client label -->
  <text x="340" y="410" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor" opacity="0.5">← Client request travels down on MISS; cached response returns on HIT →</text>
</svg>

A well-tuned production system intercepts the majority of tile traffic at the CDN, handles repeated bounding-box queries in Redis, and reaches PostGIS only for novel spatial predicates — ideally fewer than 30% of total requests under steady-state load.

## Database and Infrastructure Layer

### GiST Indexes and Bounding-Box Pre-Filtering

The `GIST` index is the foundational performance primitive in PostGIS. It implements an R-tree variant through PostgreSQL's Generalized Search Tree interface, partitioning two-dimensional space so that bounding-box lookups touch only a logarithmic fraction of the table. Without it, every spatial predicate degenerates into a sequential scan.

```sql
-- Create a GiST index on the geometry column
CREATE INDEX parcels_geom_gist ON parcels USING GIST (geom);

-- After bulk inserts, refresh planner statistics
ANALYZE parcels;
```

The `&&` operator performs a cheap bounding-box overlap test and is what the GiST index directly answers. Precise predicates like `ST_Intersects` implicitly invoke `&&` when an index is present, but spelling it out explicitly is useful when you need to guarantee index usage or when you combine multiple conditions:

```sql
-- Explicit two-step filter: fast bbox scan first, precise predicate second
SELECT id, name, ST_AsGeoJSON(geom) AS geometry
FROM parcels
WHERE geom && ST_MakeEnvelope(-122.5, 37.7, -122.3, 37.9, 4326)
  AND ST_Intersects(geom, ST_MakeEnvelope(-122.5, 37.7, -122.3, 37.9, 4326));
```

For multi-column queries that combine spatial and attribute filters, a partial index on a filtered subset often outperforms a full-table index:

```sql
-- Partial GiST index: only active parcels
CREATE INDEX parcels_active_geom_gist ON parcels USING GIST (geom)
WHERE status = 'active';
```

### Query Plan Analysis

Blindly adding indexes is not enough — the planner must choose to use them. Table statistics become stale after bulk loads or spatial migrations, causing the planner to underestimate selectivity and fall back to sequential scans. For detailed diagnosis and remediation, the [Query Plan Analysis & Index Tuning](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) guide walks through systematic use of `EXPLAIN (ANALYZE, BUFFERS)` to identify bitmap heap scans, rows removed by index filter, and work_mem spills.

Key signals to watch in a plan output:

| Node type | What it means | Action |
|-----------|---------------|--------|
| `Seq Scan` on large table | Index not used or not present | Add GiST index, run `ANALYZE` |
| `Bitmap Heap Scan` | Index used but many false positives | Increase `work_mem`, check operator family |
| `Index Scan` with high `Rows Removed by Index Filter` | Bounding boxes large, many candidates | Narrow search area or add attribute predicate |
| `Sort` with `external merge` | Insufficient `work_mem` for ORDER BY | Increase `work_mem` for the session |

When `work_mem` is set too low, hash joins and sort operations spill to disk, adding 10–100 ms to queries that should complete in under 5 ms. A session-level override is safe for diagnostic purposes: `SET work_mem = '64MB';`.

### Connection Pooling with PgBouncer

FastAPI's async architecture multiplies the connection pressure on PostgreSQL. Without pooling, each concurrent Uvicorn worker that awaits a database result holds an open PostgreSQL backend process for the full request duration — and PostgreSQL's default `max_connections = 100` evaporates under moderate load.

[PgBouncer connection pooling setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) covers the complete configuration, but the critical choices are:

- **Transaction pooling mode** (`pool_mode = transaction`): the connection returns to the pool after each transaction, not each session. This is the right choice for stateless FastAPI routes.
- **Pool sizing**: set `default_pool_size` to 2–3× the number of PostGIS CPU cores. More connections increase context-switching overhead and degrade spatial query performance.
- **asyncpg compatibility**: PgBouncer's transaction mode is incompatible with named prepared statements. Set `server_reset_query = DISCARD ALL` and configure `asyncpg` with `statement_cache_size=0` or use the `pgbouncer=True` flag in your SQLAlchemy URL.

```ini
# pgbouncer.ini — transaction-mode pool for a spatial workload
[databases]
spatial_db = host=127.0.0.1 port=5432 dbname=spatial_db

[pgbouncer]
pool_mode = transaction
default_pool_size = 20
max_client_conn = 200
server_reset_query = DISCARD ALL
auth_type = md5
listen_port = 6432
```

## Application Layer Patterns

### Async FastAPI Integration

FastAPI's dependency injection system provides a clean place to attach both the database pool and the Redis cache client so they are shared across route handlers without leaking state:

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends
import asyncpg
import redis.asyncio as aioredis

_pool: asyncpg.Pool | None = None
_redis: aioredis.Redis | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _pool, _redis
    _pool = await asyncpg.create_pool(
        dsn="postgresql://user:pass@localhost:6432/spatial_db",
        min_size=5,
        max_size=20,
        statement_cache_size=0,   # required for PgBouncer transaction mode
    )
    _redis = await aioredis.from_url("redis://localhost:6379", decode_responses=False)
    yield
    await _pool.close()
    await _redis.aclose()

app = FastAPI(lifespan=lifespan)

async def get_pool() -> asyncpg.Pool:
    return _pool

async def get_redis() -> aioredis.Redis:
    return _redis
```

Route handlers receive the pool and Redis client through `Depends`, keeping I/O non-blocking throughout:

```python
import hashlib, json, zlib
from fastapi import APIRouter, Query, Depends
import asyncpg, redis.asyncio as aioredis

router = APIRouter()

def _bbox_cache_key(minx: float, miny: float, maxx: float, maxy: float) -> str:
    # Snap to 3 decimal places to collapse near-identical bounding boxes
    normalized = f"{minx:.3f},{miny:.3f},{maxx:.3f},{maxy:.3f}"
    return f"bbox:{hashlib.sha1(normalized.encode()).hexdigest()}"

@router.get("/parcels")
async def query_parcels(
    minx: float = Query(..., description="West longitude"),
    miny: float = Query(..., description="South latitude"),
    maxx: float = Query(..., description="East longitude"),
    maxy: float = Query(..., description="North latitude"),
    pool: asyncpg.Pool = Depends(get_pool),
    redis: aioredis.Redis = Depends(get_redis),
):
    key = _bbox_cache_key(minx, miny, maxx, maxy)

    cached = await redis.get(key)
    if cached:
        return json.loads(zlib.decompress(cached))

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, name, ST_AsGeoJSON(geom)::json AS geometry
            FROM parcels
            WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
              AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
            LIMIT 5000
            """,
            minx, miny, maxx, maxy,
        )

    result = {"type": "FeatureCollection", "features": [dict(r) for r in rows]}
    compressed = zlib.compress(json.dumps(result).encode(), level=6)
    await redis.set(key, compressed, ex=300)
    return result
```

### Geometry Serialization and Memory Overhead

`ST_AsGeoJSON` produces verbose coordinate arrays. A single administrative polygon with 50,000 vertices can exceed 5 MB of JSON — enough to block FastAPI's event loop for 200+ ms during serialization. Mitigation strategies, in order of impact:

1. **Zoom-adaptive simplification**: apply `ST_SimplifyPreserveTopology(geom, tolerance)` where tolerance scales with the viewport zoom level. At zoom 10, a 100-metre tolerance is invisible to end-users and reduces vertex count by 90%.
2. **Well-Known Binary (WKB) for internal microservices**: WKB is 3–5× more compact than GeoJSON and eliminates the JSON parse/serialize round-trip. Reserve GeoJSON for client-facing endpoints.
3. **Streaming large responses**: use FastAPI's `StreamingResponse` with an async generator to avoid buffering full payloads in memory. This is critical for responses exceeding 1 MB.
4. **FlatGeobuf for bulk transfers**: for the [GeoJSON vs GeoParquet serialization](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision, FlatGeobuf is the fastest binary option for large feature sets that must be streamable without loading into memory.

```python
from fastapi.responses import StreamingResponse
import asyncio

async def stream_features(pool, envelope):
    async with pool.acquire() as conn:
        async with conn.transaction():
            async for row in conn.cursor(
                "SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.001))::text "
                "FROM large_layer WHERE geom && $1::geometry",
                envelope,
            ):
                yield row[0].encode() + b"\n"

@router.get("/large-layer/stream")
async def stream_large_layer(pool: asyncpg.Pool = Depends(get_pool)):
    envelope = "ST_MakeEnvelope(-180,-90,180,90,4326)"
    return StreamingResponse(
        stream_features(pool, envelope),
        media_type="application/x-ndjson",
    )
```

## Data Contracts and Serialization

### Format Selection for Spatial Responses

The right serialization format depends on client type, payload size, and update frequency. Use this decision matrix at the start of each endpoint design:

| Format | Best for | Avg size (10 k features) | Client support | Streaming |
|--------|----------|--------------------------|----------------|-----------|
| GeoJSON | Browser/JS clients, debugging | ~8 MB | Universal | Via NDJSON |
| GeoParquet | Analytics, data science pipelines | ~1.2 MB | Python/R/DuckDB | No |
| FlatGeobuf | Large bulk exports, mobile | ~1.5 MB | GDAL, MapLibre | Yes |
| MVT (vector tile) | Map rendering at fixed zoom levels | ~50 KB/tile | Mapbox GL, MapLibre | No (tile-based) |
| WKB | Internal microservice calls | ~2 MB | PostGIS, Shapely | No |

For endpoints that serve both analytics consumers and browser map clients, consider content negotiation via the `Accept` header to serve GeoParquet to `application/x-parquet` requests and GeoJSON as the default.

### OGC Compliance

If your API must comply with OGC API – Features (formerly WFS 3.0), structure GeoJSON responses to include `links`, `timeStamp`, and `numberMatched` fields at the collection level. The `Content-Type` header must be `application/geo+json`. For [spatial pagination](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) across large feature collections, the OGC spec recommends cursor-based `next` links rather than offset-based page numbers — offset pagination degrades quadratically as the skip value grows.

## Intelligent Caching Strategies

### Redis Key Normalization for Spatial Queries

Floating-point coordinates from client requests are inherently noisy. Two requests for `37.77492,-122.41942` and `37.77491,-122.41943` represent the same visible viewport yet produce different cache keys if hashed raw. Key normalization is the single most important factor in Redis hit rate for spatial workloads.

Normalization strategies, from coarsest to finest:

- **Fixed decimal precision**: round coordinates to 3 decimal places (~111 m grid). Simple, effective for city-scale bounding boxes.
- **H3 / S2 cell identifiers**: convert the bounding box to a covering set of H3 cells at a fixed resolution and use the sorted cell IDs as the cache key. Provides consistent spatial granularity regardless of input.
- **Tile matrix alignment**: snap bounding boxes to the Tile Map Service (TMS) grid at a fixed zoom level. Ensures cache entries align with tile boundaries and avoids fragmentation at tile edges.

[Redis caching for spatial queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) details all three strategies with complete Python implementations, including compression pipelines and eviction policy configuration.

### Cache Invalidation and TTL Policy

Cache invalidation for spatial data is harder than for relational records because a single geometry update can affect an unbounded number of bounding-box queries. Two practical strategies:

- **Time-based TTL**: the simplest approach. Set TTL proportional to data volatility: 30 s for real-time tracking layers, 300 s for frequently updated parcels, 86 400 s for static administrative boundaries. Accept brief staleness as a design constraint.
- **Tag-based invalidation**: group cache keys by a spatial region tag (e.g. H3 cell at resolution 5) and delete all keys with a matching tag when geometries in that region change. Redis does not support tag-based deletion natively; implement it with a secondary set that tracks keys per tag.

Avoid cache-aside patterns that require invalidating individual query results after writes — the combinatorial explosion of possible bounding boxes makes precise invalidation impractical. Prefer short TTLs for mutable layers.

### Tile Generation and CDN Distribution

Vector tiles generated with `ST_AsMVT` bypass the GeoJSON serialization step entirely and produce binary Mapbox Vector Tile (MVT) payloads that CDNs cache as static files:

```sql
-- Generate an MVT tile for a given zoom/x/y
WITH tile_bounds AS (
  SELECT ST_TileEnvelope($1, $2, $3) AS envelope
),
clipped AS (
  SELECT ST_AsMVTGeom(
    ST_Transform(geom, 3857),
    tile_bounds.envelope,
    4096,   -- extent
    256,    -- buffer in tile units
    true    -- clip to tile bounds
  ) AS mvt_geom,
  id, name
  FROM parcels, tile_bounds
  WHERE ST_Intersects(
    ST_Transform(geom, 3857),
    tile_bounds.envelope
  )
)
SELECT ST_AsMVT(clipped, 'parcels', 4096, 'mvt_geom')
FROM clipped;
```

Serve tiles with aggressive HTTP caching headers. For mostly-static layers, a 24-hour max-age with `stale-while-revalidate` keeps the CDN warm without stale-data risk:

```
Cache-Control: public, max-age=86400, stale-while-revalidate=3600
Vary: Accept-Encoding
```

For dynamic layers, set a shorter max-age (60–300 s) and rely on `stale-while-revalidate` to serve cached tiles while the CDN revalidates in the background. Full tile generation and CDN configuration details are in [Tile Generation & CDN Distribution](/high-performance-caching-query-optimization/tile-generation-cdn-distribution/).

## Performance and Scalability

### Benchmarks and Baseline Targets

Before optimizing, establish baselines with `EXPLAIN (ANALYZE, BUFFERS)` in PostgreSQL and wrk or Locust at the HTTP layer. These targets represent achievable steady-state performance on modern cloud infrastructure (8 CPU, 32 GB RAM):

| Operation | Cold (no cache) | Warm (Redis HIT) | CDN HIT |
|-----------|----------------|-----------------|---------|
| Bbox query, 1 k features | 15–40 ms | 2–5 ms | < 1 ms |
| Bbox query, 10 k features | 80–200 ms | 5–15 ms | < 1 ms |
| MVT tile, zoom 14 | 20–60 ms | 3–8 ms | < 1 ms |
| KNN query, 10 neighbors | 5–20 ms | 2–4 ms | N/A |
| Polygon union, 100 k geoms | 800–2000 ms | 10–20 ms | N/A |

KNN queries deserve special attention: the PostGIS `<->` distance operator enables index-accelerated nearest-neighbor search, as covered in the [K-Nearest Neighbor routing](/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) guide.

### Concurrency Limits and Async Trade-offs

FastAPI routes that call PostGIS via `asyncpg` are genuinely non-blocking — the event loop is free while awaiting a query result. However, the database itself is the bottleneck under high concurrency. Parallelism beyond `max_parallel_workers_per_gather` (default 2) yields diminishing returns for single-query spatial workloads.

For batch operations, use `asyncio.gather` to fan out multiple lightweight queries concurrently rather than constructing one massive spatial query. Each query acquires a separate pool connection and runs in parallel on the PostGIS side:

```python
import asyncio

async def multi_region_query(pool, regions: list[dict]) -> list[dict]:
    async def fetch_one(region):
        async with pool.acquire() as conn:
            return await conn.fetch(
                "SELECT id, ST_AsGeoJSON(geom) FROM zones "
                "WHERE geom && ST_MakeEnvelope($1,$2,$3,$4,4326)",
                region["minx"], region["miny"], region["maxx"], region["maxy"],
            )
    results = await asyncio.gather(*[fetch_one(r) for r in regions])
    return [dict(row) for rows in results for row in rows]
```

## Production Readiness

### Versioning and Health Checks

[API versioning for GIS endpoints](/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) recommends URL-prefixed versioning (`/v1/parcels`, `/v2/parcels`) for spatial APIs because geometry schema changes — adding Z coordinates, switching CRS, or changing property names — are breaking changes that clients cannot detect from HTTP headers alone.

Every deployment should expose a `/health` endpoint that validates both the PostGIS connection and the Redis connection before reporting healthy:

```python
@app.get("/health")
async def health(
    pool: asyncpg.Pool = Depends(get_pool),
    redis: aioredis.Redis = Depends(get_redis),
):
    async with pool.acquire() as conn:
        postgis_ok = await conn.fetchval("SELECT PostGIS_Version()") is not None
    redis_ok = await redis.ping()
    if not (postgis_ok and redis_ok):
        raise HTTPException(status_code=503, detail="Dependency unavailable")
    return {"status": "ok", "postgis": postgis_ok, "redis": redis_ok}
```

### Rate Limiting and Monitoring Signals

Unbounded spatial queries are a denial-of-service vector — a single request with a global bounding box can consume minutes of CPU on PostGIS. Enforce hard limits at the API layer:

- Maximum bounding box area (e.g. reject queries spanning more than 1° × 1° at zoom < 12)
- Maximum `LIMIT` on feature queries (5 000 features per request)
- Per-IP and per-API-key rate limits via a middleware layer (e.g. `slowapi` + Redis counter)

Export these signals to Prometheus for alerting:

- `spatial_query_duration_seconds` (histogram, labeled by endpoint and zoom level)
- `redis_cache_hits_total` and `redis_cache_misses_total`
- `pgbouncer_pool_size` and `pgbouncer_waiting_clients`
- `postgis_index_scans_total` vs `postgis_seq_scans_total` (via `pg_stat_user_tables`)

## Failure Modes and Gotchas

1. **Stale table statistics after bulk load.** After inserting or deleting more than ~10% of a table's rows, the planner's cardinality estimates drift, causing it to prefer sequential scans. Always run `ANALYZE <table>` after bulk spatial loads.

2. **Function wrapping defeats index usage.** Writing `WHERE ST_Transform(geom, 4326) && $1` prevents the GiST index on the original `geom` column from being used. Store data in the CRS you query in, or create a functional index: `CREATE INDEX ON parcels USING GIST (ST_Transform(geom, 4326))`.

3. **PgBouncer transaction mode breaks prepared statements.** Using `asyncpg` without setting `statement_cache_size=0` causes `ERROR: prepared statement "..." already exists` errors after the first cache fill. Set `statement_cache_size=0` at the pool level.

4. **Redis key fragmentation from unsanitized coordinates.** If clients can send arbitrary floating-point coordinates, cache hit rates drop to near zero. Always normalize to a fixed grid before constructing the cache key. Monitor Redis `keyspace_hits` and `keyspace_misses` in real time; a hit rate below 30% for repeated viewports indicates a normalization bug.

5. **GeoJSON payload size blowing memory limits.** A 50 000-feature response serialized to GeoJSON can exceed 100 MB. Set an explicit `LIMIT` in the query, enforce a maximum bounding-box area, and use `ST_SimplifyPreserveTopology` at zoom levels below 14 to reduce vertex count before serialization.

6. **CDN caching responses with error status codes.** If a PostGIS timeout causes a 504 response, CDN edge nodes may cache it if `Cache-Control` headers are set globally. Always set `Cache-Control: no-store` on error responses, and only allow caching on 200 OK responses.

7. **Projection mismatch between stored SRID and query SRID.** Passing coordinates in EPSG:4326 to a column stored in EPSG:3857 without explicit `ST_Transform` returns empty results silently — PostGIS compares raw coordinates without projection. Always verify `ST_SRID(geom)` matches your envelope's SRID.

## Production Readiness Checklist

- [ ] GiST index exists on every spatial column used in `WHERE` or `JOIN` predicates; `ANALYZE` runs after bulk loads
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` confirms index scans for the 10 most frequent query shapes; sequential scans are documented with a justification
- [ ] Redis hit rate exceeds 70% for repeated bounding-box queries; cache keys are normalized to 3 d.p. or tile-grid resolution
- [ ] GeoJSON payloads are under 2 MB for typical viewport queries; `ST_SimplifyPreserveTopology` applied at zoom < 14
- [ ] PgBouncer configured in transaction mode; `asyncpg` pool uses `statement_cache_size=0`; pool size matches PostGIS CPU core count × 2–3
- [ ] Bounding-box area limit enforced at the route level; per-IP rate limiting active
- [ ] `/health` endpoint validates both PostGIS and Redis before returning 200
- [ ] Prometheus metrics for query duration, cache hit/miss ratio, pool saturation, and index vs sequential scan rates are active and alerting

---

## Related

- [Query Plan Analysis & Index Tuning](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — reading `EXPLAIN ANALYZE` output, fixing planner misestimates, and choosing between GiST and BRIN indexes
- [Redis Caching for Spatial Queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — key normalization, H3-based cache tagging, compression pipelines, and eviction policies
- [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — complete `pgbouncer.ini` configuration, asyncpg compatibility, and pool sizing formulas
- [Tile Generation & CDN Distribution](/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — `ST_AsMVT` pipelines, cache-header strategy, and fallback for uncached zoom levels
- [GeoJSON vs GeoParquet Serialization](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — choosing the right output format for browser clients, analytics pipelines, and bulk exports
