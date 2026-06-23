---
layout: layouts/page.njk
title: "Implementing ST_Within and ST_Intersects in FastAPI"
description: "Step-by-step guide to wiring PostGIS ST_Within and ST_Intersects into a FastAPI endpoint: Pydantic v2 geometry validation, GeoAlchemy2 mapping, GiST index usage, and production hardening."
slug: implementing-st_within-and-st_intersects-in-fastapi
type: long_tail
breadcrumb:
  - label: "Bounding Box & Spatial Index Queries"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/"
  - label: "Advanced Spatial Endpoints"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
datePublished: "2024-03-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Implementing ST_Within and ST_Intersects in FastAPI",
      "description": "Step-by-step guide to wiring PostGIS ST_Within and ST_Intersects into a FastAPI endpoint: Pydantic v2 geometry validation, GeoAlchemy2 mapping, GiST index usage, and production hardening.",
      "datePublished": "2024-03-01",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Advanced Spatial Endpoints",
          "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Bounding Box & Spatial Index Queries",
          "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/"
        },
        {
          "@type": "ListItem",
          "position": 3,
          "name": "Implementing ST_Within and ST_Intersects in FastAPI",
          "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/implementing-st_within-and-st_intersects-in-fastapi/"
        }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement ST_Within and ST_Intersects in FastAPI",
      "step": [
        {"@type": "HowToStep", "name": "Validate GeoJSON with Pydantic v2", "position": 1},
        {"@type": "HowToStep", "name": "Map PostGIS columns with GeoAlchemy2", "position": 2},
        {"@type": "HowToStep", "name": "Execute spatial predicate via sqlalchemy.func", "position": 3},
        {"@type": "HowToStep", "name": "Apply GiST index pre-filter for production throughput", "position": 4}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the difference between ST_Within and ST_Intersects?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "ST_Intersects returns TRUE when two geometries share any space — including touching boundaries or full containment. ST_Within returns TRUE only when the first geometry is completely enclosed inside the second, with no boundary-only contact counting."
          }
        },
        {
          "@type": "Question",
          "name": "Why does my ST_Within query return FALSE even when the point looks inside the polygon?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The most common cause is an SRID mismatch. If the stored geometry is in EPSG:4326 but the input WKT is bound without an explicit SRID, PostGIS silently compares geometries in different coordinate systems and returns FALSE. Always pass ST_GeomFromText(wkt, 4326) and verify both sides share the same SRID."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Bounding Box & Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/)

# Implementing ST_Within and ST_Intersects in FastAPI

Wire `ST_Within` and `ST_Intersects` into a FastAPI endpoint that validates incoming GeoJSON with Pydantic v2, maps PostGIS geometry columns through GeoAlchemy2, and executes spatial predicates entirely at the database layer — with a GiST index pre-filter to keep response times flat at scale.

## Context & When to Use

Both `ST_Intersects` and `ST_Within` evaluate spatial relationships inside PostGIS and should never be reimplemented in Python with in-memory geometry math. The distinction between them is architectural as much as mathematical:

- **`ST_Intersects(geomA, geomB)`** returns `TRUE` when the geometries share *any* point — touching edges, overlapping interiors, or complete containment all qualify. It is the right predicate for "find all features that overlap this search polygon" and for geofencing queries where partial overlap is meaningful.
- **`ST_Within(geomA, geomB)`** returns `TRUE` only when `geomA` lies entirely inside `geomB`. Boundary contact without interior overlap yields `FALSE`. Use this for strict containment checks such as confirming that a land parcel falls wholly within a zoning district, or that a delivery point sits inside an authorized service zone.

Choose `ST_Within` when the business rule demands full containment and partial overlaps must be rejected. Choose `ST_Intersects` when any spatial contact qualifies — it also benefits from slightly better index selectivity in many distributions because its result set is never smaller than `ST_Within`'s.

The precondition for either predicate is that both geometries must share the same Spatial Reference Identifier (SRID). A mismatch causes PostGIS to compare coordinates in different systems and return silent `FALSE` results with no error. Always normalize to a single SRID — typically EPSG:4326 for WGS84 web APIs — before running the predicate.

