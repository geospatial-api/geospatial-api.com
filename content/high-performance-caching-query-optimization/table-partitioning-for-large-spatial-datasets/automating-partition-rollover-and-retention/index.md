---
layout: layouts/page.njk
title: "Automating Partition Rollover and Retention"
description: "Create partitions ahead of the data and expire them with DETACH CONCURRENTLY — plus the monitoring that catches a rollover job that stopped running weeks ago."
slug: automating-partition-rollover-and-retention
type: howto
breadcrumb:
  - label: "Geospatial Caching and Query Optimization"
    url: "/high-performance-caching-query-optimization/"
  - label: "Table Partitioning for Large Spatial Datasets"
    url: "/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/"
  - label: "Automating Partition Rollover and Retention"
    url: "/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/automating-partition-rollover-and-retention/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Automating Partition Rollover and Retention",
      "description": "Create partitions ahead of the data and expire them with DETACH CONCURRENTLY, plus the monitoring that catches a stalled rollover job.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/automating-partition-rollover-and-retention/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Geospatial Caching and Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 2, "name": "Table Partitioning for Large Spatial Datasets", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/" },
        { "@type": "ListItem", "position": 3, "name": "Automating Partition Rollover and Retention", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/automating-partition-rollover-and-retention/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Automate Partition Creation and Expiry",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Create ahead", "text": "Run a scheduled function that creates the next few partitions before any data needs them." },
        { "@type": "HowToStep", "position": 2, "name": "Detach concurrently", "text": "Expire old data by detaching the partition without an exclusive lock, then dropping the standalone table." },
        { "@type": "HowToStep", "position": 3, "name": "Alert on the runway", "text": "Monitor how many days of future partitions exist, so a stalled job is caught weeks before it causes an insert failure." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "How far ahead should partitions be created?",
          "acceptedAnswer": { "@type": "Answer", "text": "Far enough that the job can fail silently for a full alerting cycle and still leave room. Three months ahead for monthly partitions is a common choice: even if the scheduler breaks and nobody notices for six weeks, inserts keep working. Creating ahead costs nothing, since an empty partition is a catalogue entry and a few kilobytes." }
        },
        {
          "@type": "Question",
          "name": "Why detach before dropping instead of dropping directly?",
          "acceptedAnswer": { "@type": "Answer", "text": "DROP TABLE on an attached partition takes an ACCESS EXCLUSIVE lock on the whole hierarchy, so every query against the parent blocks. DETACH PARTITION CONCURRENTLY removes it from the hierarchy without that lock, after which the standalone table can be dropped in isolation. It also gives you a window to archive the data before it disappears." }
        },
        {
          "@type": "Question",
          "name": "Should the rollover job live in the database or the application?",
          "acceptedAnswer": { "@type": "Answer", "text": "Either works, but it must be somewhere with monitoring. A pg_cron job inside the database survives application deploys and has no network dependency; an application task is easier to test and log. What matters more than the location is that a failure raises an alert, because the symptom of a stalled job appears only when the runway runs out." }
        }
      ]
    }
  ]
}
</script>

← Back to [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/)

# Automating partition rollover and retention

This page covers the scheduled job that keeps a partitioned spatial table alive: creating next month's partition before anything needs it, expiring the oldest without locking the hierarchy, and alerting when the job stops.

## Context & When to Use

A partitioned table has a moving edge. On the first day of a month with no partition covering it, every insert fails with `no partition of relation found for row` — a total write outage caused by a job that stopped running weeks earlier. On the other end, partitions that are never expired accumulate until the retention policy is a fiction and the disk fills.

Both problems are solved by one scheduled function and one alert. The function is idempotent, creates several months ahead, and detaches anything past the retention horizon. The alert watches the *runway* — how many days of future partitions exist — because that is the only signal that degrades gradually before the outage. Row counts, disk usage and query latency all look perfectly healthy right up to the moment the first insert fails.

This applies to any table using the design from [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/), and doubly so to an [audit trail](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/), where retention is a policy commitment rather than a disk-space convenience.

## Runnable Implementation

