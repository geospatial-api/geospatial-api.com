---
layout: layouts/page.njk
title: "Reading EXPLAIN ANALYZE for Spatial Query Optimization"
description: "Read EXPLAIN ANALYZE for PostGIS: verify GiST indexes hit on && pre-filters, diagnose Seq Scans, and align actual execution time with your FastAPI latency SLAs."
---

# Reading EXPLAIN ANALYZE for Spatial Query Optimization

Reading `EXPLAIN ANALYZE` for spatial query optimization means verifying that PostGIS bounding-box pre-filters (`&&`) are hitting GiST indexes, that exact geometry predicates (`ST_DWithin`, `ST_Intersects`) run as efficient post-filters, and that `actual time` aligns with your API latency SLAs. Spatial queries routinely mislead developers because the PostgreSQL planner inflates costs for `VOLATILE` geometry functions. The truth lives in the execution node tree, `Rows Removed by Filter`, and buffer hit ratios. If your plan shows a `Seq Scan` on large geometry columns, missing `Index Cond`, or high `shared read` counts, your spatial index is either unused, poorly clustered, or bypassed by implicit type casts.

This workflow extends standard [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) practices, but PostGIS requires explicit attention to operator selectivity, index-only scan limitations, and the mandatory two-phase evaluation pattern.

### Core Metrics That Matter for Spatial Plans

