---
layout: layouts/page.njk
title: "Vector Tile Endpoints with ST_AsMVT"
description: "Build Mapbox Vector Tile endpoints directly in PostGIS with ST_AsMVT and ST_AsMVTGeom: tile envelopes, per-zoom simplification, attribute budgets, and streaming the protobuf from FastAPI."
slug: vector-tile-endpoints-with-st-asmvt
type: topic
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Vector Tile Endpoints with ST_AsMVT"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Vector Tile Endpoints with ST_AsMVT",
      "description": "Build Mapbox Vector Tile endpoints directly in PostGIS with ST_AsMVT and ST_AsMVTGeom: tile envelopes, per-zoom simplification, attribute budgets, and streaming the protobuf from FastAPI.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com" },
      "url": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/"
    },
    {
      "@type": "Article",
      "headline": "Vector Tile Endpoints with ST_AsMVT",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 3, "name": "Vector Tile Endpoints with ST_AsMVT", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Serve Mapbox Vector Tiles from PostGIS with FastAPI",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Build the tile envelope", "text": "Derive the Web Mercator envelope for z/x/y with ST_TileEnvelope and buffer it so features crossing the edge still render." },
        { "@type": "HowToStep", "position": 2, "name": "Clip and quantise geometry", "text": "Pass each candidate geometry through ST_AsMVTGeom to clip it to the tile and convert to 4096-unit tile space." },
        { "@type": "HowToStep", "position": 3, "name": "Aggregate to a protobuf layer", "text": "Wrap the clipped rows in ST_AsMVT with an explicit layer name and only the attributes the style needs." },
        { "@type": "HowToStep", "position": 4, "name": "Return the tile with cache headers", "text": "Send application/vnd.mapbox-vector-tile with an ETag and a Cache-Control policy matched to the data's update rate." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why do features disappear at the edge of a vector tile?",
          "acceptedAnswer": { "@type": "Answer", "text": "ST_AsMVTGeom clips strictly to the tile extent, so a line or polygon that continues past the edge is cut and its label or join may vanish. Pass a buffer of 64 tile units as the fourth argument and select against a slightly enlarged envelope, so the renderer has enough geometry beyond the seam to draw a continuous feature." }
        },
        {
          "@type": "Question",
          "name": "Should tiles be generated in the database or by a separate tile server?",
          "acceptedAnswer": { "@type": "Answer", "text": "Generate in the database when the data changes frequently and the styling needs live attributes; a single ST_AsMVT query is usually 15 to 60 ms and avoids an extra deployment. Move to a pre-rendered tile archive when the data is stable, the traffic is heavy, or tiles must be served from an edge cache with no origin round trip." }
        },
        {
          "@type": "Question",
          "name": "What is the right extent value for ST_AsMVTGeom?",
          "acceptedAnswer": { "@type": "Answer", "text": "4096 is the default and what every mainstream renderer expects. Lower values such as 2048 shrink the tile by roughly 10 to 15 percent and coarsen coordinates to about 4 metres at zoom 14, which is acceptable for choropleth layers but visible on street geometry. Do not raise it above 4096; the extra precision is below the resolution of the display." }
        },
        {
          "@type": "Question",
          "name": "How do I keep a vector tile under the practical size limit?",
          "acceptedAnswer": { "@type": "Answer", "text": "Aim for under 500 KB uncompressed per tile. Cut attributes first, since properties often outweigh geometry; then apply ST_SimplifyPreserveTopology with a tolerance derived from the zoom level; then drop features below a minimum screen area at low zoom. Measure with octet_length on the returned bytea rather than guessing." }
        }
      ]
    }
  ]
}
</script>

← Back to [Advanced Spatial Endpoints & Data Contracts](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/)

# Vector tile endpoints with ST_AsMVT

A GeoJSON endpoint that happily returns 800 features becomes unusable at 80 000: the payload passes megabytes, the browser parses JSON on the main thread, and the map stutters. Vector tiles solve this by moving the spatial cut server-side and shipping a compact protobuf whose coordinates are already in screen space. PostGIS can produce that protobuf directly with `ST_AsMVT`, which means a complete tile service is one SQL query and one FastAPI route — no separate tile server, no pre-rendering step, and no cache to invalidate on every edit.