```sql
CREATE OR REPLACE FUNCTION maintain_positions_partitions(
    months_ahead   int DEFAULT 3,
    retain_months  int DEFAULT 24
) RETURNS TABLE (action text, partition_name text)
LANGUAGE plpgsql AS $$
DECLARE
    m      date;
    i      int;
    horizon date := date_trunc('month', now())::date
                    - (retain_months || ' month')::interval;
    part   record;
BEGIN
    -- 1. Create the runway. IF NOT EXISTS makes the whole function idempotent.
    FOR i IN 0..months_ahead LOOP
        m := (date_trunc('month', now()) + (i || ' month')::interval)::date;
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF positions
                 FOR VALUES FROM (%L) TO (%L)',
            'positions_' || to_char(m, 'YYYY_MM'), m, m + interval '1 month');
        action := 'ensured'; partition_name := 'positions_' || to_char(m, 'YYYY_MM');
        RETURN NEXT;
    END LOOP;

    -- 2. Expire anything entirely older than the retention horizon
    FOR part IN
        SELECT c.relname,
               (regexp_replace(c.relname, '^positions_', '') || '_01')::date AS starts
        FROM   pg_class c
        JOIN   pg_inherits inh ON inh.inhrelid = c.oid
        WHERE  inh.inhparent = 'positions'::regclass
          AND  c.relname ~ '^positions_\d{4}_\d{2}$'
    LOOP
        CONTINUE WHEN part.starts >= horizon;
        -- CONCURRENTLY: no ACCESS EXCLUSIVE lock on the parent hierarchy
        EXECUTE format('ALTER TABLE positions DETACH PARTITION %I CONCURRENTLY',
                       part.relname);
        EXECUTE format('DROP TABLE %I', part.relname);
        action := 'expired'; partition_name := part.relname;
        RETURN NEXT;
    END LOOP;
END $$;

-- Run it daily; the function is safe to run any number of times
SELECT cron.schedule('positions-partitions', '17 3 * * *',
                     $$SELECT maintain_positions_partitions()$$);
```

Note the `regexp_replace` reconstruction of the start date from the partition name. Reading the bound from `pg_get_expr(c.relpartbound, c.oid)` is more correct but far harder to parse reliably; naming partitions after their range and deriving the date from the name is the pragmatic choice, provided the naming convention is enforced by this same function.

<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline of a rolling partition window showing the retained range, the current month, the created-ahead runway and the expiry horizon" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The rolling window the job maintains</title>
  <desc>A horizontal timeline of monthly partitions. To the left, partitions older than the 24-month retention horizon are marked for detach and drop. In the middle, the retained range holds 24 months of queryable data, with the current month highlighted. To the right, three empty partitions have been created ahead of any data, forming the runway. An annotation notes that the alert fires when the runway falls below 30 days, which is roughly six weeks before an insert would fail.</desc>
  <rect x="0" y="0" width="720" height="260" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One job maintains both ends of the window</text>
  <rect x="24" y="70" width="130" height="52" rx="6" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="89" y="92" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">expired</text>
  <text x="89" y="108" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">detach + drop</text>
  <rect x="162" y="70" width="340" height="52" rx="6" fill="var(--accent, #7c3aed)" fill-opacity="0.14" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="332" y="92" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">retained — 24 months, queryable</text>
  <text x="332" y="108" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">pruning applies here</text>
  <rect x="446" y="74" width="52" height="44" rx="4" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.22" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <text x="472" y="100" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor">now</text>
  <rect x="510" y="70" width="186" height="52" rx="6" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4" stroke-dasharray="6,4"/>
  <text x="603" y="92" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">runway — created ahead</text>
  <text x="603" y="108" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">3 empty partitions</text>
  <line x1="24" y1="140" x2="696" y2="140" stroke="currentColor" stroke-width="1.1"/>
  <text x="89" y="158" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">−25 m</text>
  <text x="332" y="158" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">−12 m</text>
  <text x="472" y="158" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <text x="603" y="158" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">+3 m</text>
  <line x1="510" y1="60" x2="510" y2="176" stroke="var(--viz-warn, #8a5000)" stroke-width="1.6" stroke-dasharray="4,3"/>
  <text x="518" y="180" font-size="9.5" fill="var(--viz-warn, #8a5000)">alert if the runway ever falls below 30 days</text>
  <line x1="162" y1="60" x2="162" y2="176" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6" stroke-dasharray="4,3"/>
  <text x="24" y="196" font-size="9.5" fill="var(--viz-bad, #a32b23)">retention horizon</text>
  <text x="24" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">A stalled job is invisible from row counts, disk usage or latency — only the runway shrinks, and it shrinks</text>
  <text x="24" y="238" font-size="10.5" fill="var(--muted, #7c6fb0)">one day per day. That predictability is what makes it a good alert.</text>
</svg>

## Key Parameters & Options

| Parameter | Recommended | Reasoning |
|---|---|---|
| `months_ahead` | 3 | Survives a six-week outage of the scheduler unnoticed |
| `retain_months` | policy-driven | Should mirror the documented commitment, not disk capacity |
| Schedule | daily, off-peak | Idempotent, so daily costs nothing and recovers from any miss |
| `DETACH … CONCURRENTLY` | always (PG 14+) | Plain `DETACH` locks the whole hierarchy |
| `DROP` timing | after detach | Gives a window to archive; also keeps the lock scope small |
| Default partition | present but alerted on | Catches stray rows without hiding a rollover failure |

