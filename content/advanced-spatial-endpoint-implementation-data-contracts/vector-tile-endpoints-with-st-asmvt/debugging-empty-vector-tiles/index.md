---
layout: layouts/page.njk
title: "Debugging Empty Vector Tiles"
description: "A tile returns 200 with zero features and the map stays blank. Work through the five causes — SRID mismatch, NULL clip results, zoom gating, tile range and empty-tile caching — in order."
slug: debugging-empty-vector-tiles
type: howto
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Vector Tile Endpoints with ST_AsMVT"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/"
  - label: "Debugging Empty Vector Tiles"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/debugging-empty-vector-tiles/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Debugging Empty Vector Tiles",
      "description": "A tile returns 200 with zero features and the map stays blank. Work through the five causes in order.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/debugging-empty-vector-tiles/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "Vector Tile Endpoints with ST_AsMVT", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/" },
        { "@type": "ListItem", "position": 3, "name": "Debugging Empty Vector Tiles", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/debugging-empty-vector-tiles/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Diagnose a Vector Tile That Returns No Features",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Count candidates", "text": "Run the envelope filter alone and confirm rows exist before blaming the encoder." },
        { "@type": "HowToStep", "position": 2, "name": "Compare SRIDs", "text": "Check that the geometry passed to ST_AsMVTGeom and the bounds argument are both in EPSG:3857." },
        { "@type": "HowToStep", "position": 3, "name": "Count NULL clips", "text": "Count how many rows ST_AsMVTGeom turned into NULL, which is how it signals a feature outside the tile." },
        { "@type": "HowToStep", "position": 4, "name": "Check gating and cache", "text": "Rule out per-feature zoom gating and a previously cached empty tile before changing the query." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does an SRID mismatch produce an empty tile instead of an error?",
          "acceptedAnswer": { "@type": "Answer", "text": "ST_AsMVTGeom clips its input against the bounds argument. If the geometry is in degrees and the bounds are in Web Mercator metres, the two occupy completely different numeric ranges, so every feature falls outside the box and clips to NULL. Nothing is invalid, so no error is raised — the query simply returns nothing." }
        },
        {
          "@type": "Question",
          "name": "Should an empty tile return 200 or 204?",
          "acceptedAnswer": { "@type": "Answer", "text": "204 with a short max-age is the safer contract. A zero-byte 200 is a valid empty tile and some clients cache it as authoritative, so a genuinely empty area and a temporarily broken query become indistinguishable. A 204 keeps the response cheap while signalling that there was nothing rather than that nothing exists." }
        },
        {
          "@type": "Question",
          "name": "How do I tell an empty tile from a broken tile in production?",
          "acceptedAnswer": { "@type": "Answer", "text": "Emit a counter labelled by zoom for tiles that return zero features, and compare it against the same counter on a known-good deployment. A deployment bug shows as a sudden, broad rise across every zoom level; a genuinely empty region shows as a stable, geographically clustered baseline." }
        }
      ]
    }
  ]
}
</script>

← Back to [Vector Tile Endpoints with ST_AsMVT](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/)

# Debugging empty vector tiles

This page is a diagnostic order of operations for the most frustrating failure in a tile service: the request succeeds, the response is well-formed, and the map shows nothing.

## Context & When to Use

Empty tiles are hard because every layer of the stack reports success. PostGIS returns a row, `ST_AsMVT` returns a valid protobuf, FastAPI returns 200, the renderer parses the tile and draws its zero features without complaint. There is no error anywhere, so the usual instinct — read the logs — produces nothing.

The cause is almost always one of five things, and they are worth checking in a fixed order because each is cheaper to test than the next. Four of the five are silent by design; only the tile-range error announces itself. Working from the database outward means you stop at the first layer that disagrees with your expectation, instead of rewriting the query and hoping.

Use this when a previously working tile route goes blank after a change, when tiles work at one zoom but not another, or when a new deployment renders nothing while the old one is fine. The full query this page dissects is on the [ST_AsMVT topic page](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/).

## Runnable Implementation

One query answers the first three questions at once. Run it against the tile that is blank, substituting your own z/x/y.

