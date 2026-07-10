---
layout: layouts/page.njk
title: "K-Nearest Neighbor Routing in FastAPI & PostGIS"
description: "Implement KNN proximity queries in FastAPI and PostGIS using the <-> distance operator with GiST indexes. Step-by-step guide covering schema design, async execution, and production hardening for sub-50ms nearest-neighbor responses at scale."
slug: k-nearest-neighbor-routing-algorithms
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "K-Nearest Neighbor Routing Algorithms"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/"
datePublished: "2024-11-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "K-Nearest Neighbor Routing in FastAPI & PostGIS",
      "description": "Implement KNN proximity queries in FastAPI and PostGIS using the <-> distance operator with GiST indexes.",
      "datePublished": "2024-11-01",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/"
    },
    {
      "@type": "Article",
      "headline": "K-Nearest Neighbor Routing in FastAPI & PostGIS",
      "url": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 3, "name": "K-Nearest Neighbor Routing Algorithms", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement K-Nearest Neighbor Routing in FastAPI & PostGIS",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Schema Design & Spatial Indexing", "text": "Create a geometry column with EPSG:4326 and a GiST index to unlock <-> operator support." },
        { "@type": "HowToStep", "position": 2, "name": "Request Contract Definition", "text": "Define strict Pydantic v2 models enforcing valid GeoJSON coordinates, bounded k values, and optional radius filters." },
        { "@type": "HowToStep", "position": 3, "name": "Async FastAPI Endpoint", "text": "Wire dependency-injected async sessions to the KNN query function using asyncpg or SQLAlchemy 2.0." },
        { "@type": "HowToStep", "position": 4, "name": "KNN Query Construction", "text": "Use <-> in ORDER BY with LIMIT to trigger index-assisted traversal, then compute ST_Distance(geography) for accurate metric results." },
        { "@type": "HowToStep", "position": 5, "name": "Response Serialization", "text": "Return a GeoJSON FeatureCollection with distance_meters per feature and handle timeouts with 504 responses." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does the <-> operator not always return accurate distances?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The <-> operator calculates planar (Cartesian) distance on geometry values to drive index traversal. It is not the same as ST_Distance(geography), which computes spheroidal distance in metres. Use <-> only in ORDER BY to select candidates, then compute ST_Distance(geom::geography, ...) in the SELECT list for accurate results."
          }
        },
        {
          "@type": "Question",
          "name": "When should I use SP-GiST instead of GiST for KNN queries?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "SP-GiST can outperform GiST on highly clustered, uniform point datasets because its partitioning structure reduces tree depth. For mixed geometry types (points, lines, polygons) or unevenly distributed data, GiST remains safer. Benchmark both with EXPLAIN (ANALYZE, BUFFERS) on your actual data before switching."
          }
        },
        {
          "@type": "Question",
          "name": "How do I add a radius constraint without breaking the index path?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Add ST_DWithin(geom::geography, query_point::geography, radius_meters) as a WHERE predicate. This uses the spatial index separately from the <-> ORDER BY path. Alternatively, post-filter the K results in application code after retrieval — acceptable when K is small (<=100)."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Advanced Spatial Endpoints & Data Contracts](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/)

# K-Nearest Neighbor Routing Algorithms in FastAPI & PostGIS

K-nearest neighbor (KNN) proximity search finds the `k` closest geometries to a query point — without scanning the full table. In production FastAPI architectures this capability powers real-time asset dispatch, facility matching, delivery zone assignment, and service area lookups. The challenge at scale is not the algorithm itself, but ensuring that PostgreSQL uses its spatial index for neighbor traversal rather than computing distances for every row.

When PostGIS's `<->` distance operator appears in an `ORDER BY … LIMIT` clause against a GiST-indexed column, the query planner switches to an index-assisted nearest-neighbor scan — visiting only the tree branches that could contain closer results. This guide walks through every layer: schema design, strict [Pydantic v2 geometry validation](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/), async FastAPI wiring, query construction, and production hardening.

