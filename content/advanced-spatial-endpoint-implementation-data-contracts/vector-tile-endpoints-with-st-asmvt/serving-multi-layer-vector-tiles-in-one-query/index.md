---
layout: layouts/page.njk
title: "Serving Multi-Layer Vector Tiles in One Query"
description: "Pack roads, buildings and labels into a single MVT with one round trip: concatenated ST_AsMVT calls, per-layer zoom rules, and the size budget that keeps the tile drawable."
slug: serving-multi-layer-vector-tiles-in-one-query
type: howto
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Vector Tile Endpoints with ST_AsMVT"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/"
  - label: "Serving Multi-Layer Vector Tiles in One Query"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/serving-multi-layer-vector-tiles-in-one-query/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Serving Multi-Layer Vector Tiles in One Query",
      "description": "Pack roads, buildings and labels into a single MVT with one round trip: concatenated ST_AsMVT calls, per-layer zoom rules, and the size budget that keeps the tile drawable.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/serving-multi-layer-vector-tiles-in-one-query/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "Vector Tile Endpoints with ST_AsMVT", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/" },
        { "@type": "ListItem", "position": 3, "name": "Serving Multi-Layer Vector Tiles in One Query", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/serving-multi-layer-vector-tiles-in-one-query/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Combine Several Layers into One Vector Tile",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Build one CTE per layer", "text": "Give each layer its own CTE with its own filter, zoom rule and attribute list." },
        { "@type": "HowToStep", "position": 2, "name": "Concatenate the protobufs", "text": "MVT is a concatenation of layer messages, so appending the bytea outputs of several ST_AsMVT calls produces a valid multi-layer tile." },
        { "@type": "HowToStep", "position": 3, "name": "Budget the total", "text": "Track the combined size and drop or thin the least important layer first when the tile approaches the practical limit." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Is concatenating ST_AsMVT outputs really valid protobuf?",
          "acceptedAnswer": { "@type": "Answer", "text": "Yes. A Mapbox Vector Tile is a protobuf message whose only repeated field is the layer, and protobuf defines concatenation of messages as equivalent to merging their repeated fields. Appending the bytea results of two ST_AsMVT calls therefore yields a tile containing both layers, which is exactly how every mainstream tile server builds them." }
        },
        {
          "@type": "Question",
          "name": "One request per layer or one request for all layers?",
          "acceptedAnswer": { "@type": "Answer", "text": "One request for all layers, in almost every case. Separate requests multiply the connection count, the round trips and the cache entries by the layer count, and the client cannot render until the slowest arrives anyway. Split only when layers have genuinely different update rates and you want them cached with different lifetimes." }
        },
        {
          "@type": "Question",
          "name": "How many layers can one tile carry?",
          "acceptedAnswer": { "@type": "Answer", "text": "The format imposes no limit; the size budget does. Four to eight layers is typical for a base map. Past that, per-layer overhead — the keys and values dictionaries are duplicated per layer — starts to matter, and the tile becomes hard to keep under 500 kilobytes at dense zoom levels." }
        }
      ]
    }
  ]
}
</script>

← Back to [Vector Tile Endpoints with ST_AsMVT](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/)

# Serving multi-layer vector tiles in one query

This page shows how to return roads, buildings, water and labels as separate named layers inside a single tile response, generated by one database round trip.

## Context & When to Use

A map style refers to layers by name: `road-major`, `building-fill`, `water`. If each of those is its own tile endpoint, a viewport showing nine tiles at four layers issues 36 HTTP requests, opens 36 cache entries, and holds 36 connections open against the pool. The rendering cannot start until the slowest of them lands, so the extra parallelism buys nothing — it only multiplies the fixed costs.

Packing them into one tile removes all of that. The Mapbox Vector Tile format is a protobuf whose top level is a repeated `layer` field, and protobuf message concatenation merges repeated fields. That means `layer_a_bytes || layer_b_bytes` is a valid two-layer tile, with no re-encoding step. PostGIS can produce both halves in one statement, so the whole tile is one query, one connection and one cache key.

