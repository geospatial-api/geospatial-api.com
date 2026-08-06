---
layout: layouts/page.njk
title: "Simplifying Geometry Per Zoom Level for Vector Tiles"
description: "Derive a simplification tolerance from the zoom level, keep polygon topology valid, and cut low-zoom tile payloads by 80% without visible change on screen."
slug: simplifying-geometry-per-zoom-level-for-vector-tiles
type: howto
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Vector Tile Endpoints with ST_AsMVT"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/"
  - label: "Simplifying Geometry Per Zoom Level"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/simplifying-geometry-per-zoom-level-for-vector-tiles/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Simplifying Geometry Per Zoom Level for Vector Tiles",
      "description": "Derive a simplification tolerance from the zoom level, keep polygon topology valid, and cut low-zoom tile payloads by 80% without visible change on screen.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/simplifying-geometry-per-zoom-level-for-vector-tiles/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "Vector Tile Endpoints with ST_AsMVT", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/" },
        { "@type": "ListItem", "position": 3, "name": "Simplifying Geometry Per Zoom Level", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/simplifying-geometry-per-zoom-level-for-vector-tiles/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Scale Vector Tile Detail to the Zoom Level",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Derive the tolerance", "text": "Compute the ground size of one tile unit at this zoom and use a small multiple of it as the simplification tolerance." },
        { "@type": "HowToStep", "position": 2, "name": "Simplify before clipping", "text": "Apply ST_SimplifyPreserveTopology to the projected geometry before it reaches ST_AsMVTGeom." },
        { "@type": "HowToStep", "position": 3, "name": "Guard validity", "text": "Repair invalid input on write so the topology-preserving simplifier never raises mid-tile." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why use ST_SimplifyPreserveTopology instead of ST_Simplify?",
          "acceptedAnswer": { "@type": "Answer", "text": "ST_Simplify runs Douglas-Peucker with no validity guarantee, so it can collapse a narrow polygon into a self-intersecting ring or drop a hole entirely. ST_SimplifyPreserveTopology never produces an invalid result and never removes a component, at roughly 20 to 40 percent more CPU. For anything rendered as a filled polygon, the guarantee is worth the cost." }
        },
        {
          "@type": "Question",
          "name": "Should simplification happen at request time or be precomputed?",
          "acceptedAnswer": { "@type": "Answer", "text": "Request time is right while the data changes and the traffic is moderate, because there is nothing to invalidate. Precompute into per-zoom-band columns or tables when the same low zoom levels are requested constantly and the source geometry is stable — you are then trading storage and a refresh job for CPU on every tile." }
        },
        {
          "@type": "Question",
          "name": "Does simplifying change the tile's visual output?",
          "acceptedAnswer": { "@type": "Answer", "text": "Not if the tolerance is derived from the tile grid. A tolerance of two tile units is by definition below what the 4096-unit grid can express, so the removed vertices would have been quantised away anyway. Visible change only appears when the tolerance is set from a fixed distance in metres rather than from the zoom." }
        }
      ]
    }
  ]
}
</script>

← Back to [Vector Tile Endpoints with ST_AsMVT](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/)

# Simplifying geometry per zoom level for vector tiles

This page shows how to compute a simplification tolerance from the requested zoom level so low-zoom tiles stop shipping vertices that no screen can resolve.

## Context & When to Use

A parcel boundary surveyed to centimetre accuracy might carry 340 vertices. At zoom 14 the whole parcel occupies perhaps 60 pixels and maybe 30 of those vertices are distinguishable. At zoom 8 the parcel is smaller than a single pixel and every vertex is waste — but the query still reads them, `ST_AsMVTGeom` still clips them, and the protobuf still encodes them. Across a dense tile this is the difference between a 690 KB payload and a 148 KB one, as measured on the [ST_AsMVT topic page](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/).

The insight that makes simplification safe is that a vector tile already has a resolution limit. `ST_AsMVTGeom` quantises coordinates onto a 4096-unit grid, so any detail finer than one tile unit is discarded regardless. Choosing a tolerance of one or two tile units therefore removes only information the format was going to throw away — the output is byte-for-byte smaller and pixel-for-pixel identical.

