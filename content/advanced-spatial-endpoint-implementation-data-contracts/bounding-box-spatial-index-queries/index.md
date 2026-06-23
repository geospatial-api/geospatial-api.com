---
layout: layouts/page.njk
title: "Bounding Box & Spatial Index Queries"
description: "Build fast PostGIS bounding box endpoints in FastAPI using the two-step operator pattern to exploit GiST indexes for sub-100ms spatial query performance."
slug: "bounding-box-spatial-index-queries"
type: "cluster"
breadcrumb: "Advanced Spatial Endpoints → Bounding Box & Spatial Index Queries"
datePublished: "2024-01-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Bounding Box & Spatial Index Queries",
      "description": "Build fast PostGIS bounding box endpoints in FastAPI using the two-step operator pattern to exploit GiST indexes for sub-100ms spatial query performance.",
      "datePublished": "2024-01-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "Article",
      "headline": "Bounding Box & Spatial Index Queries",
      "datePublished": "2024-01-15",
      "dateModified": "2026-06-23"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "/"},
        {"@type": "ListItem", "position": 2, "name": "Advanced Spatial Endpoints", "item": "/advanced-spatial-endpoint-implementation-data-contracts/"},
        {"@type": "ListItem", "position": 3, "name": "Bounding Box & Spatial Index Queries", "item": "/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement Bounding Box Spatial Index Queries in FastAPI + PostGIS",
      "step": [
        {"@type": "HowToStep", "name": "Define and validate the bounding envelope", "position": 1},
        {"@type": "HowToStep", "name": "Configure a GiST index on the geometry column", "position": 2},
        {"@type": "HowToStep", "name": "Construct an async query using the && operator", "position": 3},
        {"@type": "HowToStep", "name": "Chain topological refinement predicates", "position": 4},
        {"@type": "HowToStep", "name": "Verify with EXPLAIN ANALYZE", "position": 5}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does PostGIS ignore my GiST index on bounding box queries?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The most common cause is a CRS mismatch: if your query envelope uses EPSG:4326 but the geometry column stores EPSG:3857, PostGIS wraps the geometry in ST_Transform, which invalidates index use and forces a sequential scan. Ensure the SRID in ST_MakeEnvelope matches the column's storage CRS exactly."
          }
        },
        {
          "@type": "Question",
          "name": "What is the difference between && and ST_Intersects in PostGIS?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The && operator tests bounding-box overlap only and is fully index-aware, making it extremely fast but approximate — it returns false positives where geometries touch the envelope edge. ST_Intersects performs exact topological evaluation but does not use the GiST index alone. The standard pattern chains them: && for the index scan, ST_Intersects for exact refinement."
          }
        },
        {
          "@type": "Question",
          "name": "How do I prevent memory pressure from oversized bounding box queries?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Enforce a maximum envelope area in your Pydantic validator before the query reaches the database. A practical cap is ~5 degrees squared for global geographic data. Also apply a LIMIT and implement cursor-based pagination rather than OFFSET to avoid re-scanning large result sets on subsequent pages."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Advanced Spatial Endpoint Implementation & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/)

# Bounding Box & Spatial Index Queries

Bounding box queries are the primary spatial retrieval primitive for map-driven APIs: a client sends a rectangular coordinate envelope representing the current viewport, and the server must return every feature inside that rectangle — fast enough to keep the map responsive as the user pans and zooms. When paired with PostGIS GiST spatial indexes and FastAPI's async execution model, properly constructed bounding box endpoints return sub-100ms responses against multi-million-row tables. Getting there requires understanding exactly how the `&&` operator interacts with the index, why CRS mismatches silently destroy that interaction, and how to chain a topological refinement predicate without losing the index benefit.

This page covers the complete implementation path: schema and index setup, coordinate validation with Pydantic v2, async query construction, verification with `EXPLAIN ANALYZE`, and the failure modes that most commonly derail production deployments.

---

## Query Operator Decision Matrix

Before writing any code, understand which operator to apply at which stage. Picking the wrong operator at the wrong layer is the most frequent source of slow spatial endpoints.

