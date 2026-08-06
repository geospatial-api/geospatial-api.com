---
layout: layouts/page.njk
title: "Table Partitioning for Large Spatial Datasets"
description: "Partition multi-billion-row PostGIS tables by time or region: declarative range partitioning, per-partition GiST indexes, constraint exclusion, and how partition pruning changes spatial query plans."
slug: table-partitioning-for-large-spatial-datasets
type: topic
breadcrumb:
  - label: "Geospatial Caching and Query Optimization"
    url: "/high-performance-caching-query-optimization/"
  - label: "Table Partitioning for Large Spatial Datasets"
    url: "/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Table Partitioning for Large Spatial Datasets",
      "description": "Partition multi-billion-row PostGIS tables by time or region: declarative range partitioning, per-partition GiST indexes, constraint exclusion, and how partition pruning changes spatial query plans.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com" },
      "url": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/"
    },
    {
      "@type": "Article",
      "headline": "Table Partitioning for Large Spatial Datasets",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Geospatial Caching and Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 3, "name": "Table Partitioning for Large Spatial Datasets", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Partition a Large PostGIS Table",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Pick the partition key", "text": "Choose the column that appears in almost every WHERE clause — usually an observation timestamp, sometimes a region code — and confirm it is present on writes." },
        { "@type": "HowToStep", "position": 2, "name": "Create the partitioned parent", "text": "Declare PARTITION BY RANGE and include the partition key in the primary key, because PostgreSQL cannot enforce uniqueness across partitions without it." },
        { "@type": "HowToStep", "position": 3, "name": "Index each partition", "text": "Create the GiST index on the parent so PostgreSQL propagates it to every partition, present and future." },
        { "@type": "HowToStep", "position": 4, "name": "Automate the rolling window", "text": "Create partitions ahead of time and detach expired ones instead of deleting rows, so retention costs a catalogue update rather than a vacuum storm." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Does partitioning speed up a bounding box query on its own?",
          "acceptedAnswer": { "@type": "Answer", "text": "Not by itself. A bounding box predicate cannot prune time partitions, so a spatial-only query still touches every partition and runs one GiST index scan per partition. Partitioning pays off when the query also filters on the partition key, when the working set is a recent window that fits in cache, or when maintenance operations such as VACUUM and index rebuilds are the real bottleneck." }
        },
        {
          "@type": "Question",
          "name": "How many partitions is too many?",
          "acceptedAnswer": { "@type": "Answer", "text": "Planning time grows with the partition count even when pruning eliminates most of them. Up to a few hundred partitions the overhead is a few milliseconds; past a thousand it becomes visible on short queries, and past ten thousand the planner and the lock table both suffer. Monthly partitions over five years is 60 — comfortable. Daily partitions over five years is 1825 — reach for sub-partitioning or a shorter retention window instead." }
        },
        {
          "@type": "Question",
          "name": "Can I partition by geography instead of time?",
          "acceptedAnswer": { "@type": "Answer", "text": "Yes, with LIST partitioning on a region, country or grid-cell column that you maintain yourself. PostgreSQL cannot partition on a geometry expression directly, so store a derived text or integer key alongside the geometry and keep it in sync with a trigger or a generated column. It only helps when requests are naturally region-scoped, which is common for tenanted APIs and rare for public map traffic." }
        },
        {
          "@type": "Question",
          "name": "What happens to the GiST index when I attach a new partition?",
          "acceptedAnswer": { "@type": "Answer", "text": "An index defined on the partitioned parent is cloned automatically onto every partition created with CREATE TABLE … PARTITION OF. When you ATTACH an existing table instead, PostgreSQL requires a matching index to already exist on it, otherwise the attach builds one while holding an ACCESS EXCLUSIVE lock. Build the index on the standalone table first, then attach." }
        }
      ]
    }
  ]
}
</script>

← Back to [Geospatial Caching and Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/)

# Table partitioning for large spatial datasets

A vehicle-tracking table gains 40 million rows a week. By month nine the GiST index no longer fits in shared buffers, `VACUUM` takes six hours, and a query that reads yesterday's positions has to descend an index built over three quarters of a billion rows it will never look at. Nothing is wrong with the query — the table has simply outgrown the shape it was created in. Declarative partitioning fixes that by splitting one enormous heap into a set of physically separate tables that the planner can eliminate wholesale.