Apply this on every tile route that serves polygons or lines. Point layers need no simplification, since a point has one vertex; they need the feature-count controls covered under attribute budgeting instead. If your tiles are pre-rendered rather than generated per request, the same tolerance formula belongs in the generation job.

## Runnable Implementation

```sql
-- Ground size of one tile unit at a zoom level, in Web Mercator metres.
-- 40075016.6855785 m is the equatorial circumference; 4096 is the MVT extent.
CREATE OR REPLACE FUNCTION tile_tolerance(z integer, units double precision DEFAULT 2)
RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT 40075016.6855785 / (2 ^ GREATEST(z, 0)) / 4096 * units;
$$;

-- Tile query with zoom-derived simplification applied BEFORE clipping
WITH bounds AS (
    SELECT ST_TileEnvelope($1, $2, $3)                     AS merc,
           ST_Transform(ST_TileEnvelope($1, $2, $3), 4326) AS wgs
),
tile AS (
    SELECT f.id,
           f.category_code,
           ST_AsMVTGeom(
               ST_SimplifyPreserveTopology(
                   ST_Transform(f.geom, 3857),
                   tile_tolerance($1)          -- 2 tile units at this zoom
               ),
               b.merc, 4096, 64, true
           ) AS geom
    FROM   features f
    CROSS  JOIN bounds b
    WHERE  f.geom && b.wgs
      AND  f.min_zoom <= $1
)
SELECT ST_AsMVT(tile.*, 'features', 4096, 'geom') AS mvt
FROM   tile
WHERE  geom IS NOT NULL;
```

At zoom 14 that tolerance is about 1.2 m; at zoom 10, 19 m; at zoom 6, 306 m. Those are exactly the distances below which the tile grid cannot represent a difference, which is why the visual result is unchanged.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Illustration of the same coastline outline rendered at three tolerances, showing vertex count falling while the visible shape stays the same" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The same outline at three zoom-derived tolerances</title>
  <desc>Three copies of a coastline polygon. The first, at full detail, carries 340 vertices and is 11.4 kilobytes. The second, simplified with a zoom-14 tolerance of 1.2 metres, carries 96 vertices and is 3.2 kilobytes, and its outline is visually identical. The third, simplified with a zoom-8 tolerance of 153 metres, carries 14 vertices and is 0.5 kilobytes, and at that zoom the shape occupies only a few pixels so the loss is invisible on screen.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One outline, three tolerances — and what the screen can show</text>
  <text x="120" y="52" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">source</text>
  <path d="M50 150 L58 128 L66 138 L74 112 L82 124 L90 100 L100 116 L110 92 L120 108 L130 86 L142 104 L154 82 L166 98 L178 80 L188 96 L190 150 Z" fill="var(--accent, #7c3aed)" fill-opacity="0.18" stroke="var(--accent, #7c3aed)" stroke-width="1.6"/>
  <text x="120" y="176" text-anchor="middle" font-size="10" fill="currentColor">340 vertices · 11.4 KB</text>
  <text x="120" y="192" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">tolerance 0</text>
  <text x="360" y="52" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">z14 · 1.2 m</text>
  <path d="M290 150 L300 122 L316 106 L330 96 L348 88 L366 92 L384 82 L400 92 L420 84 L430 150 Z" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.18" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <text x="360" y="176" text-anchor="middle" font-size="10" fill="currentColor">96 vertices · 3.2 KB</text>
  <text x="360" y="192" text-anchor="middle" font-size="9.5" fill="var(--viz-good, #1f6b3a)">visually identical</text>
  <text x="590" y="52" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">z8 · 153 m</text>
  <path d="M520 150 L540 112 L580 88 L630 92 L660 150 Z" fill="var(--viz-warn, #8a5000)" fill-opacity="0.18" stroke="var(--viz-warn, #8a5000)" stroke-width="1.6"/>
  <text x="590" y="176" text-anchor="middle" font-size="10" fill="currentColor">14 vertices · 0.5 KB</text>
  <text x="590" y="192" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">at z8 this is ~3 px wide</text>
  <line x1="20" y1="206" x2="700" y2="206" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="228" font-size="10.5" fill="var(--muted, #7c6fb0)">Detail is only waste relative to a display scale — the same third shape at zoom 14 would be an obvious error.</text>
  <text x="20" y="244" font-size="10.5" fill="var(--muted, #7c6fb0)">That is the entire argument for deriving tolerance from zoom rather than fixing it.</text>