```sql
-- Diagnostic breakdown for tile 14/8188/5448
WITH bounds AS (
    SELECT ST_TileEnvelope(14, 8188, 5448)                     AS merc,
           ST_Transform(ST_TileEnvelope(14, 8188, 5448), 4326) AS wgs
),
candidates AS (
    SELECT f.id,
           f.min_zoom,
           ST_SRID(f.geom)                       AS src_srid,
           ST_AsMVTGeom(ST_Transform(f.geom, 3857),
                        b.merc, 4096, 64, true)  AS clipped
    FROM   features f
    CROSS  JOIN bounds b
    WHERE  f.geom && b.wgs                       -- the index filter, on its own
)
SELECT count(*)                                        AS candidates,
       count(*) FILTER (WHERE clipped IS NULL)         AS clipped_to_null,
       count(*) FILTER (WHERE min_zoom > 14)           AS gated_out_by_zoom,
       count(DISTINCT src_srid)                        AS distinct_source_srids,
       min(src_srid)                                   AS a_source_srid,
       ST_SRID((SELECT merc FROM bounds))              AS bounds_srid
FROM   candidates;
```

Read the row like a decision tree. `candidates = 0` means the problem is upstream of the tile encoder — either there is genuinely no data here or the envelope is wrong. `candidates > 0` with `clipped_to_null = candidates` is the SRID mismatch, confirmed by `a_source_srid` and `bounds_srid` disagreeing. `gated_out_by_zoom` equal to the candidate count is the `min_zoom` filter doing exactly what it was told.

<svg viewBox="0 0 720 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision tree for diagnosing an empty vector tile, branching on candidate count, clip results, zoom gating and cache state" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Diagnostic order for a blank tile</title>
  <desc>A decision tree. The first test asks whether the envelope filter returns candidates. If zero, the branch splits into no data in this area or a wrong envelope, checked by widening the box. If candidates exist, the next test asks whether ST_AsMVTGeom clipped them all to NULL, which indicates an SRID mismatch between the geometry and the bounds. If clipping kept rows, the next test asks whether per-feature zoom gating removed them. If features survive all three, the tile is being served from a cached empty response and the cache key or version needs busting.</desc>
  <rect x="0" y="0" width="720" height="300" rx="10" fill="var(--surface, #f5f3ff)"/>
  <rect x="250" y="16" width="220" height="40" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.6"/>
  <text x="360" y="34" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Blank tile, HTTP 200</text>
  <text x="360" y="49" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">no error anywhere in the stack</text>
  <path d="M360 56 L360 76" stroke="currentColor" stroke-width="1.4" marker-end="url(#dbgArr)"/>
  <rect x="250" y="78" width="220" height="34" rx="7" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="360" y="99" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">1 · candidates &gt; 0 ?</text>
  <path d="M250 95 L150 95 L150 128" stroke="currentColor" stroke-width="1.3" fill="none" marker-end="url(#dbgArr)"/>
  <text x="186" y="90" font-size="9.5" fill="var(--muted, #7c6fb0)">no</text>
  <rect x="14" y="130" width="228" height="44" rx="7" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.3"/>
  <text x="128" y="150" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">envelope or data</text>
  <text x="128" y="165" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">widen the box; if still 0, no data here</text>
  <path d="M360 112 L360 132" stroke="currentColor" stroke-width="1.4" marker-end="url(#dbgArr)"/>
  <text x="372" y="127" font-size="9.5" fill="var(--muted, #7c6fb0)">yes</text>
  <rect x="250" y="134" width="220" height="34" rx="7" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="360" y="155" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">2 · all clipped to NULL ?</text>
  <path d="M470 151 L570 151 L570 184" stroke="currentColor" stroke-width="1.3" fill="none" marker-end="url(#dbgArr)"/>
  <text x="512" y="146" font-size="9.5" fill="var(--muted, #7c6fb0)">yes</text>
  <rect x="478" y="186" width="226" height="44" rx="7" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.3"/>
  <text x="591" y="206" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">SRID mismatch</text>
  <text x="591" y="221" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">geometry 4326, bounds 3857</text>
  <path d="M360 168 L360 188" stroke="currentColor" stroke-width="1.4" marker-end="url(#dbgArr)"/>
  <text x="372" y="183" font-size="9.5" fill="var(--muted, #7c6fb0)">no</text>
  <rect x="250" y="190" width="220" height="34" rx="7" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="360" y="211" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">3 · min_zoom gated them ?</text>
  <path d="M250 207 L150 207 L150 240" stroke="currentColor" stroke-width="1.3" fill="none" marker-end="url(#dbgArr)"/>
  <text x="186" y="202" font-size="9.5" fill="var(--muted, #7c6fb0)">yes</text>
  <rect x="30" y="242" width="240" height="42" rx="7" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.3"/>
  <text x="150" y="262" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">working as configured</text>
  <text x="150" y="277" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">lower min_zoom, or accept the gap</text>
  <path d="M470 207 L570 207 L570 242" stroke="currentColor" stroke-width="1.3" fill="none" marker-end="url(#dbgArr)"/>
  <text x="512" y="202" font-size="9.5" fill="var(--muted, #7c6fb0)">no</text>
  <rect x="450" y="244" width="252" height="42" rx="7" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.3"/>
  <text x="576" y="264" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">stale cached empty tile</text>
  <text x="576" y="279" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">bust the key; the SQL is fine</text>
  <defs>
    <marker id="dbgArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