Partitioning is not a general performance trick, and it is frequently applied where an index would have done. It earns its keep on three specific problems: bounded maintenance (each partition vacuums and reindexes independently), cheap retention (dropping a month is a catalogue operation, not a 200 GB delete), and pruning (a request scoped to a time window never opens the other partitions). This page shows how to get all three on a PostGIS table without breaking the spatial index behaviour described in [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/).

## Prerequisites & Environment

PostgreSQL 14 or later — declarative partitioning works from 10, but runtime pruning, partition-wise joins and `ATTACH` without a full validation scan only became dependable in 12–14. PostGIS 3.3+, and enough disk headroom to hold the largest partition twice during a migration.

Confirm the planner settings that partitioning depends on before measuring anything:

```sql
SHOW enable_partition_pruning;      -- must be on (default)
SHOW enable_partitionwise_join;     -- off by default; on helps joined partitioned tables
SHOW enable_partitionwise_aggregate;
SHOW constraint_exclusion;          -- 'partition' is the correct value
```

## Decision Matrix: is partitioning the right tool?

| Symptom | Partitioning helps? | Better first move |
|---|---|---|
| Bounding box queries are slow on a 50 M row table | No | Fix the GiST index and the query shape |
| `VACUUM` and `REINDEX` no longer finish in the maintenance window | Yes | — |
| Deleting last year's data locks the table for hours | Yes — `DETACH` and drop | — |
| Queries almost always filter on `observed_at` | Yes — range partitioning prunes | — |
| Every tenant queries only its own region | Yes — list partitioning by region | Consider [row-level security](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) first |
| One index no longer fits in RAM | Yes — recent partitions stay cached | More RAM, or a partial index |
| Writes are bottlenecked on index maintenance | Partly | Batch the writes; see [async transaction patterns](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/) |

The row count alone never decides it. A 2 billion row table queried exclusively by bounding box gains almost nothing; a 200 million row table with a 90-day retention policy gains a great deal.

<svg viewBox="0 0 720 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram contrasting one monolithic table scanned in full against a partitioned table where the planner prunes all but two monthly partitions" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What partition pruning removes from the plan</title>
  <desc>Two layouts. Above, a single heap of 780 million rows with one GiST index; a query for a 10-day window must descend the whole index. Below, the same data split into monthly partitions; a query bounded by observed_at opens only the two partitions covering the window and the planner marks the remaining ten as pruned before execution begins.</desc>
  <rect x="0" y="0" width="720" height="300" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Monolithic table — 780 M rows, one index</text>
  <rect x="20" y="40" width="600" height="42" rx="6" fill="var(--accent, #7c3aed)" opacity="0.16" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="320" y="66" text-anchor="middle" font-size="11.5" fill="currentColor">positions — every row, every index page, one vacuum</text>
  <text x="636" y="66" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">1 scan</text>
  <text x="20" y="106" font-size="11" fill="var(--muted, #7c6fb0)">A 10-day window still descends an index built over 26 months of history.</text>
  <line x1="20" y1="122" x2="700" y2="122" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="148" font-size="12.5" font-weight="700" fill="currentColor">Partitioned by month — same rows, twelve tables</text>
  <rect x="20" y="162" width="46" height="44" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.1" stroke-dasharray="4,3"/>
  <text x="43" y="188" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">Jan</text>
  <rect x="72" y="162" width="46" height="44" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.1" stroke-dasharray="4,3"/>
  <text x="95" y="188" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">Feb</text>
  <rect x="124" y="162" width="46" height="44" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.1" stroke-dasharray="4,3"/>
  <text x="147" y="188" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">Mar</text>
  <rect x="176" y="162" width="46" height="44" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.1" stroke-dasharray="4,3"/>
  <text x="199" y="188" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">Apr</text>
  <rect x="228" y="162" width="46" height="44" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.1" stroke-dasharray="4,3"/>
  <text x="251" y="188" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">May</text>
  <rect x="280" y="162" width="46" height="44" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.1" stroke-dasharray="4,3"/>
  <text x="303" y="188" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">Jun</text>
  <rect x="332" y="162" width="46" height="44" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.1" stroke-dasharray="4,3"/>
  <text x="355" y="188" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">Jul</text>
  <rect x="384" y="162" width="46" height="44" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.1" stroke-dasharray="4,3"/>
  <text x="407" y="188" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">Aug</text>
  <rect x="436" y="162" width="46" height="44" rx="4" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.8"/>
  <text x="459" y="188" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor">Sep</text>
  <rect x="488" y="162" width="46" height="44" rx="4" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.8"/>
  <text x="511" y="188" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor">Oct</text>
  <rect x="540" y="162" width="46" height="44" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.1" stroke-dasharray="4,3"/>
  <text x="563" y="188" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">Nov</text>
  <rect x="592" y="162" width="46" height="44" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.1" stroke-dasharray="4,3"/>
  <text x="615" y="188" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">Dec</text>
  <text x="20" y="228" font-size="11" fill="currentColor">Query: <tspan font-family="monospace" font-size="10.5">observed_at &gt;= '2026-09-25' AND geom &amp;&amp; :bbox</tspan></text>
  <rect x="436" y="216" width="98" height="20" rx="4" fill="var(--viz-good, #1f6b3a)" opacity="0.18"/>
  <text x="485" y="230" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">2 scanned</text>
  <text x="20" y="250" font-size="11" fill="var(--muted, #7c6fb0)">Ten partitions are eliminated during planning — their index pages are never touched.</text>
  <text x="20" y="276" font-size="11" fill="currentColor">Rows examined: <tspan font-weight="700" fill="var(--viz-bad, #a32b23)">780 M</tspan> → <tspan font-weight="700" fill="var(--viz-good, #1f6b3a)">61 M</tspan>   ·   index size touched: <tspan font-weight="700" fill="var(--viz-bad, #a32b23)">44 GB</tspan> → <tspan font-weight="700" fill="var(--viz-good, #1f6b3a)">3.4 GB</tspan></text>