</svg>

## Key Parameters & Options

| Parameter | Typical | Effect |
|---|---|---|
| `units` in `tile_tolerance` | `2` | Multiples of one tile unit. 1 is conservative, 2 is the sweet spot, 4 starts to be visible on straight edges |
| `ST_SimplifyPreserveTopology` | always for polygons | Guarantees valid output; never drops a ring or a hole |
| `ST_Simplify` | lines only, if at all | Faster but can self-intersect; acceptable for unfilled linework |
| `ST_SimplifyVW` | alternative | Visvalingam-Whyatt; better on sinuous natural features, ~2× slower |
| Simplify position | before `ST_AsMVTGeom` | Simplifying afterwards works on tile units and undoes the clip buffer |
| `min_zoom` gating | per feature | Removes whole features rather than vertices — the bigger win at low zoom |

Order matters more than the exact tolerance. Simplifying after clipping operates on already-quantised coordinates, gains almost nothing, and can pull vertices out of the buffer zone that keeps features continuous across tile seams.

## Where the CPU actually goes

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Stacked timing bars for tile generation with and without simplification at zoom 8 and zoom 14" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Tile generation time with and without zoom-derived simplification</title>
  <desc>Four stacked bars. At zoom 8 without simplification the tile takes 210 milliseconds, split into 12 for the index scan, 138 for clipping and 60 for encoding. At zoom 8 with simplification it takes 74 milliseconds: 12 scan, 22 simplify, 28 clip, 12 encode — the simplifier costs 22 but saves 116 downstream. At zoom 14 without simplification the tile takes 23 milliseconds and with simplification 26, so at high zoom the work is slightly wasted and the tolerance falls below the data resolution anyway.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Median tile generation, dense parcel layer</text>
  <rect x="440" y="14" width="12" height="12" rx="2" fill="var(--accent, #7c3aed)" opacity="0.8"/>
  <text x="458" y="25" font-size="10" fill="currentColor">scan</text>
  <rect x="500" y="14" width="12" height="12" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="518" y="25" font-size="10" fill="currentColor">simplify</text>
  <rect x="574" y="14" width="12" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.65"/>
  <text x="592" y="25" font-size="10" fill="currentColor">clip</text>
  <rect x="628" y="14" width="12" height="12" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <text x="646" y="25" font-size="10" fill="currentColor">encode</text>
  <text x="20" y="62" font-size="10.5" fill="currentColor">z8 · none</text>
  <rect x="140" y="48" width="30" height="20" fill="var(--accent, #7c3aed)" opacity="0.8"/>
  <rect x="170" y="48" width="345" height="20" fill="var(--viz-bad, #a32b23)" opacity="0.65"/>
  <rect x="515" y="48" width="150" height="20" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <text x="672" y="63" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">210 ms</text>
  <text x="20" y="102" font-size="10.5" fill="currentColor">z8 · derived</text>
  <rect x="140" y="88" width="30" height="20" fill="var(--accent, #7c3aed)" opacity="0.8"/>
  <rect x="170" y="88" width="55" height="20" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="225" y="88" width="70" height="20" fill="var(--viz-bad, #a32b23)" opacity="0.65"/>
  <rect x="295" y="88" width="30" height="20" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <text x="333" y="103" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">74 ms — 2.8× faster</text>
  <line x1="20" y1="124" x2="700" y2="124" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="152" font-size="10.5" fill="currentColor">z14 · none</text>
  <rect x="140" y="138" width="22" height="20" fill="var(--accent, #7c3aed)" opacity="0.8"/>
  <rect x="162" y="138" width="34" height="20" fill="var(--viz-bad, #a32b23)" opacity="0.65"/>
  <rect x="196" y="138" width="20" height="20" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <text x="224" y="153" font-size="10" font-weight="700" fill="currentColor">23 ms</text>
  <text x="20" y="192" font-size="10.5" fill="currentColor">z14 · derived</text>
  <rect x="140" y="178" width="22" height="20" fill="var(--accent, #7c3aed)" opacity="0.8"/>
  <rect x="162" y="178" width="16" height="20" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <rect x="178" y="178" width="30" height="20" fill="var(--viz-bad, #a32b23)" opacity="0.65"/>
  <rect x="208" y="178" width="18" height="20" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <text x="234" y="193" font-size="10" fill="var(--muted, #7c6fb0)">26 ms — slightly worse, harmless</text>
  <text x="20" y="226" font-size="10.5" fill="var(--muted, #7c6fb0)">Simplification pays for itself at low zoom by shrinking the clip stage; at high zoom it is a rounding error either way.</text>