## Archiving before the drop

Retention rarely means "delete and forget" — it usually means the data leaves the hot database and lives somewhere cheaper. The detached partition is a plain table, so archiving is an ordinary export with no coordination required.

```bash
# The partition is standalone after DETACH: dump it without touching the parent
pg_dump --table=positions_2024_08 --format=custom --compress=9 \
        --file=/archive/positions_2024_08.dump "$DATABASE_URL"

# Or export geometry to a portable format for a data lake
ogr2ogr -f Parquet /archive/positions_2024_08.parquet \
        PG:"$DATABASE_URL" positions_2024_08
```

Exporting to GeoParquet keeps the geometry queryable outside PostGIS and compresses far better than a custom dump — the format trade-offs are covered in [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/). Whichever route, verify the archive before the drop, and record the archive location in the same job so the audit trail of what was expired is not folklore.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sequence of the expiry path from detach through verification and archive to drop, with the lock scope marked on each step" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The expiry path, and what each step locks</title>
  <desc>Four sequential steps. Detach concurrently takes a share update exclusive lock on the parent for about 30 milliseconds and leaves the partition as a standalone table. Verification counts rows and checks the archive is readable, taking no lock on the parent. Archiving exports the standalone table, taking an access share lock on that table only. Dropping the table takes an access exclusive lock on the standalone table alone, which nothing is querying. The parent hierarchy is only briefly touched in step one.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Expiry path — the parent is touched once, briefly</text>
  <rect x="18" y="48" width="156" height="76" rx="8" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.5"/>
  <text x="96" y="70" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">1 · DETACH</text>
  <text x="96" y="86" text-anchor="middle" font-size="9.5" fill="currentColor">CONCURRENTLY</text>
  <text x="96" y="102" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">parent: SHARE UPDATE</text>
  <text x="96" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">≈30 ms</text>
  <path d="M174 86 L196 86" stroke="currentColor" stroke-width="1.4" marker-end="url(#roArr)"/>
  <rect x="198" y="48" width="156" height="76" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="276" y="70" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">2 · verify</text>
  <text x="276" y="86" text-anchor="middle" font-size="9.5" fill="currentColor">row count · extent</text>
  <text x="276" y="102" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">parent: no lock</text>
  <text x="276" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">seconds</text>
  <path d="M354 86 L376 86" stroke="currentColor" stroke-width="1.4" marker-end="url(#roArr)"/>
  <rect x="378" y="48" width="156" height="76" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="456" y="70" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">3 · archive</text>
  <text x="456" y="86" text-anchor="middle" font-size="9.5" fill="currentColor">pg_dump or GeoParquet</text>
  <text x="456" y="102" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">child: ACCESS SHARE</text>
  <text x="456" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">minutes</text>
  <path d="M534 86 L556 86" stroke="currentColor" stroke-width="1.4" marker-end="url(#roArr)"/>
  <rect x="558" y="48" width="144" height="76" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="630" y="70" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">4 · DROP</text>
  <text x="630" y="86" text-anchor="middle" font-size="9.5" fill="currentColor">standalone table</text>
  <text x="630" y="102" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">nothing queries it</text>
  <text x="630" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">milliseconds</text>
  <line x1="18" y1="146" x2="702" y2="146" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="168" font-size="11" fill="currentColor">Plain <tspan font-family="monospace" font-size="10.5">DROP</tspan> on an attached partition instead:</text>
  <rect x="330" y="156" width="270" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="608" y="168" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">parent locked</text>
  <text x="20" y="196" font-size="10.5" fill="var(--muted, #7c6fb0)">Every query against the parent waits behind an ACCESS EXCLUSIVE lock for the duration of the drop — on a large</text>
  <text x="20" y="212" font-size="10.5" fill="var(--muted, #7c6fb0)">partition with many indexes that is seconds, not milliseconds, and it happens during whatever traffic is live.</text>
  <text x="20" y="230" font-size="10.5" fill="var(--muted, #7c6fb0)">Detaching first reduces the blast radius to one short catalogue update.</text>
  <defs>
    <marker id="roArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

## What the runway alert catches that nothing else does