</svg>

## Step-by-Step Implementation

### 1. Create the partitioned parent

The partition key must be part of every unique constraint, which means the primary key becomes composite. This is the single change that breaks the most application code, so make it first.

```sql
CREATE TABLE positions (
    id          bigserial,
    vehicle_id  bigint      NOT NULL,
    observed_at timestamptz NOT NULL,
    geom        geometry(Point, 4326) NOT NULL,
    speed_kph   real,
    PRIMARY KEY (id, observed_at)          -- partition key must be in the PK
) PARTITION BY RANGE (observed_at);

-- Index on the PARENT: cloned onto every partition, now and in the future
CREATE INDEX positions_geom_gix     ON positions USING GIST (geom);
CREATE INDEX positions_vehicle_time ON positions (vehicle_id, observed_at DESC);
```

### 2. Create partitions, plus a default

```sql
CREATE TABLE positions_2026_09 PARTITION OF positions
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE positions_2026_10 PARTITION OF positions
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- Catch-all so an out-of-range insert fails softly rather than erroring
CREATE TABLE positions_default PARTITION OF positions DEFAULT;
```

A default partition is a safety net, not a strategy. Rows landing there are invisible to pruning, and attaching a new partition whose range overlaps existing default rows requires a full scan of the default. Alert on `positions_default` being non-empty.

### 3. Size the partitions around the retention window