When PostgreSQL executes `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, isolate these spatial-specific signals:

| Metric | Spatial Meaning | Action |
|--------|----------------|--------|
| `Node Type` | `Index Scan` or `Bitmap Heap Scan` = GiST engaged. `Seq Scan` = full table scan. | Add `CREATE INDEX ... USING GIST (geom)` or rewrite the predicate. |
| `Index Cond` | Should show `geom && 'BOX(...)'::box2d`. This is the fast bounding-box pre-filter. | Ensure queries use `ST_DWithin`/`ST_Intersects`, which implicitly inject `&&`. |
| `Filter` | Exact spatial predicate (`st_dwithin(...)`, `st_intersects(...)`). | High `Rows Removed by Filter` = poor index selectivity or SRID mismatch. |
| `Buffers: shared hit/read` | `hit` = RAM cache. `read` = disk I/O. Spatial indexes are large; low hit ratios throttle throughput. | Increase `shared_buffers`, `CLUSTER` the table, or materialize hot zones. |
| `Planning Time` vs `Execution Time` | PostGIS functions are marked `VOLATILE`, artificially inflating planner cost. Ignore `cost=`; trust `actual time`. | Use `EXPLAIN (ANALYZE)` exclusively for production baselines. |

Understanding the two phases is what makes the recheck line in a plan meaningful rather than alarming.

<svg viewBox="0 0 720 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The two phases every spatial predicate runs: index stage then heap fetch then recheck then result" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The two phases every spatial predicate runs</title>
  <desc>A left to right pipeline. Stage 1, index stage: bounding-box overlap generous by design. Stage 2, heap fetch: candidate rows read where the I/O is. Stage 3, recheck: exact geometry test removes false positives. Stage 4, result: only true matches correct by construction. A small recheck count means the index stage was well targeted; a large one means the bounding boxes overlap far more than the shapes do.</desc>
  <rect x="0" y="0" width="720" height="210" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">The two phases every spatial predicate runs</text>
  <rect x="18" y="52" width="154" height="86" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="95" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">index stage</text>
  <text x="95" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">bounding-box overlap</text>
  <text x="95" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">generous by design</text>
  <path d="M175 95 L189 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arthetwophas)"/>
  <rect x="194" y="52" width="154" height="86" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="271" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">heap fetch</text>
  <text x="271" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">candidate rows read</text>
  <text x="271" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">where the I/O is</text>
  <path d="M351 95 L365 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arthetwophas)"/>
  <rect x="370" y="52" width="154" height="86" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="447" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">recheck</text>
  <text x="447" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">exact geometry test</text>
  <text x="447" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">removes false positives</text>
  <path d="M527 95 L541 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arthetwophas)"/>
  <rect x="546" y="52" width="154" height="86" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="623" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">result</text>
  <text x="623" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">only true matches</text>
  <text x="623" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">correct by construction</text>
  <text x="20" y="168" font-size="10.5" fill="var(--muted, #7c6fb0)">A small recheck count means the index stage was well targeted; a large one means the bounding boxes overlap far more than the shapes do.</text>
  <defs><marker id="arthetwophas" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker></defs>
</svg>

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

A spatial plan is long, but only a handful of lines carry the diagnosis.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The four numbers worth reading first: Healthy when" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The four numbers worth reading first</title>
  <desc>A comparison table. actual rows vs estimated rows: Healthy when within 10×. a bad estimate means stale statistics Rows Removed by Filter: Healthy when near zero. a large value means an unindexed predicate Rows Removed by Index Recheck: Healthy when small. normal for a bounding-box stage shared read vs shared hit: Healthy when mostly hit. reads mean the index left the cache Planning Time: Healthy when under 5 ms. high values point at partition count Everything else in a plan is detail; these five lines identify the cause in most spatial investigations.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">The four numbers worth reading first</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Healthy when</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">actual rows vs estimated rows</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="currentColor">within 10×</text>
  <text x="428" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">a bad estimate means stale statistics</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">Rows Removed by Filter</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="currentColor">near zero</text>
  <text x="428" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">a large value means an unindexed predicate</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">Rows Removed by Index Recheck</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="currentColor">small</text>
  <text x="428" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">normal for a bounding-box stage</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">shared read vs shared hit</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="currentColor">mostly hit</text>
  <text x="428" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">reads mean the index left the cache</text>
  <line x1="20" y1="194" x2="700" y2="194" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="216" font-size="10.5" fill="currentColor">Planning Time</text>
  <text x="294" y="216" font-size="11.5" font-weight="700" fill="currentColor">under 5 ms</text>
  <text x="428" y="216" font-size="9.5" fill="var(--muted, #7c6fb0)">high values point at partition count</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">Everything else in a plan is detail; these five lines identify the cause in most spatial investigations.</text>
</svg>

### Diagnosing Common Spatial Plan Failures

**Implicit Type Casts Bypass Indexes**
If your `geom` column is `geometry(Point, 3857)` but you pass a `geometry` literal in `4326` without explicit casting, PostgreSQL may perform a sequential scan. Always match SRIDs in your query or create functional indexes on transformed columns.

**Missing `CLUSTER` on High-Read Tables**
GiST indexes store bounding boxes, but heap pages remain physically scattered. Over time, `shared read` counts climb as the database performs random I/O. Run `CLUSTER venues USING venues_geom_idx;` periodically to physically reorder heap rows to match the index order. This dramatically improves buffer hit ratios for hotspot queries.

**Index-Only Scans Are Rare for Geometries**
Unlike B-tree indexes, GiST indexes cannot satisfy `Index Only Scans` for geometry columns because the index stores compressed bounding boxes, not full geometries. The heap must be visited for exact evaluation. Focus on minimizing `Rows Removed by Filter` rather than chasing index-only optimizations.

**Buffer Exhaustion Under Load**
Spatial indexes easily exceed default `shared_buffers`. When `shared read` dominates `shared hit`, your API latency will spike during concurrent requests. Monitor `pg_stat_user_indexes` and scale memory allocation or implement application-level caching for static spatial boundaries. For broader strategies on reducing database round-trips and caching hot query paths, review [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/).

Distinguishing these four states is the practical goal of reading a plan at all.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Same query, four states of health: index used, cache warm 7 ms, index used, cache cold 84 ms, index used, stale statistics 310 ms, predicate not indexable 2 100 ms" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Same query, four states of health</title>
  <desc>A horizontal bar chart. index used, cache warm is 7 ms. index used, cache cold is 84 ms. index used, stale statistics is 310 ms. predicate not indexable is 2 100 ms. Three of the four states show an Index Scan in the plan — reading the node name alone is not enough.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Same query, four states of health</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">index used, cache warm</text>
  <rect x="250" y="48" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">7 ms</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">index used, cache cold</text>
  <rect x="250" y="82" width="13" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="271" y="95" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">84 ms</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">index used, stale statistics</text>
  <rect x="250" y="116" width="50" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="308" y="129" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">310 ms</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">predicate not indexable</text>
  <rect x="250" y="150" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="163" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">2 100 ms</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">Three of the four states show an Index Scan in the plan — reading the node name alone is not enough.</text>
</svg>

### What the estimate tells you that the timing does not

The most useful line in a spatial plan is often not the duration but the gap between estimated and actual row counts. PostgreSQL chooses a plan from the estimate; if the estimate is wrong the plan is wrong, and the timing merely records how wrong.

For spatial predicates the estimate comes from PostGIS statistics gathered by `ANALYZE` — a sample of geometry bounding boxes summarised into a histogram of the data's spatial distribution. When those statistics are missing or stale, the planner falls back to a fixed selectivity guess, and on a bounding-box predicate that guess is usually far too pessimistic. The visible symptom is a plan that chooses a sequential scan or a materialised hash join over an index scan, on a query that would have been fast either way six months ago.

The rule of thumb is that estimated and actual rows should agree within about an order of magnitude. Beyond that, the fix is almost never to rewrite the query:

```sql
-- Refresh the spatial statistics for one table
ANALYZE features;