</svg>

Because the cost is concentrated where the benefit is, there is no need to switch simplification off above a zoom threshold — the formula already makes it a no-op when the tolerance falls under the data's own resolution.

## Gotchas & Failure Modes

- **`ERROR: TopologyException: found non-noded intersection`** — `ST_SimplifyPreserveTopology` was handed geometry that was already invalid. Repair at write time with `ST_MakeValid`, not per tile; the validation approach in [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) stops most of it earlier.
- **Tolerance expressed in degrees.** If the geometry has not been transformed to 3857 before simplifying, the tolerance is in degrees and a value of 19 flattens whole countries. Transform first, always.
- **Sliver polygons collapsing.** Very thin features — a road casing, a river polygon — can shrink below the tolerance and disappear. Gate them with `min_zoom` so they are removed deliberately rather than as a side effect.
- **Simplify inside a subquery the planner reruns.** Wrapping the call so it is evaluated per output row rather than once per feature multiplies the cost. Keep it in a single CTE stage as shown.
- **Cached tiles keyed without the tolerance.** If the multiplier is tuned later, previously cached tiles keep the old geometry. Put a tile-format version in the cache key — see [Caching Vector Tiles at the Edge with Cache-Control](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/).
- **Assuming smaller is always better.** Beyond about four tile units the simplification becomes visible as flattened corners on buildings and straightened curves on roads. Two is a good default; verify by eye before raising it.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Table of tolerance in metres and its relation to one tile unit across six zoom levels" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What the derived tolerance works out to at each zoom</title>
  <desc>Six zoom levels with the ground size of one tile unit and the resulting two-unit tolerance. At zoom 6 one unit is 153 metres and the tolerance 306. At zoom 8, 38 and 77. At zoom 10, 9.6 and 19. At zoom 12, 2.4 and 4.8. At zoom 14, 0.6 and 1.2. At zoom 16, 0.15 and 0.3. A note marks that from zoom 15 the tolerance drops below typical survey accuracy, so simplification becomes a no-op automatically without needing a threshold in the code.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Derived tolerance by zoom level</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="40" y="58" font-size="10.5" font-weight="700" fill="currentColor">zoom</text>
  <text x="150" y="58" font-size="10.5" font-weight="700" fill="currentColor">1 tile unit</text>
  <text x="300" y="58" font-size="10.5" font-weight="700" fill="currentColor">tolerance (2 units)</text>
  <text x="480" y="58" font-size="10.5" font-weight="700" fill="currentColor">what it removes</text>
  <text x="40" y="86" font-size="10.5" fill="currentColor">6</text>
  <text x="150" y="86" font-size="10.5" fill="currentColor">153 m</text>
  <text x="300" y="86" font-size="10.5" font-weight="700" fill="currentColor">306 m</text>
  <text x="480" y="86" font-size="10" fill="var(--muted, #7c6fb0)">whole buildings, minor road bends</text>
  <line x1="20" y1="96" x2="700" y2="96" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="40" y="114" font-size="10.5" fill="currentColor">8</text>
  <text x="150" y="114" font-size="10.5" fill="currentColor">38 m</text>
  <text x="300" y="114" font-size="10.5" font-weight="700" fill="currentColor">77 m</text>
  <text x="480" y="114" font-size="10" fill="var(--muted, #7c6fb0)">building detail, kerb lines</text>
  <line x1="20" y1="124" x2="700" y2="124" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="40" y="142" font-size="10.5" fill="currentColor">10</text>
  <text x="150" y="142" font-size="10.5" fill="currentColor">9.6 m</text>
  <text x="300" y="142" font-size="10.5" font-weight="700" fill="currentColor">19 m</text>
  <text x="480" y="142" font-size="10" fill="var(--muted, #7c6fb0)">parcel corners</text>
  <line x1="20" y1="152" x2="700" y2="152" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="40" y="170" font-size="10.5" fill="currentColor">12</text>
  <text x="150" y="170" font-size="10.5" fill="currentColor">2.4 m</text>
  <text x="300" y="170" font-size="10.5" font-weight="700" fill="currentColor">4.8 m</text>
  <text x="480" y="170" font-size="10" fill="var(--muted, #7c6fb0)">survey noise</text>
  <line x1="20" y1="180" x2="700" y2="180" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="40" y="198" font-size="10.5" fill="currentColor">14 · 16</text>
  <text x="150" y="198" font-size="10.5" fill="currentColor">0.6 · 0.15 m</text>
  <text x="300" y="198" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">1.2 · 0.3 m</text>
  <text x="480" y="198" font-size="10" fill="var(--viz-good, #1f6b3a)">below survey accuracy — a no-op</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">The formula switches itself off at high zoom, so no threshold is needed in the query.</text>
