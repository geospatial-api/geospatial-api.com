---
layout: layouts/page.njk
title: "Transforming SRIDs in API Responses with ST_Transform"
description: "Project geometry on output without losing the GiST index: where ST_Transform belongs in the query, how to cache the PROJ pipeline, and the precision to serialize at."
slug: transforming-srids-in-api-responses-with-st-transform
type: howto
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "Coordinate Reference Systems & SRID Handling"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/"
  - label: "Transforming SRIDs in API Responses"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/transforming-srids-in-api-responses-with-st-transform/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Transforming SRIDs in API Responses with ST_Transform",
      "description": "Project geometry on output without losing the GiST index: where ST_Transform belongs in the query, how to cache the PROJ pipeline, and the precision to serialize at.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/transforming-srids-in-api-responses-with-st-transform/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 2, "name": "Coordinate Reference Systems & SRID Handling", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/" },
        { "@type": "ListItem", "position": 3, "name": "Transforming SRIDs in API Responses", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/transforming-srids-in-api-responses-with-st-transform/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Project Geometry on Output Without Losing the Spatial Index",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Filter on the raw column", "text": "Keep the WHERE clause comparing the stored geometry against a constant transformed into storage space." },
        { "@type": "HowToStep", "position": 2, "name": "Transform in the SELECT list", "text": "Apply ST_Transform after filtering and pagination, so only returned rows are reprojected." },
        { "@type": "HowToStep", "position": 3, "name": "Round the output", "text": "Pass an explicit decimal precision to ST_AsGeoJSON so payloads do not carry fifteen meaningless digits." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Does ST_Transform in the SELECT list slow a query down?",
          "acceptedAnswer": { "@type": "Answer", "text": "Only in proportion to the rows returned. A transform costs roughly 1 to 3 microseconds per simple geometry once the PROJ pipeline is cached, so 500 features add under two milliseconds. The same call in the WHERE clause costs one transform per row examined, which on a large table is thousands of times more work and also disables the index." }
        },
        {
          "@type": "Question",
          "name": "Why is the first transform on a connection much slower?",
          "acceptedAnswer": { "@type": "Answer", "text": "PROJ builds and caches the transformation pipeline per backend process on first use, which takes 2 to 10 milliseconds. On a long-lived pooled connection this happens once. Under PgBouncer in transaction pooling mode you may hit a cold backend regularly, so warm the pipeline in the pool's connection-setup hook." }
        },
        {
          "@type": "Question",
          "name": "How many decimal places should a projected coordinate carry?",
          "acceptedAnswer": { "@type": "Answer", "text": "For degrees, six places is about 11 centimetres and is enough for almost every API. For a metre-based projection such as EPSG:3857 or a national grid, two places is centimetre resolution. Anything beyond that inflates the payload without adding information the source data contains." }
        }
      ]
    }
  ]
}
</script>

← Back to [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/)

# Transforming SRIDs in API responses with ST_Transform

This page shows how to let clients request geometry in a coordinate system other than the one you store in, without turning a 7 ms index scan into a 6-second sequential scan.

## Context & When to Use

Storage is one system; consumers want several. A web map wants EPSG:3857 so it can draw without reprojecting, a surveying client wants the national grid its instruments are calibrated to, and everything else wants plain longitude and latitude. Doing the conversion in PostGIS is almost always cheaper than doing it in Python, because the database already has the geometry in memory and PROJ is C.

The rule that makes it safe is positional: **transform on output, filter on storage**. A `ST_Transform` call in the `SELECT` list runs once per returned row, after the planner has already used the GiST index to cut the candidate set. The same call in the `WHERE` clause runs once per row *examined* and, worse, hides the indexed column inside an expression the planner cannot match to the index — the comparison laid out in [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/).

Use this approach whenever the output system varies per request. If a single alternative projection accounts for essentially all traffic — a tile service reading 3857 exclusively — a functional index or a materialized projected column is worth measuring instead.

## Runnable Implementation