Use this for any base map or multi-theme overlay. Keep layers separate only when their update cadences differ enough that you want distinct cache lifetimes — live vehicle positions alongside static parcel boundaries, for instance, where mixing them would force the slow-changing layer to expire at the fast layer's rate. The tile mechanics themselves are covered on the [ST_AsMVT topic page](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/).

## Runnable Implementation

```sql
-- One tile, three named layers, one round trip
WITH bounds AS (
    SELECT ST_TileEnvelope($1, $2, $3)                     AS merc,
           ST_Transform(ST_TileEnvelope($1, $2, $3), 4326) AS wgs
),
roads AS (
    SELECT r.id, r.class_code,
           ST_AsMVTGeom(ST_SimplifyPreserveTopology(ST_Transform(r.geom, 3857),
                        tile_tolerance($1)), b.merc, 4096, 64, true) AS geom
    FROM   roads r CROSS JOIN bounds b
    WHERE  r.geom && b.wgs AND r.min_zoom <= $1
),
buildings AS (
    SELECT bl.id, bl.height_m,
           ST_AsMVTGeom(ST_Transform(bl.geom, 3857),
                        b.merc, 4096, 64, true) AS geom
    FROM   buildings bl CROSS JOIN bounds b
    -- Buildings are meaningless below z13; skip the work entirely
    WHERE  $1 >= 13 AND bl.geom && b.wgs
),
labels AS (
    SELECT l.id, l.name, l.rank,
           ST_AsMVTGeom(ST_Transform(l.geom, 3857),
                        b.merc, 4096, 8, false) AS geom   -- points: no clipping
    FROM   place_labels l CROSS JOIN bounds b
    WHERE  l.geom && b.wgs AND l.rank <= GREATEST($1 - 4, 1)
)
SELECT
    COALESCE((SELECT ST_AsMVT(roads.*,     'road',     4096, 'geom')
              FROM roads     WHERE geom IS NOT NULL), ''::bytea) ||
    COALESCE((SELECT ST_AsMVT(buildings.*, 'building', 4096, 'geom')
              FROM buildings WHERE geom IS NOT NULL), ''::bytea) ||
    COALESCE((SELECT ST_AsMVT(labels.*,    'label',    4096, 'geom')
              FROM labels    WHERE geom IS NOT NULL), ''::bytea) AS mvt;
```

Three details carry the design. Each layer has its own `WHERE` clause, so zoom rules are per layer rather than global. `COALESCE(..., ''::bytea)` makes an empty layer contribute nothing instead of turning the whole expression `NULL`. And the label layer passes `clip_geom = false` with a small buffer, because clipping a point is pointless and a label just outside the tile still needs to exist for collision detection.