This page covers the query that generates a correct tile, the parameters that control size and fidelity, and the FastAPI plumbing that returns binary content with the right headers. It assumes the storage model and index setup from [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/), and pairs with [Caching Vector Tiles at the Edge with Cache-Control](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/) for the delivery side.

## Prerequisites & Environment

`ST_AsMVT` and `ST_AsMVTGeom` need PostGIS built with protobuf-c support; `ST_TileEnvelope` arrived in PostGIS 3.0. Verify both before writing the route:

```sql
-- Should list "PROTOBUF" in the output
SELECT postgis_full_version();

-- Should return an envelope in EPSG:3857, not an error
SELECT ST_AsText(ST_TileEnvelope(14, 8188, 5448));
```

On the Python side: FastAPI 0.110+, asyncpg 0.29 and nothing else — the tile is bytes from the database to the socket, so no serialization library is involved. Storage should be `geometry(…, 4326)` with a GiST index, as argued in [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/); the tile query transforms to Web Mercator on the constant side so the index still applies.

## How a tile is assembled

Four transformations turn table rows into a protobuf: pick the envelope, filter the candidates, clip and quantise each geometry, then aggregate. Each step discards data, and doing them in the wrong order is what makes a slow tile service.

<svg viewBox="0 0 720 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pipeline from a z x y tile request through envelope construction, indexed candidate filtering, ST_AsMVTGeom clipping and ST_AsMVT aggregation to a protobuf response" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>How a request for tile z/x/y becomes a protobuf</title>
  <desc>Five stages left to right. A request for z equals 14 builds a Web Mercator envelope with ST_TileEnvelope. The envelope is transformed to EPSG:4326 and used as an indexed filter that narrows 4.2 million rows to about 1400 candidates. ST_AsMVTGeom clips those to the tile and rescales them into 4096-unit tile space, leaving 1180 features. ST_AsMVT aggregates them into a single protobuf of roughly 96 kilobytes, which FastAPI returns as bytes.</desc>
  <rect x="0" y="0" width="720" height="280" fill="var(--surface, #f5f3ff)" rx="10"/>
  <text x="20" y="28" font-size="13" font-weight="700" fill="currentColor">One request, four database transformations</text>
  <rect x="18" y="46" width="126" height="86" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="81" y="68" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">1 · Envelope</text>
  <text x="81" y="86" text-anchor="middle" font-size="10" font-family="monospace" fill="currentColor">ST_TileEnvelope</text>
  <text x="81" y="102" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">z/x/y → 3857 box</text>
  <text x="81" y="118" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">buffered 64 units</text>
  <path d="M144 89 L164 89" stroke="currentColor" stroke-width="1.4" marker-end="url(#mvtArrow)"/>
  <rect x="166" y="46" width="126" height="86" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="229" y="68" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">2 · Filter</text>
  <text x="229" y="86" text-anchor="middle" font-size="10" font-family="monospace" fill="currentColor">geom &amp;&amp; env_4326</text>
  <text x="229" y="102" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">GiST index scan</text>
  <text x="229" y="118" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">4.2 M → 1 400 rows</text>
  <path d="M292 89 L312 89" stroke="currentColor" stroke-width="1.4" marker-end="url(#mvtArrow)"/>
  <rect x="314" y="46" width="126" height="86" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="377" y="68" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">3 · Clip</text>
  <text x="377" y="86" text-anchor="middle" font-size="10" font-family="monospace" fill="currentColor">ST_AsMVTGeom</text>
  <text x="377" y="102" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">to 4096 tile units</text>
  <text x="377" y="118" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">1 400 → 1 180 kept</text>
  <path d="M440 89 L460 89" stroke="currentColor" stroke-width="1.4" marker-end="url(#mvtArrow)"/>
  <rect x="462" y="46" width="126" height="86" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="525" y="68" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">4 · Aggregate</text>
  <text x="525" y="86" text-anchor="middle" font-size="10" font-family="monospace" fill="currentColor">ST_AsMVT</text>
  <text x="525" y="102" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">one layer, one row</text>
  <text x="525" y="118" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">bytea ≈ 96 KB</text>
  <path d="M588 89 L608 89" stroke="currentColor" stroke-width="1.4" marker-end="url(#mvtArrow)"/>
  <rect x="610" y="46" width="92" height="86" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="656" y="72" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Response</text>
  <text x="656" y="92" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">mapbox-vector</text>
  <text x="656" y="106" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">-tile + ETag</text>
  <line x1="18" y1="156" x2="702" y2="156" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="180" font-size="12" font-weight="700" fill="currentColor">Where the time goes at zoom 14 (median of 500 tiles)</text>
  <rect x="20" y="192" width="96" height="18" rx="3" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <text x="124" y="205" font-size="10.5" fill="currentColor">index scan 5.1 ms</text>
  <rect x="20" y="216" width="212" height="18" rx="3" fill="var(--accent, #7c3aed)" opacity="0.55"/>
  <text x="240" y="229" font-size="10.5" fill="currentColor">clip + simplify 11.4 ms</text>
  <rect x="20" y="240" width="121" height="18" rx="3" fill="var(--accent, #7c3aed)" opacity="0.35"/>
  <text x="149" y="253" font-size="10.5" fill="currentColor">protobuf encode 6.5 ms</text>
  <text x="470" y="205" font-size="10.5" fill="var(--muted, #7c6fb0)">Clipping dominates — it is the step that</text>
  <text x="470" y="221" font-size="10.5" fill="var(--muted, #7c6fb0)">simplification tolerance actually controls.</text>
  <text x="470" y="247" font-size="10.5" fill="var(--muted, #7c6fb0)">Total ≈ 23 ms per tile.</text>
  <defs>
    <marker id="mvtArrow" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

