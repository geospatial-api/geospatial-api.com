---
layout: layouts/page.njk
title: "Spatial Pagination & Cursor Strategies"
description: "Replace OFFSET/LIMIT with cursor-based spatial pagination in FastAPI and PostGIS. Use deterministic keyset traversal tokens for constant-time page fetches at scale."
---

# Spatial Pagination & Cursor Strategies

Geospatial APIs routinely serve millions of features across dynamic bounding boxes, proximity searches, and spatial joins. Traditional `OFFSET`/`LIMIT` pagination collapses under these workloads due to index fragmentation, inconsistent row ordering, and expensive sequential scans. **Spatial Pagination & Cursor Strategies** solve this by replacing arbitrary page numbers with deterministic, index-aware traversal tokens. This guide details a production-ready implementation using FastAPI and PostGIS, focusing on cursor generation, spatial index alignment, and stateless API design.

## Prerequisites & Stack Alignment

Before implementing spatial cursors, ensure your infrastructure meets these baseline requirements:
- **FastAPI 0.100+** with `uvicorn` and `pydantic` v2
- **SQLAlchemy 2.0+** (async driver recommended: `asyncpg` or `psycopg`)
- **PostGIS 3.2+** with GiST indexing enabled on geometry columns
- Python 3.10+ with `orjson` or `msgspec` for high-throughput serialization
- Foundational understanding of [Core Geospatial API Architecture with FastAPI & PostGIS](/core-geospatial-api-architecture-with-fastapi-postgis/)

Your spatial table must have a properly tuned GiST index on the geometry column. Without it, cursor traversal will degrade to sequential scans regardless of pagination strategy. Verify index health using `pg_stat_user_indexes` and ensure `work_mem` is sized appropriately for spatial sort operations.

## Why Offset/Limit Fails in Geospatial Contexts

Offset-based pagination assumes a stable, linear ordering. Spatial queries violate this assumption in three critical ways:

