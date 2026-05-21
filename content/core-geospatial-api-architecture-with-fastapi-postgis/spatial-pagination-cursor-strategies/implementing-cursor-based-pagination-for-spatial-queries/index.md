---
layout: layouts/page.njk
title: "Implementing Cursor-Based Pagination for Spatial Queries"
description: "Implement cursor pagination for PostGIS in FastAPI with keyset cursors, GiST spatial filters, and stable ORDER BY for constant-time deep pagination at scale."
---

# Implementing Cursor-Based Pagination for Spatial Queries

Implementing cursor-based pagination for spatial queries requires replacing `OFFSET/LIMIT` with deterministic keyset filtering. Instead of skipping rows, the API decodes a cursor representing the last row’s primary key (or composite spatial sort key), applies a `WHERE` clause using `>` or `>=`, and enforces a stable `ORDER BY` backed by a GiST or composite B-tree index. In FastAPI and PostGIS, this means filtering spatially first (`geom && bbox` or `ST_DWithin`), then paginating by a deterministic column like `id`, encoding the cursor in Base64, and returning the next cursor alongside the result set. This approach eliminates O(N) row scans, guarantees consistent ordering across concurrent writes, and aligns with [Core Geospatial API Architecture with FastAPI & PostGIS](/core-geospatial-api-architecture-with-fastapi-postgis/) best practices for scalable location-based services.

## Why Offset Pagination Fails for Spatial Workloads

Spatial queries rarely return rows in insertion order. When you combine bounding box filters, nearest-neighbor searches, or spatial joins with `OFFSET`, PostgreSQL must materialize the entire filtered set, sort it, discard the first N rows, and return the remainder. As page depth increases, query latency grows linearly. Worse, if underlying geometries shift or records are inserted/deleted between requests, `OFFSET` produces duplicate or skipped records.

Cursor pagination solves this by anchoring each request to a known row position, reducing page fetches to index range scans. PostgreSQL’s query planner can leverage B-tree or GiST indexes to jump directly to the cursor position, making subsequent pages execute in near-constant time regardless of dataset size. For architectural trade-offs across different spatial access patterns, review [Spatial Pagination & Cursor Strategies](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/).

## Schema & Index Prerequisites

Your PostGIS table must expose a deterministic ordering column. Primary keys work best. Pair them with a spatial index for filtering and a composite index for cursor traversal:

```sql
CREATE TABLE locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    geom GEOMETRY(Point, 4326) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial filter index (GiST handles bounding box & spatial operators)
CREATE INDEX idx_locations_geom ON locations USING GIST (geom);

-- Cursor traversal index (B-tree enables fast keyset lookups)
CREATE INDEX idx_locations_id ON locations (id);
```

The GiST index accelerates the `&&` bounding box operator, which acts as a fast pre-filter before exact spatial calculations. The B-tree index on `id` ensures the `WHERE id > :cursor_id` clause executes as an index range scan rather than a sequential scan. If your workload requires sorting by distance (`ORDER BY geom <-> point`), you must append a deterministic tiebreaker (e.g., `id`) to avoid pagination gaps when multiple points share identical distances.

## FastAPI Implementation

Below is a production-ready FastAPI endpoint using SQLAlchemy 2.0 async, Pydantic v2, and Base64 cursor encoding. The spatial filter uses the `&&` bounding box operator, while pagination relies on `id > cursor_id`.

```python
import base64
import json
from typing import Optional, List
from fastapi import FastAPI, Query, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

app = FastAPI()

class LocationResponse(BaseModel):
    id: str
    name: str
    geom: str  # WKT for API transport
    created_at: str

class PaginatedResponse(BaseModel):
    items: List[LocationResponse]
    next_cursor: Optional[str] = None

def encode_cursor(cursor_id: str) -> str:
    payload = json.dumps({"id": cursor_id}).encode()
    return base64.urlsafe_b64encode(payload).decode()

def decode_cursor(cursor: str) -> dict:
    try:
        payload = base64.urlsafe_b64decode(cursor.encode()).decode()
        return json.loads(payload)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid or corrupted cursor")

async def get_db():
    # Replace with your actual async session dependency
    raise NotImplementedError("Inject AsyncSession here")

@app.get("/locations", response_model=PaginatedResponse)
async def get_locations(
    bbox: str = Query(..., description="Comma-separated: minx,miny,maxx,maxy"),
    cursor: Optional[str] = Query(None, description="Base64 encoded cursor from previous page"),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db)
):
    try:
        minx, miny, maxx, maxy = map(float, bbox.split(","))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid bbox format. Use minx,miny,maxx,maxy")

    if cursor:
        decoded = decode_cursor(cursor)
        sql = text("""
            SELECT id, name, ST_AsText(geom) as geom, created_at
            FROM locations
            WHERE geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)
              AND id > :cursor_id
            ORDER BY id ASC
            LIMIT :limit
        """)
        params = {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy,
                  "cursor_id": decoded["id"], "limit": limit}
    else:
        sql = text("""
            SELECT id, name, ST_AsText(geom) as geom, created_at
            FROM locations
            WHERE geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)
            ORDER BY id ASC
            LIMIT :limit
        """)
        params = {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy, "limit": limit}

    result = await db.execute(sql, params)
    rows = result.mappings().all()

    items = [LocationResponse(**row) for row in rows]
    next_cursor = encode_cursor(items[-1].id) if len(items) == limit else None

    return PaginatedResponse(items=items, next_cursor=next_cursor)
```

## Handling Spatial Sort Stability & Edge Cases

When paginating spatial results, deterministic ordering is non-negotiable. If you sort purely by a spatial function like `ST_Distance`, floating-point precision or identical geometries can produce ties. PostgreSQL’s `ORDER BY` is stable only when the sort key is unique. Always append a primary key as a tiebreaker: `ORDER BY geom <-> :point, id ASC`. This guarantees that concurrent inserts or updates won’t shift rows between pages.

Cursor security matters in public APIs. Base64 encoding prevents accidental exposure of raw IDs in logs, but it is not encryption. For sensitive location data, consider signing cursors with HMAC or using opaque UUIDs mapped to internal offsets. Additionally, validate cursor payloads strictly. A malformed or tampered cursor should return `400 Bad Request` rather than triggering a full table scan.

## Performance Tuning & Validation

Cursor pagination shines when paired with proper index coverage. Run `EXPLAIN (ANALYZE, BUFFERS)` on your paginated query. You should see:
1. `Index Scan using idx_locations_geom` for the spatial filter
2. `Filter: id > '...'` applied efficiently
3. `Rows Removed by Filter` staying low relative to total returned rows

If the planner falls back to a sequential scan, your spatial filter may be too broad (e.g., querying the entire globe). Narrow the bounding box client-side or implement a quadtree/clustered indexing strategy. For high-throughput APIs, cache the cursor-to-offset mapping in Redis only if you must support arbitrary page jumps, though this defeats the memory efficiency of keyset pagination.

PostgreSQL’s documentation on [query limits and keyset pagination](https://www.postgresql.org/docs/current/queries-limit.html) explicitly recommends this pattern for large datasets. Similarly, PostGIS’s [geometry overlaps operator (`&&`)](https://postgis.net/docs/geometry_overlaps.html) is optimized for bounding box pre-filtering, making it the ideal first step before exact spatial calculations.

By anchoring pagination to deterministic keys, filtering spatially upfront, and enforcing stable sort orders, you eliminate the latency cliffs and data inconsistencies inherent to offset-based approaches. This architecture scales linearly with index size rather than row count, making it the standard for production-grade geospatial APIs.