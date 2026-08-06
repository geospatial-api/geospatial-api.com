---
layout: layouts/page.njk
title: "Avoiding Full Scans with ST_DWithin and Geography"
description: "ST_Distance in a WHERE clause reads every row. ST_DWithin uses the index. Learn the rewrite, the two indexes it needs, and how to spot the difference in a plan."
slug: avoiding-full-scans-with-st-dwithin-and-geography
type: howto
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Bounding Box & Spatial Index Queries"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/"
  - label: "Avoiding Full Scans with ST_DWithin and Geography"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/avoiding-full-scans-with-st-dwithin-and-geography/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Avoiding Full Scans with ST_DWithin and Geography",
      "description": "ST_Distance in a WHERE clause reads every row; ST_DWithin uses the index. The rewrite, the indexes and how to read the plan.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/avoiding-full-scans-with-st-dwithin-and-geography/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "Bounding Box & Spatial Index Queries", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/" },
        { "@type": "ListItem", "position": 3, "name": "Avoiding Full Scans with ST_DWithin and Geography", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/avoiding-full-scans-with-st-dwithin-and-geography/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Rewrite a Distance Filter to Use the Spatial Index",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Replace the comparison", "text": "Change ST_Distance(a, b) < r into ST_DWithin(a, b, r), which the planner can serve from a GiST index." },
        { "@type": "HowToStep", "position": 2, "name": "Index the expression you filter on", "text": "A geography predicate needs a GiST index on the geography cast; a geometry index cannot serve it." },
        { "@type": "HowToStep", "position": 3, "name": "Confirm in the plan", "text": "Look for an Index Cond naming the spatial index, not a Filter applied after a sequential scan." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why can ST_DWithin use an index when ST_Distance cannot?",
          "acceptedAnswer": { "@type": "Answer", "text": "ST_DWithin is defined so the planner can rewrite it into an index-supported bounding-box overlap against an expanded box, followed by an exact recheck. ST_Distance is an ordinary function returning a number, so a comparison against it is just a boolean expression the planner must evaluate per row — which means reading every row first." }
        },
        {
          "@type": "Question",
          "name": "Does the radius have to be a constant?",
          "acceptedAnswer": { "@type": "Answer", "text": "No, but it must be known at execution time as a parameter or a stable expression. A radius read from a column of the same table — every feature having its own catchment radius — prevents the index rewrite, because the expansion cannot be computed once. In that case pre-compute a buffered geometry column and index that instead." }
        },
        {
          "@type": "Question",
          "name": "Is ST_DWithin on geography slower than on geometry?",
          "acceptedAnswer": { "@type": "Answer", "text": "Slightly, and it is almost always worth it. The geography version does geodesic maths on the candidates that survive the index filter, adding a few microseconds each, and returns a result in metres that is correct everywhere. The geometry version is marginally faster and answers a question about degrees that no API actually wants to ask." }
        }
      ]
    }
  ]
}
</script>

← Back to [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/)

# Avoiding full scans with ST_DWithin and geography

This page covers the single highest-value rewrite in a spatial API: turning a distance comparison that reads the whole table into an index-assisted predicate that reads a few hundred rows.

## Context & When to Use

`WHERE ST_Distance(geom::geography, $point) < 5000` looks like a filter and behaves like a table scan. PostgreSQL has no way to use a spatial index on it: `ST_Distance` is an ordinary function, so the planner must call it for every row before it can evaluate the comparison. On a two million row table that is two million geodesic distance computations to return perhaps forty rows.

`ST_DWithin(geom::geography, $point, 5000)` expresses the same intent in a form the planner understands. It is rewritten internally into an index-supported overlap test against an expanded bounding box, which the GiST index serves, followed by an exact distance recheck on the small candidate set. Same answer, three orders of magnitude less work.

The rewrite is mechanical and safe, and it belongs anywhere a radius appears: proximity search, geofence membership, "alert me when a vehicle comes within 200 m". The one prerequisite people miss is the index — a geography predicate needs an index on the geography expression, and the existing geometry index will not serve it, as covered in [Measuring Distance and Area in Metres with Geography](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/measuring-distance-and-area-in-metres-with-geography/).

## Runnable Implementation

