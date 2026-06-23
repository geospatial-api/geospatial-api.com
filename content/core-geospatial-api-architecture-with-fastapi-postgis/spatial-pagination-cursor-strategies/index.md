---
layout: layouts/page.njk
title: "Spatial Pagination & Cursor Strategies"
description: "Replace OFFSET/LIMIT with cursor-based spatial pagination in FastAPI and PostGIS. Use deterministic keyset traversal tokens for constant-time page fetches at scale."
slug: "spatial-pagination-cursor-strategies"
type: "cluster"
breadcrumb: "Core Geospatial API Architecture → Spatial Pagination & Cursor Strategies"
datePublished: "2024-01-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Spatial Pagination & Cursor Strategies",
      "description": "Replace OFFSET/LIMIT with cursor-based spatial pagination in FastAPI and PostGIS. Use deterministic keyset traversal tokens for constant-time page fetches at scale.",
      "datePublished": "2024-01-15",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Core Geospatial API Architecture", "item": "https://geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 3, "name": "Spatial Pagination & Cursor Strategies", "item": "https://geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement Cursor-Based Spatial Pagination in FastAPI and PostGIS",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Configure schema and GiST index alignment" },
        { "@type": "HowToStep", "position": 2, "name": "Build secure cursor encoding and decoding" },
        { "@type": "HowToStep", "position": 3, "name": "Construct keyset queries with SQLAlchemy and PostGIS" },
        { "@type": "HowToStep", "position": 4, "name": "Serialize responses and inject the next-cursor token" },
        { "@type": "HowToStep", "position": 5, "name": "Verify correctness with EXPLAIN ANALYZE and curl" }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does OFFSET/LIMIT pagination fail on large spatial datasets?",
          "acceptedAnswer": { "@type": "Answer", "text": "OFFSET forces the database to scan and discard n rows before returning results. GiST indexes cannot skip scanned tuples, so cost grows linearly with page depth. Floating-point distance ties also cause row shuffling between requests, producing duplicate or missing features." }
        },
        {
          "@type": "Question",
          "name": "How do I handle cursor invalidation when query parameters change?",
          "acceptedAnswer": { "@type": "Answer", "text": "A cursor encodes a position relative to a specific sort key and filter set. When a client changes the bounding box, search radius, or ordering column, the encoded boundary no longer maps correctly. Return HTTP 400 with a structured error that instructs the client to discard the cursor and restart from the first page." }
        },
        {
          "@type": "Question",
          "name": "Should I use ST_Distance or the <-> operator for cursor-based KNN pagination?",
          "acceptedAnswer": { "@type": "Answer", "text": "Use ST_Distance in both the ORDER BY and the WHERE keyset boundary. The <-> operator is index-assisted for sorting but produces approximate distances unsuitable as exact boundary comparisons in a cursor WHERE clause. Compute the precise distance for the cursor value with ST_Distance at the point of cursor generation." }
        }
      ]
    }
  ]
}
</script>

← Back to [Core Geospatial API Architecture](/core-geospatial-api-architecture-with-fastapi-postgis/)

# Spatial Pagination & Cursor Strategies

Geospatial APIs routinely serve millions of features across dynamic bounding boxes, proximity searches, and spatial joins. Traditional `OFFSET`/`LIMIT` pagination collapses under these workloads due to index fragmentation, inconsistent row ordering, and expensive sequential scans. This guide details a production-ready implementation using FastAPI and PostGIS, focusing on cursor generation, spatial index alignment, and stateless API design that scales to tens of millions of rows without per-page latency growth.

---

## Decision Matrix: Offset vs Keyset vs Spatial Cursor

Before choosing a pagination strategy, map your access pattern against these three approaches:

| Strategy | Sort stability | Index usage | Cost at page N | Dynamic filter support | Recommended for |
|---|---|---|---|---|---|
| `OFFSET` / `LIMIT` | Unstable (float ties shuffle rows) | GiST bypassed for skip | O(N) scan | Restart required | Static small datasets only |
| Keyset (integer PK) | Stable | B-tree seek | O(log N) | Restart if filter changes | Non-spatial ordered lists |
| Spatial cursor (composite) | Stable with tiebreaker | GiST + B-tree | O(log N) | Restart if filter changes | Proximity and bbox traversal |