For the broader indexing and query-planning decisions that determine which spatial predicate pair to reach for at the architecture level, see [Bounding Box & Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/).

## How ST_Within and ST_Intersects Relate to the GiST Index

Before writing code, it helps to understand the two-phase evaluation PostGIS uses for any spatial predicate.

<svg viewBox="0 0 720 300" role="img" aria-label="Two-phase spatial query evaluation: bounding-box index filter followed by exact geometry test" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Two-phase spatial query evaluation</title>
  <desc>A diagram showing Phase 1 (GiST bounding-box filter using the &amp;&amp; operator) narrowing down candidate rows, followed by Phase 2 (exact ST_Intersects or ST_Within geometry test) returning the final result set.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Phase 1 box -->
  <rect x="30" y="80" width="200" height="140" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
  <text x="130" y="72" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="sans-serif">Phase 1 — Index</text>
  <rect x="55" y="100" width="150" height="50" rx="6" fill="currentColor" opacity="0.08"/>
  <text x="130" y="121" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">&amp;&amp; operator</text>
  <text x="130" y="138" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7" font-family="sans-serif">bounding-box overlap</text>
  <text x="130" y="178" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="sans-serif">GiST index scan</text>
  <text x="130" y="194" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="sans-serif">returns candidates</text>
  <!-- Arrow -->
  <line x1="230" y1="150" x2="290" y2="150" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arr)"/>
  <text x="260" y="142" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="sans-serif">candidates</text>
  <!-- Phase 2 box -->
  <rect x="290" y="80" width="200" height="140" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
  <text x="390" y="72" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="sans-serif">Phase 2 — Exact Test</text>
  <rect x="315" y="100" width="150" height="50" rx="6" fill="currentColor" opacity="0.08"/>
  <text x="390" y="121" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">ST_Intersects</text>
  <text x="390" y="138" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">ST_Within</text>
  <text x="390" y="178" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="sans-serif">exact geometry test</text>
  <text x="390" y="194" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="sans-serif">on candidate rows only</text>
  <!-- Arrow -->
  <line x1="490" y1="150" x2="550" y2="150" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arr)"/>
  <text x="520" y="142" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="sans-serif">results</text>
  <!-- Result box -->
  <rect x="550" y="110" width="140" height="80" rx="10" fill="currentColor" opacity="0.07"/>
  <text x="620" y="148" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Final</text>
  <text x="620" y="165" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">result set</text>
  <!-- Note -->
  <text x="360" y="270" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.5" font-family="sans-serif">Without a GiST index, Phase 1 becomes a sequential scan — Phase 2 runs on every row.</text>
</svg>

Phase 1 uses the `&&` bounding-box operator, which the GiST index answers in O(log n). Phase 2 applies the exact predicate only to the surviving candidate rows. Without the index, Phase 2 runs against the entire table. The `CREATE INDEX` command below is not optional in production — it is what makes these queries viable at scale.

## Runnable Implementation

The endpoint below accepts a GeoJSON geometry, validates it with Pydantic v2, repairs topology with Shapely, normalizes to EPSG:4326, and executes either `ST_Intersects` or `ST_Within` using SQLAlchemy 2.0 syntax. Geometry validation patterns used here build on the approach described in [Validating WKT and GeoJSON with Pydantic v2](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/).