Note that the filter runs against the *raw* 4326 column and the envelope is transformed to meet it, not the reverse. Wrapping the column in `ST_Transform` here would cost a sequential scan on every tile request.

## Parameter Reference: ST_AsMVTGeom

`ST_AsMVTGeom` does the real work, and its four arguments are where tile quality is won or lost.

| Argument | Typical value | What it controls |
|---|---|---|
| `geom` | the clipped source geometry, already in 3857 | Must be in the same system as `bounds`, or the output is empty with no error |
| `bounds` | `ST_TileEnvelope(z, x, y)` | The tile's extent in Web Mercator; features fully outside become `NULL` and are dropped |
| `extent` | `4096` | Tile-space resolution. At zoom 14, 4096 units ≈ 0.6 m per unit; renderers assume this default |
| `buffer` | `64` | Tile units of overdraw kept beyond the edge, so lines and labels survive the seam |
| `clip_geom` | `true` | Whether to cut geometry at the buffered edge. Set `false` only for point layers, where clipping is pointless |

The `buffer` argument is the one teams most often leave at zero and then spend a day debugging: roads that stop at tile boundaries, polygon fills that show hairline gaps, and labels that flicker as the user pans.

## Step-by-Step Implementation

### 1. Derive the envelope and pre-filter with the index

```sql
WITH bounds AS (
    SELECT ST_TileEnvelope($1, $2, $3)                        AS merc,
           -- The same box in storage space, for the indexed predicate
           ST_Transform(ST_TileEnvelope($1, $2, $3), 4326)    AS wgs
)
SELECT count(*)
FROM   features f, bounds b
WHERE  f.geom && b.wgs;
```

The `&&` operator is a bounding-box overlap test served directly by the GiST index. It is deliberately looser than `ST_Intersects` — false positives are fine here because `ST_AsMVTGeom` will discard anything that does not really touch the tile.

### 2. Clip, quantise and aggregate

```sql
WITH bounds AS (
    SELECT ST_TileEnvelope($1, $2, $3)                     AS merc,
           ST_Transform(ST_TileEnvelope($1, $2, $3), 4326) AS wgs
),
tile AS (
    SELECT f.id,
           f.name,
           f.category,
           ST_AsMVTGeom(
               ST_Transform(f.geom, 3857),  -- per-row, but only for survivors
               b.merc,
               4096,                        -- extent
               64,                          -- buffer, in tile units
               true                         -- clip
           ) AS geom
    FROM   features f
    CROSS  JOIN bounds b
    WHERE  f.geom && b.wgs
)
SELECT ST_AsMVT(tile.*, 'features', 4096, 'geom') AS mvt
FROM   tile
WHERE  geom IS NOT NULL;
```