The spatial cursor combines a floating-point spatial metric (distance or coordinate) with a stable unique key. The composite pair is the only reliable way to guarantee deterministic page boundaries when `ST_Distance` returns identical values for multiple features.

---

## Architecture: How Spatial Cursor Traversal Works

The diagram below shows the full request lifecycle. A client carries an opaque cursor token between pages; the server decodes it to a `(distance, id)` boundary, issues a keyset `WHERE` clause, and emits a new cursor from the last row of each response.

<svg viewBox="0 0 780 420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Spatial cursor pagination request lifecycle diagram" style="max-width:100%;height:auto;display:block;margin:1.5rem 0;">
  <title>Spatial Cursor Pagination — Request Lifecycle</title>
  <desc>Sequence diagram showing client sending request with cursor token, server decoding it to a spatial boundary, PostGIS executing a keyset WHERE clause via GiST index, server encoding next cursor from last row, and returning paginated GeoJSON to the client.</desc>
  <defs>
    <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="currentColor" opacity="0.7"/>
    </marker>
  </defs>
  <!-- Lane backgrounds -->
  <rect x="10" y="40" width="160" height="360" rx="6" fill="currentColor" opacity="0.05"/>
  <rect x="300" y="40" width="180" height="360" rx="6" fill="currentColor" opacity="0.05"/>
  <rect x="590" y="40" width="180" height="360" rx="6" fill="currentColor" opacity="0.05"/>
  <!-- Lane headers -->
  <rect x="10" y="10" width="160" height="32" rx="6" fill="currentColor" opacity="0.15"/>
  <text x="90" y="31" text-anchor="middle" font-size="13" font-family="system-ui,sans-serif" fill="currentColor" font-weight="600">Client</text>
  <rect x="300" y="10" width="180" height="32" rx="6" fill="currentColor" opacity="0.15"/>
  <text x="390" y="31" text-anchor="middle" font-size="13" font-family="system-ui,sans-serif" fill="currentColor" font-weight="600">FastAPI Handler</text>
  <rect x="590" y="10" width="180" height="32" rx="6" fill="currentColor" opacity="0.15"/>
  <text x="680" y="31" text-anchor="middle" font-size="13" font-family="system-ui,sans-serif" fill="currentColor" font-weight="600">PostGIS / GiST</text>
  <!-- Lifelines -->
  <line x1="90" y1="42" x2="90" y2="400" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.3"/>
  <line x1="390" y1="42" x2="390" y2="400" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.3"/>
  <line x1="680" y1="42" x2="680" y2="400" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.3"/>
  <!-- Step 1: client → handler -->
  <line x1="90" y1="90" x2="380" y2="90" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrowhead)" opacity="0.8"/>
  <text x="235" y="83" text-anchor="middle" font-size="11" font-family="system-ui,sans-serif" fill="currentColor" opacity="0.9">GET /locations?cursor=&lt;token&gt;</text>
  <!-- Step 2: decode -->
  <rect x="310" y="105" width="160" height="34" rx="4" fill="currentColor" opacity="0.1"/>
  <text x="390" y="120" text-anchor="middle" font-size="11" font-family="system-ui,sans-serif" fill="currentColor">decode_cursor(token)</text>
  <text x="390" y="133" text-anchor="middle" font-size="10" font-family="system-ui,sans-serif" fill="currentColor" opacity="0.7">→ (last_dist, last_id)</text>
  <!-- Step 3: handler → postgis -->
  <line x1="390" y1="155" x2="670" y2="155" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrowhead)" opacity="0.8"/>
  <text x="530" y="148" text-anchor="middle" font-size="11" font-family="system-ui,sans-serif" fill="currentColor" opacity="0.9">keyset WHERE clause</text>
  <!-- Step 4: postgis work -->
  <rect x="600" y="170" width="160" height="50" rx="4" fill="currentColor" opacity="0.1"/>
  <text x="680" y="186" text-anchor="middle" font-size="11" font-family="system-ui,sans-serif" fill="currentColor">GiST seek to boundary</text>
  <text x="680" y="200" text-anchor="middle" font-size="10" font-family="system-ui,sans-serif" fill="currentColor" opacity="0.7">ORDER BY dist, id LIMIT N</text>
  <text x="680" y="214" text-anchor="middle" font-size="10" font-family="system-ui,sans-serif" fill="currentColor" opacity="0.7">O(log n) scan</text>
  <!-- Step 5: postgis → handler result rows -->
  <line x1="600" y1="238" x2="400" y2="238" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrowhead)" opacity="0.8"/>
  <text x="500" y="231" text-anchor="middle" font-size="11" font-family="system-ui,sans-serif" fill="currentColor" opacity="0.9">N result rows</text>
  <!-- Step 6: encode next cursor -->
  <rect x="310" y="253" width="160" height="34" rx="4" fill="currentColor" opacity="0.1"/>
  <text x="390" y="268" text-anchor="middle" font-size="11" font-family="system-ui,sans-serif" fill="currentColor">encode_cursor(dist, id)</text>
  <text x="390" y="281" text-anchor="middle" font-size="10" font-family="system-ui,sans-serif" fill="currentColor" opacity="0.7">from last row</text>
  <!-- Step 7: handler → client response -->
  <line x1="390" y1="303" x2="100" y2="303" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrowhead)" opacity="0.8"/>
  <text x="245" y="296" text-anchor="middle" font-size="11" font-family="system-ui,sans-serif" fill="currentColor" opacity="0.9">{ items: […], next_cursor: "…" }</text>
  <!-- Step 8: client stores cursor -->
  <rect x="20" y="318" width="140" height="28" rx="4" fill="currentColor" opacity="0.1"/>
  <text x="90" y="336" text-anchor="middle" font-size="11" font-family="system-ui,sans-serif" fill="currentColor">store next_cursor</text>
  <!-- Step 9: loop arrow -->
  <path d="M90,355 Q40,360 40,375 Q40,390 90,390" stroke="currentColor" stroke-width="1.2" fill="none" stroke-dasharray="3 3" opacity="0.5" marker-end="url(#arrowhead)"/>
  <text x="20" y="375" font-size="10" font-family="system-ui,sans-serif" fill="currentColor" opacity="0.6">next page</text>
