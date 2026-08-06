---
layout: layouts/page.njk
title: "Redis Cache Tags for Bounding Box Queries"
description: "Implement Redis cache tags for spatial bounding box queries using Redis Sets. Invalidate whole grid cells atomically when PostGIS geometry data changes."
slug: configuring-redis-cache-tags-for-bounding-box-queries
breadcrumb:
  - label: "Geospatial Caching and Query Optimization"
    url: "/high-performance-caching-query-optimization/"
  - label: "Redis Caching for Spatial Queries"
    url: "/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/"
  - label: "Redis Cache Tags for Bounding Box Queries"
    url: "/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/configuring-redis-cache-tags-for-bounding-box-queries/"
datePublished: "2025-04-14"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Redis Cache Tags for Bounding Box Queries",
      "description": "Implement Redis cache tags for spatial bounding box queries using Redis Sets. Invalidate whole grid cells atomically when PostGIS geometry data changes.",
      "datePublished": "2025-04-14",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/configuring-redis-cache-tags-for-bounding-box-queries/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Geospatial Caching and Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 2, "name": "Redis Caching for Spatial Queries", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/" },
        { "@type": "ListItem", "position": 3, "name": "Redis Cache Tags for Bounding Box Queries", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/configuring-redis-cache-tags-for-bounding-box-queries/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Configure Redis Cache Tags for Bounding Box Queries",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Normalize coordinates", "text": "Round all bbox edges to a fixed decimal precision to collapse near-identical viewports into the same cache key." },
        { "@type": "HowToStep", "position": 2, "name": "Derive a grid-cell tag", "text": "Map the bbox center to a fixed spatial grid (e.g. 1°×1°) and generate a Redis Set key for that cell." },
        { "@type": "HowToStep", "position": 3, "name": "Register keys in the tag Set", "text": "On cache write, SADD the cache key into its grid-cell tag Set using a pipeline alongside the SETEX call." },
        { "@type": "HowToStep", "position": 4, "name": "Invalidate by tag on PostGIS mutation", "text": "SMEMBERS the affected tag Set, UNLINK all keys, and DELETE the tag Set in one pipeline." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does UNLINK outperform DEL for bulk cache invalidation?",
          "acceptedAnswer": { "@type": "Answer", "text": "UNLINK schedules key deletion in a background thread, so it returns immediately without blocking the Redis event loop. DEL is synchronous and blocks while each key is freed, which causes latency spikes when invalidating large tag Sets." }
        },
        {
          "@type": "Question",
          "name": "How do I choose the right grid cell size?",
          "acceptedAnswer": { "@type": "Answer", "text": "Match grid resolution to your typical viewport. A 0.1° grid (~11 km) suits regional datasets; 1° suits continental scales. Oversized grids cause over-invalidation; undersized grids fragment Redis memory across too many tag Sets." }
        },
        {
          "@type": "Question",
          "name": "Should I set a TTL on the tag Set itself?",
          "acceptedAnswer": { "@type": "Answer", "text": "Yes, as a safety net. If a mutation event is missed, an un-expired tag Set keeps stale keys alive indefinitely. Set a TTL on the tag Set slightly longer than your cache entry TTL — e.g. CACHE_TTL * 1.5 — so orphaned sets eventually self-clean." }
        }
      ]
    }
  ]
}
</script>

← Back to [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/)

# Redis Cache Tags for Bounding Box Queries

Bounding box queries carry high-cardinality parameters: a viewport shift of 0.0001 degrees or a minor zoom change generates a completely new cache key, making conventional per-key invalidation unmanageable at scale. This page shows how to group those keys under spatial tag Sets in Redis so you can invalidate an entire geographic grid cell in a single atomic pipeline when PostGIS geometry changes.

## Context & When to Use

Standard cache strategies break down for spatial bounding box endpoints because the parameter space is effectively infinite. A delivery fleet map can produce thousands of distinct bbox strings in a single hour of normal use. If a driver's geometry is updated in PostGIS, you need to expire every cached response that could contain that driver — but you cannot enumerate those keys ahead of time.