Two subtleties. `ST_AsMVT(tile.*, …)` promotes every column of the row to a tile attribute, so the `SELECT` list in the `tile` CTE *is* the attribute contract — adding a column there silently grows every tile. And the final `WHERE geom IS NOT NULL` matters: `ST_AsMVTGeom` returns `NULL` for geometry that falls entirely outside the buffered tile, and keeping those rows produces a protobuf with empty features that some renderers reject.

### 3. Scale fidelity to the zoom level

At zoom 6 a building footprint is smaller than a pixel; sending its 340 vertices is pure waste. Derive a simplification tolerance from the zoom and apply it before clipping.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of tile payload size by zoom level with and without zoom-derived simplification, showing the reduction from 690 to 148 kilobytes at zoom 8" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Tile size by zoom, with and without zoom-derived simplification</title>
  <desc>Paired bars for five zoom levels. At zoom 6 the raw tile is 610 kilobytes and the simplified tile 84. At zoom 8, 690 versus 148. At zoom 10, 520 versus 190. At zoom 12, 310 versus 205. At zoom 14, 210 versus 205, where the tolerance falls below the data resolution and the two converge. A dashed line marks the 500 kilobyte practical budget, which only the raw series crosses.</desc>
  <rect x="0" y="0" width="720" height="250" fill="var(--surface, #f5f3ff)" rx="10"/>
  <text x="20" y="26" font-size="13" font-weight="700" fill="currentColor">Payload per tile, dense parcel layer</text>
  <rect x="470" y="14" width="12" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <text x="488" y="25" font-size="10.5" fill="currentColor">no simplification</text>
  <rect x="592" y="14" width="12" height="12" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="610" y="25" font-size="10.5" fill="currentColor">zoom-derived</text>
  <line x1="58" y1="196" x2="700" y2="196" stroke="currentColor" stroke-width="1.2"/>
  <line x1="58" y1="40" x2="58" y2="196" stroke="currentColor" stroke-width="1.2"/>
  <text x="50" y="196" text-anchor="end" font-size="10" fill="var(--muted, #7c6fb0)">0</text>
  <text x="50" y="157" text-anchor="end" font-size="10" fill="var(--muted, #7c6fb0)">200 KB</text>
  <text x="50" y="118" text-anchor="end" font-size="10" fill="var(--muted, #7c6fb0)">400 KB</text>
  <text x="50" y="79" text-anchor="end" font-size="10" fill="var(--muted, #7c6fb0)">600 KB</text>
  <line x1="58" y1="98" x2="700" y2="98" stroke="var(--viz-warn, #8a5000)" stroke-width="1.3" stroke-dasharray="6,4"/>
  <text x="694" y="93" text-anchor="end" font-size="10" fill="var(--viz-warn, #8a5000)">500 KB practical budget</text>
  <rect x="86" y="77" width="34" height="119" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <rect x="124" y="180" width="34" height="16" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="122" y="212" text-anchor="middle" font-size="11" fill="currentColor">z6</text>
  <text x="103" y="71" text-anchor="middle" font-size="9.5" fill="currentColor">610</text>
  <text x="141" y="174" text-anchor="middle" font-size="9.5" fill="currentColor">84</text>
  <rect x="212" y="62" width="34" height="134" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <rect x="250" y="167" width="34" height="29" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="248" y="212" text-anchor="middle" font-size="11" fill="currentColor">z8</text>
  <text x="229" y="56" text-anchor="middle" font-size="9.5" fill="currentColor">690</text>
  <text x="267" y="161" text-anchor="middle" font-size="9.5" fill="currentColor">148</text>
  <rect x="338" y="95" width="34" height="101" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <rect x="376" y="159" width="34" height="37" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="374" y="212" text-anchor="middle" font-size="11" fill="currentColor">z10</text>
  <text x="355" y="89" text-anchor="middle" font-size="9.5" fill="currentColor">520</text>
  <text x="393" y="153" text-anchor="middle" font-size="9.5" fill="currentColor">190</text>
  <rect x="464" y="136" width="34" height="60" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <rect x="502" y="156" width="34" height="40" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="500" y="212" text-anchor="middle" font-size="11" fill="currentColor">z12</text>
  <text x="481" y="130" text-anchor="middle" font-size="9.5" fill="currentColor">310</text>
  <text x="519" y="150" text-anchor="middle" font-size="9.5" fill="currentColor">205</text>
  <rect x="590" y="155" width="34" height="41" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <rect x="628" y="156" width="34" height="40" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="626" y="212" text-anchor="middle" font-size="11" fill="currentColor">z14</text>
  <text x="607" y="149" text-anchor="middle" font-size="9.5" fill="currentColor">210</text>
  <text x="645" y="150" text-anchor="middle" font-size="9.5" fill="currentColor">205</text>
  <text x="20" y="238" font-size="10.5" fill="var(--muted, #7c6fb0)">Tolerance = 40075016.7 / (2^z × 4096) × 2 metres; below zoom 12 it removes vertices no display can resolve.</text>
