---
layout: layouts/page.njk
title: "Combining KNN Ordering with Attribute Filters"
description: "Add a WHERE clause to a nearest-neighbour query and the index-assisted ordering can collapse. Three patterns that keep the KNN scan alive: partial indexes, expanding radius search, and LATERAL per-group."
slug: combining-knn-ordering-with-attribute-filters
type: howto
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "K-Nearest Neighbor Routing Algorithms"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/"
  - label: "Combining KNN Ordering with Attribute Filters"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/combining-knn-ordering-with-attribute-filters/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Combining KNN Ordering with Attribute Filters",
      "description": "Keep an index-assisted nearest-neighbour scan alive when a WHERE clause is added: partial indexes, expanding radius search and LATERAL per-group.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/combining-knn-ordering-with-attribute-filters/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "K-Nearest Neighbor Routing Algorithms", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/" },
        { "@type": "ListItem", "position": 3, "name": "Combining KNN Ordering with Attribute Filters", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/combining-knn-ordering-with-attribute-filters/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Filter a Nearest-Neighbour Query Without Losing the Index",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Prefer a partial index", "text": "When the filter takes few distinct values, build one GiST index per value and let the planner pick." },
        { "@type": "HowToStep", "position": 2, "name": "Bound the search first", "text": "Add an ST_DWithin bound so the KNN scan works over a small candidate set instead of the whole table." },
        { "@type": "HowToStep", "position": 3, "name": "Use LATERAL for per-group nearest", "text": "For nearest-per-category, join a small groups table to a LATERAL subquery so each group gets its own KNN scan." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does adding a WHERE clause make a KNN query slower?",
          "acceptedAnswer": { "@type": "Answer", "text": "The KNN index scan walks the index in distance order and stops once the limit is reached. A filter the index cannot evaluate is applied after each candidate is fetched, so if only one row in five hundred matches, the scan must walk five hundred entries to return one. With a restrictive filter and a limit of ten, that becomes thousands of index entries and heap fetches." }
        },
        {
          "@type": "Question",
          "name": "When is a partial index the right answer?",
          "acceptedAnswer": { "@type": "Answer", "text": "When the filter column has few distinct values that are known in advance — a status, a category code, an active flag. One partial GiST index per value keeps every KNN scan pure, at the cost of extra write overhead and disk. It stops being practical past a couple of dozen values, or when the filter is a range rather than an equality." }
        },
        {
          "@type": "Question",
          "name": "Is a radius bound always safe to add?",
          "acceptedAnswer": { "@type": "Answer", "text": "Only if the API can honestly say there is no answer beyond it. Bounding a nearest search at 5 km changes the semantics: a request with no match inside the radius returns nothing rather than something far away. Usually that is the more useful behaviour, but it must be documented, and an expanding search is the fallback when a result is genuinely required." }
        }
      ]
    }
  ]
}
</script>

← Back to [K-Nearest Neighbor Routing Algorithms](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/)

# Combining KNN ordering with attribute filters

This page covers what happens when "the ten nearest" becomes "the ten nearest that are *available*", and the three ways to keep that query fast.

## Context & When to Use

The `<->` operator gives PostGIS a genuinely index-assisted nearest-neighbour scan: the GiST index is walked in distance order and the scan stops as soon as `LIMIT` is satisfied. Ten rows out of two million in about three milliseconds. It is one of the most elegant things in the database, and it is fragile in one specific way.

Add `WHERE status = 'available'` and the elegance leaks. The index cannot evaluate `status`, so the executor fetches each candidate in distance order, checks the attribute, and discards the misses. If one row in five hundred is available, returning ten means walking roughly five thousand index entries and doing five thousand heap fetches. The query still returns the right answer, and it now takes 400 ms instead of 3.

Three patterns fix it, and which one applies depends on the filter's shape: few known values, a bounded search area, or a nearest-per-group requirement. All three preserve the property that makes KNN worth using — early termination — rather than falling back to computing distance for everything. The unfiltered baseline is covered in [Optimizing KNN Queries with the PostGIS Distance Operator](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/optimizing-knn-queries-with-postgis-operator/).

## Runnable Implementation