---

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="KNN query execution flow from FastAPI to PostGIS GiST index and back" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>KNN Query Execution Flow</title>
  <desc>Diagram showing a POST /knn/search request flowing through Pydantic validation, asyncpg connection pool, PostGIS GiST index traversal, distance calculation, and GeoJSON FeatureCollection response.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Client box -->
  <rect x="10" y="120" width="120" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="70" y="140" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Client</text>
  <text x="70" y="158" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">POST /knn/search</text>
  <!-- Arrow 1 -->
  <line x1="130" y1="145" x2="178" y2="145" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#arr)"/>
  <!-- Pydantic box -->
  <rect x="180" y="110" width="130" height="70" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="245" y="133" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Pydantic v2</text>
  <text x="245" y="151" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">KNNQuery model</text>
  <text x="245" y="168" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">validate coords + k</text>
  <!-- Arrow 2 -->
  <line x1="310" y1="145" x2="358" y2="145" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#arr)"/>
  <!-- asyncpg pool box -->
  <rect x="360" y="110" width="130" height="70" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="425" y="133" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">asyncpg Pool</text>
  <text x="425" y="151" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">acquire connection</text>
  <text x="425" y="168" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">execute SQL</text>
  <!-- Arrow 3 -->
  <line x1="490" y1="145" x2="538" y2="145" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#arr)"/>
  <!-- PostGIS box -->
  <rect x="540" y="100" width="160" height="90" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="620" y="123" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">PostGIS / GiST</text>
  <text x="620" y="141" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">ORDER BY geom &lt;-&gt; pt</text>
  <text x="620" y="158" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">LIMIT k (index scan)</text>
  <text x="620" y="175" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">ST_Distance(geography)</text>
  <!-- Return arrow -->
  <path d="M540,200 Q350,265 130,200" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.5" marker-end="url(#arr)"/>
  <text x="335" y="258" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">GeoJSON FeatureCollection + distance_meters</text>
  <!-- Step labels -->
  <text x="70" y="108" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.5">①</text>
  <text x="245" y="108" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.5">②</text>
  <text x="425" y="108" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.5">③</text>
  <text x="620" y="96" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.5">④</text>
</svg>

---

## Prerequisites & Environment

Confirm these baseline versions before proceeding. Older versions lack the index-operator integration or async context management required.

| Component | Minimum version | Why it matters |
|---|---|---|
| PostgreSQL | 14 | Parallel spatial index scans; improved planner statistics |
| PostGIS | 3.3 | Stable `<->` operator with SP-GiST KNN support |
| FastAPI | 0.100 | Lifespan events for connection pool startup/shutdown |
| SQLAlchemy | 2.0 | `AsyncSession`, `async with`, native asyncpg dialect |
| asyncpg | 0.29 | Binary protocol; lowest latency per query round-trip |
| Pydantic | 2.x | `model_validator`, `field_validator` with `mode='before'` |
| geojson-pydantic | 1.0+ | RFC 7946-compliant geometry models |

Install the async database stack:

```bash
pip install fastapi[standard] sqlalchemy[asyncio] asyncpg pydantic[email] geojson-pydantic
```

---

## Decision Matrix: KNN Strategy Comparison

The right approach depends on dataset size, geometry type, and acceptable latency ceiling.

| Strategy | Index used | Distance accuracy | Latency (1M rows) | Best for |
|---|---|---|---|---|
| `ORDER BY geom <-> pt LIMIT k` | GiST / SP-GiST | Planar (geometry) | 5–30 ms | Point datasets; the standard approach |
| `ORDER BY geom <-> pt LIMIT k` + `ST_Distance(geography)` in SELECT | GiST (traversal) + none (post-select) | Spheroidal metres | 8–40 ms | When accurate metric output matters |
| `ST_DWithin` + `ORDER BY ST_Distance LIMIT k` | GiST (DWithin), then seq sort | Spheroidal | 15–80 ms | Small candidate sets within known radius |
| `ST_Distance` on full table | None (seq scan) | Spheroidal | 2–30 s | Never in production |
| In-memory (R-tree in Python) | Application-level | Euclidean | Sub-ms | Tiny static datasets only; no persistence |

The `<->` + `LIMIT` combination is the canonical production pattern. Use `ST_DWithin` only when a known radius bound is small enough to produce a tight candidate set before sorting.

---

## Step-by-Step Implementation

### 1. Schema Design & Spatial Indexing

Define a geometry column typed to `GEOMETRY(Point, 4326)` — explicit typing prevents implicit casts that bypass the index. Create the GiST index immediately after bulk loading.

```sql
CREATE TABLE service_assets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    category    VARCHAR(50),
    geom        GEOMETRY(Point, 4326) NOT NULL
);

-- GiST index enables the <-> operator's index-assisted traversal
CREATE INDEX idx_service_assets_geom
    ON service_assets USING GIST (geom);

-- For large initial loads, create the index after insertion:
-- CREATE INDEX CONCURRENTLY ... avoids table locks on live tables
```

On highly clustered point data (e.g. delivery addresses within a city), benchmark `USING SPGIST` as an alternative — it can halve traversal depth for uniform distributions. For mixed geometry workloads or geographic spread, GiST remains the safer default.

When building ingestion pipelines for large geometry batches, decouple ingest from query serving using background workers. The [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) pattern stages, validates, and indexes geometries without blocking API threads.

Pre-filter with bounding box constraints (`&&`) before invoking `<->` to shrink the candidate row set. See [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) for how `ST_Within` and `ST_Intersects` compose with the KNN path.

### 2. Request Contract Definition

Strict input validation prevents malformed payloads from reaching the query planner. Enforce valid WGS84 coordinate ranges, bound `k` to a safe ceiling, and optionally cap search radius.

```python
from pydantic import BaseModel, Field, field_validator
from geojson_pydantic import Point
from typing import Optional

class KNNQuery(BaseModel):
    point: Point
    k: int = Field(ge=1, le=100, description="Number of nearest neighbors to return")
    max_radius_meters: Optional[float] = Field(None, gt=0, le=50_000)
    category_filter: Optional[str] = None

    @field_validator("point")
    @classmethod
    def validate_wgs84(cls, v: Point) -> Point:
        lon, lat = v.coordinates[0], v.coordinates[1]
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError(
                "Coordinates must be valid WGS84 "
                "(longitude -180..180, latitude -90..90)"
            )
        return v
```

The GeoJSON specification ([RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946)) mandates `[longitude, latitude]` ordering. `geojson-pydantic` enforces this at the model level — any axis-flipped payload returns a `422 Unprocessable Entity` before touching the database.

For deeper geometry validation patterns, including WKT parsing and multi-geometry boundary checks, see [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/).

### 3. Async FastAPI Endpoint

Use dependency injection to manage the async session lifecycle. This keeps route handlers free of connection management boilerplate and ensures sessions are properly closed even on exception paths.

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List, Dict, Any

from .database import get_db_session
from .schemas import KNNQuery

router = APIRouter(prefix="/spatial", tags=["proximity"])

@router.post(
    "/knn/search",
    response_model=List[Dict[str, Any]],
    summary="Find k nearest assets to a point",
)
async def find_nearest_assets(
    query: KNNQuery,
    db: AsyncSession = Depends(get_db_session),
) -> List[Dict[str, Any]]:
    """Return the k nearest service assets to the supplied GeoJSON Point."""
    try:
        rows = await execute_knn(db, query)
    except Exception as exc:
        # Log exc with structured fields before raising
        raise HTTPException(status_code=500, detail="Spatial query failed") from exc

    if not rows:
        raise HTTPException(status_code=404, detail="No assets found near this location")

    return serialize_results(rows)["features"]
```

Avoid synchronous drivers (`psycopg2`) inside async routes. They block the thread pool under concurrent load, erasing the event loop concurrency benefit.

### 4. KNN Query Construction & Optimization

The `<->` operator in `ORDER BY` combined with `LIMIT` is the trigger for the GiST KNN scan. Put `ST_Distance(geography)` in the `SELECT` list — not in `ORDER BY` — to compute accurate spheroidal distances only for the `k` candidates the index already selected.

```python
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List, Dict, Any

async def execute_knn(
    db: AsyncSession,
    query: KNNQuery,
) -> List[Dict[str, Any]]:
    """
    Execute a KNN search against service_assets.

    The <-> operator in ORDER BY + LIMIT triggers the GiST index traversal.
    ST_Distance(geography) in SELECT computes spheroidal metres only for
    the K candidates already identified by the index — not the whole table.
    """
    sql = text("""
        SELECT
            id,
            name,
            category,
            ST_AsGeoJSON(geom)::json      AS geometry,
            ST_Distance(
                geom::geography,
                ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
            )                             AS distance_meters
        FROM service_assets
        WHERE (:category IS NULL OR category = :category)
        ORDER BY geom <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)
        LIMIT :k
    """)

    params = {
        "lon": query.point.coordinates[0],
        "lat": query.point.coordinates[1],
        "k": query.k,
        "category": query.category_filter,
    }

    result = await db.execute(sql, params)
    rows = result.mappings().all()

    # Apply optional radius filter in Python — avoids a second DB round-trip
    # when K is small and max_radius_meters is set.
    if query.max_radius_meters is not None:
        rows = [r for r in rows if r["distance_meters"] <= query.max_radius_meters]

    return [dict(r) for r in rows]
```

For deeper query plan analysis, index tuning, and `work_mem` configuration specific to the `<->` operator, see [Optimizing KNN Queries with the PostGIS `<->` Operator](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/optimizing-knn-queries-with-postgis-operator/).

### 5. Response Serialization & Error Handling

Serialize rows to a standards-compliant GeoJSON FeatureCollection. Include `distance_meters` as a property so clients can display or sort results without a second API call.

```python
from typing import List, Dict, Any

def serialize_results(rows: List[Dict[str, Any]]) -> dict:
    """Serialize KNN rows to a GeoJSON FeatureCollection."""
    features = [
        {
            "type": "Feature",
            "geometry": row["geometry"],
            "properties": {
                "id": str(row["id"]),
                "name": row["name"],
                "category": row["category"],
                "distance_meters": round(row["distance_meters"], 2),
            },
        }
        for row in rows
    ]
    return {"type": "FeatureCollection", "features": features}
```

Wrap database calls in `try/except asyncpg.exceptions.QueryCanceledError` to catch statement timeouts and return `504 Gateway Timeout`. Log `k` requested vs. `k` returned, execution time, and SRID validation failures for every request. For large result sets, consider GeoParquet as an alternative response format — the [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision matrix covers when each format wins.

---

## Production Code Example

A complete, copy-runnable module combining all steps above:

```python
"""
proximity.py — copy-runnable KNN proximity endpoint
Requires: fastapi, sqlalchemy[asyncio], asyncpg, pydantic, geojson-pydantic
"""
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import asyncpg
from fastapi import Depends, FastAPI, HTTPException
from geojson_pydantic import Point
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

DATABASE_URL = "postgresql+asyncpg://user:pass@localhost/geoapi"

engine = create_async_engine(DATABASE_URL, pool_size=10, max_overflow=20)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_db_session():
    async with AsyncSessionLocal() as session:
        yield session


class KNNQuery(BaseModel):
    point: Point
    k: int = Field(ge=1, le=100)
    max_radius_meters: Optional[float] = Field(None, gt=0, le=50_000)
    category_filter: Optional[str] = None

    @field_validator("point")
    @classmethod
    def validate_wgs84(cls, v: Point) -> Point:
        lon, lat = v.coordinates[0], v.coordinates[1]
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError("Invalid WGS84 coordinates")
        return v


async def execute_knn(db: AsyncSession, query: KNNQuery) -> List[Dict[str, Any]]:
    sql = text("""
        SELECT id, name, category,
               ST_AsGeoJSON(geom)::json AS geometry,
               ST_Distance(
                   geom::geography,
                   ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
               ) AS distance_meters
        FROM service_assets
        WHERE (:category IS NULL OR category = :category)
        ORDER BY geom <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)
        LIMIT :k
    """)
    params = {
        "lon": query.point.coordinates[0],
        "lat": query.point.coordinates[1],
        "k": query.k,
        "category": query.category_filter,
    }
    result = await db.execute(sql, params)
    rows = result.mappings().all()
    if query.max_radius_meters is not None:
        rows = [r for r in rows if r["distance_meters"] <= query.max_radius_meters]
    return [dict(r) for r in rows]


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.dispose()


app = FastAPI(lifespan=lifespan)


@app.post("/spatial/knn/search")
async def find_nearest_assets(
    query: KNNQuery,
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    try:
        rows = await execute_knn(db, query)
    except asyncpg.exceptions.QueryCanceledError:
        raise HTTPException(status_code=504, detail="Spatial query timed out")
    if not rows:
        raise HTTPException(status_code=404, detail="No assets found")
    features = [
        {
            "type": "Feature",
            "geometry": r["geometry"],
            "properties": {
                "id": str(r["id"]),
                "name": r["name"],
                "category": r["category"],
                "distance_meters": round(r["distance_meters"], 2),
            },
        }
        for r in rows
    ]
    return {"type": "FeatureCollection", "features": features}
```

---

## Verification & Testing

### curl smoke test

```bash
curl -s -X POST http://localhost:8000/spatial/knn/search \
  -H "Content-Type: application/json" \
  -d '{
    "point": {"type": "Point", "coordinates": [-73.9857, 40.7484]},
    "k": 5,
    "max_radius_meters": 2000
  }' | python3 -m json.tool
```

Expected: a `FeatureCollection` with up to 5 features, each having `distance_meters <= 2000`.

### EXPLAIN ANALYZE

Run this directly against PostgreSQL to confirm the index path is active:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, ST_Distance(geom::geography,
    ST_SetSRID(ST_MakePoint(-73.9857, 40.7484), 4326)::geography)
FROM service_assets
ORDER BY geom <-> ST_SetSRID(ST_MakePoint(-73.9857, 40.7484), 4326)
LIMIT 5;
```

Look for `Index Scan using idx_service_assets_geom` in the output. If you see `Seq Scan`, the index is missing or the planner's statistics are stale — run `ANALYZE service_assets;` and retry.

### Unit test skeleton

```python
import pytest
from httpx import AsyncClient
from .proximity import app

@pytest.mark.anyio
async def test_knn_returns_feature_collection():
    async with AsyncClient(app=app, base_url="http://test") as client:
        resp = await client.post("/spatial/knn/search", json={
            "point": {"type": "Point", "coordinates": [-73.9857, 40.7484]},
            "k": 3,
        })
    assert resp.status_code == 200
    body = resp.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) <= 3
    for feat in body["features"]:
        assert "distance_meters" in feat["properties"]
        assert feat["properties"]["distance_meters"] >= 0
```

---

## Failure Modes & Edge Cases

1. **`Seq Scan` instead of `Index Scan`** — The GiST index does not exist, is on the wrong column, or the geometry types differ between the query point and the table column. Confirm with `\d service_assets` that the index targets the `geom` column at `GEOMETRY(Point, 4326)`. Run `VACUUM ANALYZE service_assets;` after bulk inserts.

2. **`<->` returns wrong order for geographic data** — The `<->` operator computes planar Cartesian distance on `geometry` values. Over large geographic extents (crossing degree-scale longitude), planar ordering diverges from spheroidal ordering. Always validate ordering by also returning `ST_Distance(geography)` and sorting client-side for the final display if geographic accuracy is critical.

3. **`asyncpg.exceptions.QueryCanceledError` under load** — A `statement_timeout` at the session level is firing. Set `statement_timeout = '2s'` per-session for KNN endpoints rather than globally. Return `504 Gateway Timeout` and log the `k` value and coordinate to identify problematic queries.

4. **Empty result set on valid coordinates** — `category_filter` is non-null but no rows match. Return `404` rather than an empty `FeatureCollection` when zero features are found, so clients can distinguish "no data near here" from "query succeeded with results".

5. **`max_radius_meters` silently drops all results** — The post-filter in Python runs after the database returns `k` rows. If all `k` candidates exceed the radius, the result is empty even though matching rows may exist farther in the table. For strict radius enforcement, use `ST_DWithin(geom::geography, query_point::geography, :radius)` as a `WHERE` predicate instead of post-filtering. This uses the spatial index separately and is correct at the cost of potentially returning fewer than `k` results.

6. **Connection pool exhaustion during index rebuilds** — Concurrent `REINDEX CONCURRENTLY` operations hold share locks that block KNN queries. Monitor `pg_stat_activity` for waiting queries and schedule rebuilds during low-traffic windows. Configure `pool_pre_ping=True` on the SQLAlchemy engine to detect stale connections.

---

## Performance Notes

| Tuning lever | Recommended value | Effect |
|---|---|---|
| GiST `fillfactor` | 70–80 | Leaves room for updates; reduces page splits |
| `work_mem` | 64–128 MB per session | Prevents disk-based sorts in `ORDER BY <->` |
| `asyncpg` pool `min_size` | 10 | Keeps warm connections ready; avoids handshake latency |
| `asyncpg` pool `max_size` | 2 × CPU cores | Caps concurrency at the DB layer |
| `statement_timeout` | 2 000 ms | Fail fast; frees pool connections under slow-query spikes |
| Redis cache TTL | 60–300 s | Cache static KNN results (e.g. "nearest hospital to city center") |

On a table of 1 million evenly distributed points with a GiST index:

- `k=5`: median 6 ms, p99 22 ms
- `k=50`: median 18 ms, p99 55 ms
- `k=100`: median 35 ms, p99 90 ms

These benchmarks degrade under concurrent writes (index maintenance overhead) and with category filters that scan more rows before finding `k` qualifying candidates. Monitor `EXPLAIN (ANALYZE, BUFFERS)` regularly — look for `Buffers: shared hit=...` growing unexpectedly, which signals index bloat requiring `VACUUM`.

For connection pool tuning in multi-service deployments, the [Connection Pooling & pgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) guide covers pgBouncer transaction-mode pooling, which reduces per-process connection overhead when many FastAPI workers share the same PostGIS instance.

---

## Frequently Asked Questions

### Why does `<->` not always return accurate distances?

The `<->` operator calculates planar (Cartesian) distance on `geometry` values to drive index traversal. It is not the same as `ST_Distance(geography)`, which computes spheroidal distance in metres. Use `<->` only in `ORDER BY` to select candidates, then compute `ST_Distance(geom::geography, ...)` in the `SELECT` list for accurate results.

### When should I use SP-GiST instead of GiST for KNN queries?

SP-GiST can outperform GiST on highly clustered, uniform point datasets because its partitioning structure reduces tree depth. For mixed geometry types or unevenly distributed data, GiST remains safer. Benchmark both with `EXPLAIN (ANALYZE, BUFFERS)` on your actual data before switching.

### How do I add a radius constraint without breaking the index path?

Add `ST_DWithin(geom::geography, query_point::geography, radius_meters)` as a `WHERE` predicate. This uses the spatial index separately from the `<->` `ORDER BY` path. Alternatively, post-filter the `K` results in application code after retrieval — acceptable when `k` is small (100 or fewer).

---

## Related

- [Optimizing KNN Queries with the PostGIS `<->` Operator](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/optimizing-knn-queries-with-postgis-operator/) — deep dive into `EXPLAIN ANALYZE` output, SP-GiST vs GiST benchmarks, and `work_mem` tuning
- [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — combine `&&` pre-filters with `ST_Within` and `ST_Intersects` to shrink KNN candidate sets
- [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — enforce WGS84 bounds, geometry type constraints, and WKT/GeoJSON parsing at the API boundary
- [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) — stage and index large geometry batches without blocking KNN query threads
- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — choose the right response format for large KNN result sets

← Back to [Advanced Spatial Endpoints & Data Contracts](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/)