</svg>

## When to precompute instead

Request-time simplification is the right default because there is nothing to keep in sync. It stops being right when the same low-zoom tiles are requested constantly against stable data — a country-level overview that thousands of users load on every session, over boundaries that change once a year.

At that point the arithmetic flips. Simplifying 60 000 vertices on every request to produce the same 14-vertex output is work you can do once. Materialise a per-zoom-band geometry column, populate it in the job that refreshes the source, and have the tile query select the column matching the requested band:

```sql
ALTER TABLE features
  ADD COLUMN geom_z6  geometry(MultiPolygon, 3857),
  ADD COLUMN geom_z10 geometry(MultiPolygon, 3857);

UPDATE features SET
  geom_z6  = ST_SimplifyPreserveTopology(ST_Transform(geom, 3857), tile_tolerance(6)),
  geom_z10 = ST_SimplifyPreserveTopology(ST_Transform(geom, 3857), tile_tolerance(10));
```

Two bands are usually enough: one for the overview zooms and one for the middle range, with the high zooms reading the source geometry directly. The cost is storage — roughly 15 % of the source column for a z6 band and 40 % for z10 — plus the discipline of refreshing them whenever the geometry changes. Treat a stale band as a correctness bug, not a cosmetic one, and refresh it in the same transaction that writes the source.

## Verification Snippet

```sql
-- Vertex count and payload before and after, same tile
WITH b AS (SELECT ST_TileEnvelope(8, 127, 84) AS merc,
                  ST_Transform(ST_TileEnvelope(8, 127, 84), 4326) AS wgs)
SELECT sum(ST_NPoints(ST_Transform(f.geom, 3857)))                AS vertices_raw,
       sum(ST_NPoints(ST_SimplifyPreserveTopology(
             ST_Transform(f.geom, 3857), tile_tolerance(8))))     AS vertices_simplified
FROM   features f, b
WHERE  f.geom && b.wgs;
--  vertices_raw | vertices_simplified
-- --------------+---------------------
--       418 022 |              62 118
```

```bash
# Byte-level confirmation on the live route
curl -s -o /dev/null -w '%{size_download}\n' localhost:8000/v1/tiles/8/127/84.mvt
# 151392
```

---

## Related

- [Vector Tile Endpoints with ST_AsMVT](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/) — the full tile query this tolerance plugs into
- [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — precomputing tiles when request-time simplification is not enough
- [Materialized Views for Spatial Aggregations](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/) — the answer for zoom levels simplification cannot rescue

← Back to [Vector Tile Endpoints with ST_AsMVT](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/)
