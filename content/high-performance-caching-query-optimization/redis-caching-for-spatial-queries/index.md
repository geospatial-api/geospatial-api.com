---
layout: layouts/page.njk
title: "Redis Caching for Spatial Queries"
description: "Cache PostGIS spatial queries with Redis. Normalize bbox keys to fixed grid cells, serialize GeoJSON with orjson, and implement async FastAPI cache middleware."
---

# Redis Caching for Spatial Queries

Spatial queries against PostGIS are inherently expensive. Bounding box filters, nearest-neighbor searches, and polygon intersections require heavy GiST index traversals, geometry calculations, and often multiple table joins. When exposed through a public-facing map API, repeated identical requests can quickly saturate database connections and degrade response times. Implementing **Redis Caching for Spatial Queries** provides a deterministic, low-latency layer that intercepts redundant spatial computations, offloads PostGIS, and scales geospatial APIs predictably.

This guide outlines a production-ready workflow for FastAPI developers, GIS platform engineers, and API architects. It covers deterministic key generation, async cache orchestration, serialization strategies, and failure recovery patterns.

## Prerequisites & System Architecture

Before implementing spatial caching, ensure your stack meets these baseline requirements:

- **FastAPI** with `async` route handlers and dependency injection
- **PostGIS 3+** with properly maintained spatial indexes (`CREATE INDEX ... USING GIST`)
- **Redis 6+** deployed with `maxmemory-policy allkeys-lru` or `volatile-ttl`
- Python dependencies: `redis[async]`, `orjson`, `shapely`, `pydantic`, `hashlib`
- Familiarity with coordinate reference systems (CRS) and bounding box normalization

The architecture follows a strict cache-aside pattern. Incoming spatial requests are normalized into a deterministic cache key. Redis is queried first. On a hit, the serialized GeoJSON payload returns immediately. On a miss, the request falls through to PostGIS, the result is serialized, cached with a calculated TTL, and returned. This pattern aligns with broader [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/) strategies used across modern geospatial platforms.

When database connection limits become a bottleneck, pairing Redis caching with [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) ensures your PostGIS instances remain responsive even during traffic spikes. Redis handles the read-heavy spatial lookups, while PgBouncer efficiently multiplexes the remaining write and complex analytical queries.

## Step-by-Step Workflow

1. **Normalize Input Parameters**: Round bounding box coordinates to a fixed precision (typically 5–6 decimal places for ~1m accuracy). Enforce a consistent CRS (EPSG:4326 or EPSG:3857). Strip redundant or default query parameters.
2. **Generate Deterministic Cache Key**: Hash the normalized spatial envelope, layer identifier, zoom level, and filter parameters using SHA-256. Sort dictionary keys to prevent permutation mismatches.
3. **Check Redis**: Query the cache asynchronously using `redis.asyncio`. If the key exists, deserialize and return.
4. **Execute Fallback Query**: On a cache miss, run the optimized PostGIS query. Leverage `ST_AsGeoJSON` at the database level or serialize in Python using `shapely`.
5. **Cache & Return**: Store the payload with a TTL proportional to data volatility. Configure Redis eviction policies to prevent memory thrashing under high load.
6. **Handle Invalidation**: Use spatial cache tags or time-based expiration to manage stale data when underlying geometries update.

For static or slowly changing spatial datasets, consider pre-rendering vector tiles and pushing them to edge networks. [Tile Generation & CDN Distribution](/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) complements Redis caching by shifting the heaviest rendering workloads away from your origin servers entirely.

## Deterministic Spatial Key Generation

Floating-point drift and inconsistent parameter ordering are the primary causes of cache fragmentation. A bounding box of `[-73.9851, 40.7484, -73.9751, 40.7584]` must not generate a different key than `[-73.98510001, 40.74840002, -73.97509999, 40.75840001]`. The following utility normalizes and hashes spatial envelopes deterministically:

```python
import hashlib
import json
from typing import Dict, Any

def normalize_bbox(bbox: tuple[float, float, float, float], precision: int = 5) -> tuple:
    """Round bounding box coordinates to fixed precision."""
    return tuple(round(coord, precision) for coord in bbox)

def generate_spatial_cache_key(
    bbox: tuple[float, float, float, float],
    layer_id: str,
    filters: Dict[str, Any] | None = None,
    precision: int = 5
) -> str:
    """
    Generate a SHA-256 cache key from normalized spatial parameters.
    Ensures deterministic output regardless of input ordering or float drift.
    """
    normalized = normalize_bbox(bbox, precision)
    
    # Sort filters to guarantee deterministic JSON serialization
    payload = {
        "bbox": normalized,
        "layer": layer_id,
        "filters": dict(sorted(filters.items())) if filters else {}
    }
    
    # Canonical JSON string -> SHA-256 hex digest
    canonical = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
```