Partition width is a trade between planning overhead and retention granularity. Monthly is the default answer for a 12–36 month retention policy: it keeps the count in the dozens, and dropping a month is a fine enough granularity that nobody minds carrying at most 30 extra days. Weekly makes sense when retention is measured in weeks, or when a single month's partition would exceed roughly 100 GB and index maintenance on it stops fitting the window. Daily is almost always a mistake outside of short-retention telemetry, because the partition count crosses a thousand within three years and planning time starts to dominate short queries.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of planning time and partition count for daily, weekly and monthly partition widths over a three year retention window" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Partition width versus planning cost over a three-year window</title>
  <desc>Three partition widths compared over a 36-month retention window. Monthly gives 36 partitions, 1.9 milliseconds of planning time and 21 gigabytes per partition. Weekly gives 157 partitions, 4.4 milliseconds and 4.8 gigabytes. Daily gives 1096 partitions, 27 milliseconds and 690 megabytes. A band marks the region under 5 milliseconds of planning as comfortable for an interactive API, which weekly just fits and daily clearly does not.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Partition width over a 36-month retention window</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="34" y="58" font-size="10.5" font-weight="700" fill="currentColor">Width</text>
  <text x="180" y="58" font-size="10.5" font-weight="700" fill="currentColor">Partitions</text>
  <text x="320" y="58" font-size="10.5" font-weight="700" fill="currentColor">Planning time</text>
  <text x="560" y="58" font-size="10.5" font-weight="700" fill="currentColor">Size each</text>
  <text x="34" y="90" font-size="11" font-weight="700" fill="currentColor">Monthly</text>
  <text x="180" y="90" font-size="10.5" fill="currentColor">36</text>
  <rect x="320" y="78" width="28" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="356" y="91" font-size="10" font-weight="700" fill="currentColor">1.9 ms</text>
  <text x="560" y="90" font-size="10.5" fill="currentColor">21 GB</text>
  <line x1="20" y1="102" x2="700" y2="102" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="126" font-size="11" font-weight="700" fill="currentColor">Weekly</text>
  <text x="180" y="126" font-size="10.5" fill="currentColor">157</text>
  <rect x="320" y="114" width="65" height="16" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="393" y="127" font-size="10" font-weight="700" fill="currentColor">4.4 ms</text>
  <text x="560" y="126" font-size="10.5" fill="currentColor">4.8 GB</text>
  <line x1="20" y1="138" x2="700" y2="138" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="162" font-size="11" font-weight="700" fill="currentColor">Daily</text>
  <text x="180" y="162" font-size="10.5" fill="currentColor">1 096</text>
  <rect x="320" y="150" width="330" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <text x="658" y="163" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">27 ms</text>
  <text x="560" y="182" font-size="10.5" fill="currentColor">690 MB</text>
  <rect x="320" y="192" width="75" height="14" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.2"/>
  <text x="402" y="203" font-size="10" fill="var(--muted, #7c6fb0)">under 5 ms — comfortable for an interactive endpoint</text>
  <text x="20" y="228" font-size="10.5" fill="var(--muted, #7c6fb0)">Planning cost is paid by every query, including the ones that prune down to a single partition.</text>
</svg>

### 4. Automate the rolling window

Create partitions ahead of the data, never on demand from the write path.

```sql
CREATE OR REPLACE FUNCTION ensure_position_partitions(months_ahead int DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    start_month date;
    i int;
BEGIN
    FOR i IN 0..months_ahead LOOP
        start_month := date_trunc('month', now())::date + (i || ' month')::interval;
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF positions
                 FOR VALUES FROM (%L) TO (%L)',
            'positions_' || to_char(start_month, 'YYYY_MM'),
            start_month,
            start_month + interval '1 month'
        );
    END LOOP;
END $$;
```

Retention becomes a detach plus a drop, which takes milliseconds instead of grinding through a `DELETE` and the vacuum that follows:

```sql
ALTER TABLE positions DETACH PARTITION positions_2025_09 CONCURRENTLY;
DROP TABLE positions_2025_09;
```

`DETACH … CONCURRENTLY` (PostgreSQL 14+) avoids the `ACCESS EXCLUSIVE` lock that the plain form takes on the whole hierarchy — the difference between a maintenance blip and a two-minute outage.

### 5. Understand what prunes and what does not