<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram showing three layer CTEs each with its own filter, encoded separately and concatenated into one protobuf response" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Three CTEs, three ST_AsMVT calls, one concatenated tile</title>
  <desc>Three parallel branches from a shared bounds CTE. The road branch filters by min_zoom and simplifies, producing a 34 kilobyte layer. The building branch is skipped entirely below zoom 13 and otherwise produces 51 kilobytes. The label branch filters by rank derived from the zoom and does not clip, producing 6 kilobytes. The three bytea results are concatenated with the double-pipe operator into a single 91 kilobyte protobuf, which the renderer reads as three named layers.</desc>
  <rect x="0" y="0" width="720" height="260" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One statement, three layers, one response</text>
  <rect x="16" y="98" width="112" height="52" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="72" y="120" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">bounds CTE</text>
  <text x="72" y="136" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">envelope ×2 systems</text>
  <path d="M128 112 L168 62" stroke="currentColor" stroke-width="1.3" marker-end="url(#mlArr)"/>
  <path d="M128 124 L168 124" stroke="currentColor" stroke-width="1.3" marker-end="url(#mlArr)"/>
  <path d="M128 136 L168 186" stroke="currentColor" stroke-width="1.3" marker-end="url(#mlArr)"/>
  <rect x="170" y="38" width="290" height="48" rx="7" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="184" y="58" font-size="10.5" font-weight="700" fill="currentColor">road</text>
  <text x="184" y="74" font-size="9.5" fill="var(--muted, #7c6fb0)">min_zoom gate · simplify · 64-unit buffer · clipped</text>
  <text x="450" y="66" text-anchor="end" font-size="10.5" font-weight="700" fill="currentColor">34 KB</text>
  <rect x="170" y="100" width="290" height="48" rx="7" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="184" y="120" font-size="10.5" font-weight="700" fill="currentColor">building</text>
  <text x="184" y="136" font-size="9.5" fill="var(--muted, #7c6fb0)">skipped entirely below z13 · clipped</text>
  <text x="450" y="128" text-anchor="end" font-size="10.5" font-weight="700" fill="currentColor">51 KB</text>
  <rect x="170" y="162" width="290" height="48" rx="7" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="184" y="182" font-size="10.5" font-weight="700" fill="currentColor">label</text>
  <text x="184" y="198" font-size="9.5" fill="var(--muted, #7c6fb0)">rank ≤ z−4 · not clipped · 8-unit buffer</text>
  <text x="450" y="190" text-anchor="end" font-size="10.5" font-weight="700" fill="currentColor">6 KB</text>
  <path d="M460 62 L510 112" stroke="currentColor" stroke-width="1.3" marker-end="url(#mlArr)"/>
  <path d="M460 124 L510 124" stroke="currentColor" stroke-width="1.3" marker-end="url(#mlArr)"/>
  <path d="M460 186 L510 136" stroke="currentColor" stroke-width="1.3" marker-end="url(#mlArr)"/>
  <rect x="512" y="96" width="190" height="56" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <text x="607" y="118" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">bytea || bytea || bytea</text>
  <text x="607" y="136" text-anchor="middle" font-size="10" fill="currentColor">91 KB · 3 named layers</text>
  <text x="20" y="238" font-size="10.5" fill="var(--muted, #7c6fb0)">Protobuf concatenation merges repeated fields, so appending encoded layers is the documented way to build the tile.</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">No re-encoding, no intermediate parse, one connection held for one statement.</text>
  <defs>
    <marker id="mlArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

## Key Parameters & Options

| Choice | Recommended | Why |
|---|---|---|
| Layer name in `ST_AsMVT` | matches the style's source-layer | The renderer looks it up by string; a typo silently renders nothing |
| `COALESCE(…, ''::bytea)` | always | One empty layer would otherwise null the entire concatenation |
| Per-layer zoom gate | in the CTE `WHERE` | Skips the scan, not just the encode |
| `clip_geom` | `true` for lines and polygons, `false` for points | Clipping a point can only remove it |
| Buffer | 64 for lines/polygons, 8 for points | Points need only enough room for label collision |
| Layer order | cheap layers first | The statement short-circuits nothing, but the plan reads better and profiles cleanly |

## Budgeting the combined size

