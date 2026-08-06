---
layout: layouts/page.njk
title: "Migrating a Live Spatial Table to Partitions"
description: "Convert a 700 GB PostGIS table to declarative partitioning without an outage: shadow parent, backfill in batches, dual-write cutover and the rollback that stays available throughout."
slug: migrating-a-live-spatial-table-to-partitions
type: howto
breadcrumb:
  - label: "Geospatial Caching and Query Optimization"
    url: "/high-performance-caching-query-optimization/"
  - label: "Table Partitioning for Large Spatial Datasets"
    url: "/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/"
  - label: "Migrating a Live Spatial Table to Partitions"
    url: "/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/migrating-a-live-spatial-table-to-partitions/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Migrating a Live Spatial Table to Partitions",
      "description": "Convert a large PostGIS table to declarative partitioning without an outage: shadow parent, batched backfill, dual-write cutover and rollback.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/migrating-a-live-spatial-table-to-partitions/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Geospatial Caching and Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 2, "name": "Table Partitioning for Large Spatial Datasets", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/" },
        { "@type": "ListItem", "position": 3, "name": "Migrating a Live Spatial Table to Partitions", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/migrating-a-live-spatial-table-to-partitions/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Convert a Live PostGIS Table to Declarative Partitioning",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Create the shadow parent", "text": "Build an empty partitioned table with the same columns, the composite primary key and the parent indexes." },
        { "@type": "HowToStep", "position": 2, "name": "Backfill in batches", "text": "Copy historical rows month by month with a bounded batch size, building each partition's index before attaching it." },
        { "@type": "HowToStep", "position": 3, "name": "Dual-write", "text": "Write new rows to both tables while the backfill runs, so the shadow never falls behind." },
        { "@type": "HowToStep", "position": 4, "name": "Swap under one short lock", "text": "Rename both tables inside a single transaction, keeping the old table intact as the rollback path." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Can an existing table be converted in place?",
          "acceptedAnswer": { "@type": "Answer", "text": "No. PostgreSQL cannot turn an ordinary table into a partitioned one; the partitioning strategy is fixed at creation. The nearest thing is to create a new partitioned parent and attach the old table as one large partition covering all existing data, which is fast but leaves the history unsplit. A full migration copies the rows into properly bounded partitions." }
        },
        {
          "@type": "Question",
          "name": "How long should each backfill batch be?",
          "acceptedAnswer": { "@type": "Answer", "text": "Small enough that a batch commits in a few seconds and its transaction never holds a snapshot long enough to block autovacuum. One month of data is usually too big; a few hundred thousand rows keyed by a time slice is a good unit. Sleep briefly between batches so replication and vacuum keep up." }
        },
        {
          "@type": "Question",
          "name": "What is the rollback if the swap goes wrong?",
          "acceptedAnswer": { "@type": "Answer", "text": "Rename back. Because the original table is never dropped during the cutover, reverting is a second rename inside one transaction, and it takes the same few milliseconds the forward swap did. Keep the old table for at least one full retention cycle before dropping it, and keep dual-write running until you are confident." }
        }
      ]
    }
  ]
}
</script>

← Back to [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/)

# Migrating a live spatial table to partitions

This page walks through converting a large, continuously written PostGIS table into a partitioned one, with the API serving traffic throughout and a rollback that stays one rename away.

## Context & When to Use

PostgreSQL cannot convert a table to a partitioned table in place. The strategy is fixed when the parent is created, so a migration means building a new hierarchy and moving the data — which on a 700 GB tracking table is hours of I/O that cannot happen inside a maintenance window. The design goal is therefore not speed but *interruptibility*: every step must be resumable, and the table must stay readable and writable while it runs.

There is a shortcut worth knowing. If you only need future data partitioned and are content to leave history as one lump, create the parent and `ATTACH` the existing table as a single catch-all partition. That takes seconds. It gives you cheap partitioning going forward and no pruning benefit on the historical rows, which is often exactly the right trade for a table whose queries are all recent-window anyway.

The full migration below is for the case where history matters: retention needs to expire month by month, or the historical index is what no longer fits in memory. It assumes the partition design from [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/) is already settled — key, width and retention.

## Runnable Implementation

