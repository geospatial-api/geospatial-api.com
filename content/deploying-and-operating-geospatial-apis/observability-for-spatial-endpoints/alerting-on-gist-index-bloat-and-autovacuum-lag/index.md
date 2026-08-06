---
layout: layouts/page.njk
title: "Alerting on GiST Index Bloat and Autovacuum Lag"
description: "GiST indexes bloat differently from B-trees and the catalogue estimates lie about it. Measure with pgstattuple, alert on the ratio that moves first, and rebuild before latency notices."
slug: alerting-on-gist-index-bloat-and-autovacuum-lag
type: howto
breadcrumb:
  - label: "Deploying and Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Observability for Spatial Endpoints"
    url: "/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/"
  - label: "Alerting on GiST Index Bloat and Autovacuum Lag"
    url: "/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/alerting-on-gist-index-bloat-and-autovacuum-lag/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Alerting on GiST Index Bloat and Autovacuum Lag",
      "description": "Measure GiST bloat with pgstattuple, alert on the ratio that moves first, and rebuild before latency notices.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/alerting-on-gist-index-bloat-and-autovacuum-lag/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Deploying and Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/" },
        { "@type": "ListItem", "position": 2, "name": "Observability for Spatial Endpoints", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/" },
        { "@type": "ListItem", "position": 3, "name": "Alerting on GiST Index Bloat and Autovacuum Lag", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/alerting-on-gist-index-bloat-and-autovacuum-lag/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Detect and Fix GiST Index Bloat",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Measure, do not estimate", "text": "Use pgstattuple on the index rather than the catalogue-based bloat estimates written for B-trees." },
        { "@type": "HowToStep", "position": 2, "name": "Track the cache-hit ratio alongside", "text": "Bloat matters because it pushes the index out of memory, so watch both numbers together." },
        { "@type": "HowToStep", "position": 3, "name": "Rebuild concurrently", "text": "REINDEX CONCURRENTLY restores density without locking out writers." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why do standard bloat queries give wrong answers for GiST?",
          "acceptedAnswer": { "@type": "Answer", "text": "The widely-copied bloat estimates model a B-tree: fixed-width keys, a predictable fill factor and a known tuple header. A GiST index stores bounding boxes with variable overlap and splits pages by a completely different rule, so the estimate can be out by a factor of three in either direction. Measure with pgstattuple, which reads the pages, and accept that it costs a full index scan." }
        },
        {
          "@type": "Question",
          "name": "How much GiST bloat is too much?",
          "acceptedAnswer": { "@type": "Answer", "text": "The number that matters is not the percentage but whether the index still fits in the buffer cache. Twenty percent bloat on a two gigabyte index is harmless; the same percentage on an index sitting just under the cache size pushes it over the edge, and query time rises by an order of magnitude. Alert on the cache-hit ratio and use bloat as the explanation, not the trigger." }
        },
        {
          "@type": "Question",
          "name": "Does REINDEX CONCURRENTLY block writes?",
          "acceptedAnswer": { "@type": "Answer", "text": "No, but it holds a SHARE UPDATE EXCLUSIVE lock, which blocks other schema changes and autovacuum on that table, and it needs enough disk for a second copy of the index. It also leaves an invalid index behind if interrupted, so check for indexes whose name ends in ccnew after any failure." }
        }
      ]
    }
  ]
}
</script>

← Back to [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/)

# Alerting on GiST index bloat and autovacuum lag

This page covers how to measure bloat in a spatial index honestly, why the usual bloat queries mislead on GiST, and which signal to actually alert on.

## Context & When to Use

A spatial index degrades quietly. Updates and deletes leave dead entries; GiST pages split in ways that leave them half full; the index grows while the number of live rows does not. Nothing errors. Query plans do not change. The index simply gets bigger until it no longer fits in shared buffers, and then a 7 ms index scan becomes a 700 ms one over the course of a week — the pattern charted on the [observability topic page](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/).

The trap is that the popular bloat-estimation queries circulating in operations runbooks were written for B-trees. They assume fixed-width keys, a known fill factor and a predictable page layout. GiST satisfies none of those: it stores bounding boxes whose overlap changes how pages split, so the estimate can be badly wrong in either direction. Acting on it means either rebuilding an index that was fine or ignoring one that is not.

Use `pgstattuple` for the truth, use the buffer cache-hit ratio as the alert, and treat the bloat figure as the explanation you reach for once the alert has fired.

