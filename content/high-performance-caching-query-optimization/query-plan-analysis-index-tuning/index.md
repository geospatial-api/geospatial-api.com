---
layout: layouts/page.njk
title: "Query Plan Analysis & Index Tuning for PostGIS"
description: "Tune PostGIS query performance with EXPLAIN ANALYZE. Identify missing GiST indexes, sequential scans, and planner misestimates degrading your FastAPI spatial API."
slug: query-plan-analysis-index-tuning
type: cluster
breadcrumb: "High-Performance Caching & Query Optimization > Query Plan Analysis & Index Tuning"
datePublished: "2024-11-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Query Plan Analysis & Index Tuning for PostGIS",
      "description": "Tune PostGIS query performance with EXPLAIN ANALYZE. Identify missing GiST indexes, sequential scans, and planner misestimates degrading your FastAPI spatial API.",
      "datePublished": "2024-11-01",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "High-Performance Caching & Query Optimization", "item": "https://geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 3, "name": "Query Plan Analysis & Index Tuning", "item": "https://geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Tune PostGIS Spatial Query Performance",
      "step": [
        { "@type": "HowToStep", "name": "Isolate high-cost spatial queries using pg_stat_statements" },
        { "@type": "HowToStep", "name": "Capture execution plans with EXPLAIN (ANALYZE, BUFFERS)" },
        { "@type": "HowToStep", "name": "Align index strategy with spatial selectivity" },
        { "@type": "HowToStep", "name": "Refactor queries for planner efficiency" },
        { "@type": "HowToStep", "name": "Validate and monitor with pg_stat_user_indexes" }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does my PostGIS query ignore the GiST index?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The planner bypasses a GiST index when row estimates make a sequential scan cheaper, when the query uses ST_Distance in a WHERE clause instead of ST_DWithin, or when a cross-SRID cast forces a row-by-row geometry transformation. Run EXPLAIN (ANALYZE, BUFFERS) and look for 'Seq Scan' plus high 'Rows Removed by Filter' to confirm."
          }
        },
        {
          "@type": "Question",
          "name": "When should I use a BRIN index instead of GiST for spatial data?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use BRIN for very large (100M+ row) append-only tables where geometries are physically ordered on disk by region — IoT telemetry, historical GPS tracks, or time-partitioned sensor data. BRIN is far smaller and cheaper to maintain than GiST but gives coarser filtering, so it works best when scans are broad and sequential page access patterns match geographic clustering."
          }
        },
        {
          "@type": "Question",
          "name": "How do I force ANALYZE to update geometry column statistics?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Run ALTER TABLE parcels ALTER COLUMN geom SET STATISTICS 200; followed by ANALYZE parcels; This raises the statistics target for the geometry column so the planner can form better selectivity estimates for spatial predicates."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/)

# Query Plan Analysis & Index Tuning for PostGIS

In a FastAPI service backed by PostGIS, latency is almost never caused by network overhead alone. The real bottleneck is usually the query planner: whether it chooses a GiST index scan or a sequential scan, whether bounding-box pre-filtering fires before exact geometry evaluation, and whether row-count estimates are accurate enough to select a sensible join strategy. Getting those decisions right — reliably, at scale — is what separates spatial APIs that sustain sub-50 ms p99 from those that collapse under moderate load.

This page gives you a structured diagnostic workflow, a spatial index decision matrix, and production-ready FastAPI/SQLAlchemy 2.0 patterns to move from "query is slow" to "query is fast and stays fast". It is part of the broader [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/) strategy for geospatial backends.

---

## Prerequisites & Environment

Confirm these baseline requirements before running any spatial diagnostics:

| Requirement | Minimum version / setting |
|---|---|
| PostgreSQL | 14+ |
| PostGIS | 3.2+ (`CREATE EXTENSION IF NOT EXISTS postgis;`) |
| `pg_stat_statements` | Loaded via `shared_preload_libraries` |
| `auto_explain` | Loaded via `shared_preload_libraries` |
| FastAPI | 0.111+ |
| SQLAlchemy | 2.0 (async mode) with `asyncpg` driver |
| `work_mem` | ≥ 64 MB per connection for spatial sorts/hash joins |
| `default_statistics_target` | 100–200 for geometry columns |