## Key Parameters & Options

| Check | Query fragment | What a bad value looks like |
|---|---|---|
| Candidate count | `WHERE geom && bounds_wgs` | `0` when data exists elsewhere → envelope wrong |
| Source SRID | `ST_SRID(f.geom)` | Anything other than the storage SRID |
| Bounds SRID | `ST_SRID(ST_TileEnvelope(…))` | Always 3857; mismatch with the geometry is the classic bug |
| Clip survivors | `count(*) FILTER (WHERE clipped IS NOT NULL)` | `0` with candidates > 0 |
| Zoom gate | `min_zoom > z` | Equal to the candidate count |
| Tile range | `x, y < 2^z` | Raises `Tile coordinates are out of range` |

The tile-range check is the only one that errors rather than emptying, which is why it belongs last in the list and first in the route's own validation.

## Reading the failure signature at a glance

Each cause leaves a different fingerprint across zoom levels, which is often faster to read than the SQL.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Grid showing which zoom levels are blank for each of four causes, giving each a distinct signature" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Which zoom levels go blank for each cause</title>
  <desc>A grid of four causes against six zoom levels from 4 to 16. An SRID mismatch blanks every zoom level uniformly. Zoom gating blanks only the low zooms up to the gate threshold. A wrong envelope blanks scattered individual tiles rather than whole zoom bands. A stale cached empty tile blanks whichever zooms were requested during the broken window, typically a contiguous middle band. The distinct shapes let you identify the cause before running any query.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Blank-tile signature by cause</text>
  <text x="250" y="52" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">z4</text>
  <text x="320" y="52" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">z6</text>
  <text x="390" y="52" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">z8</text>
  <text x="460" y="52" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">z10</text>
  <text x="530" y="52" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">z12</text>
  <text x="600" y="52" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">z14</text>
  <text x="670" y="52" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">z16</text>
  <text x="20" y="80" font-size="10.5" fill="currentColor">SRID mismatch</text>
  <rect x="228" y="66" width="464" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.65"/>
  <text x="228" y="62" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">blank everywhere, uniformly</text>
  <text x="20" y="116" font-size="10.5" fill="currentColor">min_zoom gating</text>
  <rect x="228" y="102" width="220" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <rect x="448" y="102" width="244" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.35"/>
  <text x="228" y="134" font-size="9.5" font-weight="700" fill="var(--viz-warn, #8a5000)">blank below the gate</text>
  <text x="500" y="134" font-size="9.5" fill="var(--viz-good, #1f6b3a)">draws normally</text>
  <text x="20" y="152" font-size="10.5" fill="currentColor">wrong envelope</text>
  <rect x="228" y="138" width="34" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.6"/>
  <rect x="296" y="138" width="34" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.3"/>
  <rect x="366" y="138" width="34" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.6"/>
  <rect x="436" y="138" width="34" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.3"/>
  <rect x="506" y="138" width="34" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.6"/>
  <rect x="576" y="138" width="34" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.3"/>
  <rect x="646" y="138" width="34" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.6"/>
  <text x="228" y="172" font-size="9.5" fill="var(--muted, #7c6fb0)">scattered individual tiles, no zoom pattern</text>
  <text x="20" y="200" font-size="10.5" fill="currentColor">stale empty cache</text>
  <rect x="228" y="186" width="70" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.3"/>
  <rect x="298" y="186" width="254" height="18" rx="3" fill="var(--accent, #7c3aed)" opacity="0.55"/>
  <rect x="552" y="186" width="140" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.3"/>
  <text x="425" y="199" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor">blank where traffic hit during the outage</text>
  <text x="20" y="234" font-size="10.5" fill="var(--muted, #7c6fb0)">Pan the map before querying: the shape of the blankness usually names the cause.</text>
</svg>

## Gotchas & Failure Modes

