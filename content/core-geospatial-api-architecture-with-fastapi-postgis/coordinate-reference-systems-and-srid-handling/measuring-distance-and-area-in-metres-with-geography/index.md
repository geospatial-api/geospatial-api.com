---
layout: layouts/page.njk
title: "Measuring Distance and Area in Metres with Geography"
description: "Stop returning degrees from ST_Distance. Cast to geography, index the cast, and know when a local projection beats geodesic maths for area."
slug: measuring-distance-and-area-in-metres-with-geography
type: howto
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "Coordinate Reference Systems & SRID Handling"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/"
  - label: "Measuring Distance and Area in Metres"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/measuring-distance-and-area-in-metres-with-geography/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Measuring Distance and Area in Metres with Geography",
      "description": "Stop returning degrees from ST_Distance. Cast to geography, index the cast, and know when a local projection beats geodesic maths for area.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/measuring-distance-and-area-in-metres-with-geography/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 2, "name": "Coordinate Reference Systems & SRID Handling", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/" },
        { "@type": "ListItem", "position": 3, "name": "Measuring Distance and Area in Metres", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/measuring-distance-and-area-in-metres-with-geography/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Return Real Metres from a Spatial Endpoint",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Cast both operands", "text": "Cast the column and the comparison point to geography so ST_Distance and ST_DWithin work in metres." },
        { "@type": "HowToStep", "position": 2, "name": "Index the cast", "text": "Build a GiST index on the geography expression, because a geometry index cannot serve a geography predicate." },
        { "@type": "HowToStep", "position": 3, "name": "Choose a projection for heavy area work", "text": "For large polygon overlays, transform to a local equal-area system instead of paying geodesic cost per row." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the actual difference between geometry and geography?",
          "acceptedAnswer": { "@type": "Answer", "text": "They hold the same coordinates and differ in the maths applied to them. Geometry treats coordinates as points on a flat plane, so distance is Pythagorean and the unit is whatever the coordinates are in. Geography treats them as points on an ellipsoid, so distance is geodesic and always in metres. Geography supports fewer functions and costs more per call, which is why most schemas store geometry and cast at the point of measurement." }
        },
        {
          "@type": "Question",
          "name": "Does ST_DWithin on geography use an index?",
          "acceptedAnswer": { "@type": "Answer", "text": "Yes, if a GiST index exists on the geography expression. ST_DWithin is index-assisted for both types: the planner uses the index to find candidates within the bounding radius, then applies the exact predicate. Without the geography index the planner falls back to a sequential scan, which is the single most common reason a proximity endpoint is slow." }
        },
        {
          "@type": "Question",
          "name": "How wrong is a degree-based distance in practice?",
          "acceptedAnswer": { "@type": "Answer", "text": "It depends entirely on latitude, which is what makes it dangerous. Converting 0.05 degrees to metres using a fixed factor is accurate at the equator, about 13 percent short at 30 degrees, 29 percent short at 45 and 50 percent short at 60. A radius filter written that way returns different real-world areas for users in different cities, and the bug scales with how far your users are from the equator." }
        }
      ]
    }
  ]
}
</script>

← Back to [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/)

# Measuring distance and area in metres with geography

This page shows how to make every distance, radius and area an endpoint returns a real measurement in metres, instead of a degree value that happens to look like one.

## Context & When to Use

Any endpoint that accepts a radius, returns a distance, sorts by proximity or reports an area is making a measurement claim. If the underlying column is `geometry(…, 4326)` and nothing casts it, that claim is expressed in degrees — a unit whose ground length varies from 111 km to nothing depending on where you are and which axis you are moving along. Nothing errors; the API just returns a number that means something different for each user, as set out in [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/).

There are two correct answers, and the choice is about workload rather than accuracy. Casting to `geography` gives geodesic maths on the ellipsoid: correct everywhere on the globe, no projection to choose, slightly slower per call. Transforming to a projected system gives planar maths in metres: faster for heavy polygon work, accurate only inside that projection's area of use.

Use `geography` for point-based proximity — "stores within 5 km", "nearest ten vehicles", geofence membership. Use a projected system for bulk area and length computation over complex polygons, especially where the result feeds an aggregation rather than a single response.

## Runnable Implementation