| Operator / Function | Index-Aware | Exact Topology | Typical Use |
|---|---|---|---|
| `&&` | Yes (GiST) | No — bounding boxes only | Initial candidate scan |
| `ST_Intersects(a, b)` | Partially (calls `&&` internally) | Yes | Exact intersection check after `&&` |
| `ST_Within(a, b)` | Partially | Yes — strict containment | Point-in-polygon, feature containment |
| `ST_Contains(a, b)` | Partially | Yes — inverse of `ST_Within` | Polygon contains geometry |
| `ST_DWithin(a, b, d)` | Yes (GiST with distance) | Yes — within distance `d` | Proximity searches; see [K-Nearest Neighbor Routing](/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) |
| `ST_MakeEnvelope(x1,y1,x2,y2,srid)` | N/A — constructs geometry | N/A | Build the query rectangle server-side |

The standard two-step pattern is: `WHERE geom && ST_MakeEnvelope(...) AND ST_Intersects(geom, ST_MakeEnvelope(...))`. PostGIS is smart enough not to recompute the envelope twice if you bind it as a CTE or subexpression, but for simple queries the inline form is fine — the planner recognises the pattern.

---

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two-step bounding box query flow: GiST index scan followed by exact topological refinement" style="width:100%;max-width:720px;display:block;margin:2rem auto;">
  <title>Two-step bounding box query execution in PostGIS</title>
  <desc>Diagram showing a FastAPI request flowing through Pydantic validation, then into PostGIS where the GiST index narrows candidates via the &amp;&amp; operator, followed by ST_Intersects for exact topological refinement before serialisation to GeoJSON.</desc>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Client box -->
  <rect x="20" y="130" width="110" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="75" y="151" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85" font-family="sans-serif">Client</text>
  <text x="75" y="167" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.65" font-family="sans-serif">bbox request</text>
  <!-- Arrow: client → pydantic -->
  <line x1="130" y1="155" x2="168" y2="155" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <!-- Pydantic validation box -->
  <rect x="170" y="118" width="130" height="74" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
  <text x="235" y="140" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85" font-family="sans-serif" font-weight="600">Pydantic v2</text>
  <text x="235" y="156" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.65" font-family="sans-serif">validate minx &lt; maxx</text>
  <text x="235" y="170" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.65" font-family="sans-serif">validate miny &lt; maxy</text>
  <text x="235" y="184" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.65" font-family="sans-serif">SRID check</text>
  <!-- Arrow: pydantic → gist -->
  <line x1="300" y1="155" x2="338" y2="155" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <!-- GiST scan box -->
  <rect x="340" y="80" width="150" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
  <text x="415" y="105" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85" font-family="sans-serif" font-weight="600">Step 1: GiST index</text>
  <text x="415" y="119" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.65" font-family="sans-serif">geom &amp;&amp; ST_MakeEnvelope(…)</text>
  <text x="415" y="131" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.65" font-family="sans-serif">fast — may include false positives</text>
  <!-- Arrow: gist → refine -->
  <line x1="415" y1="140" x2="415" y2="178" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <!-- Topological refinement box -->
  <rect x="340" y="180" width="150" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
  <text x="415" y="205" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85" font-family="sans-serif" font-weight="600">Step 2: ST_Intersects</text>
  <text x="415" y="221" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.65" font-family="sans-serif">exact topology check</text>
  <text x="415" y="235" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.65" font-family="sans-serif">eliminates false positives</text>
  <!-- Arrow: refine → serialise -->
  <line x1="490" y1="210" x2="528" y2="210" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <!-- Serialisation box -->
  <rect x="530" y="183" width="140" height="54" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
  <text x="600" y="206" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85" font-family="sans-serif" font-weight="600">Serialise</text>
  <text x="600" y="222" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.65" font-family="sans-serif">ST_AsGeoJSON → response</text>
  <text x="600" y="236" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.65" font-family="sans-serif">FeatureCollection</text>
  <!-- Label: false positives annotation -->
  <line x1="490" y1="110" x2="520" y2="60" stroke="currentColor" stroke-width="1" opacity="0.35" stroke-dasharray="4,3"/>
  <text x="522" y="55" font-size="9" fill="currentColor" opacity="0.55" font-family="sans-serif">bbox overlap</text>
  <text x="522" y="67" font-size="9" fill="currentColor" opacity="0.55" font-family="sans-serif">≠ exact match</text>
</svg>

---

## Prerequisites & Environment

Confirm these baselines before implementing any spatial endpoint:

- **PostGIS 3.2+** — `ST_MakeEnvelope` and the `&&` operator are available from PostGIS 2.0, but GiST index improvements that fix edge cases with large geometries landed in 3.x.
- **PostgreSQL 14+** — parallel query plans for GiST scans are more reliable from PostgreSQL 14 onward.
- **FastAPI 0.100+** with `asyncpg 0.29+` or **SQLAlchemy 2.0** async engine. Synchronous drivers (`psycopg2`) block the event loop; under concurrent spatial load they serialise requests and degrade throughput to single-digit QPS.
- **Pydantic v2** — the `model_validator(mode="after")` API used below is Pydantic v2-specific and is not compatible with Pydantic v1's `@validator`.
- **CRS alignment** across client payloads, the database column, and the GiST index. A mismatch at any layer triggers an implicit `ST_Transform` that removes the index benefit. This alignment requirement is covered in depth in [Strict Pydantic Validation for Geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/).

Verify PostGIS is installed and check the version:

```sql
SELECT PostGIS_Full_Version();
-- Expected: POSTGIS="3.4.x" ...
```

---

## Step-by-Step Implementation

### Step 1: Schema Design & GiST Index Creation

Create the table with an explicit geometry type and SRID. Never store coordinates as `text`, `float[]`, or JSON — PostGIS cannot index those types.

```sql
-- Create table with a typed geometry column (EPSG:4326, 2D points or polygons)
CREATE TABLE spatial_features (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    geom        GEOMETRY(Geometry, 4326) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Create the GiST index — this is what makes && fast
CREATE INDEX idx_spatial_features_geom_gist
    ON spatial_features USING GIST (geom);

-- Optional: also index common filter columns for compound queries
CREATE INDEX idx_spatial_features_created_at
    ON spatial_features (created_at DESC);
```

The `USING GIST` clause selects the Generalised Search Tree index, which stores bounding-box summaries of each geometry in a balanced tree. The `&&` operator traverses this tree to find candidate rows in O(log n) time rather than scanning every row.

For metric-precision work (distance calculations, area comparisons), store in a projected CRS like `EPSG:3857` and accept client coordinates in that system. Mixing `EPSG:4326` requests against `EPSG:3857` storage is the single most common source of silent performance regressions — see Failure Mode 1 below.

### Step 2: Pydantic v2 Coordinate Validation

The envelope must be validated before it reaches the database layer. Malformed envelopes — where `maxx <= minx` or the coordinate range exceeds the CRS bounds — produce either empty result sets or PostgreSQL errors that are difficult to distinguish from query failures.

```python
from pydantic import BaseModel, Field, model_validator
from typing import Optional

class BoundingBoxRequest(BaseModel):
    minx: float = Field(..., ge=-180.0, le=180.0, description="Western longitude bound")
    miny: float = Field(..., ge=-90.0, le=90.0, description="Southern latitude bound")
    maxx: float = Field(..., ge=-180.0, le=180.0, description="Eastern longitude bound")
    maxy: float = Field(..., ge=-90.0, le=90.0, description="Northern latitude bound")
    srid: int = Field(default=4326, ge=0, le=999999)

    @model_validator(mode="after")
    def validate_bounds(self) -> "BoundingBoxRequest":
        if self.maxx <= self.minx:
            raise ValueError(
                f"maxx ({self.maxx}) must be strictly greater than minx ({self.minx})"
            )
        if self.maxy <= self.miny:
            raise ValueError(
                f"maxy ({self.maxy}) must be strictly greater than miny ({self.miny})"
            )
        # Reject envelopes that are unreasonably large (prevent runaway queries)
        area_deg = (self.maxx - self.minx) * (self.maxy - self.miny)
        if area_deg > 25.0:  # ~5° × 5° — tune to your dataset
            raise ValueError(
                f"Bounding box area {area_deg:.1f}°² exceeds the 25°² limit. "
                "Zoom in or paginate with a smaller envelope."
            )
        return self
```

The area cap is the most important guard for production systems. Without it, a client can send a global envelope (`-180,-90,180,90`) and force a full table scan that returns millions of rows — bypassing any index benefit and exhausting database memory. For datasets where global queries are legitimate, combine the area cap with a mandatory `LIMIT` and implement [cursor-based pagination](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) for subsequent pages.

### Step 3: Async Query Construction with the && Operator