This approach guarantees that semantically identical requests map to the exact same Redis key, eliminating cache fragmentation and maximizing hit rates.

## Async Cache Orchestration & Serialization

FastAPI's async event loop pairs naturally with `redis.asyncio`. To minimize latency, use `orjson` for serialization. It outperforms standard `json` by 2–4x and handles `bytes` natively, which is critical when storing compressed or binary geometry payloads.

```python
import orjson
from redis.asyncio import Redis
from fastapi import FastAPI, HTTPException
from typing import Optional

app = FastAPI()
redis_client = Redis.from_url("redis://localhost:6379/0", decode_responses=False)

async def fetch_from_cache(key: str) -> Optional[bytes]:
    return await redis_client.get(key)

async def store_in_cache(key: str, payload: dict, ttl: int = 300) -> None:
    await redis_client.setex(key, ttl, orjson.dumps(payload))

@app.get("/api/v1/spatial/search")
async def spatial_query(
    minx: float, miny: float, maxx: float, maxy: float,
    layer: str, precision: int = 5
):
    cache_key = generate_spatial_cache_key(
        bbox=(minx, miny, maxx, maxy),
        layer_id=layer,
        precision=precision
    )
    
    cached = await fetch_from_cache(cache_key)
    if cached:
        return orjson.loads(cached)
    
    # Fallback to PostGIS (pseudo-code for brevity)
    # result = await db.execute_spatial_query(minx, miny, maxx, maxy, layer)
    result = {"type": "FeatureCollection", "features": []}
    
    # Cache with TTL based on layer volatility
    ttl = 900 if layer == "static_boundaries" else 120
    await store_in_cache(cache_key, result, ttl)
    return result
```

When designing serialization pipelines, adhere strictly to the [GeoJSON Specification](https://geojson.org/) to ensure interoperability across mapping libraries like Leaflet, MapLibre, and OpenLayers. Deviating from RFC 7946 coordinate ordering or property structures will cause client-side rendering failures, regardless of cache performance.

## Invalidation & Memory Management

Spatial data rarely updates uniformly. Administrative boundaries change infrequently, while real-time transit feeds or IoT sensor geometries require near-instant invalidation. A one-size-fits-all TTL strategy leads to either stale data or excessive cache churn.

Implement tag-based invalidation by storing a mapping of spatial regions to cache keys. When a geometry updates, publish a Redis `PUBLISH` event or run a Lua script to delete all keys matching the affected bounding box prefix. For detailed implementation patterns, see [Configuring Redis cache tags for bounding box queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/configuring-redis-cache-tags-for-bounding-box-queries/).

Memory management requires proactive tuning:
- Set `maxmemory` to 70–80% of available RAM
- Use `volatile-ttl` if your cache keys have explicit expiration times
- Monitor `evicted_keys` and `keyspace_misses` via Redis `INFO` metrics
- Compress large geometry payloads with `lz4` or `zstd` before caching to reduce memory footprint

## Production Hardening & Observability

Caching introduces new failure modes. Redis outages, network partitions, or serialization errors can cascade into API downtime. Implement circuit breakers and fallback routing to ensure graceful degradation.

```python
from contextlib import asynccontextmanager
import logging

logger = logging.getLogger(__name__)

@asynccontextmanager
async def cache_with_fallback(key: str, ttl: int):
    try:
        cached = await redis_client.get(key)
        if cached:
            yield orjson.loads(cached)
            return
    except Exception as e:
        logger.warning(f"Redis cache read failed: {e}")
    
    yield None  # Signal fallback to database
```

Pair this with structured logging and distributed tracing. Export Redis latency percentiles (`p50`, `p95`, `p99`) and cache hit ratios to your observability stack. When hit rates drop below 60%, investigate key fragmentation, TTL misalignment, or query parameter drift.

To protect your API from abusive spatial scraping or runaway polygon queries, layer rate limiting at the gateway level. Implementing sliding window rate limits with FastAPI demonstrates how to use Redis sorted sets to enforce per-IP and per-user request quotas without blocking legitimate map interactions.

Finally, validate your Redis configuration against official [Redis Eviction Policies](https://redis.io/docs/latest/develop/reference/eviction/) documentation. Misconfigured eviction strategies can silently drop high-value spatial keys, forcing expensive PostGIS recomputation during peak traffic.

## Conclusion

**Redis Caching for Spatial Queries** transforms unpredictable, compute-heavy geospatial APIs into deterministic, low-latency services. By normalizing inputs, generating deterministic keys, and orchestrating async cache-aside flows, you can offload PostGIS, reduce connection saturation, and scale map APIs to handle millions of requests. Combine this with proper invalidation strategies, memory safeguards, and observability to build a resilient spatial data layer that performs consistently under production load.