## Runnable Implementation

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;

-- Honest measurement of every spatial index. Costs a full scan per index,
-- so run it off-peak and store the result rather than querying it live.
CREATE TABLE index_health_history (
    measured_at   timestamptz NOT NULL DEFAULT now(),
    index_name    text        NOT NULL,
    size_bytes    bigint      NOT NULL,
    free_percent  numeric     NOT NULL,
    hit_ratio     numeric,
    PRIMARY KEY (index_name, measured_at)
);

INSERT INTO index_health_history (index_name, size_bytes, free_percent, hit_ratio)
SELECT i.indexrelname,
       pg_relation_size(i.indexrelid),
       -- pgstattuple reads the pages: slow, but correct for GiST
       (pgstattuple(i.indexrelid)).free_percent,
       round(s.idx_blks_hit::numeric
             / NULLIF(s.idx_blks_hit + s.idx_blks_read, 0), 4)
FROM   pg_stat_user_indexes i
JOIN   pg_statio_user_indexes s USING (indexrelid)
JOIN   pg_class c   ON c.oid = i.indexrelid
JOIN   pg_am   am   ON am.oid = c.relam
WHERE  am.amname = 'gist';
```

The rebuild, when it is warranted, is one statement — and the `CONCURRENTLY` form is the only one that belongs on a live system:

```sql
REINDEX INDEX CONCURRENTLY features_geom_gix;

-- After any interruption, check for the leftover invalid copy
SELECT c.relname
FROM   pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE  NOT i.indisvalid AND c.relname LIKE '%ccnew%';
```

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of catalogue bloat estimates against pgstattuple measurements for four indexes, showing agreement on B-trees and large disagreement on GiST" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Estimated bloat versus measured bloat, by index type</title>
  <desc>Four indexes with two bars each. Two B-tree indexes show close agreement: 12 percent estimated against 13 measured, and 8 against 9. Two GiST indexes disagree sharply: one estimated at 46 percent measures 19, which would have triggered an unnecessary rebuild, and one estimated at 11 percent measures 38, which the estimate would have let pass unnoticed. The conclusion drawn is that the catalogue estimate is usable for B-trees and unusable for GiST.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Catalogue estimates were written for B-trees</text>
  <rect x="452" y="14" width="12" height="12" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <text x="470" y="25" font-size="10" fill="currentColor">estimated</text>
  <rect x="558" y="14" width="12" height="12" rx="2" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <text x="576" y="25" font-size="10" fill="currentColor">pgstattuple</text>
  <text x="20" y="60" font-size="10.5" font-family="monospace" fill="currentColor">orders_pkey (btree)</text>
  <rect x="240" y="48" width="96" height="9" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <rect x="240" y="59" width="104" height="9" rx="2" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <text x="356" y="62" font-size="9.5" fill="var(--viz-good, #1f6b3a)">12 % vs 13 % — agreement</text>
  <text x="20" y="100" font-size="10.5" font-family="monospace" fill="currentColor">users_email (btree)</text>
  <rect x="240" y="88" width="64" height="9" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <rect x="240" y="99" width="72" height="9" rx="2" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <text x="324" y="102" font-size="9.5" fill="var(--viz-good, #1f6b3a)">8 % vs 9 % — agreement</text>
  <line x1="20" y1="120" x2="700" y2="120" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="146" font-size="10.5" font-family="monospace" fill="currentColor">features_geom_gix</text>
  <rect x="240" y="134" width="368" height="9" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <rect x="240" y="145" width="152" height="9" rx="2" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <text x="404" y="148" font-size="9.5" font-weight="700" fill="var(--viz-warn, #8a5000)">46 % vs 19 % — would rebuild for nothing</text>
  <text x="20" y="186" font-size="10.5" font-family="monospace" fill="currentColor">positions_geom_gix</text>
  <rect x="240" y="174" width="88" height="9" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <rect x="240" y="185" width="304" height="9" rx="2" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <text x="556" y="188" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">11 % vs 38 % — missed</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">Both GiST rows are wrong, in opposite directions. On a spatial index the estimate is not a cheap approximation</text>
  <text x="20" y="238" font-size="10.5" fill="var(--muted, #7c6fb0)">of the measurement — it is unrelated to it.</text>
</svg>

## Key Parameters & Options

| Signal | Source | Alert on |
|---|---|---|
| `free_percent` | `pgstattuple(index)` | Trend, not absolute — a doubling in a month |
| Index cache-hit ratio | `pg_statio_user_indexes` | < 0.98 sustained 15 min — the real trigger |
| `n_dead_tup` | `pg_stat_user_tables` | > 20 % of live tuples |
| `last_autovacuum` | `pg_stat_user_tables` | Older than 24 h on a write-heavy table |
| Index size trend | `pg_relation_size` | Growing while row count is flat |
| `autovacuum_vacuum_scale_factor` | table storage parameter | 0.05 on large spatial tables, not the 0.2 default |

The default `autovacuum_vacuum_scale_factor` of 0.2 means a 400 million row table waits for 80 million dead tuples before autovacuum runs. On a spatial table that is far too late — set it per table:

```sql
ALTER TABLE features SET (autovacuum_vacuum_scale_factor = 0.05,
                          autovacuum_analyze_scale_factor = 0.02);