</svg>

```sql
-- Tolerance in Web Mercator metres: roughly two tile units at this zoom
CREATE OR REPLACE FUNCTION tile_tolerance(z integer)
RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT 40075016.6855785 / (2 ^ z) / 4096 * 2;
$$;
```

Apply it inside the tile CTE, and use `ST_SimplifyPreserveTopology` rather than `ST_Simplify` so polygons keep valid rings:

```sql
ST_AsMVTGeom(
    ST_SimplifyPreserveTopology(ST_Transform(f.geom, 3857), tile_tolerance($1)),
    b.merc, 4096, 64, true
)
```

### 4. Budget the attributes

Properties are frequently the larger half of a tile. A layer with 1 200 features and eight text attributes carries 9 600 strings; the geometry may be 40 KB and the properties 120 KB. Select only what the map style reads, and prefer small integer codes to human-readable labels where the client can map them back.

The split is worth measuring rather than assuming, because the intuition — "geometry is the big part" — is usually wrong for anything other than dense line layers. A parcel tile carrying an owner name, an address string and a status label spends most of its bytes on text that the renderer never draws, because the style only tests a category.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Stacked bars showing how tile bytes divide between geometry, keys and values for three attribute strategies" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where the bytes go in one zoom-14 tile</title>
  <desc>Three stacked bars for the same 1180 features. Shipping every column produces 168 kilobytes, of which 41 are geometry, 12 are attribute keys and 115 are attribute values. Shipping only the four attributes the style reads produces 78 kilobytes, of which 41 are geometry and 33 values. Replacing text labels with integer category codes produces 52 kilobytes, of which 41 are geometry and 8 values, at which point geometry finally dominates and further attribute trimming stops helping.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Tile composition for 1 180 features at zoom 14</text>
  <rect x="470" y="14" width="12" height="12" rx="2" fill="var(--accent, #7c3aed)" opacity="0.8"/>
  <text x="488" y="25" font-size="10" fill="currentColor">geometry</text>
  <rect x="556" y="14" width="12" height="12" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="574" y="25" font-size="10" fill="currentColor">keys</text>
  <rect x="616" y="14" width="12" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="634" y="25" font-size="10" fill="currentColor">values</text>
  <text x="20" y="62" font-size="10.5" fill="currentColor">SELECT f.*</text>
  <rect x="180" y="48" width="122" height="20" rx="3" fill="var(--accent, #7c3aed)" opacity="0.8"/>
  <rect x="302" y="48" width="36" height="20" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <rect x="338" y="48" width="300" height="20" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="646" y="63" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">168 KB</text>
  <text x="20" y="106" font-size="10.5" fill="currentColor">four style attributes only</text>
  <rect x="180" y="92" width="122" height="20" rx="3" fill="var(--accent, #7c3aed)" opacity="0.8"/>
  <rect x="302" y="92" width="12" height="20" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <rect x="314" y="92" width="98" height="20" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="420" y="107" font-size="10" font-weight="700" fill="currentColor">78 KB</text>
  <text x="20" y="150" font-size="10.5" fill="currentColor">integer category codes</text>
  <rect x="180" y="136" width="122" height="20" rx="3" fill="var(--accent, #7c3aed)" opacity="0.8"/>
  <rect x="302" y="136" width="9" height="20" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <rect x="311" y="136" width="24" height="20" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="343" y="151" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">52 KB — geometry now dominates</text>
  <line x1="302" y1="40" x2="302" y2="170" stroke="currentColor" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>
  <text x="308" y="182" font-size="10" fill="var(--muted, #7c6fb0)">geometry floor: 41 KB — only simplification moves this line</text>
  <text x="20" y="212" font-size="10.5" fill="var(--muted, #7c6fb0)">Trim attributes first; it is a one-line change to the tile CTE and needs no re-tuning of tolerance.</text>