Use `ST_MakeEnvelope` to build the query rectangle server-side and bind it through parameterized SQL. Never interpolate coordinate values into SQL strings — this both opens an injection vector and prevents query plan caching.

The exact two-step pattern for strict intersection (no false positives):

```python
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

BBOX_QUERY = text("""
    SELECT
        id,
        ST_AsGeoJSON(geom)::json AS geometry,
        name,
        created_at
    FROM spatial_features
    WHERE
        geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, :srid)
        AND ST_Intersects(geom, ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, :srid))
    ORDER BY id
    LIMIT :limit
""")

async def fetch_features_in_bbox(
    db: AsyncSession,
    bbox: BoundingBoxRequest,
    limit: int = 500,
) -> list[dict]:
    result = await db.execute(
        BBOX_QUERY,
        {
            "minx": bbox.minx, "miny": bbox.miny,
            "maxx": bbox.maxx, "maxy": bbox.maxy,
            "srid": bbox.srid, "limit": limit,
        },
    )
    return result.mappings().all()
```

When you only need approximate results (for example, initial map tile rendering where a few extra features at the boundary are acceptable), omit the `ST_Intersects` clause and rely on `&&` alone. The performance difference is significant on large datasets: `&&`-only scans run purely on the index; adding `ST_Intersects` triggers geometry deserialization for each candidate row.

For precise spatial containment (features *inside* the envelope, not just overlapping), replace `ST_Intersects` with [ST_Within or ST_Contains](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/implementing-st_within-and-st_intersects-in-fastapi/) depending on whether you need the geometry fully contained or allow boundary touching.

### Step 4: Complete FastAPI Route

```python
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from typing import Any
import json

router = APIRouter(prefix="/spatial", tags=["bounding-box"])

class GeoJSONFeature(BaseModel):
    type: str = "Feature"
    geometry: dict[str, Any]
    properties: dict[str, Any]

class FeatureCollection(BaseModel):
    type: str = "FeatureCollection"
    features: list[GeoJSONFeature]
    count: int

async def get_db() -> AsyncSession:
    # Wire to your actual async session factory
    raise NotImplementedError

@router.post(
    "/bbox",
    response_model=FeatureCollection,
    summary="Query features within a bounding box",
)
async def query_bounding_box(
    bbox: BoundingBoxRequest,
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=500, le=5000, description="Maximum features to return"),
    exact: bool = Query(
        default=True,
        description="If true, apply ST_Intersects after && for exact results. "
                    "Set false for faster approximate results (map tile rendering).",
    ),
) -> FeatureCollection:
    # Build query dynamically based on exact flag
    predicate = (
        "geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, :srid) "
        "AND ST_Intersects(geom, ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, :srid))"
        if exact
        else "geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, :srid)"
    )
    query = text(f"""
        SELECT id, ST_AsGeoJSON(geom)::json AS geometry, name, created_at
        FROM spatial_features
        WHERE {predicate}
        ORDER BY id
        LIMIT :limit
    """)  # nosec — predicate is from a trusted branch, not user input

    try:
        result = await db.execute(
            query,
            {
                "minx": bbox.minx, "miny": bbox.miny,
                "maxx": bbox.maxx, "maxy": bbox.maxy,
                "srid": bbox.srid, "limit": limit,
            },
        )
        rows = result.mappings().all()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Spatial query failed: {exc}") from exc

    features = [
        GeoJSONFeature(
            geometry=row["geometry"],
            properties={
                "id": row["id"],
                "name": row["name"],
                "created_at": row["created_at"].isoformat(),
            },
        )
        for row in rows
    ]
    return FeatureCollection(features=features, count=len(features))
```