Geometry and geography types must be consistent across your schema — the planner uses different cost models for planar (`geometry`) and spherical (`geography`) distance calculations, and mixing them inside predicates forces implicit casts that can bypass indexes entirely.

Enable `auto_explain` in `postgresql.conf` to capture slow plans automatically without manual instrumentation:

```ini
auto_explain.log_min_duration = 500
auto_explain.log_analyze = true
auto_explain.log_buffers = true
auto_explain.log_triggers = true
```

Any spatial query exceeding 500 ms will then log its full execution plan to `postgresql.log`. The child page [Reading EXPLAIN ANALYZE for spatial query optimization](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/) covers every output field in detail.

---

## Spatial Index Decision Matrix

Choose the right index type before writing a single `CREATE INDEX` statement. The wrong choice can be harder to fix later than the original missing index.

| Index type | Best for | Operators supported | Size vs GiST | Write overhead |
|---|---|---|---|---|
| **GiST** | Dynamic geometry columns, mixed inserts/updates | `&&`, `ST_DWithin`, `ST_Intersects`, `<->` (KNN) | Baseline | Medium |
| **BRIN** | Append-only tables ≥ 100 M rows with geographic clustering | `&&` bounding box only | ~10–100× smaller | Very low |
| **GIN** | Hybrid spatial + JSONB metadata queries | JSONB operators alongside `&&` | Larger | High |
| **B-tree** | Exact equality on numeric/text attribute columns only | `=`, `<`, `>` | Small | Low |
| **SP-GiST** | Dense point clouds or telephone-directory-style point data | `&&`, `<<`, `>>` | Similar to GiST | Medium |

For nearly all FastAPI geospatial endpoints — polygon intersection, radius search, bounding-box queries — **GiST is the default**. Switch to BRIN only when table size and write patterns justify it, and use GIN as a secondary index on the JSONB column rather than replacing GiST on geometry.

---

## SVG: Spatial Query Planner Decision Flow

The diagram below shows how PostgreSQL decides between a sequential scan, a bitmap heap scan, and a GiST index scan for a spatial predicate.

