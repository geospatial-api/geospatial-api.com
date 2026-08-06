---
layout: layouts/page.njk
title: "PostGIS Materialized Views vs Redis Query Caching"
description: "A direct comparison for caching spatial aggregation results: freshness and invalidation models, storage location, query flexibility, operational cost, and cold-start. Includes a decision table, runnable examples of both, and the gotchas of stacking them."
slug: "postgis-materialized-views-vs-redis-query-caching"
breadcrumb:
  - label: "High-Performance Caching & Query Optimization"
    url: "/high-performance-caching-query-optimization/"
  - label: "Materialized Views for Spatial Aggregations"
    url: "/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/"
  - label: "PostGIS Materialized Views vs Redis Query Caching"
    url: "/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/postgis-materialized-views-vs-redis-query-caching/"
datePublished: "2025-10-21"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "PostGIS Materialized Views vs Redis Query Caching",
      "description": "A direct comparison for caching spatial aggregation results: freshness and invalidation models, storage location, query flexibility, operational cost, and cold-start. Includes a decision table, runnable examples of both, and the gotchas of stacking them.",
      "datePublished": "2025-10-21",
      "dateModified": "2026-07-10",
      "author": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "High-Performance Caching & Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 2, "name": "Materialized Views for Spatial Aggregations", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/" },
        { "@type": "ListItem", "position": 3, "name": "PostGIS Materialized Views vs Redis Query Caching", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/postgis-materialized-views-vs-redis-query-caching/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Choose between a PostGIS materialized view and Redis query caching",
      "step": [
        { "@type": "HowToStep", "position": 1, "text": "Classify the workload: reusable heavy aggregate queried many ways, or hot identical response." },
        { "@type": "HowToStep", "position": 2, "text": "Materialize the aggregate as a PostGIS view with GiST and UNIQUE indexes for many-shaped queries." },
        { "@type": "HowToStep", "position": 3, "text": "Cache the serialized response in Redis with a TTL for hot identical bounding boxes." },
        { "@type": "HowToStep", "position": 4, "text": "Optionally stack a short Redis TTL over the view, keeping refresh and TTL windows aligned." }
      ]
    },
    {
      "@type": "Article",
      "headline": "PostGIS Materialized Views vs Redis Query Caching",
      "datePublished": "2025-10-21",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [Materialized Views for Spatial Aggregations](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/)

# PostGIS materialized views vs Redis query caching

When a spatial aggregation is too expensive to run per request, you can precompute it as a PostGIS materialized view or cache its serialized response in Redis — and the right choice depends entirely on how clients query the result.

## Context & when to use

Both techniques exist to avoid re-running an expensive computation. But they cache different things at different layers. A [materialized view](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/) stores the *aggregated rows* on disk inside Postgres, still queryable with SQL and spatial indexes. A [Redis cache](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) stores the *finished response bytes* in memory, keyed by a single lookup string. That difference drives every trade-off below.

Reach for a **materialized view** when one heavy aggregation feeds many query shapes. A dissolved administrative boundary or a per-cell heatmap grid gets filtered by bounding box, joined to attribute tables, sorted by count, and clipped to different zoom levels — all off the same precomputed result, each using the view's GiST index. Redis cannot do any of that; it can only return the exact response you stored under the exact key you ask for.

Reach for **Redis** when the same identical response is requested over and over with a short acceptable staleness. A dashboard tile that every user loads on the same map view, a "features in this fixed region" call behind a popular UI element — these are hot key-value reads where a TTL of 30–120 seconds is fine, and a memory `GET` beats even an indexed Postgres scan. The two are frequently combined: materialize the aggregate to make cold reads cheap, then put a short Redis TTL over the hottest bounding boxes for sub-millisecond hot reads.

---

## Comparison at a glance

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Materialized view caches aggregated rows on disk queryable many ways; Redis caches a finished response in memory keyed one way" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Materialized view vs Redis cache for spatial aggregations</title>
  <desc>Left: a materialized view stores aggregated rows on disk inside Postgres with GiST and UNIQUE indexes, queryable by bounding box, join, or sort — freshness bounded by a scheduled refresh. Right: a Redis cache stores one serialized response in memory under a single key, returned as-is, freshness bounded by a TTL. A shared expensive aggregation feeds both.</desc>
  <rect x="0" y="0" width="760" height="300" rx="12" fill="var(--surface, #f5f3ff)"/>
  <!-- shared source -->
  <rect x="300" y="18" width="160" height="46" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="380" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Expensive aggregate</text>
  <text x="380" y="56" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">ST_Union · grid counts</text>
  <!-- left: materialized view -->
  <rect x="40" y="104" width="300" height="176" rx="10" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="190" y="128" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Materialized view</text>
  <text x="190" y="148" text-anchor="middle" font-size="11" fill="currentColor">Aggregated rows on disk (Postgres)</text>
  <text x="190" y="168" text-anchor="middle" font-size="11" fill="currentColor">GiST + UNIQUE indexes</text>
  <rect x="60" y="184" width="80" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1"/>
  <text x="100" y="203" text-anchor="middle" font-size="10" fill="currentColor">bbox filter</text>
  <rect x="150" y="184" width="80" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1"/>
  <text x="190" y="203" text-anchor="middle" font-size="10" fill="currentColor">join</text>
  <rect x="240" y="184" width="80" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1"/>
  <text x="280" y="203" text-anchor="middle" font-size="10" fill="currentColor">sort / clip</text>
  <text x="190" y="238" text-anchor="middle" font-size="11" fill="currentColor">queried many ways</text>
  <text x="190" y="262" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">fresh until scheduled REFRESH</text>
  <!-- right: redis -->
  <rect x="420" y="104" width="300" height="176" rx="10" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="570" y="128" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Redis cache</text>
  <text x="570" y="148" text-anchor="middle" font-size="11" fill="currentColor">Serialized response in memory</text>
  <text x="570" y="168" text-anchor="middle" font-size="11" fill="currentColor">one key → one response</text>
  <rect x="470" y="184" width="200" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1"/>
  <text x="570" y="203" text-anchor="middle" font-size="10" fill="currentColor">GET heatmap:z10:x301:y384</text>
  <text x="570" y="238" text-anchor="middle" font-size="11" fill="currentColor">returned as-is</text>
  <text x="570" y="262" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">fresh until TTL expiry</text>
  <!-- arrows from source -->
  <line x1="340" y1="52" x2="230" y2="102" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#cmp-arr)"/>
  <line x1="420" y1="52" x2="520" y2="102" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#cmp-arr)"/>
  <defs>
    <marker id="cmp-arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="var(--accent, #7c3aed)"/>
    </marker>
  </defs>
</svg>

| Dimension | Materialized view | Redis query cache |
|---|---|---|
| What is cached | Aggregated rows (SQL-queryable) | One serialized response (bytes) |
| Storage location | Postgres disk | Redis memory |
| Freshness model | Snapshot until `REFRESH` | TTL expiry (or explicit invalidation) |
| Invalidation | Scheduled / triggered refresh | TTL, or delete-on-write |
| Query flexibility | High — filter, join, sort, re-index | None — exact key only |
| Read latency | 2–6 ms (indexed scan) | 0.2–1 ms (memory GET) |
| Cold start | None (persisted on disk) | Empty until first miss recomputes |
| Survives restart | Yes | Only if Redis persistence enabled |
| Operational cost | Refresh scheduling, disk | Memory sizing, eviction policy |
| Best fit | Reusable aggregate, many query shapes | Hot identical response, tight TTL |

---

## Runnable implementation

The same use case — a 250 m heatmap grid — implemented both ways so the difference is concrete.

```sql
-- ============================================================
-- OPTION A: Materialized view (query the aggregate many ways)
-- ============================================================
CREATE MATERIALIZED VIEW mv_ping_heatmap AS
SELECT
    row_number() OVER ()                          AS cell_id,
    ST_SnapToGrid(ST_Transform(geom, 3857), 250)  AS cell_geom,
    count(*)                                       AS ping_count
FROM gps_pings
WHERE captured_at >= now() - interval '90 days'
GROUP BY ST_SnapToGrid(ST_Transform(geom, 3857), 250)
WITH DATA;

-- GiST for spatial predicates, UNIQUE for concurrent refresh
CREATE INDEX idx_mv_ping_heatmap_geom ON mv_ping_heatmap USING GIST (cell_geom);
CREATE UNIQUE INDEX uq_mv_ping_heatmap_cell ON mv_ping_heatmap (cell_id);
ANALYZE mv_ping_heatmap;

-- A read can now filter the SAME aggregate by ANY bounding box, cheaply:
-- SELECT cell_id, ping_count FROM mv_ping_heatmap
--   WHERE cell_geom && ST_MakeEnvelope(:minx,:miny,:maxx,:maxy, 3857);
```

```python
# ============================================================
# OPTION B: Redis query cache (hot identical response, TTL)
# ============================================================
# The aggregation still runs in Postgres on a miss; Redis stores the
# finished GeoJSON so repeated identical requests skip the query entirely.
import json
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

HEATMAP_AGG = text("""
    SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', coalesce(jsonb_agg(jsonb_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(ST_Transform(cell_geom, 4326), 6)::jsonb,
            'properties', jsonb_build_object('ping_count', ping_count)
        )), '[]'::jsonb)
    )
    FROM ST_SnapToGrid(...) -- same aggregation as Option A, run live on miss
""")

async def heatmap_cached(
    tile_key: str, redis: Redis, db: AsyncSession, ttl: int = 60
) -> dict:
    cache_key = f"heatmap:{tile_key}"          # ONE key → ONE response
    hit = await redis.get(cache_key)
    if hit:
        return json.loads(hit)                 # ~0.3 ms, no Postgres round-trip

    row = await db.execute(HEATMAP_AGG)        # miss: pay the aggregation cost
    payload = row.scalar()
    await redis.setex(cache_key, ttl, json.dumps(payload))  # TTL-bounded freshness
    return payload
```

The tags-and-keys strategy for spatial Redis keys is covered in [configuring Redis cache tags for bounding-box queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/configuring-redis-cache-tags-for-bounding-box-queries/). Note that Option B still runs the full aggregation on every cache miss — Redis does nothing to make the *underlying* query cheaper, which is exactly why stacking it over Option A is common.

---

The two layers answer different shapes of question, and one row below belongs to neither.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Which layer suits which question: View, Redis" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Which layer suits which question</title>
  <desc>A comparison table. aggregate over the whole table: View yes, Redis no. the view computes it once exact repeat of a bbox request: View no, Redis yes. key match, microseconds arbitrary user-drawn polygon: View no, Redis no. neither — this is a live query per-tenant filtered totals: View partly, Redis yes. view per tenant does not scale data that changes hourly: View yes, Redis partly. refresh beats invalidation The row that matters most is the third: some questions have no cacheable form, and pretending otherwise produces stale answers.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Which layer suits which question</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">View</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Redis</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">aggregate over the whole table</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="460" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">the view computes it once</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">exact repeat of a bbox request</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">key match, microseconds</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">arbitrary user-drawn polygon</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="460" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">neither — this is a live query</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">per-tenant filtered totals</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">view per tenant does not scale</text>
  <line x1="20" y1="194" x2="700" y2="194" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="216" font-size="10.5" fill="currentColor">data that changes hourly</text>
  <text x="294" y="216" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="216" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="460" y="216" font-size="9.5" fill="var(--muted, #7c6fb0)">refresh beats invalidation</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">The row that matters most is the third: some questions have no cacheable form, and pretending otherwise produces stale answers.</text>
</svg>

## Key parameters & options

| Parameter / knob | Layer | Purpose |
|---|---|---|
| `REFRESH ... CONCURRENTLY` interval | View | Bounds view staleness; must exceed refresh duration |
| `CREATE UNIQUE INDEX` | View | Prerequisite for concurrent refresh; enables row diffing |
| GiST index on view geom | View | Lets many query shapes hit an index scan |
| `SETEX` TTL | Redis | Bounds response staleness; shorter = fresher, more misses |
| `maxmemory-policy allkeys-lru` | Redis | Eviction under memory pressure; avoid `noeviction` for caches |
| Cache key granularity | Redis | Per-tile keys hit more; per-arbitrary-bbox keys rarely hit |

---

Freshness and fragility move together, and the fastest option is the one that fails most quietly.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Staleness window by strategy, hourly-changing data: materialised view, hourly refresh up to 60 min, materialised view, 5-min refresh up to 5 min, Redis, TTL 300 s up to 5 min, Redis, tag invalidation seconds — if no event is missed" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Staleness window by strategy, hourly-changing data</title>
  <desc>A horizontal bar chart. materialised view, hourly refresh is up to 60 min. materialised view, 5-min refresh is up to 5 min. Redis, TTL 300 s is up to 5 min. Redis, tag invalidation is seconds — if no event is missed. Tag invalidation is the freshest and the most fragile: one missed event and the entry lives until its TTL.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Staleness window by strategy, hourly-changing data</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">materialised view, hourly refresh</text>
  <rect x="250" y="48" width="340" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="598" y="61" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">up to 60 min</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">materialised view, 5-min refresh</text>
  <rect x="250" y="82" width="28" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="286" y="95" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">up to 5 min</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">Redis, TTL 300 s</text>
  <rect x="250" y="116" width="28" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="286" y="129" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">up to 5 min</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">Redis, tag invalidation</text>
  <rect x="250" y="150" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="163" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">seconds — if no event is missed</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">Tag invalidation is the freshest and the most fragile: one missed event and the entry lives until its TTL.</text>
</svg>

## Gotchas & failure modes

- **Double-caching drift.** Stacking a Redis TTL over a materialized view means a client sees data that is stale by *up to* `refresh_interval + ttl`. A 5-minute refresh plus a 60 s TTL yields up to 6 minutes of staleness in the worst case. Keep the TTL small relative to the refresh interval, and never let the TTL exceed it, or you cache a soon-to-be-replaced snapshot.

- **Redis does not reduce aggregation cost.** On a cache miss, Option B runs the full `ST_SnapToGrid` + `GROUP BY` live — the first request after every TTL expiry pays the multi-second cost and can stampede under concurrency. A materialized view eliminates that cost for *all* reads. If misses are expensive and frequent, materialize.

- **`cannot refresh materialized view concurrently`.** Forgetting the UNIQUE index breaks concurrent refresh entirely. See [scheduling concurrent refresh](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/scheduling-concurrent-refresh-of-spatial-materialized-views/) for the full requirement.

- **Redis eviction under `noeviction`.** If Redis fills and the policy is `noeviction`, `SETEX` starts returning `OOM command not allowed when used memory > 'maxmemory'` and caching silently fails open to the database. Use an LRU/LFU eviction policy for pure cache workloads.

- **Cache key explosion.** Keying Redis on arbitrary floating-point bounding boxes gives near-zero hit rate — every request is a unique key. Snap requests to a tile grid before keying, so many clients share cache entries. A view has no such problem because it indexes the whole aggregate.

- **Materialized view can't do sub-second freshness.** If the aggregate must reflect writes within seconds, neither a periodic refresh nor a TTL fits well; route those reads to an on-the-fly query against the base tables and accept the cost.

---

Where both layers are in use, keep their invalidation independent. A view refresh should not attempt to purge Redis, and a cache invalidation should not trigger a refresh — coupling them produces a system where one slow operation blocks the other at exactly the moment both are needed.

Where both layers are in use, keep their invalidation independent. A view refresh should not attempt to purge Redis, and a cache invalidation should not trigger a refresh — coupling them produces a system where one slow operation blocks the other at exactly the moment both are needed.

## Verification

Confirm each layer is doing its job:

```sql
-- View: index scan, not seq scan, over the precomputed aggregate
EXPLAIN (ANALYZE, BUFFERS)
SELECT cell_id, ping_count FROM mv_ping_heatmap
WHERE cell_geom && ST_MakeEnvelope(-8250000, 4900000, -8200000, 4950000, 3857);
-- expect: Index Scan using idx_mv_ping_heatmap_geom
```

```bash
# Redis: second identical request should be a hit (much faster, no DB log entry)
redis-cli TTL "heatmap:z10:x301:y384"     # remaining seconds; -2 means missing/expired
redis-cli DEBUG OBJECT "heatmap:z10:x301:y384" | grep -o 'serializedlength:[0-9]*'
```

If the view query shows a `Seq Scan`, run `ANALYZE mv_ping_heatmap;`. If the Redis `TTL` is always `-2`, your key granularity is too fine to ever hit — snap to a tile grid.

---

## Related

- [Materialized Views for Spatial Aggregations](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/) — build, index, and serve the precomputed aggregate
- [Scheduling Concurrent Refresh of Spatial Materialized Views](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/scheduling-concurrent-refresh-of-spatial-materialized-views/) — keep view staleness bounded with pg_cron
- [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — TTL-based response caching and cache-tag invalidation

← Back to [Materialized Views for Spatial Aggregations](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/)