```sql
-- Pattern 1 — PARTIAL INDEX: few known values, exact match
CREATE INDEX vehicles_geog_available_gix ON vehicles
    USING GIST ((geom::geography)) WHERE status = 'available';
CREATE INDEX vehicles_geog_busy_gix ON vehicles
    USING GIST ((geom::geography)) WHERE status = 'busy';

-- The planner picks the matching partial index; the scan is pure KNN again
SELECT id, ROUND(ST_Distance(geom::geography, $1::geography)::numeric, 1) AS m
FROM   vehicles
WHERE  status = 'available'
ORDER  BY geom::geography <-> $1::geography
LIMIT  10;

-- Pattern 2 — BOUNDED SEARCH: filter is arbitrary, area is not
SELECT id, ROUND(ST_Distance(geom::geography, $1::geography)::numeric, 1) AS m
FROM   vehicles
WHERE  ST_DWithin(geom::geography, $1::geography, 5000)   -- index narrows first
  AND  status = ANY($2::text[])                            -- then cheap filtering
ORDER  BY geom::geography <-> $1::geography
LIMIT  10;

-- Pattern 3 — LATERAL PER-GROUP: nearest of each category, one KNN scan each
SELECT c.code, n.id, ROUND(n.m::numeric, 1) AS m
FROM   categories c
CROSS  JOIN LATERAL (
    SELECT v.id, ST_Distance(v.geom::geography, $1::geography) AS m
    FROM   vehicles v
    WHERE  v.category = c.code
    ORDER  BY v.geom::geography <-> $1::geography
    LIMIT  1
) n;
```

Pattern 2 is the one to reach for first. It is a one-line change, needs no extra indexes, and converts an unbounded walk into a bounded one — the same `ST_DWithin` rewrite described in [Avoiding Full Scans with ST_DWithin and Geography](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/avoiding-full-scans-with-st-dwithin-and-geography/), used here to protect the ordering rather than the filter.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram of a KNN index walk discarding non-matching candidates, contrasted with a partial index where every candidate matches" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What the KNN scan walks in each case</title>
  <desc>Two rows of index entries walked in distance order. In the unfiltered-index case, most entries are non-matching and are fetched then discarded; reaching ten matches requires walking about five thousand entries. In the partial-index case, every entry in the index already satisfies the filter, so ten entries are walked to return ten rows. The heap fetch count follows the same ratio, which is where the time actually goes.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Walking the index in distance order, with and without a partial index</text>
  <text x="20" y="58" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">full index + WHERE status = 'available'</text>
  <rect x="20" y="68" width="18" height="22" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.3"/>
  <rect x="42" y="68" width="18" height="22" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.3"/>
  <rect x="64" y="68" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="86" y="68" width="18" height="22" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.3"/>
  <rect x="108" y="68" width="18" height="22" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.3"/>
  <rect x="130" y="68" width="18" height="22" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.3"/>
  <rect x="152" y="68" width="18" height="22" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.3"/>
  <rect x="174" y="68" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="196" y="68" width="18" height="22" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.3"/>
  <rect x="218" y="68" width="18" height="22" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.3"/>
  <rect x="240" y="68" width="18" height="22" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.3"/>
  <rect x="262" y="68" width="18" height="22" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.3"/>
  <text x="292" y="84" font-size="11" fill="var(--muted, #7c6fb0)">… ~5 000 entries walked, 4 990 discarded</text>
  <text x="20" y="112" font-size="10.5" fill="currentColor">heap fetches: <tspan font-weight="700" fill="var(--viz-bad, #a32b23)">5 000</tspan>   ·   time: <tspan font-weight="700" fill="var(--viz-bad, #a32b23)">412 ms</tspan></text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="156" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">partial index WHERE status = 'available'</text>
  <rect x="20" y="166" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="42" y="166" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="64" y="166" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="86" y="166" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="108" y="166" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="130" y="166" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="152" y="166" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="174" y="166" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="196" y="166" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="218" y="166" width="18" height="22" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="250" y="182" font-size="11" fill="var(--muted, #7c6fb0)">scan stops here — every entry matched</text>
  <text x="20" y="210" font-size="10.5" fill="currentColor">heap fetches: <tspan font-weight="700" fill="var(--viz-good, #1f6b3a)">10</tspan>   ·   time: <tspan font-weight="700" fill="var(--viz-good, #1f6b3a)">3.1 ms</tspan></text>
  <text x="20" y="238" font-size="10.5" fill="var(--muted, #7c6fb0)">The index still terminates early in both cases — the difference is how many candidates it has to reject first.</text>
</svg>

## Key Parameters & Options

| Pattern | Best when | Cost |
|---|---|---|
| Partial index per value | ≤ ~20 known values, equality filter | One index per value; write overhead |
| `ST_DWithin` bound | any filter, bounded area acceptable | Changes semantics: no result beyond the radius |
| `LATERAL` per group | nearest-of-each-category | One KNN scan per group; needs a small groups table |
| Composite btree + GiST | filter is highly selective on its own | Loses distance ordering; sort afterwards |
| Expanding radius | a result is mandatory | Two or three queries in the worst case |
| No mitigation | filter matches > ~20 % of rows | Acceptable — the walk is short anyway |