```

## Bloat only matters when it crosses the cache

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of query latency against index size, flat until the index exceeds available buffer cache and then rising sharply" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Latency against index size, with the buffer cache boundary marked</title>
  <desc>Query latency plotted against GiST index size. From 1 to 11 gigabytes the latency stays between 6 and 9 milliseconds. The available buffer cache is 12 gigabytes, marked with a vertical line. Past that point latency climbs steeply: 34 milliseconds at 13 gigabytes, 180 at 15, and 610 at 18. The annotation notes that 30 percent bloat is irrelevant below the line and catastrophic above it, which is why the alert belongs on the cache-hit ratio rather than on the bloat percentage.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">The same bloat percentage, two completely different outcomes</text>
  <line x1="70" y1="176" x2="690" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <line x1="70" y1="44" x2="70" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <text x="62" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">600 ms</text>
  <text x="62" y="116" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">300 ms</text>
  <text x="62" y="176" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <polyline points="70,172 140,172 210,171 280,171 350,170 420,169 460,168 500,140 540,96 580,62 620,48" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="2.4"/>
  <line x1="460" y1="40" x2="460" y2="188" stroke="var(--viz-bad, #a32b23)" stroke-width="2"/>
  <text x="468" y="60" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">buffer cache: 12 GB</text>
  <text x="468" y="76" font-size="9.5" fill="var(--viz-bad, #a32b23)">past here every scan hits disk</text>
  <rect x="70" y="188" width="390" height="14" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.25"/>
  <text x="265" y="199" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">30 % bloat here is irrelevant</text>
  <rect x="462" y="188" width="228" height="14" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.25"/>
  <text x="576" y="199" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">30 % bloat here is an outage</text>
  <text x="100" y="220" font-size="9.5" fill="var(--muted, #7c6fb0)">2 GB</text>
  <text x="330" y="220" font-size="9.5" fill="var(--muted, #7c6fb0)">9 GB</text>
  <text x="540" y="220" font-size="9.5" fill="var(--muted, #7c6fb0)">15 GB</text>
  <text x="20" y="236" font-size="10.5" fill="var(--muted, #7c6fb0)">Alert on the hit ratio; use the bloat measurement to decide whether a rebuild or more memory is the fix.</text>
</svg>

Which fix to choose follows directly from the chart. If the index is bloated and would fit comfortably once rebuilt, reindex. If it is dense and simply larger than the cache, the answer is more memory or [partitioning](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/) so only the recent partitions need to stay resident.

## Gotchas & Failure Modes

- **`pgstattuple` on a huge index during business hours.** It reads every page and evicts other data from the cache while doing so — the measurement causes the symptom. Schedule it off-peak.
- **Copy-pasted bloat estimates.** As charted above, they are unrelated to reality for GiST. If a runbook has one, label it "B-tree only".
- **`REINDEX` without `CONCURRENTLY`.** Takes an `ACCESS EXCLUSIVE` lock for the whole rebuild — minutes of downtime on a large spatial index.
- **Interrupted `REINDEX CONCURRENTLY`.** Leaves an invalid `_ccnew` index consuming disk and write bandwidth without serving reads. Check for it after any failure and drop it explicitly.
- **Autovacuum blocked by a long transaction.** An idle-in-transaction connection prevents cleanup no matter how the thresholds are tuned. Watch `pg_stat_activity` for `state = 'idle in transaction'` older than a few minutes.
- **Rebuilding the symptom, not the cause.** An index that bloats again within a fortnight is being fed by an update pattern that rewrites geometry constantly. Consider whether those writes need to touch the geometry column at all.

## Why spatial tables bloat faster than the rest

It is worth understanding the mechanism, because the fix depends on which of three causes is dominant, and they call for different responses.

The first is ordinary dead tuples. Any update or delete leaves the old index entry in place until vacuum reclaims it, and a table whose geometry is rewritten on every position report generates them continuously. The second is page splits: GiST chooses a split by minimising bounding-box overlap, and when new geometry arrives in an area already densely covered, the resulting pages are often left well under half full. The third is the one people miss — an update that does not touch the geometry column still writes a new row version, and unless the table qualifies for a heap-only tuple update, that means a new entry in every index including the spatial one.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Breakdown of what contributes to GiST index growth on three different workloads" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What drives index growth, by workload</title>
  <desc>Three workloads with stacked contributions to index growth over one month. An append-only tracking table grows 6 percent, almost all from page splits. A table with frequent geometry updates grows 41 percent, split roughly evenly between dead tuples and page splits. A table with frequent attribute-only updates grows 28 percent, almost entirely from dead tuples caused by non-HOT updates touching every index. The remedies differ: page splits call for a rebuild, dead tuples call for vacuum tuning and a fill-factor change.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One month of index growth, three workloads</text>
  <rect x="450" y="14" width="12" height="12" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.65"/>
  <text x="468" y="25" font-size="10" fill="currentColor">page splits</text>
  <rect x="556" y="14" width="12" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.65"/>
  <text x="574" y="25" font-size="10" fill="currentColor">dead tuples</text>
  <text x="20" y="70" font-size="10.5" fill="currentColor">append-only positions</text>
  <rect x="200" y="56" width="60" height="20" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.65"/>
  <rect x="260" y="56" width="8" height="20" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.65"/>
  <text x="278" y="71" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">+6 % — rebuild yearly at most</text>
  <text x="20" y="122" font-size="10.5" fill="currentColor">geometry updated often</text>
  <rect x="200" y="108" width="200" height="20" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.65"/>
  <rect x="400" y="108" width="210" height="20" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.65"/>
  <text x="618" y="123" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">+41 %</text>
  <text x="200" y="146" font-size="9.5" fill="var(--muted, #7c6fb0)">→ tune autovacuum AND schedule rebuilds</text>
  <text x="20" y="186" font-size="10.5" fill="currentColor">attributes updated often</text>
  <rect x="200" y="172" width="36" height="20" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.65"/>
  <rect x="236" y="172" width="292" height="20" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.65"/>
  <text x="536" y="187" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">+28 %</text>
  <text x="200" y="210" font-size="9.5" fill="var(--muted, #7c6fb0)">→ lower fillfactor so updates stay heap-only and never touch the index</text>
  <text x="20" y="232" font-size="10.5" fill="var(--muted, #7c6fb0)">The third case is the surprising one: nothing spatial changed, yet the spatial index grew by a quarter.</text>
</svg>

That third case has a cheap fix that is easy to miss. Lowering the table's `fillfactor` leaves free space on each heap page, which lets more updates stay heap-only and therefore never touch the spatial index at all:

```sql
ALTER TABLE features SET (fillfactor = 85);
VACUUM FULL features;   -- or pg_repack, to apply it to existing pages
```

## Verification Snippet

```sql
-- Before and after a rebuild
SELECT pg_size_pretty(pg_relation_size('features_geom_gix')) AS size,
       (pgstattuple('features_geom_gix')).free_percent       AS free_pct;
--  size   | free_pct
-- --------+----------
--  14 GB  |    38.10
-- after REINDEX INDEX CONCURRENTLY:
--  8.9 GB |     4.20

-- Confirm the hit ratio recovered
SELECT indexrelname,
       round(idx_blks_hit::numeric / NULLIF(idx_blks_hit + idx_blks_read, 0), 4)
FROM   pg_statio_user_indexes WHERE indexrelname = 'features_geom_gix';
```

```bash
# Prometheus rule: alert on the leading signal, not on bloat directly
# - alert: SpatialIndexLeavingCache
#   expr: pg_statio_user_indexes_hit_ratio{index=~".*_gix"} < 0.98
#   for: 15m
```

---

## Related

- [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) — where this signal sits among the others
- [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — reading the plans a bloated index produces
- [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/) — keeping only the hot index resident

← Back to [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/)
