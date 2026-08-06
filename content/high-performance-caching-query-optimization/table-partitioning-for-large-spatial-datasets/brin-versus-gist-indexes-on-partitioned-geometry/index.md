---
layout: layouts/page.njk
title: "BRIN vs GiST Indexes on Partitioned Geometry"
description: "On append-ordered spatial partitions a BRIN index is 400× smaller than GiST. Learn when correlation makes that trade work, and when it quietly costs you a sequential scan."
slug: brin-versus-gist-indexes-on-partitioned-geometry
type: howto
breadcrumb:
  - label: "Geospatial Caching and Query Optimization"
    url: "/high-performance-caching-query-optimization/"
  - label: "Table Partitioning for Large Spatial Datasets"
    url: "/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/"
  - label: "BRIN vs GiST Indexes on Partitioned Geometry"
    url: "/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/brin-versus-gist-indexes-on-partitioned-geometry/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "BRIN vs GiST Indexes on Partitioned Geometry",
      "description": "On append-ordered spatial partitions a BRIN index is far smaller than GiST. When that trade works, and when it costs a sequential scan.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/brin-versus-gist-indexes-on-partitioned-geometry/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Geospatial Caching and Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 2, "name": "Table Partitioning for Large Spatial Datasets", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/" },
        { "@type": "ListItem", "position": 3, "name": "BRIN vs GiST Indexes on Partitioned Geometry", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/brin-versus-gist-indexes-on-partitioned-geometry/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Choose Between BRIN and GiST on a Spatial Partition",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Measure physical correlation", "text": "Check whether rows that are close in space are also close on disk; BRIN only works when they are." },
        { "@type": "HowToStep", "position": 2, "name": "Split hot from cold", "text": "Keep GiST on the recent partitions that serve interactive queries and use BRIN on the archival ones." },
        { "@type": "HowToStep", "position": 3, "name": "Tune pages_per_range", "text": "Lower the value to tighten the summarised bounding box at the cost of index size." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "How does a BRIN index work on geometry?",
          "acceptedAnswer": { "@type": "Answer", "text": "It stores one summarising bounding box per block range instead of one entry per row. A query with a bounding box predicate skips any range whose summary does not overlap, then scans the remaining ranges row by row. That makes the index tiny, but its usefulness depends entirely on whether nearby rows are stored in nearby blocks." }
        },
        {
          "@type": "Question",
          "name": "When is BRIN a bad idea for spatial data?",
          "acceptedAnswer": { "@type": "Answer", "text": "Whenever insert order is unrelated to location. A table fed by many vehicles reporting from all over a region has essentially zero spatial correlation on disk, so every block range's summary covers the whole area and the index eliminates nothing. The plan then reads the entire partition while still paying to consult the index." }
        },
        {
          "@type": "Question",
          "name": "Can one partitioned table mix index types?",
          "acceptedAnswer": { "@type": "Answer", "text": "Yes, and that is the main reason to use BRIN at all. Indexes declared on the parent are cloned to every partition, but you can also create an index directly on an individual partition. Keep the parent index off and build GiST on recent partitions and BRIN on archival ones, or attach archival partitions after building BRIN on them." }
        }
      ]
    }
  ]
}
</script>

← Back to [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/)

# BRIN vs GiST indexes on partitioned geometry

This page covers when to replace a GiST index with a BRIN index on the older partitions of a spatial table, and how to tell in advance whether it will help or quietly cost you a full scan.

## Context & When to Use

The problem partitioning solves for indexes is partly a size problem. A GiST index over 780 million geometries is 44 GB; even split into monthly partitions it is still 3.4 GB per month, and thirty-six of those never fit in shared buffers at once. The recent partitions are read constantly and deserve the memory; the two-year-old ones are read once a quarter by an analyst and are pure ballast.

BRIN offers a different bargain. Instead of an entry per row, it stores a summarising bounding box per range of table blocks — by default 128 pages, about 1 MB of heap. Query planning then works by elimination: skip any block range whose summary box does not intersect the query envelope, and scan what remains. The index for a 21 GB partition is around 90 KB.

The whole thing hinges on **physical correlation**: whether rows that are near each other in space are also near each other on disk. Data appended in survey order, or by a sensor sweeping a route, or bulk-loaded region by region, correlates well. Data appended by 4 000 vehicles reporting simultaneously from across a country does not correlate at all, and BRIN degrades to a sequential scan with extra steps. Measure before choosing — the plan analysis techniques in [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) apply directly.

## Runnable Implementation