<svg viewBox="0 0 720 420" role="img" aria-label="Spatial query planner decision flow diagram" xmlns="http://www.w3.org/2000/svg">
  <title>Spatial Query Planner Decision Flow</title>
  <desc>Flowchart showing how the PostgreSQL query planner chooses between sequential scan, bitmap heap scan, and GiST index scan based on row estimates, statistics, and operator type.</desc>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Background -->
  <rect width="720" height="420" rx="12" fill="none"/>
  <!-- Start -->
  <ellipse cx="360" cy="32" rx="80" ry="22" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="360" y="37" text-anchor="middle" font-size="13" fill="currentColor" font-family="inherit">Spatial Query</text>
  <!-- Arrow down -->
  <line x1="360" y1="54" x2="360" y2="82" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <!-- Diamond 1: GiST index exists? -->
  <polygon points="360,84 460,116 360,148 260,116" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="360" y="112" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">GiST index</text>
  <text x="360" y="128" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">on geom?</text>
  <!-- No → left → Seq Scan -->
  <line x1="260" y1="116" x2="120" y2="116" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <text x="190" y="108" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit" opacity="0.9">No</text>
  <rect x="40" y="96" width="80" height="40" rx="6" fill="none" stroke="#c97070" stroke-width="1.5"/>
  <text x="80" y="118" text-anchor="middle" font-size="12" fill="#a82e1e" font-family="inherit" font-weight="600">Seq Scan</text>
  <!-- Yes → down -->
  <line x1="360" y1="148" x2="360" y2="186" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <text x="375" y="172" font-size="11" fill="currentColor" font-family="inherit" opacity="0.9">Yes</text>
  <!-- Diamond 2: Good selectivity? -->
  <polygon points="360,188 470,222 360,256 250,222" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="360" y="218" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Planner estimate:</text>
  <text x="360" y="234" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">rows &lt; 10%?</text>
  <!-- No → left → Seq Scan fallback -->
  <line x1="250" y1="222" x2="120" y2="222" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <text x="185" y="214" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit" opacity="0.9">No</text>
  <rect x="40" y="202" width="80" height="40" rx="6" fill="none" stroke="#c97070" stroke-width="1.5"/>
  <text x="80" y="220" text-anchor="middle" font-size="11" fill="#a82e1e" font-family="inherit" font-weight="600">Seq Scan</text>
  <text x="80" y="234" text-anchor="middle" font-size="10" fill="#a82e1e" font-family="inherit">(stale stats)</text>
  <!-- Yes → down -->
  <line x1="360" y1="256" x2="360" y2="294" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <text x="375" y="278" font-size="11" fill="currentColor" font-family="inherit" opacity="0.9">Yes</text>
  <!-- Diamond 3: Uses && operator? -->
  <polygon points="360,296 470,328 360,360 250,328" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="360" y="322" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Uses &amp;&amp; or</text>
  <text x="360" y="338" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">ST_DWithin?</text>
  <!-- No → right → Filter scan -->
  <line x1="470" y1="328" x2="600" y2="328" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <text x="535" y="320" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit" opacity="0.9">No</text>
  <rect x="600" y="308" width="100" height="40" rx="6" fill="none" stroke="#c97070" stroke-width="1.5"/>
  <text x="650" y="326" text-anchor="middle" font-size="11" fill="#a82e1e" font-family="inherit" font-weight="600">Row Filter</text>
  <text x="650" y="340" text-anchor="middle" font-size="10" fill="#a82e1e" font-family="inherit">(no index use)</text>
  <!-- Yes → down → GiST Index Scan -->
  <line x1="360" y1="360" x2="360" y2="396" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <text x="375" y="382" font-size="11" fill="currentColor" font-family="inherit" opacity="0.9">Yes</text>
  <rect x="290" y="396" width="140" height="20" rx="6" fill="none" stroke="#7070c9" stroke-width="1.5"/>
  <text x="360" y="410" text-anchor="middle" font-size="12" fill="#4b3a7c" font-family="inherit" font-weight="600">GiST Index Scan</text>
</svg>

---

## Step 1: Isolate High-Cost Spatial Queries

Use `pg_stat_statements` to surface which queries consume the most cumulative execution time across all sessions:

```sql
SELECT
    queryid,
    calls,
    ROUND(total_exec_time::numeric, 2)   AS total_ms,
    ROUND(mean_exec_time::numeric, 2)    AS mean_ms,
    shared_blks_read,
    rows,
    query
FROM pg_stat_statements
WHERE query ~* '(ST_Intersects|ST_DWithin|ST_Contains|ST_Distance|ST_Within|ST_Buffer)'
ORDER BY total_exec_time DESC
LIMIT 10;
```

**Signals to act on:**

- High `shared_blks_read` relative to `rows` returned — the planner is reading far more blocks than the result set justifies, pointing to a missing or unused index.
- High `calls` × elevated `mean_exec_time` — a frequently-called endpoint is mildly slow, compounding into significant CPU and I/O pressure.
- Low `rows` with high `mean_exec_time` — the predicate is selective but not using an index, so it scans everything to find almost nothing.

Reset statistics after a schema change so you are measuring the new query shapes: `SELECT pg_stat_statements_reset();`

---

## Step 2: Capture and Interpret Execution Plans