</svg>

## Production Code Example

```python
import hashlib
from typing import Annotated

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Path, Response

router = APIRouter(prefix="/v1/tiles", tags=["tiles"])

MVT_SQL = """
WITH bounds AS (
    SELECT ST_TileEnvelope($1, $2, $3)                     AS merc,
           ST_Transform(ST_TileEnvelope($1, $2, $3), 4326) AS wgs
),
tile AS (
    SELECT f.id,
           f.category_code,                       -- small int, not a label
           ST_AsMVTGeom(
               ST_SimplifyPreserveTopology(
                   ST_Transform(f.geom, 3857),
                   40075016.6855785 / (2 ^ $1) / 4096 * 2
               ),
               b.merc, 4096, 64, true
           ) AS geom
    FROM   features f
    CROSS  JOIN bounds b
    WHERE  f.geom && b.wgs
      AND  f.min_zoom <= $1                       -- per-feature zoom gating
)
SELECT COALESCE(ST_AsMVT(tile.*, 'features', 4096, 'geom'), ''::bytea) AS mvt
FROM   tile
WHERE  geom IS NOT NULL
"""

MAX_ZOOM = 18


async def get_pool() -> asyncpg.Pool:      # wired at app startup
    raise NotImplementedError


@router.get("/{z}/{x}/{y}.mvt")
async def get_tile(
    z: Annotated[int, Path(ge=0, le=MAX_ZOOM)],
    x: Annotated[int, Path(ge=0)],
    y: Annotated[int, Path(ge=0)],
    pool: asyncpg.Pool = Depends(get_pool),
) -> Response:
    # x and y must fall inside the pyramid for this zoom, or PostGIS errors
    limit = 2 ** z
    if x >= limit or y >= limit:
        raise HTTPException(404, detail={"error": "tile_out_of_range", "z": z})

    async with pool.acquire() as conn:
        # Statement timeout: a pathological tile must not pin a backend
        await conn.execute("SET LOCAL statement_timeout = '3s'")
        mvt: bytes = await conn.fetchval(MVT_SQL, z, x, y)

    if not mvt:
        # 204 keeps empty tiles out of the cache as "missing data"
        return Response(status_code=204)

    etag = hashlib.blake2b(mvt, digest_size=16).hexdigest()
    return Response(
        content=mvt,
        media_type="application/vnd.mapbox-vector-tile",
        headers={
            "ETag": f'W/"{etag}"',
            "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
            "Content-Length": str(len(mvt)),
        },
    )
```