```python
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

router = APIRouter(prefix="/v1/features", tags=["features"])

STORAGE_SRID = 4326
# Allow-list: every code here must resolve in spatial_ref_sys on this server
OUTPUT_SRIDS = {4326: 6, 3857: 2, 27700: 2, 2154: 2}   # srid -> decimal places

FEATURES_SQL = """
SELECT f.id,
       f.layer,
       ST_AsGeoJSON(
           -- Transform ONLY the rows that survived the filter…
           CASE WHEN $5::int = 4326 THEN f.geom ELSE ST_Transform(f.geom, $5::int) END,
           $6::int                                   -- …at an explicit precision
       )::json AS geometry
FROM   features f
-- …and keep the predicate on the RAW column so features_geom_gix is usable
WHERE  f.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
ORDER  BY f.id
LIMIT  $7
"""


async def get_pool() -> asyncpg.Pool:      # wired at app startup
    raise NotImplementedError


@router.get("")
async def list_features(
    bbox: Annotated[str, Query(description="minx,miny,maxx,maxy in EPSG:4326")],
    out_srid: Annotated[int, Query(alias="crs")] = STORAGE_SRID,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    if out_srid not in OUTPUT_SRIDS:
        raise HTTPException(
            422,
            detail={"error": "unsupported_crs", "received": out_srid,
                    "supported": sorted(OUTPUT_SRIDS)},
        )
    try:
        minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(422, detail={"error": "bbox_must_be_four_numbers"})

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            FEATURES_SQL, minx, miny, maxx, maxy,
            out_srid, OUTPUT_SRIDS[out_srid], limit,
        )

    return {
        "type": "FeatureCollection",
        # Tell the client what it received — never leave the system implicit
        "crs": {"type": "name", "properties": {"name": f"EPSG:{out_srid}"}},
        "features": [
            {"type": "Feature", "id": r["id"],
             "geometry": r["geometry"], "properties": {"layer": r["layer"]}}
            for r in rows
        ],
    }
```

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram of the query pipeline showing that the index filter runs on stored coordinates and the projection runs only on the surviving rows" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Filter first, project last</title>
  <desc>A left-to-right pipeline. Four point two million stored rows enter an index filter that compares the raw geometry column against the request envelope, leaving 912 candidate rows. A limit clause cuts those to 200. Only then does ST_Transform run, reprojecting 200 geometries, followed by ST_AsGeoJSON at six decimal places. A counter under each stage shows how many transforms would have been needed had the projection been applied earlier: 4.2 million at the filter stage versus 200 at the end.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Cost of the same transform at four positions in the query</text>
  <rect x="18" y="46" width="150" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="93" y="70" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Stored rows</text>
  <text x="93" y="88" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">4 200 000 · EPSG:4326</text>
  <path d="M168 76 L192 76" stroke="currentColor" stroke-width="1.4" marker-end="url(#trArr)"/>
  <rect x="194" y="46" width="150" height="60" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.6"/>
  <text x="269" y="70" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">GiST filter</text>
  <text x="269" y="88" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">raw column · 912 rows</text>
  <path d="M344 76 L368 76" stroke="currentColor" stroke-width="1.4" marker-end="url(#trArr)"/>
  <rect x="370" y="46" width="150" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="445" y="70" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">ORDER + LIMIT</text>
  <text x="445" y="88" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">200 rows</text>
  <path d="M520 76 L544 76" stroke="currentColor" stroke-width="1.4" marker-end="url(#trArr)"/>
  <rect x="546" y="46" width="156" height="60" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <text x="624" y="70" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">ST_Transform</text>
  <text x="624" y="88" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">200 calls · 0.4 ms</text>
  <line x1="18" y1="126" x2="702" y2="126" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="148" font-size="11.5" font-weight="700" fill="currentColor">If the transform were moved earlier</text>
  <text x="30" y="170" font-size="11" fill="currentColor">inside WHERE, wrapping the column</text>
  <rect x="330" y="158" width="300" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="638" y="171" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">4 200 000 calls</text>
  <text x="30" y="196" font-size="11" fill="currentColor">after the filter, before LIMIT</text>
  <rect x="330" y="184" width="30" height="16" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="368" y="197" font-size="10.5" font-weight="700" fill="var(--viz-warn, #8a5000)">912 calls</text>
  <text x="30" y="222" font-size="11" fill="currentColor">in the SELECT list (above)</text>
  <rect x="330" y="210" width="8" height="16" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="346" y="223" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">200 calls</text>
  <defs>
    <marker id="trArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

## Key Parameters & Options

| Parameter | Value used above | Effect |
|---|---|---|
| `ST_Transform(geom, srid)` | per-request `crs` | Reprojects one geometry; needs the target SRID present in `spatial_ref_sys` |
| `ST_AsGeoJSON(geom, maxdecimaldigits)` | 6 for degrees, 2 for metres | Caps coordinate precision; the default of 15 roughly triples payload size |
| `CASE WHEN … THEN geom` | short-circuit for 4326 | Skips PROJ entirely when output equals storage — the majority of requests |
| Allow-list | `OUTPUT_SRIDS` | Prevents an arbitrary EPSG code reaching PROJ and raising a 500 |
| `&&` versus `ST_Intersects` | `&&` | Bounding-box overlap only; cheaper, and adequate when the envelope is the filter |

