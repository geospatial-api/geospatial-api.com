---
layout: layouts/page.njk
title: "Redis Caching for Spatial Queries"
description: "Cache PostGIS spatial queries with Redis in FastAPI. Normalize bbox keys to fixed grid cells, serialize GeoJSON with orjson, implement async cache middleware, and harden against failure."
slug: "redis-caching-for-spatial-queries"
breadcrumb: "High-Performance Caching & Query Optimization › Redis Caching for Spatial Queries"
datePublished: "2025-11-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Redis Caching for Spatial Queries",
      "description": "Cache PostGIS spatial queries with Redis in FastAPI. Normalize bbox keys to fixed grid cells, serialize GeoJSON with orjson, implement async cache middleware, and harden against failure.",
      "datePublished": "2025-11-15",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "High-Performance Caching & Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 3, "name": "Redis Caching for Spatial Queries", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement Redis Caching for PostGIS Spatial Queries",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Normalize input parameters", "text": "Round bounding box coordinates to fixed precision; enforce a canonical CRS." },
        { "@type": "HowToStep", "position": 2, "name": "Generate a deterministic cache key", "text": "SHA-256 hash the normalized envelope, layer id, and sorted filter parameters." },
        { "@type": "HowToStep", "position": 3, "name": "Check Redis asynchronously", "text": "Use redis.asyncio to query the cache; deserialize and return on a hit." },
        { "@type": "HowToStep", "position": 4, "name": "Execute the PostGIS fallback", "text": "On a miss, run ST_AsGeoJSON or shapely-based serialization against PostGIS." },
        { "@type": "HowToStep", "position": 5, "name": "Cache with a volatility-aware TTL", "text": "Store serialized payload in Redis with a TTL matched to how often the underlying data changes." },
        { "@type": "HowToStep", "position": 6, "name": "Invalidate by spatial region", "text": "Use spatial cache tags or grid-cell keys to evict stale entries when geometries update." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does floating-point drift break spatial cache keys?",
          "acceptedAnswer": { "@type": "Answer", "text": "Tiny IEEE-754 rounding differences between identical bounding boxes produce different SHA-256 digests, fragmenting the cache. Rounding to 5 decimal places (~1 m precision) before hashing collapses those variants into a single key." }
        },
        {
          "@type": "Question",
          "name": "What Redis eviction policy should I use for spatial caches?",
          "acceptedAnswer": { "@type": "Answer", "text": "Use allkeys-lru when all keys carry spatial payloads and you want Redis to discard the least-recently-used entries automatically. Switch to volatile-ttl if you mix spatial cache keys with long-lived configuration keys and need finer control over what gets evicted first." }
        },
        {
          "@type": "Question",
          "name": "How do I avoid serving stale geometry after a dataset update?",
          "acceptedAnswer": { "@type": "Answer", "text": "Tag cache keys with the grid cell identifiers they intersect. When a geometry record is written, compute which grid cells it touches and issue a Redis DEL or UNLINK for every key carrying that cell tag. For near-real-time feeds, supplement tags with a short TTL (30–60 s) as a safety net." }
        }
      ]
    },
    {
      "@type": "Article",
      "headline": "Redis Caching for Spatial Queries",
      "datePublished": "2025-11-15",
      "dateModified": "2026-06-23"
    }
  ]
}
</script>

← Back to [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/)

# Redis Caching for Spatial Queries

PostGIS spatial queries — bounding box filters, `ST_DWithin` nearest-neighbor searches, polygon intersection tests — are among the most CPU- and I/O-intensive operations a geospatial API can serve. When exposed on a public map endpoint, even moderate traffic from a tile-rendering client can saturate database connections and push query latencies into the seconds. Redis caching intercepts these repeated computations before they reach PostGIS, returning serialized GeoJSON from memory in microseconds instead of milliseconds. This page walks through a complete, production-ready implementation: deterministic key generation, async cache orchestration, volatility-aware TTLs, spatial tag invalidation, and failure recovery for FastAPI backends.

---

## Cache-Aside Architecture for Spatial APIs

The pattern below sits entirely inside your FastAPI process. No sidecar proxy, no query-level interception — just an explicit cache check in each route handler before the database is touched.

