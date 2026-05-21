---
layout: layouts/page.njk
title: "Reading EXPLAIN ANALYZE for Spatial Query Optimization"
description: "Read EXPLAIN ANALYZE for PostGIS: verify GiST indexes hit on && pre-filters, diagnose Seq Scans, and align actual execution time with your FastAPI latency SLAs."
---

# Reading EXPLAIN ANALYZE for Spatial Query Optimization

Reading `EXPLAIN ANALYZE` for spatial query optimization means verifying that PostGIS bounding-box pre-filters (`&&`) are hitting GiST indexes, that exact geometry predicates (`ST_DWithin`, `ST_Intersects`) run as efficient post-filters, and that `actual time` aligns with your API latency SLAs. Spatial queries routinely mislead developers because the PostgreSQL planner inflates costs for `VOLATILE` geometry functions. The truth lives in the execution node tree, `Rows Removed by Filter`, and buffer hit ratios. If your plan shows a `Seq Scan` on large geometry columns, missing `Index Cond`, or high `shared read` counts, your spatial index is either unused, poorly clustered, or bypassed by implicit type casts.

This workflow extends standard [Query Plan Analysis & Index Tuning](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) practices, but PostGIS requires explicit attention to operator selectivity, index-only scan limitations, and the mandatory two-phase evaluation pattern.

### Core Metrics That Matter for Spatial Plans

When PostgreSQL executes `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, isolate these spatial-specific signals:

| Metric | Spatial Meaning | Action |
|--------|----------------|--------|
| `Node Type` | `Index Scan` or `Bitmap Heap Scan` = GiST engaged. `Seq Scan` = full table scan. | Add `CREATE INDEX ... USING GIST (geom)` or rewrite the predicate. |
| `Index Cond` | Should show `geom && 'BOX(...)'::box2d`. This is the fast bounding-box pre-filter. | Ensure queries use `ST_DWithin`/`ST_Intersects`, which implicitly inject `&&`. |
| `Filter` | Exact spatial predicate (`st_dwithin(...)`, `st_intersects(...)`). | High `Rows Removed by Filter` = poor index selectivity or SRID mismatch. |
| `Buffers: shared hit/read` | `hit` = RAM cache. `read` = disk I/O. Spatial indexes are large; low hit ratios throttle throughput. | Increase `shared_buffers`, `CLUSTER` the table, or materialize hot zones. |
| `Planning Time` vs `Execution Time` | PostGIS functions are marked `VOLATILE`, artificially inflating planner cost. Ignore `cost=`; trust `actual time`. | Use `EXPLAIN (ANALYZE)` exclusively for production baselines. |

### The Two-Phase Execution Pattern

PostGIS evaluates spatial predicates in two distinct passes:
1. **Bounding Box Pre-Filter (`&&`)**: The planner uses the GiST index to quickly discard geometries whose extents don't intersect the query window. This step is cheap and index-driven.
2. **Exact Geometry Post-Filter**: Only candidates that pass the bounding box check are evaluated with expensive topology functions (`ST_Intersects`, `ST_DWithin`).

When reading the plan, the `Index Cond` line represents phase one. The `Filter` line represents phase two. A healthy spatial query shows a low `Rows Removed by Filter` count relative to the total rows scanned. If `Filter` removes >80% of rows, your bounding box isn't selective enough, or you're querying across mismatched SRIDs, forcing on-the-fly transformations that bypass the index. For deeper index mechanics, consult the official [PostGIS GiST Indexing documentation](https://postgis.net/docs/manual-3.3/using_postgis_dbmanagement.html#gist_indexes).

### FastAPI Integration for Plan Diagnostics

This endpoint captures the execution plan, runs the spatial query, and returns structured diagnostics without exposing raw SQL to clients. It uses `asyncpg` for high-concurrency connection pooling and parses the JSON plan output safely.

```python
from fastapi import FastAPI, HTTPException, Query
from contextlib import asynccontextmanager
import asyncpg
import json
from typing import Any, Dict, List

_pool: asyncpg.Pool | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _pool
    _pool = await asyncpg.create_pool(dsn="postgresql://user:pass@localhost:5432/gisdb")
    yield
    await _pool.close()

app = FastAPI(lifespan=lifespan)

@app.get("/api/v1/venues/nearby/analyze")
async def analyze_spatial_query(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_m: float = Query(1000.0, gt=0)
):
    query = """
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id, name, ST_AsText(geom)
        FROM venues
        WHERE ST_DWithin(
            geom,
            ST_SetSRID(ST_MakePoint($1, $2), 4326),
            $3
        );
    """
    
    async with _pool.acquire() as conn:
        try:
            rows = await conn.fetch(query, lon, lat, radius_m)
            # EXPLAIN (FORMAT JSON) returns a single row containing a JSON array string
            plan_json = json.loads(rows[0][0])
            
            # Extract key metrics for API response
            scan_node = plan_json[0]["Plan"]
            return {
                "plan_type": scan_node.get("Node Type"),
                "index_condition": scan_node.get("Index Cond"),
                "filter_condition": scan_node.get("Filter"),
                "rows_removed_by_filter": scan_node.get("Rows Removed by Filter", 0),
                "actual_total_time_ms": scan_node.get("Actual Total Time"),
                "shared_buffers_hit": scan_node.get("Shared Hit Blocks", 0),
                "shared_buffers_read": scan_node.get("Shared Read Blocks", 0),
                "planning_time_ms": plan_json[0]["Planning Time"],
                "execution_time_ms": plan_json[0]["Execution Time"]
            }
        except asyncpg.PostgresError as e:
            raise HTTPException(status_code=500, detail=f"Database execution failed: {e}")
```

### Diagnosing Common Spatial Plan Failures

**Implicit Type Casts Bypass Indexes**
If your `geom` column is `geometry(Point, 3857)` but you pass a `geometry` literal in `4326` without explicit casting, PostgreSQL may perform a sequential scan. Always match SRIDs in your query or create functional indexes on transformed columns.

**Missing `CLUSTER` on High-Read Tables**
GiST indexes store bounding boxes, but heap pages remain physically scattered. Over time, `shared read` counts climb as the database performs random I/O. Run `CLUSTER venues USING venues_geom_idx;` periodically to physically reorder heap rows to match the index order. This dramatically improves buffer hit ratios for hotspot queries.

**Index-Only Scans Are Rare for Geometries**
Unlike B-tree indexes, GiST indexes cannot satisfy `Index Only Scans` for geometry columns because the index stores compressed bounding boxes, not full geometries. The heap must be visited for exact evaluation. Focus on minimizing `Rows Removed by Filter` rather than chasing index-only optimizations.

**Buffer Exhaustion Under Load**
Spatial indexes easily exceed default `shared_buffers`. When `shared read` dominates `shared hit`, your API latency will spike during concurrent requests. Monitor `pg_stat_user_indexes` and scale memory allocation or implement application-level caching for static spatial boundaries. For broader strategies on reducing database round-trips and caching hot query paths, review [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/).

### Validation Checklist

Before shipping spatial endpoints, verify:
- [ ] `EXPLAIN` shows `Index Cond` with `&&` operator
- [ ] `Rows Removed by Filter` is < 30% of total scanned rows
- [ ] `Actual Total Time` matches your FastAPI p95 SLA
- [ ] `shared hit` > `shared read` on production workloads
- [ ] No implicit SRID conversions in the predicate

Reading execution plans for spatial workloads requires ignoring planner cost estimates and focusing on actual buffer behavior and post-filter efficiency. When bounding-box selectivity is high and heap access is localized, PostGIS scales linearly even on multi-million-row tables.