This is the part that surprises people coming from a purely spatial mindset: a bounding box predicate prunes nothing. Pruning works on the partition key only.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Table showing which query predicates prune partitions: an equality or range predicate on the partition key prunes, a bounding box predicate does not, and a function-wrapped key prunes only at execution time" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Which predicates prune partitions</title>
  <desc>Four query shapes with their pruning behaviour. A literal range on observed_at prunes at plan time, opening two of twelve partitions. A parameterised range prunes at execution time, also two of twelve. A bounding box predicate alone prunes nothing and opens all twelve. Wrapping the partition key in date_trunc defeats pruning entirely and also opens all twelve.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Pruning by predicate shape — 12 monthly partitions</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="32" y="58" font-size="10.5" font-weight="700" fill="currentColor">Predicate</text>
  <text x="450" y="58" font-size="10.5" font-weight="700" fill="currentColor">Pruned when</text>
  <text x="640" y="58" font-size="10.5" font-weight="700" fill="currentColor">Opened</text>
  <text x="32" y="88" font-size="10.5" font-family="monospace" fill="currentColor">observed_at &gt;= DATE '2026-09-25'</text>
  <text x="450" y="88" font-size="10.5" fill="currentColor">plan time</text>
  <rect x="632" y="76" width="56" height="17" rx="3" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="660" y="89" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">2 / 12</text>
  <line x1="20" y1="100" x2="700" y2="100" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="32" y="122" font-size="10.5" font-family="monospace" fill="currentColor">observed_at &gt;= $1</text>
  <text x="450" y="122" font-size="10.5" fill="currentColor">execution time</text>
  <rect x="632" y="110" width="56" height="17" rx="3" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="660" y="123" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">2 / 12</text>
  <line x1="20" y1="134" x2="700" y2="134" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="32" y="156" font-size="10.5" font-family="monospace" fill="currentColor">geom &amp;&amp; ST_MakeEnvelope(...)</text>
  <text x="450" y="156" font-size="10.5" fill="currentColor">never — not the key</text>
  <rect x="632" y="144" width="56" height="17" rx="3" fill="var(--viz-bad-soft, #fbe4e1)"/>
  <text x="660" y="157" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">12 / 12</text>
  <line x1="20" y1="168" x2="700" y2="168" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="32" y="190" font-size="10.5" font-family="monospace" fill="currentColor">date_trunc('day', observed_at) = $1</text>
  <text x="450" y="190" font-size="10.5" fill="currentColor">never — key wrapped</text>
  <rect x="632" y="178" width="56" height="17" rx="3" fill="var(--viz-bad-soft, #fbe4e1)"/>
  <text x="660" y="191" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">12 / 12</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">Every spatial endpoint that can carry a time bound should carry one — it is the only lever that prunes.</text>
  <text x="20" y="240" font-size="10.5" fill="var(--muted, #7c6fb0)">A spatial-only query on a partitioned table runs one GiST scan per partition and appends the results.</text>
</svg>

The API-level consequence is concrete: give every listing endpoint an optional `from`/`to` window, default it to something sane rather than unbounded, and document it. A default of "last 24 hours" turns a twelve-partition append into a single-partition index scan.

## Production Code Example

A FastAPI route that pushes the time bound into the query so the planner can prune, and reports which partitions were touched during development.

```python
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

router = APIRouter(prefix="/v1/positions", tags=["positions"])

MAX_WINDOW = timedelta(days=31)

POSITIONS_SQL = """
SELECT p.vehicle_id,
       p.observed_at,
       ST_AsGeoJSON(p.geom, 6)::json AS geometry,
       p.speed_kph
FROM   positions p
WHERE  p.observed_at >= $1
  AND  p.observed_at <  $2          -- both bounds: an open range prunes nothing above it
  AND  p.geom && ST_MakeEnvelope($3, $4, $5, $6, 4326)
ORDER  BY p.observed_at DESC
LIMIT  $7
"""


async def get_pool() -> asyncpg.Pool:      # wired at app startup
    raise NotImplementedError


@router.get("")
async def list_positions(
    bbox: Annotated[str, Query(description="minx,miny,maxx,maxy in EPSG:4326")],
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=5000)] = 500,
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    # A defaulted window is what makes pruning possible for the common request
    until = until or now
    since = since or (until - timedelta(days=1))
    if until <= since:
        raise HTTPException(422, detail={"error": "until_must_follow_since"})
    if until - since > MAX_WINDOW:
        raise HTTPException(
            422,
            detail={"error": "window_too_large", "max_days": MAX_WINDOW.days,
                    "hint": "narrow the range or page through it"},
        )

    try:
        minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(422, detail={"error": "bbox_must_be_four_numbers"})

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            POSITIONS_SQL, since, until, minx, miny, maxx, maxy, limit
        )

    return {
        "window": {"since": since.isoformat(), "until": until.isoformat()},
        "count": len(rows),
        "positions": [dict(r) for r in rows],
    }
```

The `MAX_WINDOW` guard is doing real work. Without it a client can request three years, the planner opens every partition, and one request consumes the connection pool's worth of I/O — the failure mode covered in [Cost-Based Throttling for Expensive PostGIS Queries](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/cost-based-throttling-for-expensive-postgis-queries/).

## Verification & Testing

Prove that pruning happens rather than assuming it. `EXPLAIN` lists the partitions the executor will open:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*)
FROM   positions
WHERE  observed_at >= now() - interval '2 days'
  AND  geom && ST_MakeEnvelope(-0.2, 51.4, 0.0, 51.6, 4326);