The value of alerting on the runway is that it degrades linearly and predictably, while every other signal stays flat until the moment of failure. A stalled scheduler produces no errors, no latency change and no disk anomaly — inserts keep landing in the partition that already exists, right up to the last day it covers.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four signals plotted over eleven weeks after a scheduler stalls, showing only the runway metric declining before the write outage" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Eleven weeks after the rollover job stopped</title>
  <desc>Four signals tracked from the week the scheduler stalled. Insert error rate stays at zero until week eleven, when it jumps to one hundred percent. Query latency stays flat throughout. Disk growth continues its normal slope with no anomaly. The runway metric falls in a straight line from 120 days to zero, crossing the 30-day alert threshold in week seven, four weeks before the outage.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Signals after the scheduler silently stopped</text>
  <line x1="70" y1="176" x2="690" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <line x1="70" y1="42" x2="70" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <polyline points="70,52 126,64 182,76 238,88 294,100 350,112 406,124 462,136 518,148 574,160 630,170 660,176" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="2.4"/>
  <text x="88" y="46" font-size="10" font-weight="700" fill="var(--accent, #7c3aed)">runway (days remaining)</text>
  <line x1="70" y1="124" x2="690" y2="124" stroke="var(--viz-warn, #8a5000)" stroke-width="1.3" stroke-dasharray="6,4"/>
  <text x="694" y="120" text-anchor="end" font-size="9.5" fill="var(--viz-warn, #8a5000)">alert at 30 days — week 7</text>
  <polyline points="70,172 574,172 630,172 634,52 690,52" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="2.2"/>
  <text x="400" y="166" font-size="10" fill="var(--viz-bad, #a32b23)">insert errors: flat zero…</text>
  <text x="560" y="70" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">…then 100 %</text>
  <polyline points="70,158 690,152" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6" stroke-dasharray="4,3"/>
  <text x="200" y="150" font-size="10" fill="var(--viz-good, #1f6b3a)">query latency — no signal</text>
  <polyline points="70,166 690,138" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.6" stroke-dasharray="2,3"/>
  <text x="430" y="140" font-size="10" fill="var(--muted, #7c6fb0)">disk growth — normal slope</text>
  <text x="70" y="194" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">w1</text>
  <text x="350" y="194" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">w6</text>
  <text x="630" y="194" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">w11</text>
  <text x="20" y="218" font-size="10.5" fill="var(--muted, #7c6fb0)">Only one of these four lines moves before the outage. Alert on the outcome — days of runway — not on whether</text>
  <text x="20" y="232" font-size="10.5" fill="var(--muted, #7c6fb0)">the job reported success, because a job that never ran reports nothing at all.</text>
</svg>

## Gotchas & Failure Modes

- **`ERROR: no partition of relation "positions" found for row`.** The runway ran out. Create the missing partition immediately, then fix the scheduler and add the runway alert — the outage is a symptom, not the bug.
- **`DETACH … CONCURRENTLY` cannot run inside a transaction block.** It errors with `cannot run inside a transaction block`, which surprises anyone wrapping maintenance in `BEGIN`. Run it as its own statement, and note that a failed detach can leave the partition in a pending state that needs `ALTER TABLE … DETACH PARTITION … FINALIZE`.
- **A non-empty default partition.** Rows there are invisible to pruning, and creating a partition whose range overlaps them requires a full scan of the default. Alert on `count(*) > 0` for the default rather than treating it as a harmless net.
- **Retention measured from insert time, not observation time.** If the partition key is `observed_at` but the policy is about when data was *received*, late-arriving data can be expired the day it lands. Make the key and the policy agree.
- **`pg_cron` running on a replica after failover.** The job silently stops when the primary changes if `cron.database_name` is not configured for the new primary. Alerting on the runway covers this too, which is the point of alerting on the outcome rather than the job.
- **Archive verified after the drop.** Verify first. A corrupt dump discovered after `DROP TABLE` is unrecoverable.

## Verification Snippet

```sql
-- Runway in days: the single number to alert on
SELECT max(upper(pg_get_expr(c.relpartbound, c.oid)::text::daterange))::date
         - current_date AS runway_days
FROM   pg_class c
JOIN   pg_inherits i ON i.inhrelid = c.oid
WHERE  i.inhparent = 'positions'::regclass
  AND  c.relname ~ '^positions_\d{4}_\d{2}$';
--  runway_days
-- -------------
--          122      → healthy; alert below 30

-- Confirm the oldest partition matches the retention policy
SELECT c.relname
FROM   pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
WHERE  i.inhparent = 'positions'::regclass
ORDER  BY c.relname LIMIT 1;
```

```bash
# Dry run in staging: the function must be safe to run twice in a row
psql -c "SELECT * FROM maintain_positions_partitions()"
psql -c "SELECT * FROM maintain_positions_partitions()"   # identical output, no errors
```

---

## Related

- [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/) — the design this job maintains
- [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/) — a table where retention is a policy commitment
- [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) — where the runway metric belongs

← Back to [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/)