```python
# requirements: fastapi>=0.111, sqlalchemy>=2.0, geoalchemy2>=0.14,
#               shapely>=2.0, psycopg2-binary>=2.9

from fastapi import FastAPI, HTTPException, Depends, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import create_engine, select, func, Column, Integer, String, text
from sqlalchemy.orm import Session, sessionmaker, DeclarativeBase
from geoalchemy2 import Geometry
from shapely.geometry import shape as shapely_shape, mapping
from shapely.validation import make_valid
from typing import Literal
import logging

app = FastAPI()
logger = logging.getLogger(__name__)

DATABASE_URL = "postgresql+psycopg2://user:pass@localhost:5432/gis_db"
engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=10)
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    pass


class Location(Base):
    __tablename__ = "locations"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    # geometry_type="GEOMETRY" accepts any PostGIS type; restrict if your
    # table holds only polygons: geometry_type="POLYGON"
    geom = Column(Geometry(geometry_type="GEOMETRY", srid=4326))


# Pydantic v2 request contract
class SpatialQueryRequest(BaseModel):
    geometry: dict = Field(
        ...,
        description="RFC 7946 GeoJSON geometry object (Polygon or MultiPolygon)"
    )
    predicate: Literal["intersects", "within"] = Field(
        "intersects",
        description="Spatial predicate to apply. 'intersects' includes partial overlap; "
                    "'within' requires full containment."
    )

    @model_validator(mode="after")
    def validate_geometry(self) -> "SpatialQueryRequest":
        geo_type = self.geometry.get("type", "")
        if geo_type not in ("Polygon", "MultiPolygon"):
            raise ValueError(
                f"geometry.type must be 'Polygon' or 'MultiPolygon', got '{geo_type}'"
            )
        try:
            shapely_shape(self.geometry)  # raises if coordinates are malformed
        except Exception as exc:
            raise ValueError(f"Invalid GeoJSON geometry: {exc}") from exc
        return self


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@app.post("/api/v1/spatial/query", status_code=status.HTTP_200_OK)
def run_spatial_query(
    body: SpatialQueryRequest,
    db: Session = Depends(get_db),
):
    try:
        # --- 1. Normalize and repair topology ---
        geom = shapely_shape(body.geometry)
        if not geom.is_valid:
            geom = make_valid(geom)
            logger.warning("Input geometry was invalid; auto-repaired with make_valid()")

        # WKT binding is driver-agnostic and avoids binary encoding bugs
        wkt = geom.wkt

        # --- 2. Build parameterized geometry expression with explicit SRID ---
        # ST_GeomFromText assigns SRID=4326; ST_Transform would re-project if needed.
        input_geom = func.ST_GeomFromText(wkt, 4326)

        # --- 3. Apply two-step index + exact-predicate pattern ---
        # The && operator triggers the GiST index scan (Phase 1).
        # The spatial predicate then runs only on index-selected candidates (Phase 2).
        if body.predicate == "intersects":
            spatial_condition = func.ST_Intersects(Location.geom, input_geom)
        else:
            spatial_condition = func.ST_Within(Location.geom, input_geom)

        stmt = (
            select(Location)
            .where(Location.geom.op("&&")(input_geom))   # bounding-box pre-filter
            .where(spatial_condition)                      # exact predicate
        )

        results = db.scalars(stmt).all()

        return {
            "predicate": body.predicate,
            "count": len(results),
            "features": [{"id": r.id, "name": r.name} for r in results],
        }

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Spatial query error: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Spatial query failed. Verify coordinates are valid WGS84 and the geometry is closed.",
        )
```

The `&&` pre-filter on line 3 of the query is what ensures the GiST index is actually used — without it, the query planner sometimes performs a sequential scan even when the index exists, particularly on small tables or with unusual statistics.

## Key Parameters & Options

| Parameter / Concept | Value / Notes |
|---|---|
| `geometry_type` in `Geometry()` | `"POLYGON"`, `"MULTIPOLYGON"`, or `"GEOMETRY"`. Restricting to a specific type lets PostGIS enforce type-level constraints at insert time. |
| `srid` in `Geometry()` | Must match the SRID used in `ST_GeomFromText`. Mismatch causes silent `FALSE` returns. Default is `0` (unknown) — always set it explicitly. |
| `pool_pre_ping=True` | Issues a lightweight `SELECT 1` before each connection checkout; prevents `OperationalError` on idle connections recycled after PostgreSQL's `tcp_keepalives_idle` timeout. |
| `pool_size` | Tune to match your PostGIS `max_connections` divided by number of API workers. Exceeding `max_connections` raises `too many connections`. |
| `make_valid()` | Shapely 2.x uses GEOS `MakeValid`. Repairs self-intersecting rings and unclosed polygons. The original topology type is preserved where possible. |
| `ST_GeomFromText(wkt, srid)` | Preferred over `ST_GeomFromGeoJSON` for WKT strings; avoids a JSON-parse step inside the database. |
| `ST_Transform(geom, target_srid)` | Use when input coordinates are in a projected CRS (e.g., EPSG:27700 British National Grid) and the stored data is in EPSG:4326. |