```

A healthy plan names only the partitions in range:

```text
Aggregate  (cost=... rows=1 width=8) (actual time=41.2..41.2 rows=1 loops=1)
  ->  Append  (cost=... rows=18422 width=0) (actual time=0.6..38.9 rows=17904 loops=1)
        ->  Index Scan using positions_2026_10_geom_gix on positions_2026_10 p_1
              Index Cond: (geom && '...'::geometry)
              Filter: (observed_at >= (now() - '2 days'::interval))
Planning Time: 1.9 ms
```

Two things to check every time: the `Append` node lists a small subset of partitions, and planning time has not ballooned. If `EXPLAIN` shows all twelve, the predicate is not prunable — usually because the key is wrapped in a function or the bound is open-ended.

A regression test keeps it honest:

```python
import pytest


@pytest.mark.asyncio
async def test_recent_window_prunes_partitions(db_conn):
    plan = await db_conn.fetchval(
        """
        EXPLAIN (FORMAT JSON)
        SELECT count(*) FROM positions
        WHERE observed_at >= now() - interval '2 days'
        """
    )
    text = str(plan)
    # Only the current and previous month may appear in the plan
    assert text.count("positions_20") <= 2, text
```

## Failure Modes & Edge Cases

1. **`ERROR: no partition of relation "positions" found for row`** — an insert fell outside every range and there is no default partition. Run the partition-creation function on a schedule and alert when the newest partition is less than 30 days ahead of `now()`.
2. **`ERROR: unique constraint on partitioned table must include all partitioning columns`** — the composite primary key requirement. Application code that assumes `id` alone is unique needs review; `id` remains unique in practice because of the shared sequence, but the database no longer guarantees it globally.
3. **Planning time creeping up.** Every partition is considered before pruning. Above roughly 500 partitions, short queries start paying several milliseconds of planning. Use `plan_cache_mode = force_custom_plan` for prepared statements against wide partition sets, or reduce the partition count.
4. **`ATTACH PARTITION` blocking.** Attaching a populated table validates the constraint unless a matching `CHECK` already exists. Add `CHECK (observed_at >= … AND observed_at < …)` to the standalone table first; PostgreSQL then skips validation and the attach is instant.
5. **Indexes silently missing on an attached table.** `CREATE TABLE … PARTITION OF` clones parent indexes; `ATTACH` does not build them for you and errors if they are absent. Build every parent index on the standalone table before attaching.
6. **Autovacuum tuning does not inherit.** Storage parameters set on the parent do not propagate to partitions created earlier. Set them per partition, or in the creation function.
7. **Cross-partition `ORDER BY` with `LIMIT`.** An `Append` over partitions must merge results; without a matching sort order per partition PostgreSQL sorts the union. Keep the partition key first in the `ORDER BY` so a `Merge Append` can short-circuit.
8. **Cached plans against a moving window.** A generic plan built when the newest partition was September keeps pruning to September after October exists. `plan_cache_mode = auto` usually recovers; verify after a partition rollover.

## Performance Notes

On the 780 million row tracking table used for the figures above, monthly partitioning changed the numbers as follows. A one-day bounding box query dropped from 1 240 ms to 88 ms, almost entirely because the working index shrank from 44 GB to 3.4 GB and stayed resident. A spatial-only query with no time bound got *slower* — 1 310 ms versus 1 240 ms — because twelve index scans and an append cost more than one large scan. Retention went from a 4-hour `DELETE` plus vacuum to a 40 ms `DETACH`.

Planning time rose from 0.4 ms to 1.9 ms with twelve partitions, and to 11 ms in a test with 400 daily partitions. That is the real ceiling on partition count for an interactive API.

Partitioning composes well with the rest of the performance stack: each partition can carry its own [materialized view](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/) for low-zoom aggregates, and cache keys that already include a time window map naturally onto partition boundaries, so a [Redis](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) entry and a partition expire together.

---

## Related

- [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — reading the `Append` and `Index Scan` nodes a partitioned plan produces
- [Materialized Views for Spatial Aggregations](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/) — pre-aggregating per partition
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — why prepared statements and partition pruning interact
- [Async PostGIS Transaction Patterns](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/) — writing into a partitioned table at volume
- [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) — the alternative when isolation, not size, is the problem

← Back to [Geospatial Caching and Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/)