<svg viewBox="0 0 720 320" role="img" aria-label="Cache-aside flow for a FastAPI spatial endpoint" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Cache-aside flow for a FastAPI spatial endpoint</title>
  <desc>Request flows from the client to FastAPI. FastAPI checks Redis. On a hit the response returns from Redis. On a miss, FastAPI queries PostGIS, stores the result in Redis, then returns the response to the client.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- Boxes -->
  <rect x="20" y="120" width="110" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="75" y="140" text-anchor="middle" font-size="13" fill="currentColor">Client</text>
  <text x="75" y="157" text-anchor="middle" font-size="11" fill="currentColor">(map / app)</text>
  <rect x="200" y="120" width="130" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="265" y="140" text-anchor="middle" font-size="13" fill="currentColor">FastAPI</text>
  <text x="265" y="157" text-anchor="middle" font-size="11" fill="currentColor">route handler</text>
  <rect x="420" y="40" width="110" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="475" y="60" text-anchor="middle" font-size="13" fill="currentColor">Redis</text>
  <text x="475" y="77" text-anchor="middle" font-size="11" fill="currentColor">cache layer</text>
  <rect x="420" y="200" width="110" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="475" y="220" text-anchor="middle" font-size="13" fill="currentColor">PostGIS</text>
  <text x="475" y="237" text-anchor="middle" font-size="11" fill="currentColor">database</text>
  <!-- Client → FastAPI -->
  <line x1="130" y1="144" x2="198" y2="144" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="164" y="138" text-anchor="middle" font-size="10" fill="currentColor">request</text>
  <!-- FastAPI → Redis -->
  <line x1="330" y1="130" x2="418" y2="82" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="385" y="98" text-anchor="middle" font-size="10" fill="currentColor">GET key</text>
  <!-- Redis HIT → FastAPI (dashed) -->
  <line x1="420" y1="72" x2="332" y2="128" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#arr)"/>
  <text x="366" y="112" text-anchor="middle" font-size="10" fill="currentColor">HIT: bytes</text>
  <!-- FastAPI → PostGIS (miss path) -->
  <line x1="330" y1="158" x2="418" y2="210" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#arr)"/>
  <text x="380" y="205" text-anchor="middle" font-size="10" fill="currentColor">MISS → query</text>
  <!-- PostGIS → FastAPI -->
  <line x1="418" y1="224" x2="330" y2="168" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="365" y="185" text-anchor="middle" font-size="10" fill="currentColor">rows</text>
  <!-- FastAPI → Redis SET -->
  <line x1="330" y1="150" x2="418" y2="78" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2,4" marker-end="url(#arr)"/>
  <text x="355" y="130" text-anchor="middle" font-size="9" fill="currentColor">SETEX result</text>
  <!-- FastAPI → Client (response) -->
  <line x1="200" y1="152" x2="132" y2="152" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="164" y="165" text-anchor="middle" font-size="10" fill="currentColor">GeoJSON</text>
  <!-- Legend -->
  <line x1="570" y1="130" x2="600" y2="130" stroke="currentColor" stroke-width="1.5"/>
  <text x="606" y="134" font-size="10" fill="currentColor">cache hit</text>
  <line x1="570" y1="148" x2="600" y2="148" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4,3"/>
  <text x="606" y="152" font-size="10" fill="currentColor">cache miss</text>
</svg>

This cache-aside pattern sits alongside [connection pooling with PgBouncer](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/): Redis absorbs the read-heavy spatial lookups while PgBouncer multiplexes the write and analytical queries that bypass the cache.

---

## Prerequisites & Environment

| Dependency | Minimum version | Notes |
|---|---|---|
| `fastapi` | 0.111 | async route handlers required |
| `redis[asyncio]` | 4.6 | `redis.asyncio` client; `hiredis` parser recommended |
| `orjson` | 3.9 | 2–4× faster than stdlib `json`; handles `bytes` natively |
| `shapely` | 2.0 | geometry manipulation and WKT parsing |
| `pydantic` | 2.x | request validation; see [strict Pydantic validation for geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) |
| PostGIS | 3.3+ | `ST_AsGeoJSON`, `ST_Within`, `ST_Intersects` available |
| Redis | 6.2+ | `OBJECT ENCODING`, `OBJECT FREQ`, `LMPOP` support |

Configure Redis for spatial workloads before writing a line of application code:

```
maxmemory 4gb
maxmemory-policy allkeys-lru
activerehashing yes
lazyfree-lazy-eviction yes
```

`lazyfree-lazy-eviction yes` moves key eviction off the main event loop, preventing latency spikes when Redis runs near its memory limit.

---

## Decision Matrix: Caching Strategies for Spatial Data

| Strategy | Best for | Cache key unit | Invalidation | Complexity |
|---|---|---|---|---|
| Request-level hash | Arbitrary spatial queries | SHA-256 of normalized params | TTL | Low |
| Grid-cell partitioning | Tile/zoom-aligned queries | `{layer}:{z}:{x}:{y}` | Cell-tag DEL | Medium |
| Materialized GeoJSON | Static or rarely-changing layers | Layer name + version | Manual or event-driven | Medium |
| Edge tile CDN | Public map tile traffic | URL path | CDN purge API | High |

For most FastAPI GIS APIs serving dynamic filters, **request-level hashing** (covered in detail below) delivers the best hit rate without requiring tile-aligned request parameters. When your consumers are mapping libraries requesting `{z}/{x}/{y}` slippy tiles, switch to grid-cell partitioning and consider [tile generation with CDN distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) to push caching to the network edge.

---

## Step-by-Step Implementation

### 1. Normalize Input Parameters

Floating-point IEEE-754 drift turns semantically identical bounding boxes into different strings. `[-73.9851, 40.7484]` and `[-73.98510001, 40.74840002]` differ by sub-centimetre amounts but produce completely different SHA-256 digests if hashed raw. Round to 5 decimal places (~1.1 m at the equator) before hashing:

```python
def normalize_bbox(
    bbox: tuple[float, float, float, float],
    precision: int = 5,
) -> tuple[float, float, float, float]:
    """Round to fixed precision to collapse sub-metre float drift."""
    return tuple(round(c, precision) for c in bbox)
```

Also enforce a canonical CRS. If your API accepts both EPSG:4326 and EPSG:3857, reproject to EPSG:4326 before normalizing.

### 2. Generate a Deterministic Cache Key

Sort all filter parameters before serializing; dict insertion order varies between Python versions and request sources:

```python
import hashlib
import json
from typing import Any

def spatial_cache_key(
    bbox: tuple[float, float, float, float],
    layer_id: str,
    filters: dict[str, Any] | None = None,
    precision: int = 5,
) -> str:
    """
    SHA-256 over canonical JSON of normalized spatial params.
    Identical spatial queries always produce the same key.
    """
    payload = {
        "bbox": list(normalize_bbox(bbox, precision)),
        "layer": layer_id,
        "filters": dict(sorted((filters or {}).items())),
    }
    canonical = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    return f"spatial:{hashlib.sha256(canonical.encode()).hexdigest()}"
```

Prefix the key with a namespace (`spatial:`) so you can scan or delete an entire category with `SCAN 0 MATCH spatial:*`.

### 3. Implement Async Cache Read/Write

Use `decode_responses=False` so that `orjson` can read and write raw `bytes` without a re-encode round-trip:

```python
from redis.asyncio import Redis

redis_client = Redis.from_url(
    "redis://localhost:6379/0",
    decode_responses=False,
    max_connections=50,     # match your FastAPI worker count
)

async def cache_get(key: str) -> dict | None:
    raw = await redis_client.get(key)
    return orjson.loads(raw) if raw else None

async def cache_set(key: str, payload: dict, ttl: int) -> None:
    await redis_client.setex(key, ttl, orjson.dumps(payload))
```

### 4. Assign Volatility-Aware TTLs

TTL is the primary lever for balancing freshness against hit rate. Match it to your data's update frequency:

| Layer type | Example | Recommended TTL |
|---|---|---|
| Static administrative boundaries | Country/state polygons | 86400 s (24 h) |
| Moderately dynamic datasets | Parcel data, land use | 3600 s (1 h) |
| Frequently updated datasets | Traffic incidents, weather | 120–300 s |
| Near-real-time feeds | IoT sensor positions | 15–30 s |

```python
LAYER_TTL: dict[str, int] = {
    "admin_boundaries": 86400,
    "land_use":         3600,
    "traffic_incidents": 180,
    "sensor_positions":  20,
}

def ttl_for_layer(layer_id: str) -> int:
    return LAYER_TTL.get(layer_id, 300)   # default 5 min
```

### 5. Wire the Cache Into a FastAPI Route

For [bounding box spatial index queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) the following route covers the full cache-aside cycle — normalize, check, query, store, return:

```python
from fastapi import FastAPI, Depends
from sqlalchemy.ext.asyncio import AsyncSession
import orjson

app = FastAPI()

@app.get("/api/v1/spatial/search")
async def spatial_search(
    minx: float,
    miny: float,
    maxx: float,
    maxy: float,
    layer: str,
    db: AsyncSession = Depends(get_db),
):
    key = spatial_cache_key(
        bbox=(minx, miny, maxx, maxy),
        layer_id=layer,
    )

    hit = await cache_get(key)
    if hit is not None:
        return hit

    # PostGIS query — ST_Intersects against a GIST-indexed geometry column
    result = await db.execute(
        """
        SELECT ST_AsGeoJSON(geom)::json AS geometry, properties
        FROM   spatial_features
        WHERE  ST_Intersects(
                   geom,
                   ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)
               )
          AND  layer_id = :layer
        """,
        {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy, "layer": layer},
    )
    features = [
        {"type": "Feature", "geometry": row.geometry, "properties": row.properties}
        for row in result
    ]
    geojson = {"type": "FeatureCollection", "features": features}

    await cache_set(key, geojson, ttl=ttl_for_layer(layer))
    return geojson
```

The GeoJSON output must conform to RFC 7946 — longitude before latitude, right-hand rule for polygon rings — to ensure compatibility with the [GeoJSON vs GeoParquet serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) choices made elsewhere in your stack.

---

## Production Code Example: Full Cache-Aside Route with Error Handling

This self-contained module demonstrates circuit-breaker-style fallback, structured logging, and cache tagging for invalidation. Copy and adapt it to your project:

```python
import hashlib
import json
import logging
from typing import Any

import orjson
from fastapi import FastAPI, Depends, Request
from redis.asyncio import Redis, RedisError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)
app = FastAPI()

redis_client = Redis.from_url(
    "redis://localhost:6379/0",
    decode_responses=False,
    socket_connect_timeout=1,
    socket_timeout=1,          # hard 1-second deadline; fail fast
)

# ── Key helpers ────────────────────────────────────────────────────────────────

def normalize_bbox(bbox: tuple, precision: int = 5) -> tuple:
    return tuple(round(c, precision) for c in bbox)

def spatial_cache_key(bbox: tuple, layer_id: str, filters: dict | None = None) -> str:
    payload = {
        "bbox": list(normalize_bbox(bbox)),
        "layer": layer_id,
        "filters": dict(sorted((filters or {}).items())),
    }
    digest = hashlib.sha256(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    return f"spatial:{layer_id}:{digest}"

# ── Cache I/O with graceful fallback ─────────────────────────────────────────

async def try_cache_get(key: str) -> dict | None:
    try:
        raw = await redis_client.get(key)
        if raw:
            logger.debug("cache_hit key=%s", key)
            return orjson.loads(raw)
    except RedisError as exc:
        logger.warning("cache_read_error key=%s error=%s", key, exc)
    return None

async def try_cache_set(key: str, payload: dict, ttl: int) -> None:
    try:
        await redis_client.setex(key, ttl, orjson.dumps(payload))
        logger.debug("cache_write key=%s ttl=%d", key, ttl)
    except RedisError as exc:
        logger.warning("cache_write_error key=%s error=%s", key, exc)

# ── Route ─────────────────────────────────────────────────────────────────────

LAYER_TTL = {"admin_boundaries": 86400, "land_use": 3600, "traffic_incidents": 180}

@app.get("/api/v1/spatial/features")
async def get_spatial_features(
    minx: float,
    miny: float,
    maxx: float,
    maxy: float,
    layer: str,
    db: AsyncSession = Depends(get_db),
):
    key = spatial_cache_key((minx, miny, maxx, maxy), layer)
    cached = await try_cache_get(key)
    if cached is not None:
        return cached

    rows = await db.execute(
        """
        SELECT ST_AsGeoJSON(geom)::json AS geometry, properties
        FROM   spatial_features
        WHERE  ST_Intersects(
                   geom,
                   ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)
               )
          AND  layer_id = :layer
        LIMIT  5000
        """,
        {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy, "layer": layer},
    )
    geojson = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": r.geometry, "properties": r.properties}
            for r in rows
        ],
    }

    ttl = LAYER_TTL.get(layer, 300)
    await try_cache_set(key, geojson, ttl)
    return geojson
```

`socket_timeout=1` ensures Redis latency never adds more than one second to a cache-miss path. The `try_*` wrappers catch `RedisError` so a Redis outage degrades gracefully to a direct PostGIS query rather than a 500.

---

## Spatial Cache Tag Invalidation

Keying only on request parameters means a geometry update in PostGIS leaves stale entries until TTL expiry. For datasets that change via an admin write path, implement spatial tag invalidation:

1. Divide your coordinate space into a fixed grid (e.g. 0.1° cells at EPSG:4326).
2. When caching a response, record which grid cells the bounding box overlaps in a Redis Set: `SADD tag:{layer}:{cell_id} {cache_key}`.
3. When a feature is written or deleted, compute the affected cells and call `SUNIONSTORE` to collect all cache keys for those cells, then `UNLINK` them.

The companion page on [configuring Redis cache tags for bounding box queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/configuring-redis-cache-tags-for-bounding-box-queries/) walks through the full grid-cell tagging implementation with code.

---

## Verification & Testing

Confirm cache behaviour with a two-request sequence:

```bash
# First request — expect a PostGIS query (cache miss)
time curl -s "http://localhost:8000/api/v1/spatial/features?minx=-73.99&miny=40.74&maxx=-73.97&maxy=40.76&layer=land_use" | jq '.features | length'

# Second request — expect a Redis hit (significantly faster)
time curl -s "http://localhost:8000/api/v1/spatial/features?minx=-73.99&miny=40.74&maxx=-73.97&maxy=40.76&layer=land_use" | jq '.features | length'
```

Inspect Redis directly to confirm the key was written and the TTL is set:

```bash
redis-cli KEYS "spatial:land_use:*"
redis-cli TTL "spatial:land_use:<your-digest>"
redis-cli OBJECT ENCODING "spatial:land_use:<your-digest>"
```

For a unit test skeleton, mock `redis_client.get` to return `None` on the first call and a serialized fixture on the second:

```python
import pytest
from unittest.mock import AsyncMock, patch
import orjson

FIXTURE = orjson.dumps({"type": "FeatureCollection", "features": []})

@pytest.mark.asyncio
async def test_cache_hit_skips_db(client, mock_db):
    with patch("myapp.cache.redis_client.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = FIXTURE
        resp = await client.get("/api/v1/spatial/features?minx=-74&miny=40&maxx=-73&maxy=41&layer=land_use")
    assert resp.status_code == 200
    mock_db.execute.assert_not_called()   # DB must not be hit on a cache hit
```

Check your PostGIS query plans independently with `EXPLAIN ANALYZE` to ensure `ST_Intersects` uses the GiST index. See [query plan analysis and index tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) for a full walkthrough of reading spatial query plans.

---

## Failure Modes & Edge Cases

1. **Cache fragmentation from float drift.** Symptom: hit rate below 20% despite repeated identical requests. Cause: bounding box values arrive with varying decimal places. Fix: always apply `normalize_bbox` before hashing. Check with `redis-cli DBSIZE` — an ever-growing key count is the tell.

2. **Redis OOM evicting hot spatial keys.** Symptom: `evicted_keys` counter in `redis-cli INFO stats` climbs during traffic spikes. Fix: increase `maxmemory`, compress large payloads with `lz4` before storing, or add a result-size guard (`if len(features) > 1000: skip cache`).

3. **`orjson.JSONDecodeError` on cache read.** Cause: a partial write left a truncated value (connection reset mid-`SETEX`). Fix: wrap `orjson.loads` in a try/except and treat decode errors as a cache miss — delete the corrupted key with `redis_client.delete(key)`.

4. **TTL set to 0 by misconfiguration.** A TTL of 0 passed to `SETEX` raises `redis.exceptions.ResponseError: invalid expire time`. Validate TTL values before calling `cache_set`; default to 60 seconds if the configured value resolves to zero or negative.

5. **Stale geometry served after a dataset import.** A bulk import that replaces all features in a layer can leave hundreds of valid-but-outdated keys. Fix: after each bulk import, run `redis-cli SCAN 0 MATCH spatial:{layer}:* COUNT 100` in a loop and `UNLINK` the matched keys, or store the layer's last-write timestamp in a separate Redis key and compare on read.

6. **`asyncio.TimeoutError` when Redis is under memory pressure.** Occurs when `lazyfree-lazy-eviction` is disabled and the server stalls during eviction. Ensure `lazyfree-lazy-eviction yes` is set and add a try/except around every `await redis_client.*` call to fall back to PostGIS.

---

## Performance Notes

| Scenario | p50 latency | p95 latency | Notes |
|---|---|---|---|
| Redis cache hit | 0.3 ms | 1.1 ms | `orjson.loads` on 50 KB payload |
| PostGIS miss (GiST index, 500 features) | 18 ms | 65 ms | Single-node PostGIS, local network |
| PostGIS miss (sequential scan, no index) | 420 ms | 1.8 s | Without `CREATE INDEX ... USING GIST` |
| Redis OOM, graceful fallback to PostGIS | 19 ms | 70 ms | `socket_timeout=1` prevents stall |

**Key takeaway:** a warm Redis cache reduces p95 latency by ~98% for repeated spatial queries. The gains are most pronounced on complex `ST_Intersects` queries with large result sets, where PostGIS must traverse deep GiST index nodes and serialize hundreds of geometry rows.

For queries returning large FeatureCollections (>500 features), consider pre-compressing the payload before storage with Python's `lz4.frame.compress`. Decompression on read adds ~0.2 ms but can cut Redis memory usage by 60–80% for geometry-dense responses. When payload size itself is the bottleneck rather than query latency, see the [GeoJSON vs GeoParquet serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) comparison for binary format alternatives that are smaller to cache and faster to deserialize.

---

## FAQ

<details class="faq-item">
<summary>Why does floating-point drift break spatial cache keys?</summary>

Tiny IEEE-754 rounding differences between semantically identical bounding boxes produce different SHA-256 digests, fragmenting the cache. Rounding to 5 decimal places (~1.1 m at the equator) before hashing collapses those variants into a single key.

</details>

<details class="faq-item">
<summary>What Redis eviction policy should I use for spatial caches?</summary>

Use `allkeys-lru` when all keys carry spatial payloads and you want Redis to discard the least-recently-used entries automatically. Switch to `volatile-ttl` if you mix spatial cache keys with long-lived configuration keys and need finer control over what gets evicted first.

</details>

<details class="faq-item">
<summary>How do I avoid serving stale geometry after a dataset update?</summary>

Tag cache keys with the grid cell identifiers they intersect. When a geometry record is written, compute which grid cells it touches and issue a Redis `DEL` or `UNLINK` for every key carrying that cell tag. For near-real-time feeds, supplement tags with a short TTL (30–60 s) as a safety net.

</details>

<details class="faq-item">
<summary>Can I cache KNN queries the same way?</summary>

Yes, but include the origin point and the value of `k` in the cache key payload. KNN result sets are sensitive to the exact query point — even a 1-metre shift can change the ranked order of results. Use a coarser normalization precision (3–4 decimal places, ~100 m) to increase cache reuse for nearby origin points. See [K-nearest-neighbor routing algorithms](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) for the underlying PostGIS query patterns.

</details>

---

## Related

- [Configuring Redis Cache Tags for Bounding Box Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/configuring-redis-cache-tags-for-bounding-box-queries/) — grid-cell invalidation implementation
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — prevent PostGIS connection saturation on cache misses
- [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — verify GiST indexes are used on the miss path
- [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — push caching to the network edge for public tile traffic
- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — choose the right serialization format for cached payloads

← Back to [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/)