Short-circuiting the identity case matters more than it looks: on a service where 80 % of traffic wants 4326, the `CASE` removes four fifths of all PROJ work for one line of SQL.

The precision argument deserves the same scrutiny. It is the cheapest payload reduction available and the one most often left at the default.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of response size for 500 features against the decimal precision passed to ST_AsGeoJSON, falling from 1.42 megabytes at the default to 386 kilobytes at six places" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Payload size by ST_AsGeoJSON precision, 500 polygon features</title>
  <desc>Five bars. The default of fifteen significant digits produces 1420 kilobytes. Nine decimal places produce 690 kilobytes. Seven produce 470. Six produce 386, marked as the recommended setting at roughly eleven centimetres of ground resolution. Four produce 318 kilobytes but resolve only to eleven metres, which is too coarse for parcel boundaries.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Response size for 500 polygon features, gzip off</text>
  <line x1="120" y1="44" x2="120" y2="168" stroke="currentColor" stroke-width="1.1"/>
  <text x="112" y="60" text-anchor="end" font-size="10.5" fill="currentColor">default (15)</text>
  <rect x="120" y="48" width="540" height="17" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="668" y="61" font-size="10.5" fill="currentColor">1 420 KB</text>
  <text x="112" y="86" text-anchor="end" font-size="10.5" fill="currentColor">9 dp</text>
  <rect x="120" y="74" width="262" height="17" rx="3" fill="var(--accent, #7c3aed)" opacity="0.6"/>
  <text x="390" y="87" font-size="10.5" fill="currentColor">690 KB</text>
  <text x="112" y="112" text-anchor="end" font-size="10.5" fill="currentColor">7 dp</text>
  <rect x="120" y="100" width="179" height="17" rx="3" fill="var(--accent, #7c3aed)" opacity="0.6"/>
  <text x="307" y="113" font-size="10.5" fill="currentColor">470 KB</text>
  <text x="112" y="138" text-anchor="end" font-size="10.5" font-weight="700" fill="currentColor">6 dp</text>
  <rect x="120" y="126" width="147" height="17" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="275" y="139" font-size="10.5" font-weight="700" fill="currentColor">386 KB — ≈11 cm, recommended</text>
  <text x="112" y="164" text-anchor="end" font-size="10.5" fill="currentColor">4 dp</text>
  <rect x="120" y="152" width="121" height="17" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="249" y="165" font-size="10.5" fill="currentColor">318 KB — ≈11 m, too coarse for parcels</text>
  <text x="20" y="196" font-size="10.5" fill="var(--muted, #7c6fb0)">Below six places the curve flattens: the saving stops while the error keeps growing.</text>
  <text x="20" y="212" font-size="10.5" fill="var(--muted, #7c6fb0)">Set it explicitly — the default is never the right answer for an API.</text>
</svg>

## Gotchas & Failure Modes

Most transform failures are domain-of-validity problems: the geometry is fine, but it sits outside the area the target system was defined for.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Latitude scale showing the usable band for Web Mercator and for the British National Grid against a global dataset" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Domain of validity by target projection</title>
  <desc>A vertical latitude scale from 90 degrees north to 90 degrees south. A global EPSG 4326 dataset covers the full range. Web Mercator EPSG 3857 covers only 85.06 north to 85.06 south, with the polar caps marked as a failure zone where coordinates diverge. The British National Grid EPSG 27700 covers roughly 49.8 to 61 degrees north, with everything outside marked as degraded accuracy rather than an error, which is why it fails silently.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Which latitudes each target system can actually represent</text>
  <line x1="70" y1="46" x2="70" y2="186" stroke="currentColor" stroke-width="1.1"/>
  <text x="62" y="52" text-anchor="end" font-size="10" fill="var(--muted, #7c6fb0)">90°N</text>
  <text x="62" y="120" text-anchor="end" font-size="10" fill="var(--muted, #7c6fb0)">0°</text>
  <text x="62" y="188" text-anchor="end" font-size="10" fill="var(--muted, #7c6fb0)">90°S</text>
  <text x="120" y="42" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">EPSG:4326</text>
  <rect x="92" y="46" width="56" height="140" rx="5" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="120" y="120" text-anchor="middle" font-size="10" fill="currentColor">all</text>
  <text x="120" y="204" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">storage</text>
  <text x="270" y="42" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">EPSG:3857</text>
  <rect x="242" y="46" width="56" height="12" rx="3" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.2"/>
  <rect x="242" y="58" width="56" height="116" rx="4" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <rect x="242" y="174" width="56" height="12" rx="3" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.2"/>
  <text x="270" y="118" text-anchor="middle" font-size="10" fill="currentColor">±85.06°</text>
  <text x="318" y="55" font-size="10" fill="var(--viz-bad, #a32b23)">diverges — clip before transforming</text>
  <text x="318" y="183" font-size="10" fill="var(--viz-bad, #a32b23)">diverges — clip before transforming</text>
  <text x="560" y="42" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">EPSG:27700</text>
  <rect x="532" y="46" width="56" height="24" rx="3" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.2"/>
  <rect x="532" y="70" width="56" height="18" rx="3" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <rect x="532" y="88" width="56" height="98" rx="3" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.2"/>
  <text x="608" y="82" font-size="10" fill="currentColor">49.8°–61°N only</text>
  <text x="608" y="104" font-size="10" fill="var(--viz-warn, #8a5000)">outside: no error,</text>
  <text x="608" y="118" font-size="10" fill="var(--viz-warn, #8a5000)">just wrong numbers</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">A national grid degrades quietly; Web Mercator fails loudly. Guard both at the API boundary, not in the renderer.</text>