```sql
-- The index the predicate needs. Without it the rewrite happens and
-- still ends in a sequential scan, which is the confusing failure.
CREATE INDEX IF NOT EXISTS features_geog_gix
    ON features USING GIST ((geom::geography));

-- ✕ Reads every row: ST_Distance is opaque to the planner
SELECT id, name
FROM   features
WHERE  ST_Distance(geom::geography,
                   ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) < $3;

-- ✓ Index-assisted: expanded-box overlap, then an exact recheck
SELECT id, name,
       ROUND(ST_Distance(geom::geography, p.pt)::numeric, 1) AS distance_m
FROM   features f,
       LATERAL (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS pt) p
WHERE  ST_DWithin(f.geom::geography, p.pt, $3)
ORDER  BY f.geom::geography <-> p.pt
LIMIT  $4;
```

Note that `ST_Distance` still appears — in the `SELECT` list, where it runs once per returned row and costs nothing. The rule is the same one that governs [transform placement](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/transforming-srids-in-api-responses-with-st-transform/): expensive functions belong on the output side, index-friendly predicates on the filter side.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram of how ST_DWithin is executed in two stages against how ST_Distance is executed row by row" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Two stages versus two million evaluations</title>
  <desc>Two execution paths for the same question. The ST_Distance path evaluates the function on all 2.1 million rows and then filters, taking 2100 milliseconds. The ST_DWithin path first uses the GiST index to find rows whose bounding box overlaps a box expanded by the radius, yielding 340 candidates, then applies the exact geodesic distance to those candidates only, keeping 38 and taking 9 milliseconds. The recheck stage is highlighted as the reason the answer is identical.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Same question, same answer, two execution shapes</text>
  <rect x="16" y="44" width="336" height="112" rx="9" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.5"/>
  <text x="34" y="66" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">✕ ST_Distance(...) &lt; r</text>
  <rect x="34" y="78" width="300" height="26" rx="4" fill="var(--viz-bad-soft, #fbe4e1)"/>
  <text x="46" y="96" font-size="10" fill="currentColor">evaluate geodesic distance — 2 100 000 rows</text>
  <rect x="34" y="110" width="300" height="26" rx="4" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1"/>
  <text x="46" y="128" font-size="10" fill="currentColor">keep 38</text>
  <text x="334" y="150" text-anchor="end" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">2 100 ms</text>
  <rect x="368" y="44" width="336" height="112" rx="9" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="386" y="66" font-size="11" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓ ST_DWithin(..., r)</text>
  <rect x="386" y="78" width="300" height="26" rx="4" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="398" y="96" font-size="10" fill="currentColor">GiST: boxes overlapping box ⊕ r — 340 candidates</text>
  <rect x="386" y="110" width="300" height="26" rx="4" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="1"/>
  <text x="398" y="128" font-size="10" fill="currentColor">exact recheck on 340 → keep 38</text>
  <text x="686" y="150" text-anchor="end" font-size="11" font-weight="700" fill="var(--viz-good, #1f6b3a)">9 ms</text>
  <line x1="16" y1="172" x2="704" y2="172" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="196" font-size="10.5" fill="currentColor">The recheck is why the two answers are identical: the index stage is deliberately generous, and the</text>
  <text x="20" y="212" font-size="10.5" fill="currentColor">exact predicate then removes the false positives it let through.</text>
  <text x="20" y="238" font-size="10.5" fill="var(--muted, #7c6fb0)">2.1 M point table, 5 km radius, warm cache. The ratio holds across sizes; the absolute numbers do not.</text>
</svg>

## Key Parameters & Options

| Construct | Index-assisted | Unit | Notes |
|---|---|---|---|
| `ST_DWithin(geog, geog, m)` | yes | metres | The default choice for proximity |
| `ST_DWithin(geom, geom, deg)` | yes | degrees | Fast and answers the wrong question |
| `ST_Distance(...) < r` | no | — | Always a scan; rewrite it |
| `ST_Distance` in `SELECT` | n/a | metres | Correct place for it |
| `<->` ordering | yes, with GiST | metres on geography | Pair with `LIMIT` for nearest-N |
| Radius from a column | no | — | Pre-compute a buffered column instead |

The per-feature radius case deserves a note, because it looks harmless and is not. `ST_DWithin(a.geom, b.geom, a.catchment_m)` cannot be index-assisted, since the expansion differs per row. The fix is to materialise `ST_Buffer(geom::geography, catchment_m)::geometry` into its own indexed column and test overlap against that.

## Reading the plan