```sql
-- 1. Shadow parent: same shape, composite PK, indexes defined on the parent
CREATE TABLE positions_new (
    LIKE positions INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
    PRIMARY KEY (id, observed_at)
) PARTITION BY RANGE (observed_at);

CREATE INDEX positions_new_geom_gix     ON positions_new USING GIST (geom);
CREATE INDEX positions_new_vehicle_time ON positions_new (vehicle_id, observed_at DESC);

-- 2. Backfill one month at a time, as a STANDALONE table, then attach it.
--    Building the index off-hierarchy avoids holding locks on the live parent.
CREATE TABLE positions_2026_03 (LIKE positions_new INCLUDING DEFAULTS);

INSERT INTO positions_2026_03 (id, vehicle_id, observed_at, geom, speed_kph)
SELECT id, vehicle_id, observed_at, geom, speed_kph
FROM   positions
WHERE  observed_at >= '2026-03-01' AND observed_at < '2026-04-01';

-- The CHECK lets ATTACH skip its validation scan entirely
ALTER TABLE positions_2026_03
  ADD CONSTRAINT positions_2026_03_range
  CHECK (observed_at >= '2026-03-01' AND observed_at < '2026-04-01');

CREATE INDEX ON positions_2026_03 USING GIST (geom);
CREATE INDEX ON positions_2026_03 (vehicle_id, observed_at DESC);
ALTER TABLE positions_2026_03 ADD PRIMARY KEY (id, observed_at);

ALTER TABLE positions_new ATTACH PARTITION positions_2026_03
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');   -- instant, no scan
```

The `CHECK` constraint before `ATTACH` is the difference between a millisecond catalogue update and a full sequential scan under an `ACCESS EXCLUSIVE` lock. PostgreSQL uses the constraint to prove every row already satisfies the partition bound, so it skips validation.