The tag-based approach solves this by introducing a level of indirection. Every bbox cache key is registered into a Redis Set that represents the coarse grid cell it falls within. When geometry in a cell changes, you fetch the Set membership and purge the whole batch. The cost is two extra Redis commands on write (`SADD`) and one pipeline on invalidation (`SMEMBERS` + `UNLINK` + `DEL`), both of which are negligible compared to the PostGIS query they replace.

Use this pattern when: your bbox parameters are user-driven and unpredictable (map panning, viewport resizing); your underlying spatial data changes frequently enough that stale responses are a correctness concern; and you need sub-50 ms read latency under high concurrency. If your spatial data is nearly static, a simpler approach — a global TTL plus periodic cache warming — is sufficient. For the foundational key structure and connection setup, read the [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) guide first.

This technique also complements [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) work: once you know which `ST_Intersects` or `ST_Within` calls dominate your `EXPLAIN ANALYZE` output, tag-driven caching is the next layer to add so those expensive plans run as rarely as possible.

## Tag Architecture Diagram

The diagram below shows the data flow from an incoming bbox request through the Redis tag layer to PostGIS, and the separate invalidation path triggered by a geometry mutation.

<svg role="img" aria-label="Redis cache tag architecture for bounding box queries" viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:640px;font-family:inherit">
  <title>Redis cache tag architecture for bounding box queries</title>
  <desc>Diagram showing two flows: a read path where bbox requests hit Redis and fall through to PostGIS on a miss, and an invalidation path where PostGIS mutations purge the Redis tag Set.</desc>
  <!-- Background panels -->
  <rect x="0" y="0" width="640" height="400" rx="6" fill="var(--surface, #f5f3ff)"/>
  <!-- Client box -->
  <rect x="20" y="20" width="120" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="80" y="37" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">FastAPI</text>
  <text x="80" y="52" text-anchor="middle" font-size="11" fill="currentColor">bbox request</text>
  <!-- Arrow: client -> normalize -->
  <line x1="140" y1="42" x2="190" y2="42" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"/>
  <!-- Normalize box -->
  <rect x="190" y="20" width="120" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="250" y="37" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Normalize</text>
  <text x="250" y="52" text-anchor="middle" font-size="11" fill="currentColor">round + grid tag</text>
  <!-- Arrow: normalize -> Redis -->
  <line x1="310" y1="42" x2="360" y2="42" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"/>
  <!-- Redis box -->
  <rect x="360" y="20" width="120" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="420" y="37" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Redis</text>
  <text x="420" y="52" text-anchor="middle" font-size="11" fill="currentColor">GET cache_key</text>
  <!-- HIT label -->
  <text x="540" y="37" text-anchor="start" font-size="11" fill="currentColor" font-style="italic">HIT →</text>
  <text x="540" y="50" text-anchor="start" font-size="11" fill="currentColor" font-style="italic">return</text>
  <!-- MISS path: Redis -> PostGIS -->
  <line x1="420" y1="64" x2="420" y2="130" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arrow)"/>
  <text x="428" y="100" font-size="11" fill="currentColor" font-style="italic">MISS</text>
  <!-- PostGIS box -->
  <rect x="360" y="130" width="120" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="420" y="147" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">PostGIS</text>
  <text x="420" y="162" text-anchor="middle" font-size="11" fill="currentColor">ST_Intersects query</text>
  <!-- Arrow: PostGIS -> cache write -->
  <line x1="360" y1="152" x2="250" y2="152" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"/>
  <!-- Cache write box -->
  <rect x="130" y="130" width="120" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="190" y="147" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Pipeline write</text>
  <text x="190" y="162" text-anchor="middle" font-size="11" fill="currentColor">SETEX + SADD</text>
  <!-- Divider -->
  <line x1="20" y1="210" x2="620" y2="210" stroke="currentColor" stroke-width="1" stroke-dasharray="4,4" opacity="0.4"/>
  <text x="30" y="228" font-size="11" fill="currentColor" opacity="0.7" font-style="italic">Invalidation path (on PostGIS mutation)</text>
  <!-- Mutation event box -->
  <rect x="20" y="240" width="130" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="85" y="257" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Geometry update</text>
  <text x="85" y="272" text-anchor="middle" font-size="11" fill="currentColor">POST /features</text>
  <!-- Arrow: mutation -> derive tag -->
  <line x1="150" y1="262" x2="200" y2="262" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"/>
  <!-- Derive tag box -->
  <rect x="200" y="240" width="120" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="260" y="257" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Derive tag key</text>
  <text x="260" y="272" text-anchor="middle" font-size="11" fill="currentColor">grid cell(s)</text>
  <!-- Arrow: derive -> smembers -->
  <line x1="320" y1="262" x2="370" y2="262" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"/>
  <!-- SMEMBERS box -->
  <rect x="370" y="240" width="120" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="430" y="257" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">SMEMBERS</text>
  <text x="430" y="272" text-anchor="middle" font-size="11" fill="currentColor">fetch all keys</text>
  <!-- Arrow: smembers -> purge -->
  <line x1="490" y1="262" x2="540" y2="262" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"/>
  <!-- Purge box -->
  <rect x="540" y="240" width="80" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="580" y="257" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">UNLINK</text>
  <text x="580" y="272" text-anchor="middle" font-size="11" fill="currentColor">+ DEL tag</text>
  <!-- Legend -->
  <text x="20" y="355" font-size="11" fill="currentColor" opacity="0.8">Solid arrows — read/write path</text>
  <line x1="20" y1="368" x2="50" y2="368" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5,3"/>
  <text x="58" y="372" font-size="11" fill="currentColor" opacity="0.8">Dashed — cache miss fallthrough</text>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