The rewrite either happened or it did not, and the plan says which in one line.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Annotated comparison of two EXPLAIN outputs, one showing a sequential scan with a filter and one showing an index scan with an index condition" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What the plan looks like in each case</title>
  <desc>Two EXPLAIN excerpts side by side. The failing plan shows a sequential scan on features with the distance test appearing as a Filter and 2.1 million rows removed by that filter. The healthy plan shows an index scan using the geography GiST index, with the predicate appearing as an Index Cond and only 302 rows removed by recheck. Two annotations point out that the words Filter and Index Cond are the whole diagnosis, and that a large rows-removed count under Filter always means a scan.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One word tells you which plan you got</text>
  <rect x="16" y="42" width="336" height="120" rx="8" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="30" y="64" font-size="9.5" font-family="monospace" fill="currentColor">Seq Scan on features</text>
  <text x="30" y="82" font-size="9.5" font-family="monospace" font-weight="700" fill="var(--viz-bad, #a32b23)">  Filter: (st_distance(...) &lt; 5000)</text>
  <text x="30" y="100" font-size="9.5" font-family="monospace" fill="currentColor">  Rows Removed by Filter: 2099962</text>
  <text x="30" y="118" font-size="9.5" font-family="monospace" fill="currentColor">  actual time=2101.4..2101.4</text>
  <text x="30" y="146" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">"Filter" + a huge removal count = a scan</text>
  <rect x="368" y="42" width="336" height="120" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="382" y="64" font-size="9.5" font-family="monospace" fill="currentColor">Index Scan using features_geog_gix</text>
  <text x="382" y="82" font-size="9.5" font-family="monospace" font-weight="700" fill="var(--viz-good, #1f6b3a)">  Index Cond: (geom::geography &amp;&amp; ...)</text>
  <text x="382" y="100" font-size="9.5" font-family="monospace" fill="currentColor">  Rows Removed by Recheck: 302</text>
  <text x="382" y="118" font-size="9.5" font-family="monospace" fill="currentColor">  actual time=8.9..9.1</text>
  <text x="382" y="146" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">"Index Cond" + a small recheck = correct</text>
  <line x1="16" y1="178" x2="704" y2="178" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="200" font-size="10.5" fill="currentColor">A third case exists and is the most confusing: <tspan font-family="monospace" font-size="10">ST_DWithin</tspan> with no geography index, which</text>
  <text x="20" y="216" font-size="10.5" fill="currentColor">also produces a Seq Scan — the rewrite is willing but there is nothing to rewrite onto.</text>
  <text x="20" y="234" font-size="10.5" fill="var(--muted, #7c6fb0)">If the query looks right and the plan looks wrong, check for the index on the cast expression first.</text>
</svg>

## Where the rewrite stops helping

Index assistance is not unconditional. It works by narrowing the candidate set, so it delivers less and less as the radius grows relative to the data's extent. Past a certain point the expanded box covers most of the table, every row becomes a candidate, and the plan reverts to a scan with an index lookup bolted on the front.

That crossover is worth knowing, because the fix is different on each side of it. Below it, the answer is always "make sure the index exists and the predicate is index-friendly". Above it, no index will help and the answer is a coarser data structure: a pre-aggregated summary table, a [materialized view](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/), or simply refusing the request with a documented maximum radius.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of query time against search radius showing index assistance losing effectiveness as the radius approaches the extent of the data" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Index benefit against search radius</title>
  <desc>Query time plotted against search radius from 100 metres to 500 kilometres, for a dataset spanning about 400 kilometres. Up to 20 kilometres the indexed query stays under 20 milliseconds while the unindexed comparison sits flat at 2100 milliseconds. From 50 kilometres the indexed line climbs as the candidate set grows, reaching 400 milliseconds at 150 kilometres and converging with the unindexed line at around 300 kilometres, where the expanded box covers nearly the whole dataset. A marker shows the practical maximum radius an API should accept.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">The index stops paying once the radius approaches the data's extent</text>
  <line x1="70" y1="176" x2="686" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <line x1="70" y1="44" x2="70" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <text x="62" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">2 500 ms</text>
  <text x="62" y="114" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">1 200 ms</text>
  <text x="62" y="176" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <polyline points="70,72 200,72 330,72 460,72 600,72 686,72" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="2.2" stroke-dasharray="6,4"/>
  <text x="200" y="66" font-size="10" fill="var(--viz-bad, #a32b23)">ST_Distance — flat, always a full scan</text>
  <polyline points="70,174 150,173 230,170 310,160 390,140 470,112 550,90 620,78 686,73" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="2.4"/>
  <text x="300" y="196" text-anchor="middle" font-size="10" fill="var(--viz-good, #1f6b3a)">ST_DWithin — grows with the candidate set</text>
  <line x1="310" y1="40" x2="310" y2="186" stroke="var(--viz-warn, #8a5000)" stroke-width="1.8" stroke-dasharray="5,3"/>
  <text x="318" y="96" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">practical maximum</text>
  <text x="318" y="110" font-size="9.5" fill="var(--viz-warn, #8a5000)">cap the API's radius here</text>
  <text x="90" y="212" font-size="9.5" fill="var(--muted, #7c6fb0)">100 m</text>
  <text x="290" y="212" font-size="9.5" fill="var(--muted, #7c6fb0)">50 km</text>
  <text x="470" y="212" font-size="9.5" fill="var(--muted, #7c6fb0)">150 km</text>
  <text x="640" y="212" font-size="9.5" fill="var(--muted, #7c6fb0)">500 km</text>
  <text x="20" y="234" font-size="10.5" fill="var(--muted, #7c6fb0)">A documented maximum radius is a feature, not a limitation — it keeps every accepted request on the fast side.</text>