</svg>

---

## Prerequisites & Environment

Before implementing spatial cursors, confirm these baseline requirements:

- **FastAPI 0.100+** with `uvicorn` and Pydantic v2 models
- **SQLAlchemy 2.0+** using `asyncpg` or `psycopg` async drivers
- **PostGIS 3.2+** with GiST indexing enabled on geometry columns
- Python 3.10+ for union-type annotations (`str | None`)
- `orjson` or `msgspec` for high-throughput GeoJSON serialization

Your spatial table must carry a properly tuned GiST index on the geometry column. Verify index health with `pg_stat_user_indexes` and ensure `work_mem` is sized for spatial sort operations (128 MB or more on large datasets). For geometry column design and SRID conventions, follow the [Spatial Resource Modeling Patterns](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) baseline.

---

## Why Offset/Limit Fails in Geospatial Contexts

Offset-based pagination assumes a stable, linear ordering. Spatial queries violate this in three ways:

1. **Non-deterministic ordering.** Functions like `ST_Distance` return floating-point distances. Ties in distance values cause row shuffling between requests, producing duplicate results or silently missing features at page boundaries.
2. **Index bypass.** `OFFSET n` forces the planner to scan and discard `n` rows before returning the next batch. GiST indexes cannot skip scanned tuples, so cost grows linearly with page depth.
3. **Dynamic spatial filters.** When users pan, zoom, or adjust proximity radii, the underlying result set shifts. Page numbers become meaningless and the client must restart from zero, multiplying database load.

Cursor pagination resolves these issues by encoding the exact boundary position of the last returned record into a stateless token. The next request uses that token to resume scanning directly from the index boundary, guaranteeing O(log n) traversal and consistent ordering regardless of dataset size.

---

## Core Principles of Spatial Cursor Design

A robust spatial cursor system depends on three design rules:

- **Composite determinism.** Distance values alone are insufficient. Cursors must combine the spatial metric with a stable unique identifier (UUID or auto-incrementing integer) to break ties among equidistant geometries.
- **Stateless opacity.** Clients must never parse cursor contents. Tokens must be URL-safe, versioned, and tamper-resistant to prevent injection or state leakage.
- **Index boundary alignment.** The cursor must map directly to the `ORDER BY` sort keys. Misalignment forces the query planner to use temporary tables or disk-based sorts instead of GiST seeks.

---

## Step-by-Step Implementation

