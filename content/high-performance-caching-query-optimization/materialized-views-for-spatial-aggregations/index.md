---
layout: layouts/page.njk
title: "Materialized Views for Spatial Aggregations in PostGIS"
description: "Precompute expensive spatial aggregations — heatmap grids, boundary rollups, ST_Union dissolves, per-cell counts — as PostGIS materialized views so FastAPI read endpoints stay fast. Covers GiST + UNIQUE indexing, concurrent refresh, and when a view beats query-time caching."
slug: "materialized-views-for-spatial-aggregations"
breadcrumb:
  - label: "High-Performance Caching & Query Optimization"
    url: "/high-performance-caching-query-optimization/"
  - label: "Materialized Views for Spatial Aggregations"
    url: "/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/"
datePublished: "2025-09-08"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Materialized Views for Spatial Aggregations in PostGIS",
      "description": "Precompute expensive spatial aggregations — heatmap grids, boundary rollups, ST_Union dissolves, per-cell counts — as PostGIS materialized views so FastAPI read endpoints stay fast. Covers GiST + UNIQUE indexing, concurrent refresh, and when a view beats query-time caching.",
      "datePublished": "2025-09-08",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "Article",
      "headline": "Materialized Views for Spatial Aggregations in PostGIS",
      "datePublished": "2025-09-08",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/"},
        {"@type": "ListItem", "position": 2, "name": "High-Performance Caching & Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/"},
        {"@type": "ListItem", "position": 3, "name": "Materialized Views for Spatial Aggregations", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Precompute Spatial Aggregations with PostGIS Materialized Views",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Write the aggregation query with ST_Union, grid binning, or boundary rollups"},
        {"@type": "HowToStep", "position": 2, "name": "Create the materialized view WITH DATA"},
        {"@type": "HowToStep", "position": 3, "name": "Add a GiST index on the geometry column and a UNIQUE index for concurrent refresh"},
        {"@type": "HowToStep", "position": 4, "name": "Serve the view from a FastAPI read route"},
        {"@type": "HowToStep", "position": 5, "name": "Verify with EXPLAIN ANALYZE and schedule REFRESH MATERIALIZED VIEW CONCURRENTLY"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "When does a materialized view beat query-time Redis caching for spatial aggregations?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "A materialized view wins when a single expensive aggregation — an ST_Union dissolve or a per-cell count over millions of rows — is reused by many query shapes: bounding-box filters, KNN lookups, and attribute joins can all run against the precomputed result with its own GiST index. Redis wins for hot, identical key-value responses with tight TTLs. If clients query the same aggregate many different ways, materialize it; if they hammer one identical response, cache it in Redis."
          }
        },
        {
          "@type": "Question",
          "name": "Why do I get 'cannot refresh materialized view concurrently' errors?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "REFRESH MATERIALIZED VIEW CONCURRENTLY requires at least one UNIQUE index covering every row of the view, so PostgreSQL can diff old and new rows instead of taking an ACCESS EXCLUSIVE lock. Without that unique index the command fails with 'cannot refresh materialized view concurrently'. Add CREATE UNIQUE INDEX on a stable key such as the grid cell id or the boundary gid before scheduling concurrent refreshes."
          }
        },
        {
          "@type": "Question",
          "name": "How do I avoid stale reads from a spatial materialized view?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "A materialized view is a snapshot: it never reflects writes to the base tables until you refresh it. Bound the staleness by scheduling REFRESH MATERIALIZED VIEW CONCURRENTLY at an interval shorter than your freshness SLA, expose the last refresh timestamp to clients in a header or metadata field, and for data that must be live, route those requests to an on-the-fly query instead of the view."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/)

# Materialized views for spatial aggregations in PostGIS

Some spatial reads are cheap: a point lookup, a bounding-box scan against a GiST index. Others are ruinously expensive to run per request: dissolving thousands of parcels into a single administrative boundary with `ST_Union`, binning millions of GPS pings into a heatmap grid and counting per cell, or rolling attribute sums up to a country polygon. Running these at query time turns a 5 ms endpoint into a 4-second one, holds a backend connection for the whole aggregation, and collapses under concurrent load. A PostGIS **materialized view** solves this by computing the aggregate once, storing the result as a physical table on disk, and letting read endpoints scan it — with their own spatial index — in single-digit milliseconds.

This guide shows how to build spatial materialized views correctly: writing the aggregation, indexing the view (both a GiST index for spatial predicates and a UNIQUE index that unlocks concurrent refresh), serving it from FastAPI, and deciding when a view is the right tool versus an on-the-fly query or a [Redis cache in front of the database](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/). It sits alongside [query plan analysis and index tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) in the broader [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/) picture — a materialized view is only fast if the query planner actually uses its indexes.

---

## Architecture overview

The diagram below shows where a materialized view sits: an expensive aggregation over base tables is computed once during refresh and written to disk; read endpoints then scan the indexed view instead of re-running the aggregation on every request.

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Materialized view precomputes a spatial aggregation once; FastAPI read routes scan the indexed view instead of re-aggregating the base tables per request" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Spatial materialized view read path</title>
  <desc>Base tables (parcels, gps_pings) feed an expensive aggregation using ST_Union and grid binning. A scheduled refresh writes the result into a materialized view stored on disk with a GiST index and a UNIQUE index. FastAPI read routes scan the indexed view in milliseconds, bypassing the per-request aggregation. A refresh scheduler runs REFRESH MATERIALIZED VIEW CONCURRENTLY on an interval.</desc>
  <rect x="0" y="0" width="760" height="340" rx="12" fill="none"/>
  <!-- Base tables group -->
  <rect x="18" y="40" width="180" height="180" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 3" opacity="0.55"/>
  <text x="108" y="32" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">Base tables</text>
  <rect x="34" y="58" width="148" height="42" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="108" y="80" text-anchor="middle" font-size="12" fill="currentColor">parcels</text>
  <text x="108" y="94" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">geom · admin_id</text>
  <rect x="34" y="118" width="148" height="42" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="108" y="140" text-anchor="middle" font-size="12" fill="currentColor">gps_pings</text>
  <text x="108" y="154" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">10M+ rows</text>
  <text x="108" y="200" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">frequent writes</text>
  <!-- Aggregation box -->
  <rect x="248" y="70" width="150" height="120" rx="10" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="323" y="98" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Aggregation</text>
  <text x="323" y="120" text-anchor="middle" font-size="11" fill="currentColor">ST_Union dissolve</text>
  <text x="323" y="138" text-anchor="middle" font-size="11" fill="currentColor">grid binning</text>
  <text x="323" y="156" text-anchor="middle" font-size="11" fill="currentColor">per-cell counts</text>
  <text x="323" y="178" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">seconds per run</text>
  <line x1="182" y1="100" x2="246" y2="120" stroke="currentColor" stroke-width="1.5" marker-end="url(#mv-arr)"/>
  <line x1="182" y1="139" x2="246" y2="140" stroke="currentColor" stroke-width="1.5" marker-end="url(#mv-arr)"/>
  <!-- Refresh scheduler -->
  <rect x="248" y="240" width="150" height="56" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 2"/>
  <text x="323" y="264" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Refresh scheduler</text>
  <text x="323" y="282" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">pg_cron · CONCURRENTLY</text>
  <line x1="323" y1="240" x2="323" y2="192" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2" marker-end="url(#mv-arr)"/>
  <!-- Materialized view -->
  <rect x="452" y="70" width="172" height="120" rx="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="538" y="96" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Materialized view</text>
  <text x="538" y="116" text-anchor="middle" font-size="11" fill="currentColor">on-disk snapshot</text>
  <text x="538" y="138" text-anchor="middle" font-size="11" fill="currentColor">GiST index (geom)</text>
  <text x="538" y="156" text-anchor="middle" font-size="11" fill="currentColor">UNIQUE index (key)</text>
  <text x="538" y="178" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">scanned in ms</text>
  <line x1="398" y1="130" x2="450" y2="130" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#mv-arr)"/>
  <!-- FastAPI read -->
  <rect x="644" y="86" width="100" height="88" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="694" y="122" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">FastAPI</text>
  <text x="694" y="140" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">read route</text>
  <line x1="624" y1="130" x2="642" y2="130" stroke="currentColor" stroke-width="1.5" marker-end="url(#mv-arr)"/>
  <defs>
    <marker id="mv-arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

---

## Prerequisites & Environment

Materialized views have been in PostgreSQL since 9.3, and `REFRESH ... CONCURRENTLY` since 9.4, so version pressure comes from PostGIS and the async stack, not the view machinery itself.

| Component | Minimum version | Why it matters |
|---|---|---|
| PostgreSQL | 14+ | Stable `CONCURRENTLY` refresh planning; `pg_cron` compatibility |
| PostGIS | 3.3+ | `ST_Union`, `ST_SnapToGrid`, `ST_AsMVTGeom`, `ST_HexagonGrid` all available |
| pg_cron | 1.5+ | In-database refresh scheduling (optional; external scheduler works too) |
| FastAPI | 0.100+ | Async lifespan, Python 3.10+ |
| asyncpg | 0.29+ | Binary geometry parsing on the read path |
| SQLAlchemy | 2.0+ | `AsyncSession`, `text()` with bound parameters |

Confirm the aggregation functions you rely on are present before building anything:

```sql
-- Verify PostGIS build and that grid/dissolve functions exist
SELECT PostGIS_Full_Version();
SELECT proname FROM pg_proc
WHERE proname IN ('st_union', 'st_snaptogrid', 'st_hexagongrid', 'st_asmvtgeom')
ORDER BY proname;
```

If `st_hexagongrid` is missing you are on PostGIS < 3.1; fall back to `ST_SnapToGrid` for square binning. Install `pg_cron` by adding it to `shared_preload_libraries` and running `CREATE EXTENSION pg_cron;` in the target database — covered in depth in [scheduling concurrent refresh of spatial materialized views](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/scheduling-concurrent-refresh-of-spatial-materialized-views/).

---

## Decision matrix: materialized view vs on-the-fly query vs Redis cache

Before writing a `CREATE MATERIALIZED VIEW`, decide it is actually the right layer. These three approaches solve overlapping but distinct problems.

| Dimension | Materialized view | On-the-fly query | Redis cache |
|---|---|---|---|
| Where result lives | On disk, in Postgres | Nowhere (recomputed) | In Redis memory |
| Freshness | Snapshot until refresh | Always live | TTL-bounded |
| Query flexibility | High — indexable, joinable, filterable many ways | High — arbitrary | Low — one key, one response |
| Cost per read | Low (index scan) | High (full aggregation) | Very low (memory GET) |
| Cost per write | Deferred to refresh | None | Invalidation logic |
| Best for | Reusable heavy aggregates queried many ways | Live data, low query volume | Hot identical responses, tight TTL |
| Cold start | None (persisted) | N/A | Empty until first miss |

The heuristic: **materialize when one expensive aggregation is reused by many query shapes**; **cache in Redis when the same exact response is requested repeatedly**; **query on the fly when data must be live and volume is low**. These are not mutually exclusive — a common production stack materializes a heatmap grid, then puts a short Redis TTL in front of the most popular bounding boxes. The head-to-head trade-offs are worked through in [PostGIS materialized views vs Redis query caching](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/postgis-materialized-views-vs-redis-query-caching/).

---

## Step-by-Step Implementation

### Step 1: Write the aggregation query

Start with the raw aggregation and prove it returns what you want before wrapping it in a view. Here we bin GPS pings into a 250 m grid and count per cell — a heatmap source.

```sql
-- Per-cell counts on a 250 m grid in Web Mercator (EPSG:3857).
-- ST_SnapToGrid collapses points to a shared origin so GROUP BY buckets them.
SELECT
    ST_SnapToGrid(ST_Transform(geom, 3857), 250) AS cell_geom,
    count(*)                                      AS ping_count,
    avg(speed_kmh)                                AS avg_speed
FROM gps_pings
WHERE captured_at >= now() - interval '90 days'
GROUP BY ST_SnapToGrid(ST_Transform(geom, 3857), 250);
```

A boundary rollup — dissolving parcels into administrative polygons with `ST_Union` — is the other canonical case:

```sql
-- Dissolve parcels into one polygon per admin region, summing attributes.
SELECT
    admin_id,
    ST_Union(geom)         AS boundary_geom,
    sum(assessed_value)    AS total_value,
    count(*)               AS parcel_count
FROM parcels
WHERE ST_IsValid(geom)          -- guard: ST_Union returns NULL on invalid input
GROUP BY admin_id;
```

### Step 2: Create the materialized view

Wrap the aggregation. Materialize it immediately with `WITH DATA` so the first read does not trigger the full computation. Add a stable synthetic key — a plain row number here — because the grid geometry alone is not guaranteed unique enough to index cheaply, and Step 3 needs a UNIQUE key.

```sql
CREATE MATERIALIZED VIEW mv_ping_heatmap AS
SELECT
    row_number() OVER ()                          AS cell_id,   -- stable unique key
    ST_SnapToGrid(ST_Transform(geom, 3857), 250)  AS cell_geom,
    count(*)                                       AS ping_count,
    avg(speed_kmh)                                 AS avg_speed
FROM gps_pings
WHERE captured_at >= now() - interval '90 days'
GROUP BY ST_SnapToGrid(ST_Transform(geom, 3857), 250)
WITH DATA;
```

### Step 3: Index the view — GiST *and* UNIQUE

This is the step that people skip and then hit a wall on. A materialized view needs **two** indexes for a production spatial read path:

- A **GiST index** on the geometry column so bounding-box and `ST_Intersects` predicates use an index scan, exactly as they would on a base table.
- A **UNIQUE index** on the stable key. This is the hard prerequisite for `REFRESH MATERIALIZED VIEW CONCURRENTLY`; without it the concurrent refresh command fails outright.

```sql
-- Spatial index: enables index scans for bbox / intersects filters on the view
CREATE INDEX idx_mv_ping_heatmap_geom
    ON mv_ping_heatmap USING GIST (cell_geom);

-- UNIQUE index: REQUIRED for concurrent refresh. Must cover every row uniquely.
CREATE UNIQUE INDEX uq_mv_ping_heatmap_cell
    ON mv_ping_heatmap (cell_id);

-- Refresh statistics so the planner costs the view accurately
ANALYZE mv_ping_heatmap;
```

If your natural key already uniquely identifies every row — `admin_id` in the boundary rollup, for example — index that directly instead of a synthetic `row_number()`. The concurrent-refresh mechanics and scheduling are detailed in [scheduling concurrent refresh of spatial materialized views](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/scheduling-concurrent-refresh-of-spatial-materialized-views/).

### Step 4: Choose a refresh strategy

Three strategies, chosen by freshness need and view size:

1. **Plain `REFRESH MATERIALIZED VIEW mv_ping_heatmap;`** — fastest to compute, but takes an `ACCESS EXCLUSIVE` lock, so reads block for the whole rebuild. Fine for off-peak nightly refreshes.
2. **`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ping_heatmap;`** — keeps the view readable throughout by diffing rows against the unique index. Slower and more I/O-heavy, but no read downtime. This is the default for endpoints serving live traffic.
3. **Event-driven refresh** — trigger a refresh from the application after a batch write completes, rather than on a fixed clock, when writes are bursty and infrequent.

### Step 5: Serve the view from FastAPI

Read routes treat the view exactly like a table — the win is that the expensive work already happened. Cross-link the read path to [query plan analysis](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) so you can confirm the GiST index is used.

The full route is in the next section.

---

## Production Code Example

A FastAPI read route serving the heatmap grid as GeoJSON, filtered to a client bounding box. Every geometry predicate hits the view's GiST index; the aggregation was precomputed at refresh time, so this endpoint returns in milliseconds regardless of how many billions of pings underlie it. The response also surfaces the view's last refresh time so clients can reason about staleness.

```python
# app/routes/heatmap.py
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from typing import Any
from ..dependencies import get_db

router = APIRouter(prefix="/heatmap", tags=["heatmap"])

# Bounding-box scan over the materialized view. The && operator uses the
# GiST index on cell_geom; the view is in EPSG:3857 so we build the
# envelope in 3857 as well. No ST_Union / GROUP BY here — it is precomputed.
HEATMAP_QUERY = text("""
    SELECT
        cell_id,
        ST_AsGeoJSON(ST_Transform(cell_geom, 4326), 6)::jsonb AS geometry,
        ping_count,
        round(avg_speed::numeric, 1) AS avg_speed
    FROM mv_ping_heatmap
    WHERE cell_geom && ST_Transform(
        ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326), 3857
    )
    ORDER BY ping_count DESC
    LIMIT :limit
""")

# pg_matviews exposes no refresh time, so we read it from a bookkeeping table
# that the refresh job stamps (see the scheduling guide). Falls back to NULL.
REFRESH_META = text("""
    SELECT last_refresh FROM mv_refresh_log
    WHERE view_name = 'mv_ping_heatmap'
""")


@router.get("/cells")
async def heatmap_cells(
    minx: float = Query(..., description="West longitude (EPSG:4326)"),
    miny: float = Query(..., description="South latitude"),
    maxx: float = Query(..., description="East longitude"),
    maxy: float = Query(..., description="North latitude"),
    limit: int = Query(2000, le=10000),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """
    Return a GeoJSON FeatureCollection of heatmap grid cells within the
    bounding box, read from the precomputed materialized view.
    """
    if minx >= maxx or miny >= maxy:
        raise HTTPException(status_code=400, detail="Invalid bounding box.")

    result = await db.execute(
        HEATMAP_QUERY,
        {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy, "limit": limit},
    )
    rows = result.mappings().all()

    meta = await db.execute(REFRESH_META)
    last_refresh = meta.scalar()

    features = [
        {
            "type": "Feature",
            "id": row["cell_id"],
            "geometry": row["geometry"],
            "properties": {
                "ping_count": row["ping_count"],
                "avg_speed": float(row["avg_speed"]) if row["avg_speed"] else None,
            },
        }
        for row in rows
    ]

    return {
        "type": "FeatureCollection",
        "features": features,
        "meta": {"last_refresh": last_refresh.isoformat() if last_refresh else None},
    }
```

The route never issues an `ST_Union` or a `GROUP BY`; those ran once during refresh. It is a pure indexed scan over a physical table, so it behaves like any other bounding-box endpoint — the same double-predicate GiST pattern used across the [caching and query optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/) work applies unchanged.

---

## Verification & Testing

**Confirm the GiST index is used** — run `EXPLAIN ANALYZE` on the view query, not the base tables:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT cell_id, ping_count
FROM mv_ping_heatmap
WHERE cell_geom && ST_MakeEnvelope(-8250000, 4900000, -8200000, 4950000, 3857);
```

Look for `Index Scan using idx_mv_ping_heatmap_geom` (or a `Bitmap Index Scan` on it). A `Seq Scan` on the view means the planner ignored the GiST index — usually because `ANALYZE` was never run after creation, or the envelope SRID does not match the view's SRID.

**Time a refresh** to size your schedule window:

```sql
\timing on
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ping_heatmap;
-- Time: 8423.551 ms  ← this must comfortably fit inside your refresh interval
```

**Check the view is populated and current:**

```sql
-- ispopulated is false if the view was created WITH NO DATA and never refreshed
SELECT matviewname, ispopulated FROM pg_matviews WHERE matviewname = 'mv_ping_heatmap';
SELECT count(*) FROM mv_ping_heatmap;
```

**Smoke-test the endpoint:**

```bash
curl -s "http://localhost:8000/heatmap/cells?minx=-74.05&miny=40.68&maxx=-73.90&maxy=40.82&limit=500" \
  | jq '{n: (.features | length), refreshed: .meta.last_refresh}'
```

**Unit test skeleton (pytest-asyncio):**

```python
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_heatmap_returns_feature_collection():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get(
            "/heatmap/cells",
            params={"minx": -74.05, "miny": 40.68, "maxx": -73.90, "maxy": 40.82},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["type"] == "FeatureCollection"
    assert "last_refresh" in body["meta"]
```

---

## Failure Modes & Edge Cases

1. **`cannot refresh materialized view concurrently` and detail `Create a unique index with no WHERE clause on one or more columns of the materialized view`** — you ran `REFRESH ... CONCURRENTLY` without a covering UNIQUE index. Add `CREATE UNIQUE INDEX ... ON mv_name (stable_key)`. The index must be unique, non-partial (no `WHERE`), and cover the whole row set. A partial unique index does *not* satisfy the requirement.

2. **Stale reads after base-table writes.** The view is a snapshot; inserts and updates to `gps_pings` or `parcels` are invisible until the next refresh. This is by design, not a bug. Bound staleness with a scheduled refresh shorter than your SLA and expose `last_refresh` to clients, as the example route does. Data that must be live should bypass the view.

3. **`ST_Union` returns NULL and rows vanish.** A single invalid geometry in the aggregation group makes `ST_Union` return `NULL` for that group, silently dropping it from the view. Guard with `WHERE ST_IsValid(geom)` or repair upstream with `ST_MakeValid(geom)` before the union.

4. **Concurrent refresh is slower than a full rebuild and pins disk.** `CONCURRENTLY` builds a fresh temp copy, diffs it against the live view via the unique index, and applies the delta — that is more total I/O than a plain refresh. On a large heatmap grid a concurrent refresh can take 2–4× the wall-clock of a plain one. If reads can tolerate a brief lock during an off-peak window, plain refresh is cheaper.

5. **Refresh window overrun / overlapping refreshes.** If a refresh takes longer than its schedule interval, a second refresh can start before the first finishes, doubling load. Serialize refreshes with an advisory lock or a job-level mutex — covered in [scheduling concurrent refresh](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/scheduling-concurrent-refresh-of-spatial-materialized-views/).

6. **`Seq Scan` on the view despite a GiST index.** The planner has no statistics until you `ANALYZE` the view — creation does not populate `pg_statistic`. Always `ANALYZE mv_name;` immediately after `CREATE` and after each refresh if row counts shift dramatically. A refresh does update statistics for `CONCURRENTLY`, but the first plan after creation needs an explicit `ANALYZE`.

7. **Dropped dependent objects on `DROP MATERIALIZED VIEW`.** Views, functions, or other materialized views built on top of this one are dropped with `CASCADE`. Check `pg_depend` before dropping, or you will silently lose downstream rollups.

---

## Performance Notes

**Read latency.** A bounding-box scan over an indexed heatmap grid of ~40,000 cells returns in 2–6 ms — indistinguishable from a base-table lookup, because it *is* one. The same query expressed as a live `ST_SnapToGrid` + `GROUP BY` over 30 million pings runs 3–9 seconds. That two-to-three-orders-of-magnitude gap is the entire justification for the view.

**Refresh cost.** Plain `REFRESH` on the 90-day heatmap runs in ~3.5 s; `REFRESH ... CONCURRENTLY` on the same view runs ~8.5 s and roughly doubles temporary disk usage during the diff. Size the refresh interval to comfortably exceed the concurrent refresh time — a 5-minute schedule for an 8.5 s refresh leaves ample headroom and no overlap risk.

**Storage.** The heatmap view is tiny relative to its base table (tens of thousands of cell rows versus tens of millions of pings), so the disk cost is negligible. Boundary dissolves can be larger if the unioned polygons are vertex-dense; apply `ST_Simplify` or `ST_SnapToGrid` inside the view definition to cap vertex counts at the client's rendering resolution.

**vs Redis.** A view and a [Redis cache](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) are complementary, not competing. The view removes the aggregation cost for *every* query shape; Redis removes the network-plus-scan cost for the *hottest identical* responses. Stacking a short Redis TTL over the most-requested bounding boxes of a materialized view gives sub-millisecond hot reads while the view keeps cold reads cheap. The full comparison, including invalidation drift, is in [PostGIS materialized views vs Redis query caching](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/postgis-materialized-views-vs-redis-query-caching/).

**Concurrency.** Because the read route holds a connection only for a fast index scan, it multiplexes cleanly through a transaction-mode connection pool. Refreshes, by contrast, hold a backend for seconds — run them on a dedicated maintenance connection, never on the request path.

---

## FAQ

### When does a materialized view beat query-time Redis caching for spatial aggregations?

A materialized view wins when a single expensive aggregation — an `ST_Union` dissolve or a per-cell count over millions of rows — is reused by many query shapes: bounding-box filters, KNN lookups, and attribute joins can all run against the precomputed result with its own GiST index. Redis wins for hot, identical key-value responses with tight TTLs. If clients query the same aggregate many different ways, materialize it; if they hammer one identical response, cache it in Redis.

### Why do I get `cannot refresh materialized view concurrently` errors?

`REFRESH MATERIALIZED VIEW CONCURRENTLY` requires at least one UNIQUE index covering every row of the view, so PostgreSQL can diff old and new rows instead of taking an `ACCESS EXCLUSIVE` lock. Without that unique index the command fails with `cannot refresh materialized view concurrently`. Add a `CREATE UNIQUE INDEX` on a stable key — the grid `cell_id` or the boundary `admin_id` — before scheduling concurrent refreshes.

### How do I avoid stale reads from a spatial materialized view?

A materialized view is a snapshot: it never reflects writes to the base tables until you refresh it. Bound the staleness by scheduling `REFRESH MATERIALIZED VIEW CONCURRENTLY` at an interval shorter than your freshness SLA, expose the last refresh timestamp to clients in a header or metadata field, and for data that must be live, route those requests to an on-the-fly query instead of the view.

---

## Related

- [PostGIS Materialized Views vs Redis Query Caching](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/postgis-materialized-views-vs-redis-query-caching/) — pick the right caching layer for spatial aggregation results
- [Scheduling Concurrent Refresh of Spatial Materialized Views](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/scheduling-concurrent-refresh-of-spatial-materialized-views/) — pg_cron schedules, monitoring, and avoiding overlapping refreshes
- [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — TTL-bounded response caching that complements a materialized view
- [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — confirm the view's GiST index is actually used with EXPLAIN ANALYZE
- [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/) — the broader caching and optimization picture

← Back to [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/)