That last row matters. If the filter keeps most rows, the plain KNN scan discards very little and none of this is needed. The patterns are for *selective* filters, and measuring selectivity is the first step rather than the last.

## When a result is mandatory: expanding search

A bounded search returns nothing when nothing is near, which is usually correct and occasionally unacceptable — a dispatcher must be given *some* vehicle. The answer is to try a small radius first and widen only on a miss, so the common case stays fast.

```python
RADII_M = (2_000, 10_000, 50_000)     # try nearest first, widen on empty

async def nearest_available(conn, point_wkt: str, limit: int = 10):
    for radius in RADII_M:
        rows = await conn.fetch(NEAREST_BOUNDED_SQL, point_wkt, radius, limit)
        if len(rows) >= limit:
            return rows, radius
    # Final fallback: unbounded, and log it — a frequent fallback means the
    # radii are wrong for this data, not that the data is unusual
    return await conn.fetch(NEAREST_UNBOUNDED_SQL, point_wkt, limit), None
```

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of how often each radius step is needed and the resulting average latency of an expanding search" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Expanding search: how often each step is reached</title>
  <desc>Three radius steps with the share of requests satisfied at each. The 2 kilometre step satisfies 87 percent of requests in 3 milliseconds. The 10 kilometre step handles a further 11 percent, costing 3 plus 9 milliseconds because the first attempt is wasted. The 50 kilometre step handles 2 percent at a cumulative 58 milliseconds. The weighted average is 5.4 milliseconds, close to the best case, which is the argument for trying the small radius first rather than starting wide.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Expanding search over a real dispatch workload</text>
  <text x="20" y="62" font-size="10.5" fill="currentColor">2 km — first attempt</text>
  <rect x="220" y="48" width="418" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="648" y="62" font-size="10.5" font-weight="700" fill="currentColor">87 % · 3 ms</text>
  <text x="20" y="102" font-size="10.5" fill="currentColor">10 km — second attempt</text>
  <rect x="220" y="88" width="53" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="283" y="102" font-size="10.5" font-weight="700" fill="currentColor">11 %</text>
  <text x="330" y="102" font-size="10" fill="var(--muted, #7c6fb0)">12 ms cumulative — the first try is wasted work</text>
  <text x="20" y="142" font-size="10.5" fill="currentColor">50 km — third attempt</text>
  <rect x="220" y="128" width="10" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="240" y="142" font-size="10.5" font-weight="700" fill="currentColor">2 %</text>
  <text x="330" y="142" font-size="10" fill="var(--muted, #7c6fb0)">58 ms cumulative</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="186" font-size="11" fill="currentColor">Weighted average: <tspan font-weight="700" fill="var(--viz-good, #1f6b3a)">5.4 ms</tspan>   ·   starting at 50 km instead: <tspan font-weight="700" fill="var(--viz-bad, #a32b23)">58 ms</tspan> for every request</text>
  <text x="20" y="214" font-size="10.5" fill="var(--muted, #7c6fb0)">Wasted first attempts cost far less than making the common case pay for the rare one. Track how often the</text>
  <text x="20" y="230" font-size="10.5" fill="var(--muted, #7c6fb0)">final fallback is reached — a rising rate means the radii no longer match the data's density.</text>
</svg>