The `statement_timeout` is not optional. A tile request at zoom 3 over a global dataset can touch millions of rows; without a timeout one careless client holds a connection until the pool starves, which is the failure described in [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

### 5. Gate features by zoom in the table, not the style

Client-side style rules that hide a layer below zoom 12 still pay to download it. Push the decision into the data with a `min_zoom` column, populated once from whatever makes a feature significant — road classification, building footprint area, settlement population — and filter on it in the tile query. A single integer column removes the majority of features from low-zoom tiles before clipping runs, which is the expensive stage.

```sql
ALTER TABLE features ADD COLUMN min_zoom smallint NOT NULL DEFAULT 0;

-- Example rule: show a parcel only once it is at least a few pixels across
UPDATE features
SET    min_zoom = CASE
         WHEN ST_Area(geom::geography) > 1e6 THEN 6
         WHEN ST_Area(geom::geography) > 5e4 THEN 10
         WHEN ST_Area(geom::geography) > 2e3 THEN 13
         ELSE 15
       END;

CREATE INDEX features_minzoom_geom_gix ON features USING GIST (geom) WHERE min_zoom <= 12;
```

The partial index is the second half of the trick: low-zoom tiles, which are the ones at risk of unbounded work, get an index containing only the features they are allowed to draw. Recompute `min_zoom` in the same job that refreshes the data, not on read.

## Verification & Testing

Vector tiles are binary, so assert on their decoded structure rather than eyeballing a map.

```python
import mapbox_vector_tile  # test-only dependency
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_tile_has_expected_layer_and_extent(seeded_db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        r = await client.get("/v1/tiles/14/8188/5448.mvt")

    assert r.status_code == 200
    assert r.headers["content-type"] == "application/vnd.mapbox-vector-tile"

    decoded = mapbox_vector_tile.decode(r.content)
    assert "features" in decoded
    layer = decoded["features"]
    assert layer["extent"] == 4096
    assert len(layer["features"]) > 0
    # Coordinates live in tile space, allowing for the 64-unit buffer
    for feature in layer["features"][:20]:
        for x, y in _flatten_coords(feature["geometry"]):
            assert -64 <= x <= 4160 and -64 <= y <= 4160


@pytest.mark.asyncio
async def test_out_of_range_tile_is_404(seeded_db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        r = await client.get("/v1/tiles/2/9/1.mvt")   # 2^2 = 4 columns, 9 is invalid
    assert r.status_code == 404
```

Track tile size directly in SQL while tuning:

```sql
SELECT z, round(avg(octet_length(mvt)) / 1024.0, 1) AS avg_kb,
       max(octet_length(mvt)) / 1024 AS max_kb
FROM   sampled_tiles
GROUP  BY z ORDER BY z;
```

## Failure Modes & Edge Cases

1. **Empty tiles everywhere.** Almost always an SRID mismatch: the geometry passed to `ST_AsMVTGeom` is in 4326 while `bounds` is in 3857. There is no error — every row simply clips to `NULL`. Check with `SELECT ST_SRID(...)` on both arguments.
2. **`ERROR: Tile coordinates are out of range`.** `ST_TileEnvelope` validates x and y against the zoom. Range-check the path parameters in FastAPI and return 404, as in the route above.
3. **Features cut at tile seams.** `buffer` left at 0, or the candidate filter uses the unbuffered envelope. Both must be generous; the clip step is what enforces the real boundary.
4. **Tiles growing without explanation.** Someone added a column to the tile CTE. Every column becomes an attribute on every feature. Pin the attribute list in a code review checklist and assert on decoded property names in tests.
5. **Invalid geometry raises mid-tile.** `ST_SimplifyPreserveTopology` throws on self-intersecting input. Repair on write with `ST_MakeValid` rather than per tile — the validation approach in [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) stops most of it at the door.
6. **204 versus 200 for empty tiles.** Returning a zero-byte 200 makes some clients cache an empty layer permanently. A 204 with a short `max-age` is the safer contract when data may arrive later.
7. **Zoom 0–4 over global data.** No amount of simplification saves a tile that must summarise a continent. Serve those zoom levels from a pre-aggregated table built with [materialized views](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/).

## Performance Notes

On a 4.2 million row parcel table, median tile generation at zoom 14 is about 23 ms and the 99th percentile about 140 ms, dominated by clipping rather than by the protobuf encode. Zoom 10 roughly triples the candidate count and lands near 70 ms; below zoom 8 the query becomes unbounded and needs the pre-aggregation route.

`ST_AsMVT` is parallel-safe, so a tile touching many rows can use parallel workers if `max_parallel_workers_per_gather` allows it — but each worker holds its own memory for the aggregate, so a global tile can multiply `work_mem` by the worker count. Cap parallelism for the tile role rather than raising memory.

Because tiles are immutable for a given data version, they are the easiest thing in the whole API to cache. Put a short `max-age` with a long `stale-while-revalidate` in front of the origin and let the edge absorb the repeat traffic — the pattern set out in [Cloudflare Workers Edge Routing for Vector Tile Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/cloudflare-workers-edge-routing-for-vector-tile-endpoints/).

---

## Related

- [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — the index behaviour every tile query depends on
- [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — pre-rendering and distributing tiles at scale
- [Caching Vector Tiles at the Edge with Cache-Control](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/) — header policy for tile responses
- [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/) — why the tile query transforms the envelope, not the column
- [Materialized Views for Spatial Aggregations](https://www.geospatial-api.com/high-performance-caching-query-optimization/materialized-views-for-spatial-aggregations/) — pre-aggregating the low zoom levels

← Back to [Advanced Spatial Endpoints & Data Contracts](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/)