## Gotchas & Failure Modes

- **Silent `FALSE` from SRID mismatch.** If the table column has `srid=4326` and you bind input geometry without an explicit SRID (e.g., `ST_GeomFromText(wkt)` with no second argument), PostGIS assigns SRID 0. The predicate evaluates against geometries in different coordinate systems and consistently returns `FALSE` — no error is raised. Always include the SRID argument.

- **`&&` absent means sequential scan on small tables.** The PostgreSQL query planner sometimes skips the GiST index on tables with fewer than roughly 1 000 rows because a sequential scan is cheaper. If you are testing locally with a small fixture dataset and notice the index is not being used in `EXPLAIN ANALYZE`, that is expected — verify index usage under realistic data volumes, or force it with `SET enable_seqscan = off` during development.

- **`ST_Within` asymmetry.** `ST_Within(A, B)` is not the same as `ST_Within(B, A)`. Swapping the argument order silently changes the semantic: `ST_Within(Location.geom, input_geom)` asks "is each stored feature inside the search polygon?", while `ST_Within(input_geom, Location.geom)` asks "is the search polygon inside each feature?". This is a common copy-paste error.

- **`make_valid` changes geometry type.** For degenerate inputs (e.g., a polygon that collapses to a line), `make_valid` may return a `GeometryCollection` instead of a `Polygon`. If your `Geometry` column is typed as `POLYGON`, the subsequent insert or comparison raises `InvalidParameterValue: Geometry type (GeometryCollection) does not match column type (Polygon)`. Handle the returned type after repair.

- **Large result sets and memory.** `db.scalars(stmt).all()` loads the entire result set into Python memory. For endpoints that may return thousands of features, apply [cursor-based pagination](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) rather than `LIMIT/OFFSET`, and stream [GeoJSON serialization](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) to avoid buffering full feature collections.

## Verification Snippet

Create the index first, then query the endpoint and inspect the plan:

```sql
-- 1. Create the GiST index (run once after table creation)
CREATE INDEX IF NOT EXISTS idx_locations_geom
    ON locations USING GIST (geom);

-- 2. Gather fresh statistics so the planner knows your data distribution
ANALYZE locations;

-- 3. Confirm index usage for an intersects query
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, name
FROM   locations
WHERE  geom && ST_GeomFromText('POLYGON((...))', 4326)
  AND  ST_Intersects(geom, ST_GeomFromText('POLYGON((...))', 4326));
-- Look for "Index Scan using idx_locations_geom" in the output.
-- "Bitmap Heap Scan" also indicates index use on larger tables.
-- "Seq Scan" means the planner chose a full-table scan — check row counts and statistics.
```

You can also exercise the FastAPI endpoint directly:

```bash
curl -s -X POST http://localhost:8000/api/v1/spatial/query \
  -H "Content-Type: application/json" \
  -d '{
    "predicate": "within",
    "geometry": {
      "type": "Polygon",
      "coordinates": [[
        [-0.15, 51.49], [-0.05, 51.49],
        [-0.05, 51.52], [-0.15, 51.52],
        [-0.15, 51.49]
      ]]
    }
  }' | python3 -m json.tool
# Expected: {"predicate": "within", "count": <n>, "features": [...]}
```

A `count` of `0` when you expect results almost always means an SRID mismatch or a geometry that failed Pydantic validation before reaching the database. Add `logger.debug("WKT: %s", wkt)` just before the query to confirm the geometry was parsed correctly.

---

## Related

- [Bounding Box & Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — index design, `&&` operator semantics, and query plan analysis for spatial endpoints
- [Validating WKT and GeoJSON with Pydantic v2](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/) — Pydantic v2 geometry validators, coordinate bounds checking, and topology repair patterns
- [Spatial Pagination & Cursor Strategies](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — cursor-based pagination for large spatial result sets
- [Reading EXPLAIN ANALYZE for Spatial Query Optimization](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/) — interpreting PostGIS query plans and confirming index usage

← Back to [Bounding Box & Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/)