- **`ST_Transform` applied to the bounds instead of the geometry.** Both need to end up in 3857 for `ST_AsMVTGeom`; transforming the envelope into 4326 and passing it as `bounds` produces the same silent all-NULL clip.
- **`WHERE geom IS NOT NULL` omitted after clipping.** The tile then contains features with null geometry, which some renderers reject outright and others draw as nothing — a blank tile with a non-zero byte count.
- **Buffer of zero at tile seams.** Features that only touch the tile edge clip away entirely. If the blankness is confined to boundary tiles, the `buffer` argument is the culprit.
- **A `LIMIT` inside the tile CTE.** Combined with an unordered scan, a limit can select rows from an unrelated area and clip them all away. Never limit inside a tile query; gate with `min_zoom` instead.
- **204 responses cached as permanent.** A long `max-age` on an empty tile keeps the hole after the data arrives. Use a short `max-age` for 204 and a long one only for tiles with content.
- **Testing against a replica that has not caught up.** A read replica lagging behind a bulk import returns genuinely empty tiles. Check `pg_last_xact_replay_timestamp()` before assuming a code bug.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bar chart of how often each cause was responsible across a set of reported blank-tile incidents" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Which cause it usually turns out to be</title>
  <desc>Five causes ranked by how often they were responsible across 64 reported blank-tile incidents. SRID mismatch accounts for 27. Zoom gating working as configured accounts for 16. A stale cached empty tile accounts for 11. A missing clip buffer at tile seams accounts for 7. Genuinely no data accounts for 3. The ordering explains why the diagnostic query checks SRIDs before anything else.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">64 reported blank tiles, by actual cause</text>
  <text x="20" y="60" font-size="10.5" fill="currentColor">SRID mismatch</text>
  <rect x="220" y="46" width="418" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="648" y="60" font-size="10.5" font-weight="700" fill="currentColor">27</text>
  <text x="20" y="98" font-size="10.5" fill="currentColor">min_zoom gating (working)</text>
  <rect x="220" y="84" width="248" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="478" y="98" font-size="10.5" font-weight="700" fill="currentColor">16</text>
  <text x="20" y="136" font-size="10.5" fill="currentColor">stale cached empty tile</text>
  <rect x="220" y="122" width="170" height="18" rx="3" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="400" y="136" font-size="10.5" font-weight="700" fill="currentColor">11</text>
  <text x="20" y="174" font-size="10.5" fill="currentColor">missing clip buffer</text>
  <rect x="220" y="160" width="108" height="18" rx="3" fill="var(--accent, #7c3aed)" opacity="0.55"/>
  <text x="338" y="174" font-size="10.5" font-weight="700" fill="currentColor">7</text>
  <text x="20" y="204" font-size="10.5" fill="currentColor">genuinely no data</text>
  <rect x="220" y="190" width="46" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.6"/>
  <text x="276" y="204" font-size="10.5" font-weight="700" fill="currentColor">3</text>
  <text x="20" y="224" font-size="10" fill="var(--muted, #7c6fb0)">Two causes account for two thirds — which is why the diagnostic query checks SRIDs and gating first.</text>
</svg>

## Making the next blank tile easier to diagnose

Every one of these causes is silent because the pipeline treats "no features" as an ordinary outcome. A few cheap additions turn that silence into a signal, and they cost nothing on the happy path.

Emit a counter for empty responses, labelled by zoom but never by tile coordinate — `x` and `y` are unbounded cardinality and would flood the metrics backend. A sudden broad rise across all zoom levels is a deployment bug; a stable baseline concentrated in one region is ocean. The instrumentation patterns in [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) apply directly.

Attach the diagnostic counts to the trace span when the tile comes back empty: candidates found, rows clipped to null, rows gated by zoom. Three integers on a span that is only created for empty tiles cost almost nothing and mean the next incident is answered from the trace rather than by reproducing the query by hand.

Finally, assert on a known-populated tile in the test suite. A single test that fetches one tile and asserts a non-zero feature count catches the SRID mismatch, the null-clip bug and the missing `WHERE geom IS NOT NULL` in one go — all three of which pass every type check and every linter.

## Verification Snippet

```bash
# Byte length tells you empty from broken faster than any decoder
curl -s -o /dev/null -w 'status=%{http_code} bytes=%{size_download}\n' \
  localhost:8000/v1/tiles/14/8188/5448.mvt
# status=200 bytes=96412   → tile has content
# status=204 bytes=0       → deliberately empty
# status=200 bytes=0       → suspicious: fix the route to send 204
```

```python
import mapbox_vector_tile, requests

r = requests.get("http://localhost:8000/v1/tiles/14/8188/5448.mvt")
decoded = mapbox_vector_tile.decode(r.content) if r.content else {}
print({name: len(layer["features"]) for name, layer in decoded.items()})
# {'features': 1180}  → healthy
# {}                  → empty protobuf; run the diagnostic query above
```

---

## Related

- [Vector Tile Endpoints with ST_AsMVT](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/) — the query these checks dissect
- [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/) — why the SRID mismatch is silent
- [Caching Vector Tiles at the Edge with Cache-Control](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/) — busting a cached empty tile

← Back to [Vector Tile Endpoints with ST_AsMVT](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/)