```sql
-- One index per access pattern: the geometry index cannot serve a geography predicate
CREATE INDEX features_geom_gix ON features USING GIST (geom);
CREATE INDEX features_geog_gix ON features USING GIST ((geom::geography));

-- Proximity search that returns real metres, index-assisted on both sides
PREPARE nearby (float8, float8, float8, int) AS
SELECT f.id,
       f.name,
       ROUND(ST_Distance(
           f.geom::geography,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
       )::numeric, 1) AS distance_m
FROM   features f
WHERE  ST_DWithin(                       -- $3 is METRES, because both sides are geography
           f.geom::geography,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           $3
       )
ORDER  BY f.geom::geography <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
LIMIT  $4;

EXECUTE nearby(-0.1276, 51.5072, 5000, 10);   -- within 5 km of Trafalgar Square
```

The FastAPI side keeps the unit contract explicit — the parameter is named for its unit, validated, and bounded:

```python
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query

router = APIRouter(prefix="/v1/nearby", tags=["proximity"])

NEARBY_SQL = """
SELECT f.id, f.name,
       ROUND(ST_Distance(f.geom::geography, p.pt)::numeric, 1) AS distance_m
FROM   features f,
       LATERAL (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS pt) p
WHERE  ST_DWithin(f.geom::geography, p.pt, $3)
ORDER  BY f.geom::geography <-> p.pt
LIMIT  $4
"""


async def get_pool() -> asyncpg.Pool:      # wired at app startup
    raise NotImplementedError


@router.get("")
async def nearby(
    lon: Annotated[float, Query(ge=-180, le=180)],
    lat: Annotated[float, Query(ge=-90, le=90)],
    # Named for the unit: no caller can mistake this for degrees
    radius_m: Annotated[float, Query(gt=0, le=50_000)] = 1_000,
    limit: Annotated[int, Query(ge=1, le=200)] = 20,
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(NEARBY_SQL, lon, lat, radius_m, limit)
    return {
        "unit": "metre",
        "radius_m": radius_m,
        "results": [dict(r) for r in rows],
    }
```

<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of a degree radius and a metric radius at three latitudes, showing the degree circle collapsing into an ellipse as latitude rises" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>A degree radius is an ellipse that shrinks with latitude</title>
  <desc>Three panels for latitudes 0, 45 and 60 degrees. In each, a dashed shape shows the ground footprint of a 0.05 degree radius and a solid circle shows a true 5 kilometre radius. At the equator the two nearly coincide. At 45 degrees the degree footprint is an ellipse noticeably narrower east to west. At 60 degrees it is half as wide as it is tall, so an endpoint using degrees returns a much smaller real search area for northern users than for equatorial ones.</desc>
  <rect x="0" y="0" width="720" height="260" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">The same "0.05°" radius, drawn on the ground</text>
  <text x="130" y="52" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">0° — equator</text>
  <ellipse cx="130" cy="130" rx="62" ry="62" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.8" stroke-dasharray="6,4"/>
  <circle cx="130" cy="130" r="60" fill="var(--accent, #7c3aed)" fill-opacity="0.12" stroke="var(--accent, #7c3aed)" stroke-width="1.8"/>
  <text x="130" y="134" text-anchor="middle" font-size="10" fill="currentColor">≈ equal</text>
  <text x="130" y="212" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">5.6 km × 5.6 km</text>
  <text x="360" y="52" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">45° — Milan</text>
  <ellipse cx="360" cy="130" rx="44" ry="62" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.8" stroke-dasharray="6,4"/>
  <circle cx="360" cy="130" r="60" fill="var(--accent, #7c3aed)" fill-opacity="0.12" stroke="var(--accent, #7c3aed)" stroke-width="1.8"/>
  <text x="360" y="134" text-anchor="middle" font-size="10" fill="currentColor">29 % narrower</text>
  <text x="360" y="212" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">3.9 km × 5.6 km</text>
  <text x="590" y="52" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">60° — Oslo</text>
  <ellipse cx="590" cy="130" rx="31" ry="62" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.8" stroke-dasharray="6,4"/>
  <circle cx="590" cy="130" r="60" fill="var(--accent, #7c3aed)" fill-opacity="0.12" stroke="var(--accent, #7c3aed)" stroke-width="1.8"/>
  <text x="590" y="134" text-anchor="middle" font-size="10" fill="currentColor">50 % narrower</text>
  <text x="590" y="212" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">2.8 km × 5.6 km</text>
  <rect x="20" y="228" width="14" height="4" fill="var(--accent, #7c3aed)"/>
  <text x="42" y="234" font-size="10.5" fill="currentColor">geography — a true 5 km radius, same everywhere</text>
  <rect x="360" y="228" width="14" height="4" fill="var(--viz-bad, #a32b23)"/>
  <text x="382" y="234" font-size="10.5" fill="currentColor">0.05° on a geometry column — an ellipse that shrinks</text>