The single risk of a combined tile is that the total quietly grows past what a mobile client can decode smoothly. Track it per layer, and thin the layer contributing most before reaching for global simplification.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Stacked bars of combined tile size across five zoom levels, with the practical budget line and the layer that crosses it" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Combined tile size by zoom, per layer</title>
  <desc>Stacked bars for zooms 10 through 16. At zoom 10 the tile is 47 kilobytes, almost all roads. At zoom 12 it is 88 kilobytes. At zoom 13 buildings switch on and the total jumps to 174. At zoom 14 it reaches 232 and at zoom 16 it reaches 470, just under the 500 kilobyte budget line, with buildings contributing the majority. The chart makes clear that the building layer, not roads, is what to thin if the budget is exceeded.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Combined tile size, dense urban column</text>
  <rect x="470" y="14" width="12" height="12" rx="2" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <text x="488" y="25" font-size="10" fill="currentColor">road</text>
  <rect x="534" y="14" width="12" height="12" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <text x="552" y="25" font-size="10" fill="currentColor">building</text>
  <rect x="614" y="14" width="12" height="12" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.6"/>
  <text x="632" y="25" font-size="10" fill="currentColor">label</text>
  <line x1="60" y1="196" x2="700" y2="196" stroke="currentColor" stroke-width="1.1"/>
  <line x1="60" y1="42" x2="60" y2="196" stroke="currentColor" stroke-width="1.1"/>
  <text x="52" y="50" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">500 KB</text>
  <text x="52" y="120" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">250 KB</text>
  <text x="52" y="196" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <line x1="60" y1="46" x2="700" y2="46" stroke="var(--viz-bad, #a32b23)" stroke-width="1.3" stroke-dasharray="6,4"/>
  <text x="694" y="41" text-anchor="end" font-size="9.5" fill="var(--viz-bad, #a32b23)">practical budget</text>
  <rect x="100" y="182" width="52" height="14" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <rect x="100" y="178" width="52" height="4" fill="var(--viz-good, #1f6b3a)" opacity="0.6"/>
  <text x="126" y="212" text-anchor="middle" font-size="10" fill="currentColor">z10</text>
  <text x="126" y="170" text-anchor="middle" font-size="9.5" fill="currentColor">47</text>
  <rect x="212" y="169" width="52" height="27" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <rect x="212" y="164" width="52" height="5" fill="var(--viz-good, #1f6b3a)" opacity="0.6"/>
  <text x="238" y="212" text-anchor="middle" font-size="10" fill="currentColor">z12</text>
  <text x="238" y="156" text-anchor="middle" font-size="9.5" fill="currentColor">88</text>
  <rect x="324" y="166" width="52" height="30" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <rect x="324" y="145" width="52" height="21" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <rect x="324" y="140" width="52" height="5" fill="var(--viz-good, #1f6b3a)" opacity="0.6"/>
  <text x="350" y="212" text-anchor="middle" font-size="10" fill="currentColor">z13</text>
  <text x="350" y="132" text-anchor="middle" font-size="9.5" fill="currentColor">174</text>
  <rect x="436" y="164" width="52" height="32" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <rect x="436" y="122" width="52" height="42" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <rect x="436" y="116" width="52" height="6" fill="var(--viz-good, #1f6b3a)" opacity="0.6"/>
  <text x="462" y="212" text-anchor="middle" font-size="10" fill="currentColor">z14</text>
  <text x="462" y="108" text-anchor="middle" font-size="9.5" fill="currentColor">232</text>
  <rect x="548" y="162" width="52" height="34" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <rect x="548" y="58" width="52" height="104" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <rect x="548" y="50" width="52" height="8" fill="var(--viz-good, #1f6b3a)" opacity="0.6"/>
  <text x="574" y="212" text-anchor="middle" font-size="10" fill="currentColor">z16</text>
  <text x="574" y="42" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">470</text>
  <text x="20" y="238" font-size="10.5" fill="var(--muted, #7c6fb0)">Roads stay flat; buildings drive the growth. Thin the building layer at z16, not the whole tile.</text>
</svg>

## Gotchas & Failure Modes