For the [serialization format](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision — whether to return GeoJSON, GeoParquet, or FlatGeobuf — the above route returns GeoJSON, which is the right default for browser map clients. Switch to GeoParquet streaming for data pipeline consumers that process large feature sets analytically.

---

## Verification & Testing

### EXPLAIN ANALYZE: Confirm Index Usage

Run this against your actual data to verify the GiST index is being used. If you see `Seq Scan` instead of `Index Scan using idx_spatial_features_geom_gist`, the index is being bypassed.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, ST_AsGeoJSON(geom)
FROM spatial_features
WHERE geom && ST_MakeEnvelope(-0.5, 51.3, 0.2, 51.6, 4326)
  AND ST_Intersects(geom, ST_MakeEnvelope(-0.5, 51.3, 0.2, 51.6, 4326));
```

Expected output indicators:
- `Index Scan using idx_spatial_features_geom_gist` — GiST index is active.
- `Rows Removed by Index Recheck` — topological refinement step eliminated false positives.
- `Buffers: shared hit=...` — low shared read counts indicate the index fits in `shared_buffers`.

If you see `Seq Scan` with `rows=<large number>`, run `ANALYZE spatial_features;` to refresh table statistics, then re-explain.

For more detail on reading these plans, see [Reading EXPLAIN ANALYZE for Spatial Query Optimization](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/).

### Integration Test with curl

```bash
curl -s -X POST http://localhost:8000/spatial/bbox \
  -H "Content-Type: application/json" \
  -d '{"minx": -0.5, "miny": 51.3, "maxx": 0.2, "maxy": 51.6, "srid": 4326}' \
  | python3 -m json.tool | head -30
```

Expected response structure:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {"type": "Point", "coordinates": [-0.12, 51.50]},
      "properties": {"id": 42, "name": "London"}
    }
  ],
  "count": 1
}
```

### Unit Test Skeleton

```python
import pytest
from httpx import AsyncClient
from myapp.main import app

@pytest.mark.asyncio
async def test_bbox_returns_features_within_envelope():
    async with AsyncClient(app=app, base_url="http://test") as client:
        response = await client.post(
            "/spatial/bbox",
            json={"minx": -0.5, "miny": 51.3, "maxx": 0.2, "maxy": 51.6},
        )
    assert response.status_code == 200
    data = response.json()
    assert data["type"] == "FeatureCollection"
    assert isinstance(data["features"], list)

@pytest.mark.asyncio
async def test_bbox_rejects_inverted_envelope():
    async with AsyncClient(app=app, base_url="http://test") as client:
        response = await client.post(
            "/spatial/bbox",
            json={"minx": 0.2, "miny": 51.6, "maxx": -0.5, "maxy": 51.3},
        )
    assert response.status_code == 422  # Pydantic validation error
```

---

## Failure Modes & Edge Cases

1. **CRS mismatch strips the index.** If the client sends EPSG:4326 coordinates but the column stores EPSG:3857 (Web Mercator), PostGIS silently wraps every candidate in `ST_Transform`, which forces a sequential scan. Symptom: `EXPLAIN` shows `Seq Scan` despite an existing GiST index; query time jumps from ~5ms to >2s on large tables. Fix: always match the `:srid` bind parameter to the column's storage CRS, or transform the envelope explicitly: `ST_MakeEnvelope(..., 4326)::geography`.

2. **GiST index bloat under write-heavy workloads.** Frequent `INSERT`/`UPDATE`/`DELETE` operations fragment the GiST tree. Index pages fill with dead tuples that must be visited during scans. Symptom: `pg_stat_user_indexes.idx_scan` stays high but query time drifts upward over days. Fix: run `REINDEX CONCURRENTLY idx_spatial_features_geom_gist` during a maintenance window — it rebuilds without taking an exclusive lock. For tables that receive continuous bulk writes, consider decoupling ingestion with [async bulk uploads via Celery](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) to batch-write and reindex outside peak query hours.

3. **`&&` returns geometries outside the visible envelope.** This is expected: `&&` checks bounding-box overlap, not exact intersection. A long diagonal line whose bounding box overlaps the query rectangle but whose actual geometry does not is a classic false positive. Symptom: client map renders features that appear outside the viewport. Fix: always chain `ST_Intersects` for the exact refinement step.

4. **Anti-meridian envelopes fail silently.** Envelopes that cross the 180°/-180° boundary (e.g. `minx=170, maxx=-170`) cannot be expressed as a simple `ST_MakeEnvelope` call because `maxx < minx`. PostGIS does not raise an error — it returns an empty or incorrect result set. Fix: split the query into two envelopes: one for `[170, maxx_east]` and one for `[-180, -170]`, then union the results in the application layer.

5. **OFFSET pagination causes full re-scans.** `LIMIT 500 OFFSET 500` forces PostGIS to evaluate the first 1000 candidates just to discard the first 500. On a dataset with 10 million features and a large bounding box, this compounds with every subsequent page. Fix: use keyset pagination on `id` (add `WHERE id > :last_id` to the query) or implement the full [Spatial Pagination & Cursor Strategies](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) pattern.

6. **`VACUUM` neglect causes bloat-triggered planner fallback.** If table bloat crosses a planner cost threshold, PostgreSQL may decide a sequential scan is cheaper than the index. Symptom: `EXPLAIN` shows `Seq Scan (cost=...` even though the index exists and statistics are fresh. Fix: run `VACUUM ANALYZE spatial_features;` and increase `autovacuum_vacuum_scale_factor` for the table.

---

## Performance Notes

| Scenario | Approximate Latency | Notes |
|---|---|---|
| `&&` only, 1M rows, small bbox (~0.01°²) | 2–8 ms | Pure index scan, minimal row materialization |
| `&&` + `ST_Intersects`, 1M rows, small bbox | 5–20 ms | Adds geometry deserialization for ~index candidates |
| `&&` + `ST_Intersects`, 1M rows, large bbox (~5°²) | 50–200 ms | More candidates; result count may hit LIMIT |
| No index (Seq Scan), 1M rows, any bbox | 800–4000 ms | Never acceptable in production |

**Async vs sync driver impact:** With `asyncpg` under 50 concurrent requests, bounding box queries sustain ~400 QPS. With `psycopg2` (synchronous, blocking the event loop), the same hardware reaches ~40 QPS before timeouts appear. Always use an async driver for spatial endpoints exposed to concurrent clients.

**Connection pool sizing:** Each bounding box query holds a database connection for the full query duration. Under concurrent load, small pool sizes (< 10 connections) create a queue behind the pool, adding latency that appears as slow API responses rather than slow queries. For PostGIS workloads, configure the pool at 10–20 connections per API worker and set the overflow limit conservatively. See [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) for production pool tuning guidance.

**Result set size:** Returning 5000 GeoJSON features in a single response with complex polygon geometries can generate payloads over 10 MB. For map tile rendering, consider [tile generation and CDN distribution](/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) patterns that pre-rasterize at each zoom level and serve static tiles, eliminating per-request spatial queries entirely at high traffic volumes.

---

## Frequently Asked Questions

<details class="faq-item">
<summary>Why does PostGIS ignore my GiST index on bounding box queries?</summary>

The most common cause is a CRS mismatch: if your query envelope uses EPSG:4326 but the geometry column stores EPSG:3857, PostGIS wraps the geometry in `ST_Transform`, which invalidates index use and forces a sequential scan. Ensure the SRID in `ST_MakeEnvelope` matches the column's storage CRS exactly. Run `SELECT Find_SRID('public', 'spatial_features', 'geom');` to confirm the column's actual SRID.

</details>

<details class="faq-item">
<summary>What is the difference between && and ST_Intersects?</summary>

The `&&` operator tests bounding-box overlap only and is fully index-aware, making it extremely fast but approximate — it returns false positives where geometries touch the envelope edge. `ST_Intersects` performs exact topological evaluation but uses the GiST index only as a pre-filter (it calls `&&` internally when the index exists). The standard pattern chains them: `&&` drives the index scan, `ST_Intersects` eliminates false positives.

</details>

<details class="faq-item">
<summary>How do I prevent memory pressure from oversized bounding box queries?</summary>

Enforce a maximum envelope area in your Pydantic validator before the query reaches the database. A practical cap is ~25 degrees squared for global geographic data (roughly a 5°×5° window). Also apply a hard `LIMIT` and implement cursor-based pagination rather than `OFFSET` to avoid re-scanning large result sets on subsequent pages. For analytics workloads that genuinely need global extents, stream results using an async generator rather than materializing the full result set in memory.

</details>

---

## Related

- [Implementing ST_Within and ST_Intersects in FastAPI](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/implementing-st_within-and-st_intersects-in-fastapi/) — exact topological predicates as a refinement step over bounding box candidates
- [K-Nearest Neighbor Routing Algorithms](/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) — proximity search with `<->` KNN-GiST operator when viewport-based retrieval is insufficient
- [Strict Pydantic Validation for Geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — WKT and GeoJSON validation patterns that complement the envelope validators above
- [Spatial Pagination & Cursor Strategies](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — keyset pagination for large spatial result sets
- [Query Plan Analysis & Index Tuning](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — reading `EXPLAIN ANALYZE` output to diagnose index bypass

← Back to [Advanced Spatial Endpoint Implementation & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/)