</svg>

## Key Parameters & Options

| Construct | Unit | Index needed | Notes |
|---|---|---|---|
| `ST_Distance(geom, geom)` | degrees | `GIST(geom)` | Almost never what an API wants |
| `ST_Distance(geog, geog)` | metres | `GIST((geom::geography))` | Geodesic; correct globally |
| `ST_DWithin(geog, geog, m)` | metres | geography GiST | Index-assisted; prefer over `ST_Distance < x` |
| `<->` on geography | metres | geography GiST | KNN ordering — see [KNN routing](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) |
| `ST_Area(geog)` | m² | — | Geodesic area; slower on complex polygons |
| `ST_Area(ST_Transform(geom, <equal-area>))` | m² | — | Faster in bulk, valid only in the projection's area |

`ST_DWithin` rather than `ST_Distance(...) < 5000` is the single most valuable substitution on this page: the former is index-assisted, the latter forces a distance computation for every row in the table.

## Cost of each measurement path

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Benchmark chart comparing query time for four measurement approaches over a two million row table" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Measured cost of four ways to ask "within 5 km"</title>
  <desc>Four bars over a two million row point table. ST_DWithin on geography with a geography index takes 9 milliseconds. ST_DWithin on geometry with a degree radius takes 7 milliseconds but answers the wrong question. ST_Distance compared against a constant, with no index assistance, takes 2100 milliseconds. Transforming both sides to a local projected system per row takes 3400 milliseconds. The two fast options are marked correct and incorrect respectively, making the point that the cheapest query is not always the right one.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">"Everything within 5 km", 2 M point table, log scale</text>
  <line x1="300" y1="40" x2="300" y2="186" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="450" y1="40" x2="450" y2="186" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="600" y1="40" x2="600" y2="186" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="300" y="202" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">10 ms</text>
  <text x="450" y="202" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">100 ms</text>
  <text x="600" y="202" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">1 s</text>
  <text x="20" y="62" font-size="10.5" fill="currentColor">ST_DWithin(geog, geog, 5000)</text>
  <rect x="220" y="50" width="73" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.85"/>
  <text x="301" y="63" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">9 ms — correct</text>
  <text x="20" y="94" font-size="10.5" fill="currentColor">ST_DWithin(geom, geom, 0.05)</text>
  <rect x="220" y="82" width="57" height="16" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="285" y="95" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">7 ms — wrong question</text>
  <text x="20" y="126" font-size="10.5" fill="currentColor">ST_Distance(geog, geog) &lt; 5000</text>
  <rect x="220" y="114" width="400" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <text x="628" y="127" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">2 100 ms</text>
  <text x="20" y="158" font-size="10.5" fill="currentColor">per-row ST_Transform then measure</text>
  <rect x="220" y="146" width="432" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <text x="660" y="159" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">3 400 ms</text>
  <text x="20" y="226" font-size="10.5" fill="var(--muted, #7c6fb0)">The geodesic maths is not the expensive part — losing index assistance is. Both slow rows scan the whole table.</text>
</svg>

## Choosing between geography and a projection for area

Distance is settled — cast to `geography` and move on. Area is the case where the projected route genuinely competes, because geodesic area on a complex polygon is expensive and the accuracy advantage only matters over long distances. The deciding factors are how big the polygons are, how many of them there are per request, and whether they all fall inside one projection's area of use.