- **A `NULL` layer nulls the tile.** Without `COALESCE`, a zoom level where one layer is empty returns `NULL` for the whole concatenation and the route sends a blank tile — see [Debugging Empty Vector Tiles](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/debugging-empty-vector-tiles/).
- **Layer names drifting from the style.** The renderer matches `source-layer` by exact string. Keep the names in one constant shared by the SQL and the style, and assert on the decoded layer set in tests.
- **Duplicated attribute dictionaries.** Each layer carries its own keys and values tables, so a shared attribute repeated across six layers is stored six times. Another reason to keep layer counts moderate.
- **One slow layer holding the statement.** The combined query is as slow as its slowest CTE. Profile per layer before assuming the tile is uniformly expensive, and consider [materialized views](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/) for the one that dominates.
- **Cache invalidation across mixed cadences.** A combined tile expires at the shortest lifetime of any layer inside it. If one layer changes every minute, split it out rather than dragging the others down.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of request count, connections and cache entries for one combined tile versus four separate layer endpoints" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Fixed costs of splitting layers across endpoints</title>
  <desc>For a viewport showing nine tiles with four layers, the combined design issues 9 HTTP requests, holds 9 database connections and creates 9 cache entries. The split design issues 36 requests, holds 36 connections and creates 36 cache entries, while the rendered result is identical. Time to first render is 118 milliseconds combined against 260 split, because the client waits for the slowest of four times as many responses.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One viewport, 9 tiles, 4 layers</text>
  <rect x="470" y="14" width="12" height="12" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="488" y="25" font-size="10" fill="currentColor">combined</text>
  <rect x="580" y="14" width="12" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="598" y="25" font-size="10" fill="currentColor">split per layer</text>
  <text x="20" y="62" font-size="10.5" fill="currentColor">HTTP requests</text>
  <rect x="180" y="48" width="60" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="248" y="61" font-size="10" fill="currentColor">9</text>
  <rect x="180" y="66" width="240" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="428" y="79" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">36</text>
  <text x="20" y="112" font-size="10.5" fill="currentColor">DB connections held</text>
  <rect x="180" y="98" width="60" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="248" y="111" font-size="10" fill="currentColor">9</text>
  <rect x="180" y="116" width="240" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="428" y="129" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">36</text>
  <text x="20" y="162" font-size="10.5" fill="currentColor">cache entries created</text>
  <rect x="180" y="148" width="60" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="248" y="161" font-size="10" fill="currentColor">9</text>
  <rect x="180" y="166" width="240" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="428" y="179" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">36</text>
  <text x="20" y="206" font-size="10.5" fill="currentColor">time to first render</text>
  <rect x="180" y="192" width="118" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="306" y="205" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">118 ms</text>
  <rect x="330" y="192" width="260" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="598" y="205" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">260 ms</text>
  <text x="20" y="224" font-size="10" fill="var(--muted, #7c6fb0)">Identical pixels. The split version simply waits for the slowest of four times as many responses.</text>
</svg>

## Deciding what belongs in the same tile

The grouping decision is about change rate and audience, not about what looks tidy in the style file. Two layers belong together when they are always drawn together and change on similar timescales; they belong apart when either of those breaks.

Road geometry and building footprints change monthly at most, are drawn on every request, and share a cache lifetime measured in hours — one tile. Live vehicle positions change every few seconds and would drag that hours-long lifetime down to nothing, so they belong in their own endpoint with its own short `max-age`, layered client-side over the base tile.

Access control is the second splitter. If one layer is public and another requires a scope check, keeping them in the same tile means the tile itself becomes privileged and the public layer stops being cacheable at the edge. Split by sensitivity so the public half can be served from a shared cache and only the restricted half carries a per-caller cache key — the pattern described in [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/).

A useful test when in doubt: if you would ever want to invalidate one layer without the other, they are two tiles.

## Verification Snippet

```python
import mapbox_vector_tile, requests

r = requests.get("http://localhost:8000/v1/tiles/14/8188/5448.mvt")
tile = mapbox_vector_tile.decode(r.content)

assert set(tile) == {"road", "building", "label"}, set(tile)
for name, layer in tile.items():
    print(f"{name:9} {len(layer['features']):5} features  extent={layer['extent']}")
# road       1180 features  extent=4096
# building    842 features  extent=4096
# label        37 features  extent=4096
```

```sql
-- Per-layer byte contribution for one tile, to find what to thin
SELECT 'road' AS layer, octet_length((SELECT ST_AsMVT(r.*, 'road', 4096, 'geom') FROM roads r)) AS bytes
UNION ALL
SELECT 'building', octet_length((SELECT ST_AsMVT(b.*, 'building', 4096, 'geom') FROM buildings b));
```

---

## Related

- [Vector Tile Endpoints with ST_AsMVT](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/) — the single-layer query this extends
- [Simplifying Geometry Per Zoom Level for Vector Tiles](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/simplifying-geometry-per-zoom-level-for-vector-tiles/) — the tolerance each layer applies
- [Cloudflare Workers Edge Routing for Vector Tile Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/cloudflare-workers-edge-routing-for-vector-tile-endpoints/) — serving the combined tile from the edge

← Back to [Vector Tile Endpoints with ST_AsMVT](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/)