Once a problem query is identified, capture its plan at the right verbosity:

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
SELECT id, ST_AsGeoJSON(geom) AS geojson
FROM parcels
WHERE ST_Intersects(geom, ST_MakeEnvelope(-122.4, 37.7, -122.3, 37.8, 4326));
```

Key fields to inspect in the JSON output:

| Field | What it reveals |
|---|---|
| `Node Type` | `Seq Scan` = no index used; `Bitmap Heap Scan` = partial index; `Index Scan` = ideal |
| `Rows Removed by Filter` | Geometries evaluated and discarded after bounding box matched — high values signal stale statistics |
| `Shared Hit Blocks` | Blocks served from shared buffer cache (fast) |
| `Shared Read Blocks` | Blocks read from disk (slow) — minimize these |
| `Actual Rows` vs `Plan Rows` | Large divergence = planner misestimate; fix with `ANALYZE` and higher `statistics_target` |

For a complete reference on parsing these fields in spatial context, see [Reading EXPLAIN ANALYZE for spatial query optimization](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/).

---

## Step 3: Align Index Strategy with Spatial Selectivity

### Creating the right GiST index

Always build GiST indexes on the geometry or geography column and include any frequently-filtered attribute columns as `INCLUDE` columns to enable index-only scans:

```sql
-- Standard GiST for geometry
CREATE INDEX CONCURRENTLY idx_parcels_geom_gist
    ON parcels USING GIST (geom);

-- Partial GiST for active records only — smaller, faster
CREATE INDEX CONCURRENTLY idx_active_parcels_geom_gist
    ON parcels USING GIST (geom)
    WHERE status = 'active';

-- BRIN for a time-partitioned IoT telemetry table
CREATE INDEX idx_telemetry_geom_brin
    ON telemetry USING BRIN (geom) WITH (pages_per_range = 64);
```

Always use `CONCURRENTLY` in production so the build does not lock the table.

### Force bounding-box pre-filtering

PostGIS spatial functions (`ST_Intersects`, `ST_Contains`, `ST_Within`) internally use the `&&` bounding-box operator to trigger the GiST index. But if the planner's row estimate is off, it can skip the index. Make bounding-box filtering explicit when this matters:

```sql
-- Implicit (planner may or may not use GiST depending on estimates)
SELECT * FROM parcels
WHERE ST_Intersects(geom, ST_MakeEnvelope(-122.4, 37.7, -122.3, 37.8, 4326));

-- Explicit bounding box pre-filter guarantees GiST entry,
-- then exact predicate eliminates false positives
SELECT * FROM parcels
WHERE geom && ST_MakeEnvelope(-122.4, 37.7, -122.3, 37.8, 4326)
  AND ST_Intersects(geom, ST_MakeEnvelope(-122.4, 37.7, -122.3, 37.8, 4326));
```

### Update statistics for geometry columns

Raise the statistics target on geometry columns so the planner has fine-grained histogram data:

```sql
ALTER TABLE parcels ALTER COLUMN geom SET STATISTICS 200;
ANALYZE parcels;
```

The default target of 100 is often too coarse for skewed spatial distributions (e.g. dense urban areas next to sparse rural areas). A target of 200 gives the planner better selectivity estimates without significant overhead.

---

## Step 4: Refactor Queries for Planner Efficiency

### Replace ST_Distance with ST_DWithin

`ST_Distance` computes the exact distance for every candidate row before filtering. `ST_DWithin` integrates with the GiST index to stop scanning as soon as it has collected enough qualifying rows within the radius:

```sql
-- Avoid: computes distance for every row, no index leverage
WHERE ST_Distance(
    geom,
    ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326)::geography
) < 1000;

-- Use: index-aware radius scan, short-circuits on saturation
WHERE ST_DWithin(
    geom::geography,
    ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326)::geography,
    1000
);
```

### Avoid cross-SRID implicit casts

Mixing SRID 4326 data with SRID 3857 in the same predicate forces PostgreSQL to reproject every row before comparison, bypassing the index:

```sql
-- Bad: on-the-fly reprojection per row
WHERE ST_Intersects(geom_4326, ST_Transform(search_geom_3857, 4326));