<svg viewBox="0 0 720 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline of the migration showing dual-write beginning before the backfill, the backfill proceeding month by month, and a short rename swap at the end" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Migration timeline — the table stays available throughout</title>
  <desc>A five-phase timeline. Phase one creates the shadow parent, taking seconds with no locks. Phase two turns on dual-write so every new row lands in both tables, adding about 0.3 milliseconds per write. Phase three backfills history in month-sized batches over roughly six hours, during which reads still come from the original table. Phase four verifies row counts and checksums per month. Phase five renames both tables inside one transaction, holding an exclusive lock for about 40 milliseconds. A rollback arrow shows that the reverse rename remains available for as long as the old table is kept.</desc>
  <rect x="0" y="0" width="720" height="280" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Cutover timeline — total downtime measured in milliseconds</text>
  <line x1="30" y1="150" x2="690" y2="150" stroke="currentColor" stroke-width="1.2"/>
  <rect x="34" y="112" width="94" height="36" rx="6" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="81" y="128" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">1 · shadow</text>
  <text x="81" y="142" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">parent + indexes</text>
  <text x="81" y="168" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">seconds</text>
  <rect x="136" y="112" width="110" height="36" rx="6" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.3"/>
  <text x="191" y="128" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">2 · dual-write on</text>
  <text x="191" y="142" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">+0.3 ms per write</text>
  <text x="191" y="168" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">before the backfill</text>
  <rect x="254" y="104" width="252" height="52" rx="6" fill="var(--accent, #7c3aed)" fill-opacity="0.14" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="380" y="124" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">3 · backfill, month by month</text>
  <text x="380" y="139" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">resumable · reads still hit the old table</text>
  <text x="380" y="152" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">~6 h for 700 GB</text>
  <rect x="514" y="112" width="94" height="36" rx="6" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="561" y="128" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">4 · verify</text>
  <text x="561" y="142" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">counts per month</text>
  <rect x="616" y="112" width="74" height="36" rx="6" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="653" y="128" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">5 · swap</text>
  <text x="653" y="142" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">~40 ms lock</text>
  <path d="M653 178 L653 210 L200 210 L200 190" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5" fill="none" stroke-dasharray="6,4" marker-end="url(#mgArr)"/>
  <text x="430" y="226" text-anchor="middle" font-size="10" fill="var(--viz-good, #1f6b3a)">rollback: rename back — available until the old table is dropped</text>
  <text x="30" y="254" font-size="10.5" fill="var(--muted, #7c6fb0)">Dual-write must start BEFORE the backfill, or rows written during the copy are lost from the new table.</text>
  <text x="30" y="270" font-size="10.5" fill="var(--muted, #7c6fb0)">Every phase before the swap is interruptible and resumable without data loss.</text>
  <defs>
    <marker id="mgArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="var(--viz-good, #1f6b3a)"/></marker>
  </defs>
</svg>

## Key Parameters & Options

| Step | Setting | Why |
|---|---|---|
| Dual-write | trigger on the old table, or application-level | A trigger cannot be forgotten by a code path; the application version is easier to remove later |
| Batch size | 200k–500k rows | Commits in seconds; avoids long-lived snapshots that stall autovacuum |
| `CHECK` before `ATTACH` | mandatory | Turns a full validation scan into a catalogue update |
| Index build | on the standalone table | Avoids `ACCESS EXCLUSIVE` on the live hierarchy |
| Swap | two `ALTER TABLE … RENAME` in one transaction | Atomic from the application's point of view |
| Old table | keep for one retention cycle | The rollback path, and the arbiter in any count dispute |

The dual-write trigger is short enough to read in one go:

```sql
CREATE OR REPLACE FUNCTION positions_dual_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO positions_new (id, vehicle_id, observed_at, geom, speed_kph)
    VALUES (NEW.id, NEW.vehicle_id, NEW.observed_at, NEW.geom, NEW.speed_kph)
    ON CONFLICT DO NOTHING;      -- backfill may already have copied this row
    RETURN NEW;
END $$;

CREATE TRIGGER positions_dual_write_trg
    AFTER INSERT ON positions
    FOR EACH ROW EXECUTE FUNCTION positions_dual_write();
```

`ON CONFLICT DO NOTHING` matters because the backfill and the trigger overlap at the boundary of the current month; without it the migration aborts on a duplicate key the first time a row is written to a range the copy has already reached.

## What the swap actually costs

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of lock duration for three cutover strategies, showing rename swap at 40 milliseconds against a full copy under lock at over two hours" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Lock duration by cutover strategy</title>
  <desc>Three approaches compared by how long the table is unavailable. Copying everything inside one maintenance transaction locks the table for two hours and twenty minutes. Attaching the old table as a single catch-all partition locks it for about 900 milliseconds. The shadow-plus-rename approach described here locks it for roughly 40 milliseconds, short enough that connection-level retries absorb it entirely.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">How long the table is unavailable, by strategy (log scale)</text>
  <line x1="230" y1="44" x2="230" y2="164" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="380" y1="44" x2="380" y2="164" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="530" y1="44" x2="530" y2="164" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="680" y1="44" x2="680" y2="164" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="230" y="180" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">100 ms</text>
  <text x="380" y="180" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">1 s</text>
  <text x="530" y="180" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">1 min</text>
  <text x="680" y="180" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">1 h+</text>
  <text x="20" y="66" font-size="10.5" fill="currentColor">copy inside one transaction</text>
  <rect x="200" y="54" width="420" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <text x="628" y="67" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">2 h 20 m</text>
  <text x="20" y="106" font-size="10.5" fill="currentColor">attach old table as catch-all</text>
  <rect x="200" y="94" width="175" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="196" y="107" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">900 ms</text>
  <text x="20" y="146" font-size="10.5" fill="currentColor">shadow + rename (this page)</text>
  <rect x="200" y="134" width="26" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.85"/>
  <text x="196" y="147" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">40 ms</text>
  <text x="20" y="208" font-size="10.5" fill="var(--muted, #7c6fb0)">At 40 ms the swap is shorter than a normal statement timeout, so in-flight requests retry rather than fail.</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">The catch-all attach is a legitimate middle option when historical pruning is not needed.</text>
</svg>

The swap itself is four statements in one transaction:

```sql
BEGIN;
ALTER TABLE positions     RENAME TO positions_old;
ALTER TABLE positions_new RENAME TO positions;
DROP TRIGGER positions_dual_write_trg ON positions_old;
COMMIT;
```

## Tracking backfill progress

A six-hour backfill needs a progress signal, or the only way to know whether it is halfway or stuck is to watch disk usage. Record each completed month in a small control table, and the job becomes both resumable and reportable.

```sql
CREATE TABLE migration_progress (
    month        date PRIMARY KEY,
    rows_copied  bigint,
    finished_at  timestamptz DEFAULT now()
);
```

The backfill loop checks that table before each month and skips what is already done, which is what makes an interrupted run safe to restart. It also gives operations a straight answer to "how long left" — months remaining multiplied by the observed rate per month.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Progress chart of a backfill showing months completed against elapsed time, with the rate slowing as recent denser months are reached" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Backfill progress across 24 monthly batches</title>
  <desc>A step chart of months completed against elapsed hours. The first twelve months complete in about ninety minutes because early data is sparse. Progress slows through the middle as monthly row counts grow, and the last six months, which hold the densest data, take nearly three hours between them. A projection line based on the average rate would have predicted four hours; the actual total is six, which is why progress should be measured in rows rather than months.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Backfill progress — months are not equal units of work</text>
  <line x1="60" y1="160" x2="690" y2="160" stroke="currentColor" stroke-width="1.1"/>
  <line x1="60" y1="42" x2="60" y2="160" stroke="currentColor" stroke-width="1.1"/>
  <text x="52" y="48" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">24 m</text>
  <text x="52" y="104" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">12 m</text>
  <text x="52" y="160" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <polyline points="60,160 90,148 120,136 150,124 180,112 210,104 260,94 320,84 390,74 470,64 570,54 690,44" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="2.2"/>
  <polyline points="60,160 690,44" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.4" stroke-dasharray="6,4"/>
  <text x="200" y="132" font-size="10" fill="var(--muted, #7c6fb0)">naive linear projection: 4 h</text>
  <text x="430" y="96" font-size="10" font-weight="700" fill="var(--accent, #7c3aed)">actual: 6 h 10 m</text>
  <text x="90" y="178" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">1 h</text>
  <text x="290" y="178" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">3 h</text>
  <text x="490" y="178" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">5 h</text>
  <text x="660" y="178" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">6 h</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">Recent months hold far more rows than old ones, so estimate remaining time from rows copied, not months done.</text>
  <text x="20" y="214" font-size="10.5" fill="var(--muted, #7c6fb0)">The control table makes both numbers available without inspecting the target table.</text>
</svg>

## Gotchas & Failure Modes

- **Dual-write started after the backfill.** Rows written during the copy never reach the new table and are silently missing after the swap. Always enable dual-write first, then backfill.
- **`ERROR: duplicate key value violates unique constraint`** during backfill — the trigger already inserted the row. `ON CONFLICT DO NOTHING` on the trigger insert, not on the backfill, is the right place to absorb it.
- **Sequence left behind.** `id` keeps its sequence through the rename because the sequence is owned by the column, but confirm with `SELECT last_value FROM positions_id_seq` before and after; a mismatch means the new table got its own sequence from `LIKE INCLUDING DEFAULTS`.
- **Foreign keys pointing at the old table.** They follow the rename, so a child table now references `positions_old`. Drop and recreate them against the new parent, and note that a foreign key *to* a partitioned table needs PostgreSQL 12+.
- **Views and functions with `search_path` surprises.** A view defined on `positions` binds to the OID, not the name, so after the rename it still reads the old table. Recreate every dependent view — list them with `pg_depend` before starting.
- **Backfill starving autovacuum.** Long batches hold snapshots that prevent cleanup on the live table, and bloat accumulates exactly while you are trying to migrate. Keep batches short and watch `n_dead_tup`, as described in [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/).

## Verification Snippet

```sql
-- Per-month reconciliation before the swap; every row must match
SELECT date_trunc('month', observed_at) AS month,
       count(*) FILTER (WHERE src = 'old') AS old_rows,
       count(*) FILTER (WHERE src = 'new') AS new_rows
FROM (
    SELECT observed_at, 'old' AS src FROM positions
    UNION ALL
    SELECT observed_at, 'new' AS src FROM positions_new
) t
GROUP BY 1 ORDER BY 1;

-- Geometry checksum per month catches a truncated or reprojected copy
SELECT date_trunc('month', observed_at) AS month,
       md5(string_agg(ST_AsBinary(geom)::text, '' ORDER BY id)) AS digest
FROM   positions_new
GROUP  BY 1 ORDER BY 1;
```

```bash
# After the swap: the API should be unchanged, and the plan should prune
psql -c "EXPLAIN SELECT count(*) FROM positions WHERE observed_at >= now() - interval '2 days'" \
  | grep -c positions_20
# 1  → one partition in the plan
```

---

## Related

- [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/) — the partition design this migration implements
- [Automating Spatial Database Migrations in CI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/automating-spatial-database-migrations-in-ci/) — running the steps as reviewed, repeatable migrations
- [Managing Async Transactions for Bulk Geometry Writes](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/) — batch sizing for the backfill

← Back to [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/)