</svg>

- **`ERROR: transform: couldn't project point … latitude or longitude exceeded limits`** — a coordinate outside the target system's domain of validity, typically a global dataset being pushed into a national grid. Clip to the projection's bounds first, or reject the request for out-of-area features.
- **Web Mercator above 85°.** `ST_Transform(geom, 3857)` on polar data produces coordinates that grow without bound and renderers cannot draw. Filter latitude to ±85.06 when the requested output is 3857.
- **Missing grid-shift files.** Transforms to national grids silently degrade from centimetre to metre accuracy when `proj-data` is absent from the image. Verify at startup with a round-trip assertion, and pin the package alongside the PostGIS version as described in [Pinning PostGIS Versions in Production Images](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/).
- **Cache keys that ignore the output system.** A cached 3857 payload served to a client that asked for 4326 is a silent 20 000 km error. Include the EPSG code in every cache key — see [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/).
- **Cold PROJ pipeline after a pool restart.** The first transform on each backend costs several milliseconds. Warm it in the connection-setup hook: `SELECT ST_Transform(ST_SetSRID(ST_MakePoint(0,0),4326), 3857)`.

### Advertising the systems you support

Clients should not have to discover the allow-list by trial and error. Expose it, and expose which one is the default, so an integrator can negotiate rather than guess:

```python
@router.get("/crs")
async def supported_crs() -> dict[str, object]:
    return {
        "default": STORAGE_SRID,
        "supported": [
            {"epsg": code, "decimals": dp,
             "uri": f"http://www.opengis.net/def/crs/EPSG/0/{code}"}
            for code, dp in sorted(OUTPUT_SRIDS.items())
        ],
    }
```

Using the OGC CRS URI form alongside the bare EPSG code costs nothing and makes the endpoint legible to OGC API Features clients, which expect that identifier shape. When a system is later added or withdrawn, this endpoint and the `crs` response member are the two places the change becomes visible to clients — treat a withdrawal as a breaking change and route it through the deprecation process in [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) rather than removing the code silently.

## Verification Snippet

Confirm both that the index is still used and that the coordinates actually moved:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT ST_AsGeoJSON(ST_Transform(geom, 3857), 2)
FROM   features
WHERE  geom && ST_MakeEnvelope(-0.2, 51.4, 0.0, 51.6, 4326)
LIMIT  200;
-- Expect: Index Scan using features_geom_gix …  (NOT Seq Scan)
```

```bash
# Same feature, two systems: the numbers must differ by orders of magnitude
curl -s "localhost:8000/v1/features?bbox=-0.2,51.4,0,51.6&limit=1&crs=4326" | jq '.features[0].geometry.coordinates'
# [-0.127761, 51.507351]
curl -s "localhost:8000/v1/features?bbox=-0.2,51.4,0,51.6&limit=1&crs=3857" | jq '.features[0].geometry.coordinates'
# [-14222.34, 6711533.9]
```

---

## Related

- [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/) — choosing the storage system this page projects out of
- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — how output precision interacts with format choice
- [Reading EXPLAIN ANALYZE for Spatial Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/) — confirming the index survived

← Back to [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/)