-- Better: transform the search geometry once, keep geom_4326 untouched
WHERE ST_Intersects(
    geom_4326,
    ST_Transform(ST_SetSRID($1::geometry, 3857), 4326)
);
```

### Prefer geography for metric distance calculations

Use the `geography` type when you need results in meters. Avoid casting `geometry` to `geography` inside a hot loop — declare the column as `geography` at DDL time or maintain a separate indexed `geography` column.

---

## Production Code Example

A complete, copy-runnable FastAPI route using SQLAlchemy 2.0 async demonstrating explicit bounding-box pre-filtering, proper SRID handling, `ST_DWithin` radius search, and connection pool configuration:

```python
from __future__ import annotations

from fastapi import Depends, FastAPI, Query
from sqlalchemy import Column, Integer, String, select, func
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from geoalchemy2 import Geometry

DATABASE_URL = "postgresql+asyncpg://user:pass@localhost:5432/spatial_db"

engine = create_async_engine(
    DATABASE_URL,
    pool_size=20,
    max_overflow=10,
    pool_pre_ping=True,
    # Binary codec keeps geometry transfer compact
    connect_args={"server_settings": {"jit": "off"}},
)
async_session = async_sessionmaker(engine, expire_on_commit=False)


class Parcel(Base):
    __tablename__ = "parcels"
    id = Column(Integer, primary_key=True)
    name = Column(String)
    # Declare as geometry(Geometry, 4326) to keep SRID explicit
    geom = Column(Geometry("GEOMETRY", srid=4326))


app = FastAPI()


async def get_db() -> AsyncSession:
    async with async_session() as session:
        yield session


@app.get("/api/v1/parcels/nearby")
async def nearby_parcels(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_m: float = Query(1000, ge=1, le=50_000),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    """
    Return parcels within `radius_m` metres of (lat, lon).
    Uses ST_DWithin on geography for metric distances,
    ordered by proximity via ST_Distance.
    """
    point = func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326)
    point_geog = func.cast(point, func.geography())

    stmt = (
        select(
            Parcel.id,
            Parcel.name,
            func.ST_AsGeoJSON(Parcel.geom).label("geojson"),
            func.ST_Distance(
                func.cast(Parcel.geom, func.geography()), point_geog
            ).label("distance_m"),
        )
        .where(
            func.ST_DWithin(
                func.cast(Parcel.geom, func.geography()),
                point_geog,
                radius_m,
            )
        )
        .order_by("distance_m")
        .limit(limit)
    )

    result = await db.execute(stmt)
    rows = result.mappings().all()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "geojson": r["geojson"],
            "distance_m": round(r["distance_m"], 2),
        }
        for r in rows
    ]
```

Key reliability notes:
- `expire_on_commit=False` prevents lazy-loading geometry columns after session closure, which would raise a `DetachedInstanceError`.
- `jit=off` avoids rare JIT-compilation overhead on short spatial queries; re-enable and benchmark for batch/analytics workloads.
- Validate `radius_m` bounds at the FastAPI layer to prevent full-table-scan radius values that overwhelm `ST_DWithin`.

For pagination strategies on large spatial result sets, see the [Spatial Pagination & Cursor Strategies](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) guide.

---

## Verification & Testing

### Confirm the index is being used

Run the query under `EXPLAIN (ANALYZE, BUFFERS)` after index creation and check for `Bitmap Index Scan` or `Index Scan` on `idx_parcels_geom_gist`:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM parcels
WHERE ST_DWithin(
    geom::geography,
    ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326)::geography,
    1000
);
-- Expected: Bitmap Heap Scan on parcels
--             ->  Bitmap Index Scan on idx_parcels_geom_gist
--                   Index Cond: (geom && ...)
--           Buffers: shared hit=12 read=0  ← disk reads should be near zero
```

### Unit test via pytest + asyncpg