## Choosing between the three patterns

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision tree selecting between a partial index, a bounded search and a lateral join based on the filter's shape" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Which pattern the filter's shape calls for</title>
  <desc>A decision tree. The first question asks whether the filter has a small fixed set of values. If yes, a partial index per value is the answer. If no, the next question asks whether the query is nearest-per-group. If yes, a lateral join gives each group its own scan. If no, the final question asks whether a bounded search area is acceptable to the product. If yes, an ST_DWithin bound is the answer; if no, an expanding radius search is the fallback.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <rect x="252" y="14" width="216" height="34" rx="7" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="360" y="36" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">Filter has few fixed values?</text>
  <path d="M252 31 L150 31 L150 62" stroke="currentColor" stroke-width="1.3" fill="none" marker-end="url(#knArr)"/>
  <text x="188" y="26" font-size="9.5" fill="var(--muted, #7c6fb0)">yes</text>
  <rect x="30" y="64" width="240" height="44" rx="7" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.3"/>
  <text x="150" y="84" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">partial index per value</text>
  <text x="150" y="99" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">purest scan; costs write overhead</text>
  <path d="M360 48 L360 72" stroke="currentColor" stroke-width="1.3" marker-end="url(#knArr)"/>
  <text x="370" y="66" font-size="9.5" fill="var(--muted, #7c6fb0)">no</text>
  <rect x="252" y="74" width="216" height="34" rx="7" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="360" y="96" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Nearest per group?</text>
  <path d="M468 91 L570 91 L570 122" stroke="currentColor" stroke-width="1.3" fill="none" marker-end="url(#knArr)"/>
  <text x="510" y="86" font-size="9.5" fill="var(--muted, #7c6fb0)">yes</text>
  <rect x="450" y="124" width="240" height="44" rx="7" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.3"/>
  <text x="570" y="144" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">LATERAL per group</text>
  <text x="570" y="159" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">one scan each; keep the group set small</text>
  <path d="M360 108 L360 132" stroke="currentColor" stroke-width="1.3" marker-end="url(#knArr)"/>
  <text x="370" y="126" font-size="9.5" fill="var(--muted, #7c6fb0)">no</text>
  <rect x="252" y="134" width="216" height="34" rx="7" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="360" y="156" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Bounded area acceptable?</text>
  <path d="M252 151 L150 151 L150 180" stroke="currentColor" stroke-width="1.3" fill="none" marker-end="url(#knArr)"/>
  <text x="188" y="146" font-size="9.5" fill="var(--muted, #7c6fb0)">yes</text>
  <rect x="30" y="182" width="240" height="44" rx="7" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="150" y="202" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">ST_DWithin bound</text>
  <text x="150" y="217" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">one line; try this first</text>
  <path d="M468 151 L570 151 L570 180" stroke="currentColor" stroke-width="1.3" fill="none" marker-end="url(#knArr)"/>
  <text x="510" y="146" font-size="9.5" fill="var(--muted, #7c6fb0)">no</text>
  <rect x="450" y="182" width="240" height="44" rx="7" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.3"/>
  <text x="570" y="202" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">expanding radius</text>
  <text x="570" y="217" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">two or three queries worst case</text>
  <defs>
    <marker id="knArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

## Gotchas & Failure Modes

- **A partial index the planner will not use.** The index predicate must match the query predicate closely enough for PostgreSQL to prove implication. `WHERE status = 'available'` matches; `WHERE status IN ('available')` usually does too; `WHERE status <> 'busy'` does not.
- **Too many partial indexes.** Each one is maintained on every write. Twenty partial GiST indexes on a high-write table can cost more than the queries save; measure the write path before adding the fifth.
- **`LIMIT` missing from the KNN query.** Without it there is no early termination and the operator sorts the whole candidate set. The `<->` operator is only fast in combination with a limit.
- **Ordering by `ST_Distance` instead of `<->`.** Semantically identical, but only the operator form is index-assisted for ordering.
- **A `LATERAL` join over a large outer table.** Pattern 3 runs one KNN scan per outer row. That is excellent for twelve categories and disastrous for 200 000 customers — for the latter, invert the problem and batch.
- **Filter selectivity changing over time.** A partial index sized for "10 % available" behaves very differently when a fleet goes to 90 % idle overnight. Re-measure after any operational change.

## Verification Snippet

```sql
-- Confirm the partial index is chosen, and that the scan terminates early
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM vehicles
WHERE status = 'available'
ORDER BY geom::geography <-> ST_SetSRID(ST_MakePoint(-0.1276, 51.5072), 4326)::geography
LIMIT 10;
-- Limit  (actual time=0.09..3.06 rows=10 loops=1)
--   ->  Index Scan using vehicles_geog_available_gix on vehicles
--         Order By: ((geom)::geography <-> '...'::geography)
--  (no "Rows Removed by Filter" line at all)

-- Selectivity check: is any of this necessary?
SELECT status, count(*), round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM   vehicles GROUP BY status ORDER BY 2 DESC;
```

```bash
curl -s "localhost:8000/v1/nearest?lon=-0.1276&lat=51.5072&status=available&limit=10" \
  | jq '{count: (.results|length), radius_used: .radius_m, first: .results[0].distance_m}'
# {"count":10,"radius_used":2000,"first":184.6}
```

---

## Related

- [K-Nearest Neighbor Routing Algorithms](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) — the ordering this page filters
- [Optimizing KNN Queries with the PostGIS Distance Operator](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/optimizing-knn-queries-with-postgis-operator/) — the unfiltered baseline
- [Avoiding Full Scans with ST_DWithin and Geography](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/avoiding-full-scans-with-st-dwithin-and-geography/) — the bound used in pattern 2

← Back to [K-Nearest Neighbor Routing Algorithms](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/)