### Step 1: Schema Configuration & Index Alignment

Define a composite index that matches your primary access pattern. For proximity searches, pair the geometry GiST index with a B-tree index on the primary key:

```sql
-- GiST index for spatial operations and KNN ordering
CREATE INDEX idx_locations_geom ON locations USING GIST (geom);

-- B-tree index for deterministic keyset tiebreaking
CREATE INDEX idx_locations_id ON locations USING btree (id);
```

Use `GEOMETRY(Point, 4326)` or the `geography` type on your `geom` column. The `geography` type computes accurate spherical distances in metres without an explicit `ST_Transform`, which simplifies cursor value comparison. Avoid storing pre-calculated distances as a column; compute them at query time to maintain index selectivity.

For a complete schema design reference including multi-geometry tables and SRID conventions, see [Spatial Resource Modeling Patterns](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/).

### Step 2: Secure Cursor Encoding & Decoding

Cursors should be opaque, URL-safe, and versioned. Encode the composite key as JSON, compress lightly for large payloads, then Base64URL-encode the result:

```python
import base64
import json
import zlib
from typing import Any, Tuple


def encode_cursor(*keys: Any, version: int = 1) -> str:
    """Encode composite sort keys into a URL-safe, versioned cursor token."""
    payload = json.dumps({"v": version, "k": list(keys)}).encode("utf-8")
    compressed = zlib.compress(payload, level=1)
    # Strip trailing '=' padding; restore it on decode
    return base64.urlsafe_b64encode(compressed).decode("utf-8").rstrip("=")


def decode_cursor(cursor: str) -> Tuple[int, Tuple[Any, ...]]:
    """Decode and validate a cursor token; raises ValueError on tampered input."""
    # Restore stripped padding
    padded = cursor + "=" * (4 - len(cursor) % 4)
    try:
        compressed = base64.urlsafe_b64decode(padded)
        payload = json.loads(zlib.decompress(compressed))
    except Exception as exc:
        raise ValueError(f"Invalid cursor: {exc}") from exc
    if payload.get("v") != 1:
        raise ValueError(f"Unsupported cursor version: {payload.get('v')}")
    return payload["v"], tuple(payload["k"])
```

In FastAPI, wrap `decode_cursor` in a dependency that raises `HTTPException(status_code=400)` on `ValueError`. Never let raw cursor errors surface to clients.

### Step 3: Query Construction with SQLAlchemy & PostGIS

Build async queries that use `ST_Distance` for deterministic ordering and keyset `WHERE` boundaries. The boundary condition requires an `OR` clause — not `AND` — to correctly advance past tied distances:

```python
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Location
from .cursors import decode_cursor, encode_cursor


async def fetch_proximity_page(
    session: AsyncSession,
    lat: float,
    lon: float,
    limit: int = 50,
    cursor: str | None = None,
) -> dict:
    """Return one page of locations ordered by proximity, with a next-cursor."""
    ref = func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326)
    distance_expr = func.ST_Distance(
        func.ST_Transform(ref, 3857),
        func.ST_Transform(Location.geom, 3857),
    )

    stmt = (
        select(Location, distance_expr.label("dist"))
        .order_by(distance_expr, Location.id)
        .limit(limit)
    )

    if cursor:
        _, (last_dist, last_id) = decode_cursor(cursor)
        # Rows where distance is strictly greater, OR same distance and higher id
        stmt = stmt.where(
            or_(
                distance_expr > last_dist,
                and_(distance_expr == last_dist, Location.id > last_id),
            )
        )

    result = await session.execute(stmt)
    rows = result.all()  # list of (Location, dist) tuples

    next_cursor = None
    if rows:
        last_loc, last_dist_val = rows[-1]
        next_cursor = encode_cursor(float(last_dist_val), last_loc.id)

    return {"items": [r[0] for r in rows], "next_cursor": next_cursor}
```

The `ST_Transform` to EPSG:3857 converts distances to metres for consistent cursor comparison regardless of input geometry units. For bounding box scans that use [bounding box spatial index queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) instead of proximity, replace `ST_Distance` ordering with a stable primary key sort — the cursor then encodes only the `id` value.

For deep optimisation of the KNN operator and `<->` vs `<#>` trade-offs, see [Optimizing KNN Queries with the PostGIS Operator](/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/optimizing-knn-queries-with-postgis-operator/).

