---
layout: layouts/page.njk
title: "Scheduling Concurrent Refresh of Spatial Materialized Views"
description: "Keep a PostGIS materialized view readable while it rebuilds with REFRESH MATERIALIZED VIEW CONCURRENTLY, schedule it with pg_cron or an external scheduler, monitor refresh duration, and prevent overlapping refreshes with advisory locks."
slug: "scheduling-concurrent-refresh-of-spatial-materialized-views"
breadcrumb:
  - label: "High-Performance Caching & Query Optimization"
    url: "/high-performance-caching-query-optimization/"
  - label: "Materialized Views for Spatial Aggregations"
    url: "/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/"
  - label: "Scheduling Concurrent Refresh of Spatial Materialized Views"
    url: "/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/scheduling-concurrent-refresh-of-spatial-materialized-views/"
datePublished: "2025-12-03"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Scheduling Concurrent Refresh of Spatial Materialized Views",
      "description": "Keep a PostGIS materialized view readable while it rebuilds with REFRESH MATERIALIZED VIEW CONCURRENTLY, schedule it with pg_cron or an external scheduler, monitor refresh duration, and prevent overlapping refreshes with advisory locks.",
      "datePublished": "2025-12-03",
      "dateModified": "2026-07-10",
      "author": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "High-Performance Caching & Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 2, "name": "Materialized Views for Spatial Aggregations", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/" },
        { "@type": "ListItem", "position": 3, "name": "Scheduling Concurrent Refresh of Spatial Materialized Views", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/scheduling-concurrent-refresh-of-spatial-materialized-views/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Schedule concurrent refresh of a spatial materialized view",
      "step": [
        { "@type": "HowToStep", "position": 1, "text": "Ensure the view has a non-partial UNIQUE index so CONCURRENTLY is allowed." },
        { "@type": "HowToStep", "position": 2, "text": "Wrap the refresh in a function that takes an advisory lock and stamps a refresh log." },
        { "@type": "HowToStep", "position": 3, "text": "Schedule the function with pg_cron, or from an external scheduler over a maintenance connection." },
        { "@type": "HowToStep", "position": 4, "text": "Monitor refresh duration via cron.job_run_details and the refresh log, alerting on overruns." }
      ]
    },
    {
      "@type": "Article",
      "headline": "Scheduling Concurrent Refresh of Spatial Materialized Views",
      "datePublished": "2025-12-03",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [Materialized Views for Spatial Aggregations](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/)

# Scheduling concurrent refresh of spatial materialized views

Refresh a PostGIS materialized view on a schedule without ever blocking readers — using `REFRESH MATERIALIZED VIEW CONCURRENTLY`, a UNIQUE index, and a lock that stops two refreshes from overlapping.

## Context & when to use

A [materialized view](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/) is a snapshot: it only reflects new base-table data after you refresh it. A plain `REFRESH MATERIALIZED VIEW` takes an `ACCESS EXCLUSIVE` lock, so every read against the view blocks until the rebuild finishes — unacceptable when a heatmap or boundary endpoint is serving live traffic. `REFRESH MATERIALIZED VIEW CONCURRENTLY` solves that: it builds a fresh copy in the background, diffs it against the current view through a UNIQUE index, and applies only the delta, so readers keep hitting the old snapshot until the swap completes.

Use concurrent refresh when the view backs a read endpoint that cannot tolerate downtime and your freshness SLA is measured in minutes, not seconds. The trade-off is cost: `CONCURRENTLY` builds a full temp copy and does a row-by-row diff, so it is slower and does substantially more I/O than a plain refresh. If reads can tolerate a brief lock in an off-peak window, plain refresh is cheaper. For sub-second freshness, neither fits — route those reads to a live query instead.

**Preconditions:** the view has at least one non-partial `UNIQUE` index (the hard requirement for `CONCURRENTLY`), the refresh completes comfortably within its schedule interval, and refreshes run on a dedicated maintenance connection, never on the request path.

---

## Refresh timeline

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Concurrent refresh keeps the view readable: scheduler fires, advisory lock is taken, a temp copy is built and diffed, the delta is applied, and reads never block" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Concurrent refresh timeline keeps readers unblocked</title>
  <desc>A scheduler (pg_cron or external) fires on an interval. The refresh function takes a Postgres advisory lock to prevent overlap. REFRESH CONCURRENTLY builds a temporary copy, diffs it against the live view via the UNIQUE index, and applies the delta. Throughout, the read endpoint keeps serving the old snapshot with no blocking. Overlapping refreshes are rejected by the advisory lock.</desc>
  <rect x="0" y="0" width="760" height="280" rx="12" fill="var(--surface, #f5f3ff)"/>
  <!-- Reads lane (always green, never blocks) -->
  <text x="14" y="52" font-size="10" fill="var(--muted, #7c6fb0)" font-weight="600">READS</text>
  <rect x="80" y="36" width="640" height="30" rx="6" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="400" y="55" text-anchor="middle" font-size="11" fill="#065f46" font-weight="600">endpoint serves old snapshot — never blocked</text>
  <!-- Refresh lane -->
  <text x="14" y="150" font-size="10" fill="var(--muted, #7c6fb0)" font-weight="600">REFRESH</text>
  <!-- scheduler tick -->
  <circle cx="96" cy="140" r="10" fill="var(--accent, #7c3aed)" opacity="0.2" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="96" y="176" text-anchor="middle" font-size="10" fill="currentColor">tick</text>
  <!-- advisory lock -->
  <rect x="140" y="122" width="120" height="36" rx="6" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="200" y="144" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">advisory lock</text>
  <text x="200" y="184" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">blocks overlap</text>
  <!-- build temp copy -->
  <rect x="288" y="122" width="150" height="36" rx="6" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="363" y="140" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">build temp copy</text>
  <text x="363" y="153" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">re-run aggregation</text>
  <!-- diff via unique index -->
  <rect x="466" y="122" width="150" height="36" rx="6" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="541" y="140" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">diff via UNIQUE</text>
  <text x="541" y="153" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">apply delta</text>
  <!-- release + stamp -->
  <rect x="640" y="122" width="90" height="36" rx="6" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="685" y="140" text-anchor="middle" font-size="10" fill="#065f46" font-weight="600">swap +</text>
  <text x="685" y="152" text-anchor="middle" font-size="10" fill="#065f46" font-weight="600">stamp log</text>
  <!-- arrows -->
  <line x1="106" y1="140" x2="138" y2="140" stroke="currentColor" stroke-width="1.5" marker-end="url(#rf-arr)"/>
  <line x1="260" y1="140" x2="286" y2="140" stroke="currentColor" stroke-width="1.5" marker-end="url(#rf-arr)"/>
  <line x1="438" y1="140" x2="464" y2="140" stroke="currentColor" stroke-width="1.5" marker-end="url(#rf-arr)"/>
  <line x1="616" y1="140" x2="638" y2="140" stroke="#10b981" stroke-width="1.5" marker-end="url(#rf-arr2)"/>
  <!-- overlap rejected -->
  <text x="200" y="228" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">second tick during a run → lock not acquired → skipped</text>
  <defs>
    <marker id="rf-arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
    <marker id="rf-arr2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#10b981"/>
    </marker>
  </defs>
</svg>

---

## Runnable implementation

Wrap the refresh in a function that takes a session-level advisory lock (so overlapping runs are skipped, not queued) and stamps a bookkeeping table the read endpoint can surface as `last_refresh`. Then schedule that function with `pg_cron`.

```sql
-- 0. Prerequisite: the view MUST have a non-partial UNIQUE index, or
--    REFRESH ... CONCURRENTLY fails with:
--    "cannot refresh materialized view concurrently"
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_ping_heatmap_cell
    ON mv_ping_heatmap (cell_id);

-- 1. Bookkeeping table the API reads to report staleness
CREATE TABLE IF NOT EXISTS mv_refresh_log (
    view_name     text PRIMARY KEY,
    last_refresh  timestamptz,
    duration_ms   integer
);

-- 2. Refresh function: advisory lock prevents overlap; timing is recorded.
CREATE OR REPLACE FUNCTION refresh_ping_heatmap()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    started  timestamptz := clock_timestamp();
    got_lock boolean;
BEGIN
    -- try-lock: returns false immediately if another refresh holds it.
    -- A fixed key (871501) identifies THIS view's refresh across sessions.
    got_lock := pg_try_advisory_lock(871501);
    IF NOT got_lock THEN
        RAISE NOTICE 'refresh_ping_heatmap: previous run still active, skipping';
        RETURN;
    END IF;

    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ping_heatmap;

        INSERT INTO mv_refresh_log(view_name, last_refresh, duration_ms)
        VALUES (
            'mv_ping_heatmap',
            clock_timestamp(),
            extract(milliseconds FROM clock_timestamp() - started)::int
        )
        ON CONFLICT (view_name) DO UPDATE
            SET last_refresh = excluded.last_refresh,
                duration_ms  = excluded.duration_ms;
    EXCEPTION WHEN OTHERS THEN
        PERFORM pg_advisory_unlock(871501);  -- always release on error
        RAISE;
    END;

    PERFORM pg_advisory_unlock(871501);
END;
$$;

-- 3. Schedule every 5 minutes with pg_cron (runs inside Postgres).
--    Requires pg_cron in shared_preload_libraries + CREATE EXTENSION pg_cron.
SELECT cron.schedule(
    'refresh-ping-heatmap',       -- job name (unique)
    '*/5 * * * *',                -- standard cron: every 5 minutes
    $$SELECT refresh_ping_heatmap()$$
);
```

If you cannot install `pg_cron` (managed Postgres without the extension, for example), drive the same function from an external scheduler on a dedicated maintenance connection:

```python
# scheduler.py — APScheduler fallback when pg_cron is unavailable.
# Runs in a small sidecar process, NOT inside a FastAPI request worker.
import asyncio
import asyncpg
from apscheduler.schedulers.asyncio import AsyncIOScheduler

DSN = "postgresql://maint_user@db:5432/geo"  # a maintenance role, not the API role

async def refresh_heatmap() -> None:
    conn = await asyncpg.connect(DSN)
    try:
        # The function itself takes the advisory lock, so even if two
        # scheduler instances fire, only one refresh actually runs.
        await conn.execute("SELECT refresh_ping_heatmap()")
    finally:
        await conn.close()

def main() -> None:
    scheduler = AsyncIOScheduler(timezone="UTC")
    # coalesce + max_instances=1 stop APScheduler queuing missed runs.
    scheduler.add_job(
        refresh_heatmap, "interval", minutes=5,
        coalesce=True, max_instances=1, id="refresh-ping-heatmap",
    )
    scheduler.start()
    asyncio.get_event_loop().run_forever()

if __name__ == "__main__":
    main()
```

Reducing base-table churn between refreshes — for example by fronting the read endpoint with a short [Redis TTL](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — is discussed alongside the [materialized view vs Redis comparison](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/postgis-materialized-views-vs-redis-query-caching/).

---

A concurrent refresh is a build-then-swap, and understanding the phases explains where its extra cost comes from.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="One concurrent refresh, minute by minute: start then build new snapshot then diff and apply then swap then index maintenance" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>One concurrent refresh, minute by minute</title>
  <desc>A horizontal timeline. start: SHARE UPDATE EXCLUSIVE. build new snapshot: readers see old rows. diff and apply: the expensive half. swap: brief lock. index maintenance: unique index updated. Readers are unaffected for all but the swap, which is measured in milliseconds even on a large view.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">One concurrent refresh, minute by minute</text>
  <rect x="20" y="92" width="48" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.4"/>
  <text x="44" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">start</text>
  <text x="44" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">SHARE UPDATE EX</text>
  <rect x="72" y="92" width="309" height="34" rx="5" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="226" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">build new snapshot</text>
  <text x="226" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">readers see old rows</text>
  <rect x="385" y="92" width="152" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="461" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">diff and apply</text>
  <text x="461" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">the expensive half</text>
  <rect x="541" y="92" width="48" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="565" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">swap</text>
  <text x="565" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">brief lock</text>
  <rect x="593" y="92" width="100" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.4"/>
  <text x="643" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">index maintenance</text>
  <text x="643" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">unique index updated</text>
  <text x="20" y="184" font-size="10.5" fill="var(--muted, #7c6fb0)">Readers are unaffected for all but the swap, which is measured in milliseconds even on a large view.</text>
</svg>

## Key parameters & options

| Parameter / knob | Purpose | Recommended value |
|---|---|---|
| `CONCURRENTLY` | Keeps the view readable during refresh | Required for live-traffic endpoints |
| non-partial `UNIQUE` index | Enables `CONCURRENTLY` row diffing | Mandatory; on a stable key |
| `pg_try_advisory_lock(key)` | Skips (does not queue) overlapping refreshes | Fixed integer key per view |
| cron interval `*/5 * * * *` | Refresh cadence; must exceed refresh duration | ≥ 3× the p95 refresh time |
| `coalesce=True` (APScheduler) | Collapses missed runs into one | Always, for periodic refresh |
| `max_instances=1` (APScheduler) | Prevents concurrent scheduler firings | `1` |
| maintenance connection | Isolates refresh I/O from request pool | Dedicated role + connection |

---

Where the refresh is scheduled decides how you find out when it stops running.

<svg viewBox="0 0 720 234" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Scheduling options for the refresh job: Survives deploy, Observable" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Scheduling options for the refresh job</title>
  <desc>A comparison table. pg_cron inside the database: Survives deploy yes, Observable partly. no network dependency external scheduler + psql: Survives deploy yes, Observable yes. easiest to alert on application background task: Survives deploy no, Observable yes. dies with the process trigger on the source table: Survives deploy yes, Observable no. refreshes far too often Whatever the choice, alert on the age of the view rather than on whether the job reported success.</desc>
  <rect x="0" y="0" width="720" height="234" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Scheduling options for the refresh job</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Survives deploy</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Observable</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">pg_cron inside the database</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="460" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">no network dependency</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">external scheduler + psql</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">easiest to alert on</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">application background task</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">dies with the process</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">trigger on the source table</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="460" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">refreshes far too often</text>
  <text x="20" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">Whatever the choice, alert on the age of the view rather than on whether the job reported success.</text>
</svg>

## Gotchas & failure modes

- **`cannot refresh materialized view concurrently`** with detail `Create a unique index with no WHERE clause on one or more columns of the materialized view`. The view has no qualifying UNIQUE index, or the only one is *partial* (has a `WHERE`). Add a full, non-partial `CREATE UNIQUE INDEX` on a stable key before scheduling.

- **Overlapping refreshes double the load.** If a refresh takes longer than its interval and you have no lock, `pg_cron` (or a second scheduler replica) starts another one, and now two concurrent refreshes each build a temp copy and compete for I/O. The `pg_try_advisory_lock` guard above rejects the second run cleanly — monitor for the `previous run still active, skipping` notice; frequent skips mean your interval is too tight.

- **Long refresh blocks autovacuum on the base tables.** A `CONCURRENTLY` refresh holds a long transaction that reads the base tables; while it runs, autovacuum cannot remove dead tuples newer than the refresh's snapshot, so bloat accumulates on high-write tables like `gps_pings`. Keep refreshes short (narrow the aggregation window, or refresh less often) and watch `n_dead_tup` in `pg_stat_user_tables`.

- **`CONCURRENTLY` is slower and heavier than plain refresh.** It builds a temp copy *and* diffs it — often 2–4× the wall-clock and roughly double the temporary disk of a plain refresh. Do not reach for `CONCURRENTLY` on an off-peak nightly job where a brief lock is fine.

- **Advisory lock leaked across a pooled connection.** Session-level advisory locks are tied to the backend connection. If the refresh runs through a transaction-mode connection pool, the lock may be released on an unexpected boundary. Run refreshes on a direct maintenance connection, not through PgBouncer transaction pooling.

- **`pg_cron` runs in the wrong database.** `pg_cron` jobs execute in the database where the extension was created (often `postgres`) unless you set `cron.database_name` or pass a target. If the job silently does nothing, confirm it targets the database that owns the view.

---

## Verification

```sql
-- 1. Confirm the job is registered and active
SELECT jobid, schedule, command, active FROM cron.job
WHERE jobname = 'refresh-ping-heatmap';

-- 2. Inspect recent runs: status and duration
SELECT status, start_time, end_time,
       end_time - start_time AS duration
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'refresh-ping-heatmap')
ORDER BY start_time DESC
LIMIT 5;

-- 3. Confirm freshness from the bookkeeping table (what the API reports)
SELECT view_name, last_refresh, duration_ms,
       now() - last_refresh AS staleness
FROM mv_refresh_log
WHERE view_name = 'mv_ping_heatmap';
```

A `duration_ms` creeping toward the schedule interval is the early warning to widen the interval or shrink the view. A `status` of `failed` in `cron.job_run_details` usually points back to a missing UNIQUE index or a base-table lock conflict. Manually time one refresh to establish the baseline:

```sql
\timing on
SELECT refresh_ping_heatmap();
-- Time: 8631.204 ms  ← the interval (5 min) must dwarf this
```

---

## Related

- [Materialized Views for Spatial Aggregations](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/) — create and index the view this refresh keeps current
- [PostGIS Materialized Views vs Redis Query Caching](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/postgis-materialized-views-vs-redis-query-caching/) — when a scheduled refresh beats a TTL cache
- [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — front the view with a short TTL to smooth base-table churn

← Back to [Materialized Views for Spatial Aggregations](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/)