-- Increase the sample size for a highly skewed geometry column
ALTER TABLE features ALTER COLUMN geom SET STATISTICS 500;
ANALYZE features;
```

Raising the statistics target costs a slower `ANALYZE` and a larger histogram, and it pays for itself on any table where the data is unevenly distributed — which describes almost every real spatial dataset, since features cluster around towns, roads and coastlines rather than spreading uniformly.

### Buffers are the other half of the story

`EXPLAIN (ANALYZE, BUFFERS)` reports how many blocks came from the cache and how many from disk. Two runs of the same query with identical plans can differ by an order of magnitude purely on that split, which is why a plan captured on a warm cache says nothing useful about production at 03:00.

Read `shared hit` and `shared read` together: a plan dominated by reads is describing an index that no longer fits in memory, and no amount of query rewriting will fix it. That is a capacity or a [partitioning](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/) conversation, not a tuning one. Conversely, a plan that is almost all hits and still slow is doing genuine computational work — usually a geometry operation on complex shapes — and that is where simplification or a pre-aggregated table earns its keep.

The practical habit is to capture plans twice: once cold, immediately after a restart or a cache drop, and once warm. The difference between the two is the size of the problem that a cache is currently hiding.

### What the estimate tells you that the timing does not

The most useful line in a spatial plan is often not the duration but the gap between estimated and actual row counts. PostgreSQL chooses a plan from the estimate; if the estimate is wrong the plan is wrong, and the timing merely records how wrong.

For spatial predicates the estimate comes from PostGIS statistics gathered by `ANALYZE` — a sample of geometry bounding boxes summarised into a histogram of the data's spatial distribution. When those statistics are missing or stale, the planner falls back to a fixed selectivity guess, and on a bounding-box predicate that guess is usually far too pessimistic. The visible symptom is a plan that chooses a sequential scan or a materialised hash join over an index scan, on a query that would have been fast either way six months ago.

The rule of thumb is that estimated and actual rows should agree within about an order of magnitude. Beyond that, the fix is almost never to rewrite the query:

```sql
-- Refresh the spatial statistics for one table
ANALYZE features;

-- Increase the sample size for a highly skewed geometry column
ALTER TABLE features ALTER COLUMN geom SET STATISTICS 500;
ANALYZE features;
```

Raising the statistics target costs a slower `ANALYZE` and a larger histogram, and it pays for itself on any table where the data is unevenly distributed — which describes almost every real spatial dataset, since features cluster around towns, roads and coastlines rather than spreading uniformly.

### Buffers are the other half of the story

`EXPLAIN (ANALYZE, BUFFERS)` reports how many blocks came from the cache and how many from disk. Two runs of the same query with identical plans can differ by an order of magnitude purely on that split, which is why a plan captured on a warm cache says nothing useful about production at 03:00.

Read `shared hit` and `shared read` together: a plan dominated by reads is describing an index that no longer fits in memory, and no amount of query rewriting will fix it. That is a capacity or a [partitioning](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/) conversation, not a tuning one. Conversely, a plan that is almost all hits and still slow is doing genuine computational work — usually a geometry operation on complex shapes — and that is where simplification or a pre-aggregated table earns its keep.

The practical habit is to capture plans twice: once cold, immediately after a restart or a cache drop, and once warm. The difference between the two is the size of the problem that a cache is currently hiding.

Keep the captured plans somewhere durable — a comment on the ticket, a file in the repository — rather than in a terminal scrollback. A plan from six months ago is the only reliable way to answer whether today's behaviour is a regression or has always been like this.

### Validation Checklist

Before shipping spatial endpoints, verify:
- [ ] `EXPLAIN` shows `Index Cond` with `&&` operator
- [ ] `Rows Removed by Filter` is < 30% of total scanned rows
- [ ] `Actual Total Time` matches your FastAPI p95 SLA
- [ ] `shared hit` > `shared read` on production workloads
- [ ] No implicit SRID conversions in the predicate

Reading execution plans for spatial workloads requires ignoring planner cost estimates and focusing on actual buffer behavior and post-filter efficiency. When bounding-box selectivity is high and heap access is localized, PostGIS scales linearly even on multi-million-row tables.