1. **Non-Deterministic Ordering:** Functions like `ST_Distance()` or the `<->` KNN operator return floating-point distances. Ties in distance values cause row shuffling across requests, leading to duplicate results or missing features.
2. **Index Bypass:** `OFFSET n` forces the database to compute, sort, and discard `n` rows before returning the next `LIMIT` batch. As documented in the [PostgreSQL LIMIT/OFFSET guidelines](https://www.postgresql.org/docs/current/queries-limit.html), GiST indexes cannot skip scanned tuples efficiently, causing `O(n)` degradation as page depth increases.
3. **Dynamic Spatial Filters:** When users pan, zoom, or adjust proximity radii, the underlying result set shifts. Page numbers become meaningless, and clients must refetch from `OFFSET 0`, multiplying database load.

Cursor pagination resolves these issues by encoding the exact position of the last returned record into a stateless token. The next request uses that token to resume scanning directly from the index boundary, guaranteeing `O(log n)` traversal and consistent ordering.

## Core Principles of Spatial Cursor Design

A robust spatial cursor system relies on three architectural pillars:

- **Composite Determinism:** Distance or coordinate values alone are insufficient due to floating-point precision limits and equidistant geometries. Cursors must combine spatial metrics with a stable, unique identifier (e.g., UUID or auto-incrementing integer).
- **Stateless Opacity:** Clients should never parse cursor contents. Tokens must be URL-safe, tamper-resistant, and self-contained to prevent injection or state leakage.
- **Index Boundary Alignment:** The cursor must map directly to the sort keys used in the `ORDER BY` clause. Misalignment forces the query planner to fall back to temporary tables or disk-based sorts.

## Implementation Workflow

### Step 1: Schema Configuration & Index Alignment

Proper table design precedes cursor logic. Define a composite index that matches your primary access patterns. For proximity searches, pair the geometry column with a stable primary key:

```sql
CREATE INDEX idx_locations_geom_knn ON locations USING GIST (geom);
-- Composite index for deterministic KNN traversal
CREATE INDEX idx_locations_distance_id ON locations USING btree (id);
```

Align your schema with established [Spatial Resource Modeling Patterns](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) to ensure geometry columns use `GEOMETRY(Point, 4326)` or appropriate SRIDs. Avoid storing pre-calculated distances; compute them at query time to maintain index selectivity.

### Step 2: Secure Cursor Encoding & Decoding

Cursors should be opaque, URL-safe, and versioned. Encode the composite key as JSON, apply optional compression for large payloads, and use Base64URL encoding.

```python
import base64
import json
import zlib
from typing import Tuple, Any

def encode_cursor(*keys: Any, version: int = 1) -> str:
    """Encode composite sort keys into a URL-safe, versioned cursor."""
    payload = json.dumps({"v": version, "k": keys}).encode("utf-8")
    compressed = zlib.compress(payload, level=1)
    return base64.urlsafe_b64encode(compressed).decode("utf-8").rstrip("=")

def decode_cursor(cursor: str) -> Tuple[int, Tuple[Any, ...]]:
    """Decode and validate a cursor token."""
    padded = cursor + "=" * (4 - len(cursor) % 4)
    compressed = base64.urlsafe_b64decode(padded)
    payload = json.loads(zlib.decompress(compressed))
    if payload["v"] != 1:
        raise ValueError("Unsupported cursor version")
    return payload["v"], tuple(payload["k"])
```

### Step 3: Query Construction with SQLAlchemy & PostGIS

Build async queries that leverage PostGIS KNN operators and enforce strict `WHERE` boundaries using the decoded cursor. The `<->` operator enables index-assisted nearest-neighbor searches without full table scans.

```python
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

async def fetch_spatial_page(
    session: AsyncSession,
    lat: float,
    lon: float,
    limit: int = 50,
    cursor: str | None = None,
) -> dict:
    # Reference point geometry
    ref_point = func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326)
    
    # Base ordering: KNN distance, then stable ID
    order_by = [func.ST_Distance(ref_point, Location.geom), Location.id]
    
    stmt = select(Location).order_by(*order_by).limit(limit)
    
    if cursor:
        _, (last_dist, last_id) = decode_cursor(cursor)
        # Correct keyset boundary: rows where distance is greater, OR same distance
        # but with a higher id (tiebreaker) — must use OR not AND.
        stmt = stmt.where(
            or_(
                func.ST_Distance(ref_point, Location.geom) > last_dist,
                and_(
                    func.ST_Distance(ref_point, Location.geom) == last_dist,
                    Location.id > last_id
                )
            )
        )
    
    result = await session.execute(stmt)
    rows = result.scalars().all()
    
    # Generate next cursor from last row
    next_cursor = None
    if rows:
        last_row = rows[-1]
        dist = await session.scalar(select(func.ST_Distance(ref_point, last_row.geom)))
        next_cursor = encode_cursor(dist, last_row.id)
        
    return {"items": rows, "next_cursor": next_cursor}
```

For bounding box scans, replace `ST_Distance` with `ST_XMin(geom)`, `ST_YMin(geom)`, or `ST_Envelope` intersections. Refer to the [PostGIS KNN operator documentation](https://postgis.net/docs/geometry_distance_knn.html) for index-assisted distance optimizations and `<->` vs `<#>` operator differences.

### Step 4: Response Serialization & Next-Cursor Injection

Serialize responses consistently and attach the `next_cursor` to enable client-side pagination. When dealing with large feature collections, payload size becomes a bottleneck. Evaluate your use case against [GeoJSON vs GeoParquet Serialization](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) to determine whether text-based GeoJSON or binary columnar formats better suit your throughput requirements.

```python
from pydantic import BaseModel, Field
from typing import Optional, List

class SpatialFeature(BaseModel):
    id: int
    geom: dict  # GeoJSON dict or WKT string
    properties: dict

class PaginatedResponse(BaseModel):
    items: List[SpatialFeature]
    next_cursor: Optional[str] = Field(None, description="Opaque token for next page")
    has_more: bool

# FastAPI route integration
@app.get("/api/v1/locations/nearby", response_model=PaginatedResponse)
async def get_nearby(
    lat: float, lon: float, limit: int = 50, cursor: Optional[str] = None
):
    async with async_session() as session:
        data = await fetch_spatial_page(session, lat, lon, limit, cursor)
        return PaginatedResponse(
            items=[serialize_feature(f) for f in data["items"]],
            next_cursor=data["next_cursor"],
            has_more=data["next_cursor"] is not None
        )
```

## Production Considerations & Edge Cases

### Floating-Point Precision & Equidistant Features
PostGIS computes distances in degrees or meters depending on SRID. Use `ST_Transform` to project geometries to a metric CRS (e.g., EPSG:3857 or EPSG:4326 with `geography` type) before distance calculations. Always include a primary key in the `ORDER BY` clause as a tiebreaker to guarantee deterministic traversal.

### Dynamic Filter Changes & Cursor Invalidation
Cursors assume static query parameters. If a client modifies the bounding box, search radius, or spatial filter, the cursor becomes invalid. Enforce strict parameter validation and return `400 Bad Request` with a clear error message when mismatched filters accompany a cursor. Consider implementing a short-lived cache (Redis/Memcached) keyed by normalized filter hashes to reuse cursor states for identical queries.

### Index Fragmentation & Vacuuming
GiST indexes degrade under heavy write loads. Schedule regular `VACUUM (ANALYZE)` operations and monitor `pg_stat_user_indexes` for index bloat. If cursor traversal latency increases unexpectedly, run `REINDEX INDEX CONCURRENTLY` to rebuild spatial indexes without locking writes.

### Rate Limiting & Cursor Abuse
Stateless cursors can be replayed indefinitely. Implement rate limiting on cursor endpoints and consider adding a timestamp or nonce to the encoded payload if you need to enforce expiration windows. Never trust client-provided cursors; always decode, validate, and re-apply boundaries server-side.

## Next Steps & Advanced Patterns

Spatial cursors form the backbone of scalable geospatial APIs, but they require careful integration with broader architectural patterns. For teams building multi-tenant GIS platforms, consider combining cursor pagination with row-level security (RLS) and spatial partitioning to isolate tenant data while maintaining query performance.

To dive deeper into query optimization, async connection pooling, and advanced PostGIS indexing strategies, review the complete implementation guide at [Implementing cursor-based pagination for spatial queries](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/). Pair this with robust monitoring, query plan analysis, and load testing to ensure your spatial endpoints scale predictably under production traffic.