</svg>

## Gotchas & Failure Modes

- **The geography index missing.** `ST_DWithin` on geography with only a geometry index still scans. The predicate is correct and the plan is not; the index on `(geom::geography)` is the fix.
- **Casting only one operand.** Mixing a geometry and a geography argument either raises `function st_dwithin(geometry, geography, numeric) does not exist` or silently resolves to the geometry overload with a degree radius. Cast both.
- **A radius that is actually a column.** Index assistance requires the radius to be constant for the scan. Materialise a buffered geometry if each feature has its own catchment.
- **`ST_DWithin` with a huge radius.** At continental scale the expanded box covers most of the table and the index stops helping. Above roughly a tenth of the data's extent, a different access path — or a coarser pre-aggregated table — is needed.
- **Sorting by `ST_Distance` after filtering with `ST_DWithin`.** Correct, but it re-computes distance for every candidate. Use the `<->` operator, which the same index serves for ordering.
- **`ANALYZE` never run after a bulk load.** Without statistics the planner may estimate the candidate set as the whole table and choose a scan anyway. Run `ANALYZE` after any large import, as in [Managing Async Transactions for Bulk Geometry Writes](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/).

One last practical note: the rewrite is worth applying even where the current table is small enough that nobody notices. A distance filter that scans two hundred thousand rows in forty milliseconds looks perfectly healthy in review, and it becomes a two-second query the quarter the table reaches four million. Because the rewrite costs nothing and reads no worse, there is no reason to defer it until the metric turns red.

One last practical note: the rewrite is worth applying even where the current table is small enough that nobody notices. A distance filter that scans two hundred thousand rows in forty milliseconds looks perfectly healthy in review, and it becomes a two-second query the quarter the table reaches four million. Because the rewrite costs nothing and reads no worse, there is no reason to defer it until the metric turns red.

## Verification Snippet

```sql
-- Prove the rewrite happened
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM features
WHERE ST_DWithin(geom::geography,
                 ST_SetSRID(ST_MakePoint(-0.1276, 51.5072), 4326)::geography, 5000);
-- Index Scan using features_geog_gix on features
--   Index Cond: ((geom)::geography && _st_expand(...))
--   Rows Removed by Recheck: 302

-- And that both forms agree on the answer
SELECT count(*) FROM features
WHERE ST_DWithin(geom::geography, $1::geography, 5000);
SELECT count(*) FROM features
WHERE ST_Distance(geom::geography, $1::geography) < 5000;
-- identical counts, wildly different timings
```

```bash
curl -s "localhost:8000/v1/nearby?lon=-0.1276&lat=51.5072&radius_m=5000" \
  | jq '.results | length, (.[0].distance_m)'
# 38
# 184.6
```

---

## Related

- [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — the index behaviour this relies on
- [Measuring Distance and Area in Metres with Geography](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/measuring-distance-and-area-in-metres-with-geography/) — why the cast is there at all
- [Reading EXPLAIN ANALYZE for Spatial Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/) — the plan vocabulary in full

← Back to [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/)