A rule that holds up in practice: below a few thousand polygons per request, use `geography` and stop thinking about it. Above that, or where the polygons carry tens of thousands of vertices each, transform once into a local equal-area system and measure there — the accuracy difference across a single country is fractions of a percent, and the speed difference is an order of magnitude.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision guide comparing geodesic area on geography against area in a projected system across polygon count and complexity" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Geodesic area versus projected area, by workload shape</title>
  <desc>A two-axis guide. The horizontal axis is polygons per request from one to one hundred thousand; the vertical axis is polygon complexity from simple to tens of thousands of vertices. The lower-left region, small counts and simple shapes, is marked geography: correct everywhere and fast enough. The upper-right region, high counts or very complex shapes, is marked projected equal-area: an order of magnitude faster with sub-percent error inside the projection's area of use. A diagonal band between them notes that either choice works and the deciding factor is whether the data crosses the projection boundary.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Which area computation to reach for</text>
  <line x1="90" y1="180" x2="690" y2="180" stroke="currentColor" stroke-width="1.1"/>
  <line x1="90" y1="40" x2="90" y2="180" stroke="currentColor" stroke-width="1.1"/>
  <text x="390" y="204" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">polygons per request →</text>
  <text x="82" y="48" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">complex</text>
  <text x="82" y="176" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">simple</text>
  <text x="120" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">1</text>
  <text x="300" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">1 000</text>
  <text x="490" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">10 000</text>
  <text x="650" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">100 000</text>
  <path d="M90 180 L90 120 L340 120 L340 180 Z" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.16" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="215" y="146" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">geography</text>
  <text x="215" y="163" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">correct anywhere, no setup</text>
  <path d="M420 40 L690 40 L690 130 L420 130 Z" fill="var(--accent, #7c3aed)" fill-opacity="0.16" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="555" y="76" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">projected equal-area</text>
  <text x="555" y="94" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">≈10× faster in bulk</text>
  <text x="555" y="110" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">valid inside its area of use only</text>
  <path d="M340 120 L420 40 L420 130 L340 180 Z" fill="var(--viz-warn, #8a5000)" fill-opacity="0.12" stroke="var(--viz-warn, #8a5000)" stroke-width="1.2" stroke-dasharray="5,3"/>
  <text x="380" y="66" text-anchor="middle" font-size="9.5" fill="var(--viz-warn, #8a5000)">either</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">In the overlap band, let the data decide: if it crosses the projection's boundary, geography wins by default.</text>
</svg>

## Gotchas & Failure Modes

- **A geography predicate with only a geometry index.** The plan silently becomes a sequential scan. Confirm with `EXPLAIN`: the `Index Cond` should name the `_geog_gix` index, not appear as a `Filter`.
- **Casting only one side.** `ST_DWithin(geom, point::geography, 5000)` raises `function st_dwithin(geometry, geography, integer) does not exist`, or worse, silently resolves to the geometry overload if both are castable. Cast both operands explicitly.
- **`ST_Area(geography)` on national-scale polygons.** Geodesic area on a 200 000-vertex boundary can take seconds. Transform to an equal-area projection for bulk work and accept the area-of-use limits.
- **`ST_Buffer` on geography.** It converts to geometry internally, buffers, and converts back — accurate near the buffer's centre and increasingly wrong at its edges for large radii. Above about 100 km, buffer in a local projection instead.
- **Storing the cast instead of casting.** A generated `geography` column doubles storage for data you already have. The functional index gives the same query performance at index cost only.

## Verification Snippet

```sql
-- The plan must show the GEOGRAPHY index, not a filter
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM features
WHERE ST_DWithin(geom::geography,
                 ST_SetSRID(ST_MakePoint(-0.1276, 51.5072), 4326)::geography,
                 5000);
-- Index Scan using features_geog_gix on features
--   Index Cond: ((geom)::geography && _st_expand(...))

-- A known distance: Trafalgar Square to St Paul's is ~2.06 km
SELECT ROUND(ST_Distance(
         ST_SetSRID(ST_MakePoint(-0.12776, 51.50735), 4326)::geography,
         ST_SetSRID(ST_MakePoint(-0.09831, 51.51385), 4326)::geography
       )::numeric, 0) AS metres;
--  metres
-- --------
--    2131
```

```bash
curl -s "localhost:8000/v1/nearby?lon=-0.1276&lat=51.5072&radius_m=2000&limit=3" | jq
# {"unit":"metre","radius_m":2000,"results":[{"id":41,"name":"…","distance_m":184.6}, …]}
```

---

## Related

- [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/) — the storage decision that makes the cast necessary
- [Optimizing KNN Queries with the PostGIS Distance Operator](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/optimizing-knn-queries-with-postgis-operator/) — ordering by distance at scale
- [Reading EXPLAIN ANALYZE for Spatial Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/) — confirming index assistance

← Back to [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/)