## Runnable Implementation

The implementation below uses `redis-py` 5.0+ async client and Python 3.10+. It covers coordinate normalization, deterministic key generation, atomic cache writes with tag registration, and the invalidation routine. Wire `invalidate_layer_bbox` into any FastAPI mutation route that persists geometry to PostGIS.

For the PostGIS query inside `fetch_features_from_db`, use `ST_Intersects` or `ST_Within` with a properly maintained `GIST` index — see [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) for the full index setup. If you are returning large feature sets, consider the [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision matrix before choosing a serialization format for the cached payload.

```python
import math
import json
from typing import Optional
from fastapi import FastAPI, Query, Depends
import redis.asyncio as aioredis

app = FastAPI()

# ------------------------------------------------------------------
# Connection — reuse a single pool across all requests
# ------------------------------------------------------------------
redis_pool = aioredis.ConnectionPool(
    host="localhost", port=6379, db=0,
    decode_responses=True, max_connections=50
)

async def get_redis() -> aioredis.Redis:
    return aioredis.Redis(connection_pool=redis_pool)

# ------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------
CACHE_TTL = 3600      # seconds — fallback TTL if invalidation is missed
TAG_TTL   = 5400      # tag Set TTL — slightly longer than CACHE_TTL
PRECISION = 4         # ~11 m accuracy at mid-latitudes
GRID_SIZE = 1.0       # 1°×1° grid cell for tag derivation

# ------------------------------------------------------------------
# Key helpers
# ------------------------------------------------------------------
def normalize_bbox(minx: float, miny: float,
                   maxx: float, maxy: float) -> tuple[float, float, float, float]:
    """Round all bbox edges to PRECISION decimal places."""
    return (
        round(minx, PRECISION), round(miny, PRECISION),
        round(maxx, PRECISION), round(maxy, PRECISION),
    )

def cache_key(layer: str, bbox: tuple) -> str:
    """Deterministic cache key from layer + normalized bbox."""
    return f"cache:bbox:{layer}:{bbox[0]}:{bbox[1]}:{bbox[2]}:{bbox[3]}"

def tag_key(layer: str, bbox: tuple) -> str:
    """Redis Set key representing the grid cell containing this bbox center."""
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    gx = math.floor(cx / GRID_SIZE) * GRID_SIZE
    gy = math.floor(cy / GRID_SIZE) * GRID_SIZE
    return f"tag:bbox:{layer}:{gx}:{gy}"

# ------------------------------------------------------------------
# Cache-aside read with tag registration
# ------------------------------------------------------------------
async def fetch_features_from_db(
    layer: str, bbox: tuple, redis: aioredis.Redis
) -> dict:
    """
    Replace this stub with your asyncpg + PostGIS call.
    Example SQL:
        SELECT ST_AsGeoJSON(geom) FROM features
        WHERE layer = $1
          AND ST_Intersects(geom, ST_MakeEnvelope($2,$3,$4,$5, 4326))
    """
    return {"type": "FeatureCollection", "features": []}

@app.get("/api/features")
async def get_features(
    layer: str = Query(...),
    minx: float = Query(...), miny: float = Query(...),
    maxx: float = Query(...), maxy: float = Query(...),
    redis: aioredis.Redis = Depends(get_redis),
):
    bbox  = normalize_bbox(minx, miny, maxx, maxy)
    ckey  = cache_key(layer, bbox)

    # 1. Cache lookup
    cached = await redis.get(ckey)
    if cached:
        return {"source": "cache", "data": json.loads(cached)}

    # 2. Cache miss — query PostGIS
    data = await fetch_features_from_db(layer, bbox, redis)
    payload = json.dumps(data)

    # 3. Write cache entry + register in tag Set (one pipeline, non-transactional)
    tkey = tag_key(layer, bbox)
    async with redis.pipeline(transaction=False) as pipe:
        pipe.setex(ckey, CACHE_TTL, payload)   # cache the response
        pipe.sadd(tkey, ckey)                   # register key in grid-cell tag
        pipe.expire(tkey, TAG_TTL)              # safety TTL on the tag Set itself
        await pipe.execute()

    return {"source": "db", "data": data}

# ------------------------------------------------------------------
# Invalidation — call this inside mutation routes
# ------------------------------------------------------------------
async def invalidate_layer_bbox(
    layer: str,
    affected_bbox: tuple,
    redis: aioredis.Redis,
) -> int:
    """
    Purge all cache keys whose tag Set covers affected_bbox.
    Returns the number of keys removed.

    For updates that span multiple grid cells, compute all affected
    tag keys and call this function once per cell (or fan out with
    asyncio.gather for large updates).
    """
    tkey = tag_key(layer, affected_bbox)
    keys = await redis.smembers(tkey)
    if not keys:
        return 0

    # UNLINK is non-blocking (background thread); DEL would block the event loop
    async with redis.pipeline(transaction=False) as pipe:
        pipe.unlink(*keys)    # async key deletion — does not block Redis
        pipe.delete(tkey)     # remove the tag Set itself
        await pipe.execute()

    return len(keys)

@app.post("/api/features/{feature_id}")
async def update_feature(
    feature_id: int,
    layer: str = Query(...),
    minx: float = Query(...), miny: float = Query(...),
    maxx: float = Query(...), maxy: float = Query(...),
    redis: aioredis.Redis = Depends(get_redis),
):
    bbox = normalize_bbox(minx, miny, maxx, maxy)
    # ... persist geometry to PostGIS here ...
    removed = await invalidate_layer_bbox(layer, bbox, redis)
    return {"invalidated_keys": removed}
```

The grid size is the one tuning knob here, and its cost curve is steep at the large end.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Keys purged per invalidation, by grid size: 0.01° cells 12 keys — precise, many tag sets, 0.1° cells 140 keys, 1° cells 2 400 keys, 5° cells 41 000 keys — UNLINK stalls" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Keys purged per invalidation, by grid size</title>
  <desc>A horizontal bar chart. 0.01° cells is 12 keys — precise, many tag sets. 0.1° cells is 140 keys. 1° cells is 2 400 keys. 5° cells is 41 000 keys — UNLINK stalls. Grid size trades over-invalidation against the number of tag sets Redis has to hold. One degree suits regional data; five never does.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Keys purged per invalidation, by grid size</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">0.01° cells</text>
  <rect x="250" y="48" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">12 keys — precise, many tag sets</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">0.1° cells</text>
  <rect x="250" y="82" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="95" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">140 keys</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">1° cells</text>
  <rect x="250" y="116" width="19" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="277" y="129" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">2 400 keys</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">5° cells</text>
  <rect x="250" y="150" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="163" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">41 000 keys — UNLINK</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">Grid size trades over-invalidation against the number of tag sets Redis has to hold. One degree suits regional data; five never does.</text>
</svg>

## Key Parameters & Options

| Parameter | Default | Effect |
|---|---|---|
| `PRECISION` | `4` | Decimal places for coordinate rounding. 4 ≈ 11 m; 5 ≈ 1 m. Lower values increase hit rate but risk boundary mismatches. |
| `GRID_SIZE` | `1.0` (degrees) | Width/height of each tag cell. Smaller grids reduce over-invalidation but create more tag Sets. Use `0.1` for city-scale datasets, `1.0` for regional, `5.0` for continental. |
| `CACHE_TTL` | `3600` s | Fallback TTL applied to every cache entry. Caps stale exposure if a mutation event is missed. |
| `TAG_TTL` | `5400` s | TTL applied to the tag Set itself. Should exceed `CACHE_TTL` so entries always expire before their tag Set disappears. |
| `transaction=False` | — | Pipelines without `MULTI/EXEC`. Correct here because we do not need rollback semantics; removing it avoids the round-trip cost of `MULTI`. |
| `UNLINK` vs `DEL` | `UNLINK` preferred | `UNLINK` defers memory reclamation to a background thread. Use `DEL` only if you need guaranteed synchronous deletion (rarely needed in production). |

Both failure modes come from the same grid decision, and they are not equally serious.

<svg viewBox="0 0 720 198" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two ways an invalidation goes wrong: over-invalidation versus under-invalidation" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Two ways an invalidation goes wrong</title>
  <desc>Two panels. over-invalidation: grid cell far larger than the edit thousands of live keys purged hit rate collapses for minutes harmless to correctness under-invalidation: bbox straddles a cell boundary key registered only in the centre cell stale response served until TTL a correctness bug, invisible Only the right-hand column is dangerous, which is why every cache entry needs a TTL as well as a tag.</desc>
  <rect x="0" y="0" width="720" height="198" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Two ways an invalidation goes wrong</text>
  <rect x="16" y="40" width="336" height="122" rx="9" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.5"/>
  <text x="34" y="62" font-size="11" font-weight="700" fill="var(--viz-warn, #8a5000)">over-invalidation</text>
  <text x="34" y="84" font-size="10" fill="currentColor">grid cell far larger than the edit</text>
  <text x="34" y="106" font-size="10" fill="currentColor">thousands of live keys purged</text>
  <text x="34" y="128" font-size="10" fill="currentColor">hit rate collapses for minutes</text>
  <text x="34" y="150" font-size="10" fill="currentColor">harmless to correctness</text>
  <rect x="368" y="40" width="336" height="122" rx="9" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.5"/>
  <text x="386" y="62" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">under-invalidation</text>
  <text x="386" y="84" font-size="10" fill="currentColor">bbox straddles a cell boundary</text>
  <text x="386" y="106" font-size="10" fill="currentColor">key registered only in the centre cell</text>
  <text x="386" y="128" font-size="10" fill="currentColor">stale response served until TTL</text>
  <text x="386" y="150" font-size="10" fill="currentColor">a correctness bug, invisible</text>
  <text x="20" y="194" font-size="10.5" fill="var(--muted, #7c6fb0)">Only the right-hand column is dangerous, which is why every cache entry needs a TTL as well as a tag.</text>
</svg>

## Gotchas & Failure Modes

- **Orphaned tag Sets after missed mutations.** If a geometry update bypasses `invalidate_layer_bbox` (e.g. a direct SQL `UPDATE` outside the API), the tag Set persists and stale cache keys remain live until `CACHE_TTL` expires. Always apply `TAG_TTL` on the tag Set and `CACHE_TTL` on every cache entry as independent safety nets. Never rely on invalidation alone.

- **Grid boundary splits.** A bbox that straddles a grid cell boundary registers only in the cell containing its *center*. A geometry update in the adjacent cell will not purge it. For datasets with frequent edits near grid lines, reduce `GRID_SIZE` or use a multi-cell registration strategy: compute all grid cells that intersect the bbox and `SADD` the cache key into every relevant tag Set.

- **Tag Set memory growth under high write volume.** Each `SADD` call adds one string entry to the Set. Under sustained load, a popular grid cell can accumulate tens of thousands of entries. Monitor with `MEMORY USAGE tag:bbox:*` and track `SCARD` on hot tag Sets. If a Set exceeds ~10k members, the invalidation pipeline stalls noticeably — consider sharding by zoom level or adding a secondary expiry sweep.

- **Race between cache write and invalidation.** In a concurrent environment, a mutation event can arrive between the PostGIS query and the `pipeline.execute()` call that writes the cache entry. The new cache entry contains stale data but lacks its tag registration, so it will never be invalidated by tag. Mitigate by adding a short `CACHE_TTL` (60–300 s) for data that mutates frequently, so any stale window is bounded.

- **`pipeline(transaction=False)` does not guarantee atomicity.** Commands in a non-transactional pipeline are sent in bulk but can be interrupted if the connection drops mid-flight. If `SETEX` succeeds but `SADD` does not, the cache key is live but untagged. Detect this via a periodic reconciliation job that scans `cache:bbox:*` keys and checks each one against its expected tag Set.

## Verification Snippet

After deploying, confirm the tag mechanism works end-to-end:

```bash
# 1. Make a cacheable request
curl -s "http://localhost:8000/api/features?layer=roads&minx=-0.1278&miny=51.5074&maxx=-0.0978&maxy=51.5274"
# Expect: {"source": "db", ...}

# 2. Confirm cache entry exists
redis-cli GET "cache:bbox:roads:-0.1278:51.5074:-0.0978:51.5274"

# 3. Confirm tag Set membership
redis-cli SMEMBERS "tag:bbox:roads:-1.0:51.0"
# Expect: 1) "cache:bbox:roads:-0.1278:51.5074:-0.0978:51.5274"

# 4. Trigger invalidation via mutation route
curl -s -X POST "http://localhost:8000/api/features/42?layer=roads&minx=-0.1278&miny=51.5074&maxx=-0.0978&maxy=51.5274"
# Expect: {"invalidated_keys": 1}

# 5. Confirm the cache key is gone
redis-cli GET "cache:bbox:roads:-0.1278:51.5074:-0.0978:51.5274"
# Expect: (nil)

# 6. Next request re-populates from PostGIS
curl -s "http://localhost:8000/api/features?layer=roads&minx=-0.1278&miny=51.5074&maxx=-0.0978&maxy=51.5274"
# Expect: {"source": "db", ...}
```

To verify tag Set TTL is set correctly:

```bash
redis-cli TTL "tag:bbox:roads:-1.0:51.0"
# Expect: a positive integer close to TAG_TTL (5400)
```

---

## Related

- [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — cache-aside architecture, key normalization, and async FastAPI middleware
- [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — use `EXPLAIN ANALYZE` to identify which PostGIS operations benefit most from caching
- [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — PostGIS `GIST` index setup and `ST_Intersects` query patterns that feed the cache
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — reduce PostGIS connection pressure on cache misses

← Back to [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/)