### Step 4: Response Serialization & Next-Cursor Injection

Define strict Pydantic models and wire them into the FastAPI route. Attach `next_cursor` so clients can request the following page without any server state:

```python
from typing import Optional
from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException, Query

router = APIRouter()


class LocationFeature(BaseModel):
    id: int
    name: str
    geom_geojson: dict  # serialized with ST_AsGeoJSON at query time

    model_config = {"from_attributes": True}


class ProximityPage(BaseModel):
    items: list[LocationFeature]
    next_cursor: Optional[str] = Field(None, description="Opaque token for next page")
    has_more: bool


@router.get("/locations/nearby", response_model=ProximityPage)
async def get_nearby_locations(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    limit: int = Query(50, ge=1, le=200),
    cursor: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_session),
) -> ProximityPage:
    try:
        data = await fetch_proximity_page(session, lat, lon, limit, cursor)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return ProximityPage(
        items=[LocationFeature.model_validate(loc) for loc in data["items"]],
        next_cursor=data["next_cursor"],
        has_more=data["next_cursor"] is not None,
    )
```

When response payload size is a concern — especially for large feature collections — evaluate whether binary formats reduce wire cost. The [GeoJSON vs GeoParquet Serialization](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision matrix covers the trade-offs between text-based GeoJSON and columnar formats for cursor-paginated endpoints.

For [API versioning](/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) on cursor endpoints, encode the cursor version (`"v": 1`) so you can introduce new sort keys in a future API version without breaking existing client tokens.

---

## Production Code Example

The following is a self-contained, copy-runnable FastAPI application demonstrating the full spatial cursor pattern with a geometry table and async session:

```python
"""
Full spatial cursor pagination example.
Requires: fastapi, uvicorn, sqlalchemy[asyncio], asyncpg, geoalchemy2
PostGIS table: CREATE TABLE locations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    geom GEOMETRY(Point, 4326) NOT NULL
);
CREATE INDEX idx_locations_geom ON locations USING GIST (geom);
"""
import base64
import json
import zlib
from contextlib import asynccontextmanager
from typing import Any, Optional, Tuple

from fastapi import FastAPI, HTTPException, Query
from geoalchemy2 import Geometry
from pydantic import BaseModel
from sqlalchemy import Column, Integer, String, Text, func, and_, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase


DATABASE_URL = "postgresql+asyncpg://user:password@localhost/gisdb"
engine = create_async_engine(DATABASE_URL, pool_size=10, max_overflow=5)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Location(Base):
    __tablename__ = "locations"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    geom = Column(Geometry("POINT", srid=4326), nullable=False)


# --- Cursor helpers ---

def encode_cursor(*keys: Any, version: int = 1) -> str:
    payload = json.dumps({"v": version, "k": list(keys)}).encode()
    return base64.urlsafe_b64encode(zlib.compress(payload, 1)).decode().rstrip("=")


def decode_cursor(token: str) -> Tuple[int, tuple]:
    padded = token + "=" * (4 - len(token) % 4)
    try:
        payload = json.loads(zlib.decompress(base64.urlsafe_b64decode(padded)))
    except Exception as exc:
        raise ValueError(f"Malformed cursor: {exc}") from exc
    if payload.get("v") != 1:
        raise ValueError("Unsupported cursor version")
    return payload["v"], tuple(payload["k"])


# --- Pydantic schemas ---

class NearbyItem(BaseModel):
    id: int
    name: str
    distance_m: float


class NearbyPage(BaseModel):
    items: list[NearbyItem]
    next_cursor: Optional[str]
    has_more: bool


# --- Application ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield

app = FastAPI(lifespan=lifespan)


@app.get("/api/v1/locations/nearby", response_model=NearbyPage)
async def nearby(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    limit: int = Query(50, ge=1, le=200),
    cursor: Optional[str] = Query(None),
):
    ref = func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326)
    dist_m = func.ST_Distance(
        func.ST_Transform(ref, 3857),
        func.ST_Transform(Location.geom, 3857),
    ).label("distance_m")

    stmt = select(Location, dist_m).order_by(dist_m, Location.id).limit(limit)

    if cursor:
        try:
            _, (last_dist, last_id) = decode_cursor(cursor)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        dist_expr = func.ST_Distance(
            func.ST_Transform(ref, 3857),
            func.ST_Transform(Location.geom, 3857),
        )
        stmt = stmt.where(
            or_(
                dist_expr > last_dist,
                and_(dist_expr == last_dist, Location.id > last_id),
            )
        )

    async with SessionLocal() as session:
        rows = (await session.execute(stmt)).all()

    items = [
        NearbyItem(id=loc.id, name=loc.name, distance_m=round(dist, 2))
        for loc, dist in rows
    ]
    next_cursor = (
        encode_cursor(float(rows[-1][1]), rows[-1][0].id) if rows else None
    )
    return NearbyPage(items=items, next_cursor=next_cursor, has_more=next_cursor is not None)
```

---

## Verification & Testing

### curl Walkthrough

Fetch the first page, then use `next_cursor` to retrieve the second:

```bash
# First page (no cursor)
curl -s "http://localhost:8000/api/v1/locations/nearby?lat=51.5074&lon=-0.1278&limit=5" | jq .

# Second page using returned next_cursor token
CURSOR=$(curl -s "http://localhost:8000/api/v1/locations/nearby?lat=51.5074&lon=-0.1278&limit=5" \
  | jq -r '.next_cursor')
curl -s "http://localhost:8000/api/v1/locations/nearby?lat=51.5074&lon=-0.1278&limit=5&cursor=${CURSOR}" | jq .
```

Confirm that no `id` appears in both responses, and that the minimum `distance_m` on the second page is greater than or equal to the maximum on the first.

### EXPLAIN ANALYZE

Verify the query planner uses the GiST index rather than a sequential scan:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, name,
       ST_Distance(
           ST_Transform(ST_SetSRID(ST_MakePoint(-0.1278, 51.5074), 4326), 3857),
           ST_Transform(geom, 3857)
       ) AS distance_m
FROM locations
WHERE ST_Distance(
          ST_Transform(ST_SetSRID(ST_MakePoint(-0.1278, 51.5074), 4326), 3857),
          ST_Transform(geom, 3857)
      ) > 1234.56
   OR (
      ST_Distance(
          ST_Transform(ST_SetSRID(ST_MakePoint(-0.1278, 51.5074), 4326), 3857),
          ST_Transform(geom, 3857)
      ) = 1234.56 AND id > 999
   )
ORDER BY distance_m, id
LIMIT 50;
```

Expected output should include `Index Scan using idx_locations_geom` and `Buffers: shared hit=…` with a low heap-fetch count. If you see `Seq Scan` instead, confirm `work_mem` is at least 64 MB and that the GiST index exists on the transformed geometry. For a detailed walkthrough of query plan analysis, see [Reading EXPLAIN ANALYZE for Spatial Query Optimization](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/).

### Unit Test Skeleton

```python
import pytest
from .cursors import decode_cursor, encode_cursor


def test_cursor_round_trip():
    token = encode_cursor(1234.567, 42)
    version, keys = decode_cursor(token)
    assert version == 1
    assert keys == (1234.567, 42)


def test_cursor_rejects_tampered_token():
    with pytest.raises(ValueError, match="Malformed cursor"):
        decode_cursor("not-a-real-cursor")


def test_cursor_rejects_wrong_version():
    import base64, json, zlib
    payload = json.dumps({"v": 99, "k": [1.0, 1]}).encode()
    token = base64.urlsafe_b64encode(zlib.compress(payload, 1)).decode().rstrip("=")
    with pytest.raises(ValueError, match="Unsupported cursor version"):
        decode_cursor(token)
```

---

## Failure Modes & Edge Cases

1. **Float precision drift in cursor comparison.** `ST_Distance` in EPSG:3857 returns double-precision floats. Serialising to JSON loses sub-nanometre precision. In practice this is safe; the composite `(dist, id)` tiebreaker guarantees forward progress even if two rows compare equal on distance. Do not use `NUMERIC` cast on the cursor value — it makes equality comparisons unreliable across parameter changes.

2. **Cursor used with changed query parameters.** A cursor is valid only for the same `lat`, `lon`, and `limit` combination. If a client sends a mismatched filter, the keyset boundary is meaningless. Return `HTTP 400` with: `{"detail": "Cursor is invalid for the current query parameters. Restart from the first page."}`.

3. **Empty last page and `has_more` false positive.** If the last page returns exactly `limit` rows, `next_cursor` will be non-null but the following request will return zero rows. Clients must handle an empty `items` array gracefully, even when `has_more` is `true`. Some teams reduce `limit` by 1 and use the extra slot as a lookahead.

4. **GiST index bloat after heavy writes.** GiST indexes degrade under high-write workloads. Monitor `pg_stat_user_indexes` for bloat; schedule `VACUUM (ANALYZE)` nightly and run `REINDEX INDEX CONCURRENTLY idx_locations_geom` during maintenance windows if traversal latency spikes unexpectedly.

5. **Cursor replay and abuse.** Stateless cursors can be replayed indefinitely. If your threat model requires expiration, embed a Unix timestamp in the payload and reject tokens older than a configurable TTL. Apply rate limiting on cursor endpoints independently from first-page requests — cursor-driven scraping is faster than offset scraping.

6. **Null geometry rows breaking sort order.** Rows with `NULL` in the geometry column cause `ST_Distance` to return `NULL`, which sorts last in PostgreSQL. Add a `WHERE geom IS NOT NULL` constraint to the query and enforce `NOT NULL` at the schema level.

---

## Performance Notes

| Configuration | Observed p95 latency | Notes |
|---|---|---|
| 1 M rows, GiST index, `work_mem` 128 MB | ~4 ms per page | Index-only seeks; cursor avoids full sort |
| 1 M rows, no GiST index | ~850 ms per page | Sequential scan; unacceptable at scale |
| 10 M rows, GiST + B-tree composite | ~12 ms per page | Slight increase from larger index depth |
| `OFFSET 500000`, GiST index | ~1 200 ms | O(N) regardless of index presence |

Key levers:

- **`work_mem`**: raise from the PostgreSQL default (4 MB) to at least 64–128 MB for sessions running spatial sort operations. Set it per-connection via `SET LOCAL work_mem = '128MB'` in a SQLAlchemy `@event.listens_for(engine, "connect")` hook to avoid global impact.
- **Async sessions**: each FastAPI request should borrow a pooled connection from `asyncpg`. Avoid synchronous `session.execute()` calls in async routes — they block the event loop.
- **Connection pool sizing**: use `pgBouncer` in transaction mode for high-concurrency deployments. See [Connection Pooling & pgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) for spatial-workload pool configuration.
- **Avoid `SELECT *`**: always project only the columns you need. Fetching the geometry column as WKB and converting client-side is 30–60% slower than using `ST_AsGeoJSON` at the SQL layer.

---

## Frequently Asked Questions

<details class="faq-item">
<summary>Why does OFFSET/LIMIT pagination fail on large spatial datasets?</summary>

`OFFSET` forces the database to scan and discard N rows before returning results. GiST indexes cannot skip scanned tuples, so cost grows linearly with page depth. Floating-point distance ties also cause row shuffling between requests, producing duplicate or missing features at boundaries.

</details>

<details class="faq-item">
<summary>How do I handle cursor invalidation when query parameters change?</summary>

A cursor encodes a position relative to a specific sort key and filter set. When a client changes the bounding box, search radius, or ordering column, the encoded boundary no longer maps correctly. Return HTTP 400 with a structured error that instructs the client to discard the cursor and restart from the first page.

</details>

<details class="faq-item">
<summary>Should I use ST_Distance or the &lt;-&gt; operator for cursor-based KNN pagination?</summary>

Use `ST_Distance` in both the `ORDER BY` and the keyset `WHERE` boundary. The `<->` operator is index-assisted for sorting but produces approximate distances unsuitable as exact boundary comparisons in a cursor `WHERE` clause. Compute the precise distance for the cursor value with `ST_Distance` at the point of cursor generation.

</details>

---

## Related

- [Implementing Cursor-Based Pagination for Spatial Queries](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/) — deep implementation walkthrough with async connection patterns
- [GeoJSON vs GeoParquet Serialization](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — choose the right response format for paginated spatial endpoints
- [Spatial Resource Modeling Patterns](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) — geometry column design and SRID conventions
- [API Versioning for GIS Endpoints](/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — version cursor tokens alongside API changes
- [Bounding Box Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — cursor pagination adapted for `ST_Within` and `ST_Intersects` scans

← Back to [Core Geospatial API Architecture](/core-geospatial-api-architecture-with-fastapi-postgis/)