```sql
-- 1. Measure correlation FIRST. Compare the area of the whole partition's
--    extent against the average area of a per-block-range extent.
WITH ranges AS (
    SELECT (ctid::text::point)[0]::bigint / 128 AS block_range,
           ST_Extent(geom)                      AS range_extent
    FROM   positions_2025_04
    GROUP  BY 1
)
SELECT count(*)                                              AS block_ranges,
       round(avg(ST_Area(range_extent))::numeric, 6)         AS avg_range_area,
       round(ST_Area(ST_Extent(range_extent))::numeric, 6)   AS whole_area,
       round((avg(ST_Area(range_extent))
              / NULLIF(ST_Area(ST_Extent(range_extent)), 0) * 100)::numeric, 2)
                                                             AS pct_of_whole
FROM   ranges;
-- pct_of_whole under ~5 %  → BRIN will prune well
-- pct_of_whole above ~40 % → BRIN will prune almost nothing

-- 2. Archival partitions: BRIN instead of GiST
DROP INDEX IF EXISTS positions_2025_04_geom_gix;
CREATE INDEX positions_2025_04_geom_brin
    ON positions_2025_04 USING BRIN (geom) WITH (pages_per_range = 32);

-- 3. Keep GiST where interactive queries land
CREATE INDEX IF NOT EXISTS positions_2026_08_geom_gix
    ON positions_2026_08 USING GIST (geom);
```

Because indexes declared on the parent are cloned to every partition, a mixed strategy means *not* declaring the geometry index on the parent and managing it per partition instead — usually in the same scheduled function that creates and detaches partitions.