```python
import pytest
import httpx

@pytest.mark.asyncio
async def test_nearby_parcels_uses_index(async_client: httpx.AsyncClient):
    response = await async_client.get(
        "/api/v1/parcels/nearby",
        params={"lat": 37.7749, "lon": -122.4194, "radius_m": 500},
    )
    assert response.status_code == 200
    data = response.json()
    # All returned parcels must be within radius
    assert all(p["distance_m"] <= 500 for p in data)
    # Response must be fast — index means < 50 ms in test DB
    assert response.elapsed.total_seconds() < 0.05
```

### Monitor index usage over time

```sql
SELECT
    indexrelname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE relname = 'parcels'
ORDER BY idx_scan DESC;
```

Any GiST index with `idx_scan = 0` after a warm-up period is unused — consider dropping it to reclaim write I/O budget.

---

## Failure Modes & Edge Cases

1. **`Seq Scan` persists after index creation.** The planner's row estimate is too high — it believes a sequential scan is cheaper. Fix: run `ANALYZE parcels;` to refresh statistics. If estimates are still wrong, raise `default_statistics_target` for the geometry column to 200 and re-analyze.

2. **`ERROR: operator does not exist: geometry && geography`** — you are mixing `geometry` and `geography` operands in the `&&` operator. Cast both sides to the same type before comparison, or store the column consistently as one type.

3. **Index scan chosen but query is still slow.** The index is filtering correctly but `Rows Removed by Filter` is high — your bounding boxes are too large relative to the query area. Add a partial index that covers only the relevant region, or partition the table by geographic tile.

4. **`ST_DWithin` returns no results at large radii.** When `radius_m` exceeds roughly 20 000 m on a `geometry` column (not `geography`), the units shift to degrees, not meters. Always cast to `geography` for metric distances, or use `ST_DWithin(geom, point, radius_degrees)` with explicit degree conversion.

5. **Index bloat after heavy deletes/updates.** GiST indexes on geometry columns accumulate dead pages after high-churn workloads. Monitor with `SELECT * FROM pgstattuple('idx_parcels_geom_gist');` and schedule `REINDEX CONCURRENTLY` during low-traffic windows.

6. **Planner chooses merge join over nested loop for spatial join.** When joining two large geometry tables, the planner may choose a merge join strategy that does not leverage either table's GiST index. Force the better plan with `SET enable_mergejoin = off;` in the session, or restructure the join to use `ST_DWithin` with a lateral subquery.

---

## Performance Notes

| Technique | Typical latency improvement | Notes |
|---|---|---|
| GiST index on geometry column (no index → GiST) | 10–1000× | Depends on table size and selectivity |
| `ST_DWithin` replacing `ST_Distance` in `WHERE` | 5–50× | Short-circuits scan on saturation |
| Explicit `&&` bounding-box pre-filter | 2–10× | Forces index entry when planner estimates are off |
| Raising `default_statistics_target` to 200 | 1.5–3× | Prevents misestimate-driven sequential scans |
| Partial GiST on filtered subset | 1.5–5× | Smaller index = faster scan, lower memory pressure |
| `work_mem = 64 MB` for spatial sorts | 1.2–2× | Avoids disk-based sort for ORDER BY distance |

For repeated spatial queries with the same parameters — dashboard tiles, choropleth layers — supplement index tuning with [Redis Caching for Spatial Queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) to eliminate repeated database round-trips entirely. For rasterized map layers, [Tile Generation & CDN Distribution](/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) pre-generates output so the database only handles dynamic, user-driven spatial filters rather than baseline rendering volume.

Connection pool sizing is directly linked to query latency under concurrency: see [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) for how to tune `pool_size` and transaction-mode pooling for spatial workloads.

---

## Related

- [Reading EXPLAIN ANALYZE for spatial query optimization](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/) — field-by-field breakdown of PostGIS execution plan output
- [Redis Caching for Spatial Queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — cache serialized GeoJSON and tile coordinates to offload the database
- [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — tune transaction-mode pooling for concurrent spatial API traffic
- [Tile Generation & CDN Distribution](/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — shift baseline map rendering load away from real-time query execution
- [Spatial Pagination & Cursor Strategies](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — paginate large spatial result sets without offset-based row scans

← Back to [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/)