<svg viewBox="0 0 720 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Illustration contrasting well-correlated and poorly-correlated block ranges and the fraction of the table each lets BRIN skip" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Why physical correlation decides whether BRIN works</title>
  <desc>Two panels. On the left, data appended in survey order: each block range's summary box covers a small distinct area, so a query envelope overlaps only three of twelve ranges and BRIN skips 75 percent of the partition. On the right, data appended by many simultaneous reporters: every block range's summary box spans nearly the whole box, so the same query envelope overlaps all twelve and BRIN skips nothing, leaving a full scan plus index overhead.</desc>
  <rect x="0" y="0" width="720" height="300" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">The same index, two insert orders</text>
  <text x="180" y="52" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">appended in survey order</text>
  <rect x="40" y="62" width="280" height="150" rx="6" fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.4"/>
  <rect x="48" y="70" width="66" height="44" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="118" y="70" width="66" height="44" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="188" y="70" width="66" height="44" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="258" y="70" width="54" height="44" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="48" y="118" width="66" height="44" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="118" y="118" width="66" height="44" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="188" y="118" width="66" height="44" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="258" y="118" width="54" height="44" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="48" y="166" width="66" height="40" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="118" y="166" width="66" height="40" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="188" y="166" width="66" height="40" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="258" y="166" width="54" height="40" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.14" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <rect x="126" y="126" width="140" height="66" rx="3" fill="var(--accent, #7c3aed)" fill-opacity="0.28" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="196" y="228" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent, #7c3aed)">query box</text>
  <text x="180" y="246" text-anchor="middle" font-size="10.5" fill="currentColor">3 of 12 ranges overlap</text>
  <text x="180" y="272" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good, #1f6b3a)">75 % of the partition skipped</text>
  <text x="540" y="52" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">appended by 4 000 reporters</text>
  <rect x="400" y="62" width="280" height="150" rx="6" fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.4"/>
  <rect x="406" y="68" width="268" height="138" rx="3" fill="var(--viz-bad, #a32b23)" fill-opacity="0.07" stroke="var(--viz-bad, #a32b23)" stroke-width="1"/>
  <rect x="410" y="72" width="260" height="130" rx="3" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1"/>
  <rect x="414" y="76" width="252" height="122" rx="3" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1"/>
  <rect x="418" y="80" width="244" height="114" rx="3" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1"/>
  <text x="540" y="118" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">every range covers</text>
  <text x="540" y="134" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">nearly all of it</text>
  <rect x="486" y="126" width="140" height="66" rx="3" fill="var(--accent, #7c3aed)" fill-opacity="0.28" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="556" y="228" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent, #7c3aed)">query box</text>
  <text x="540" y="246" text-anchor="middle" font-size="10.5" fill="currentColor">12 of 12 ranges overlap</text>
  <text x="540" y="272" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">nothing skipped — a scan with overhead</text>
  <text x="20" y="294" font-size="10.5" fill="var(--muted, #7c6fb0)">Run the correlation query before switching; the index type that is 400× smaller is not automatically cheaper.</text>
</svg>

## Key Parameters & Options

| Setting | GiST | BRIN |
|---|---|---|
| Index size, 21 GB partition | 3.4 GB | 90 KB at `pages_per_range = 128` |
| Build time | 18 min | 22 s |
| Write overhead per row | ~14 µs | ~0.4 µs |
| Bounding box query, correlated data | 7 ms | 41 ms |
| Bounding box query, uncorrelated data | 9 ms | 2 900 ms |
| `pages_per_range` | n/a | 32 tightens summaries 4×, index still tiny |
| Supports `<->` KNN ordering | yes | no |
| Supports `ST_DWithin` index assist | yes | partially, via the bounding box |

BRIN loses KNN ordering entirely, so any partition that serves a nearest-neighbour endpoint keeps GiST regardless of age. That constraint often decides the split point on its own.

## Choosing the boundary between hot and cold

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of query frequency and index memory by partition age, showing where switching from GiST to BRIN reclaims memory without affecting traffic" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where to put the GiST-to-BRIN boundary</title>
  <desc>Two series across twelve monthly partitions ordered newest to oldest. Query share falls sharply: the newest three partitions absorb 91 percent of all queries, months four to six take 7 percent, and everything older than six months takes 2 percent. Index memory is flat at 3.4 gigabytes per partition regardless of age. A boundary drawn after month four converts eight partitions to BRIN, reclaiming 27 gigabytes of buffer space while affecting only 2 percent of queries.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Query share versus index cost, by partition age</text>
  <line x1="56" y1="176" x2="700" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <line x1="56" y1="44" x2="56" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <rect x="66" y="52" width="36" height="124" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <rect x="110" y="96" width="36" height="80" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <rect x="154" y="140" width="36" height="36" fill="var(--accent, #7c3aed)" opacity="0.65"/>
  <rect x="198" y="162" width="36" height="14" fill="var(--accent, #7c3aed)" opacity="0.6"/>
  <rect x="242" y="168" width="36" height="8" fill="var(--accent, #7c3aed)" opacity="0.55"/>
  <rect x="286" y="171" width="36" height="5" fill="var(--accent, #7c3aed)" opacity="0.5"/>
  <rect x="330" y="173" width="36" height="3" fill="var(--accent, #7c3aed)" opacity="0.45"/>
  <rect x="374" y="173" width="36" height="3" fill="var(--accent, #7c3aed)" opacity="0.45"/>
  <rect x="418" y="174" width="36" height="2" fill="var(--accent, #7c3aed)" opacity="0.4"/>
  <rect x="462" y="174" width="36" height="2" fill="var(--accent, #7c3aed)" opacity="0.4"/>
  <rect x="506" y="175" width="36" height="1" fill="var(--accent, #7c3aed)" opacity="0.4"/>
  <rect x="550" y="175" width="36" height="1" fill="var(--accent, #7c3aed)" opacity="0.4"/>
  <line x1="66" y1="60" x2="586" y2="60" stroke="var(--viz-warn, #8a5000)" stroke-width="1.6" stroke-dasharray="6,4"/>
  <text x="596" y="57" font-size="9.5" fill="var(--viz-warn, #8a5000)">GiST index: 3.4 GB</text>
  <text x="596" y="70" font-size="9.5" fill="var(--viz-warn, #8a5000)">per partition, flat</text>
  <line x1="234" y1="40" x2="234" y2="188" stroke="var(--viz-good, #1f6b3a)" stroke-width="2"/>
  <text x="242" y="112" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">boundary</text>
  <text x="242" y="127" font-size="9.5" fill="var(--viz-good, #1f6b3a)">GiST ← | → BRIN</text>
  <text x="84" y="196" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">m1</text>
  <text x="216" y="196" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">m4</text>
  <text x="392" y="196" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">m8</text>
  <text x="568" y="196" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">m12</text>
  <text x="20" y="218" font-size="10.5" fill="currentColor">Newest 3 partitions: <tspan font-weight="700">91 %</tspan> of queries   ·   older than 4 months: <tspan font-weight="700">2 %</tspan> of queries</text>
  <text x="20" y="233" font-size="10.5" fill="var(--viz-good, #1f6b3a)">Switching 8 partitions to BRIN reclaims 27 GB of buffer cache and slows 2 % of queries.</text>
</svg>

## Creating correlation deliberately

If a partition would benefit from BRIN but its insert order is random, the correlation can be manufactured. Once a partition is detached and no longer receiving writes, rewriting it in spatial order costs one pass over the data and permanently changes what BRIN can do with it.

The ordering key needs to be a one-dimensional value that keeps nearby geometries adjacent. A geohash or a Hilbert curve index both work; PostGIS ships `ST_GeoHash` for points and `ST_Hexagon`-style grids for coarser bucketing. Sorting by geohash prefix is the simplest version and gets most of the benefit:

```sql
-- On a DETACHED partition only: rewrite in spatial order, then index
CREATE TABLE positions_2025_04_sorted AS
SELECT * FROM positions_2025_04
ORDER  BY ST_GeoHash(ST_Transform(geom, 4326), 8);

CREATE INDEX ON positions_2025_04_sorted USING BRIN (geom) WITH (pages_per_range = 32);
```

After the rewrite, the correlation query from earlier typically drops from 60–80 % of the whole extent per block range to under 3 %, which is the difference between BRIN pruning nothing and pruning almost everything. The cost is one full rewrite of the partition, so it belongs in the same maintenance pass that detaches and archives — never on a live partition.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Before and after chart of block-range extent as a percentage of the partition extent, following a spatial-order rewrite" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Effect of a spatial-order rewrite on BRIN pruning</title>
  <desc>Two paired measurements. Before the rewrite, the average block range summarises 71 percent of the partition extent and a bounding box query reads 94 percent of the blocks. After sorting by geohash, the average block range summarises 2.4 percent of the extent and the same query reads 6 percent of the blocks. Query time falls from 2900 milliseconds to 58 milliseconds, while the index stays under 100 kilobytes in both cases.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Same partition, same BRIN index, rewritten in spatial order</text>
  <text x="20" y="60" font-size="10.5" fill="currentColor">avg block-range extent</text>
  <rect x="220" y="48" width="326" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="554" y="61" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">71 % before</text>
  <rect x="220" y="70" width="11" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.85"/>
  <text x="239" y="83" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">2.4 % after</text>
  <text x="20" y="118" font-size="10.5" fill="currentColor">blocks read per query</text>
  <rect x="220" y="106" width="432" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="660" y="119" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">94 %</text>
  <rect x="220" y="128" width="28" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.85"/>
  <text x="256" y="141" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">6 %</text>
  <text x="20" y="176" font-size="10.5" fill="currentColor">query time</text>
  <rect x="220" y="164" width="420" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="648" y="177" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">2 900 ms</text>
  <rect x="220" y="186" width="18" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.85"/>
  <text x="246" y="199" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">58 ms</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">The index is under 100 KB in both cases — what changed is the data underneath it, not the index.</text>
</svg>

## Gotchas & Failure Modes

- **BRIN on an uncorrelated partition.** The plan still says `Bitmap Index Scan`, so it looks indexed while reading every block. Compare `actual rows` against `rows removed by filter` in `EXPLAIN ANALYZE` — a huge removal count is the tell.
- **Summaries going stale after inserts.** BRIN does not summarise new pages until `VACUUM` runs or `brin_summarize_new_values()` is called. On an append-heavy archival partition that is rarely vacuumed, the tail of the table is effectively unindexed.
- **`CLUSTER` as a prerequisite.** Rewriting a partition in spatial order — `CLUSTER … USING <gist index>` — creates the correlation BRIN needs, but takes an `ACCESS EXCLUSIVE` lock for the duration. Do it once, on an already-detached partition, before attaching it.
- **Parent-level index blocking the mix.** An index declared on the parent is cloned to every child and cannot be dropped from one child alone. Manage geometry indexes per partition from the start if a mixed strategy is planned.
- **KNN queries silently losing their index.** `ORDER BY geom <-> point` cannot use BRIN. If an analyst runs a nearest-neighbour query across all partitions, the archival ones sort in memory. Bound such queries by time so they only touch GiST partitions.
- **`pages_per_range` set too low.** At 1 page per range the index approaches the size of a btree while still lacking its precision. Between 32 and 128 is the useful band.

## Verification Snippet

```sql
-- Size comparison, per partition
SELECT c.relname,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size,
       am.amname                                      AS index_type
FROM   pg_class c
JOIN   pg_index i  ON i.indrelid = c.oid
JOIN   pg_class ic ON ic.oid = i.indexrelid
JOIN   pg_am am    ON am.oid = ic.relam
WHERE  c.relname LIKE 'positions_20%'
ORDER  BY c.relname;

-- Does BRIN actually eliminate anything here?
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM positions_2025_04
WHERE geom && ST_MakeEnvelope(-0.2, 51.4, 0.0, 51.6, 4326);
-- Healthy:   Bitmap Heap Scan … Rows Removed by Index Recheck: 4 012
-- Unhealthy: Bitmap Heap Scan … Rows Removed by Index Recheck: 9 940 118
```

---

## Related

- [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/) — the partition layout this indexes
- [Reading EXPLAIN ANALYZE for Spatial Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/) — telling a working index scan from a decorative one
- [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) — watching the cache-hit ratio this trade is meant to protect

← Back to [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/)
