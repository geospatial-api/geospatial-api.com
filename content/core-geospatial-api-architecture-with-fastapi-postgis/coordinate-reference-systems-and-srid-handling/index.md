---
layout: layouts/page.njk
title: "Coordinate Reference Systems & SRID Handling"
description: "Choose a storage SRID, transform coordinates at the API boundary, and stop silent reprojection bugs in FastAPI and PostGIS. Covers EPSG:4326 vs 3857, geography vs geometry, and ST_Transform placement."
slug: coordinate-reference-systems-and-srid-handling
type: topic
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "Coordinate Reference Systems & SRID Handling"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Coordinate Reference Systems & SRID Handling",
      "description": "Choose a storage SRID, transform coordinates at the API boundary, and stop silent reprojection bugs in FastAPI and PostGIS.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com" },
      "url": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/"
    },
    {
      "@type": "Article",
      "headline": "Coordinate Reference Systems & SRID Handling",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 3, "name": "Coordinate Reference Systems & SRID Handling", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Handle Coordinate Reference Systems in a FastAPI and PostGIS API",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Pin one storage SRID", "text": "Declare a single storage SRID in the column type so every row is typed and no mixed-SRID rows can be inserted." },
        { "@type": "HowToStep", "position": 2, "name": "Validate the input CRS", "text": "Accept an explicit CRS parameter, reject unknown codes with 422, and transform the input geometry to the storage SRID before any predicate runs." },
        { "@type": "HowToStep", "position": 3, "name": "Measure in a metric system", "text": "Cast to geography or transform to a projected SRID for distance, length and area, never in degrees." },
        { "@type": "HowToStep", "position": 4, "name": "Transform on output only", "text": "Apply ST_Transform in the SELECT list after filtering so the GiST index still serves the predicate." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Should I store geometry in EPSG:4326 or EPSG:3857?",
          "acceptedAnswer": { "@type": "Answer", "text": "Store in EPSG:4326 unless every consumer is a web map. 4326 is the interchange standard used by GeoJSON, it loses no information, and PostGIS can transform to 3857 on output in microseconds per feature. Storing in 3857 bakes Web Mercator distortion into the data, breaks polar coverage beyond about 85 degrees of latitude, and forces a reverse transform for any client that expects longitude and latitude." }
        },
        {
          "@type": "Question",
          "name": "Why does ST_Distance return a tiny number like 0.0134?",
          "acceptedAnswer": { "@type": "Answer", "text": "The geometry is in EPSG:4326, so the result is in degrees, not metres. Degrees are not a unit of length: one degree of longitude is about 111 km at the equator and about 55 km at 60 degrees north. Cast both arguments to geography, or transform them to a metric projected SRID, before calling ST_Distance." }
        },
        {
          "@type": "Question",
          "name": "Does ST_Transform stop PostGIS using the spatial index?",
          "acceptedAnswer": { "@type": "Answer", "text": "It does when it wraps the indexed column inside the predicate. ST_Intersects(ST_Transform(geom, 3857), bounds) forces a per-row transform and a sequential scan. Transform the constant side of the comparison instead, or add a functional index on the transformed expression if the projected form is queried constantly." }
        },
        {
          "@type": "Question",
          "name": "What does SRID 0 mean on a geometry column?",
          "acceptedAnswer": { "@type": "Answer", "text": "SRID 0 means undefined: the coordinates carry no declared reference system. PostGIS will refuse to compare an SRID 0 geometry with a 4326 geometry and raises the error operation on mixed SRID geometries. It usually appears after loading WKT without an SRID prefix, and the fix is to set the SRID explicitly with ST_SetSRID when the true system is known." }
        }
      ]
    }
  ]
}
</script>

← Back to [Core Geospatial API Architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/)

# Coordinate reference systems and SRID handling

Every spatial API makes one irreversible decision on its first day: which coordinate reference system the geometry column is typed in. Get it right and reprojection is a cheap output-side concern; get it wrong and you inherit distorted distances, mixed-SRID errors that only fire in production, and sequential scans on tables that have a perfectly good index. This page covers the decision itself, the transformation rules that keep queries index-backed, and the validation layer that stops a client's unlabelled coordinates from silently corrupting a dataset.

The problem is subtle because nothing crashes. A polygon stored in EPSG:3857 but labelled 4326 still draws on a map; it just draws in the wrong place, several hundred kilometres from where the surveyor put it. A distance filter written in degrees still returns rows; it just returns the wrong ones, and the error scales with latitude. These are data-integrity failures wearing the costume of a working feature, which is why the defences belong in the schema and in the [Pydantic geometry validators](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) at the edge rather than in a code review checklist.

## Prerequisites & Environment

The examples assume PostgreSQL 15 or 16 with PostGIS 3.3+, `proj` 9.x, FastAPI 0.110+, SQLAlchemy 2.0, and asyncpg 0.29. Confirm the PROJ database is present before relying on any transform — a container built without `proj-data` can resolve EPSG:4326 and EPSG:3857 from the built-in tables while failing on national grids such as EPSG:27700 or EPSG:2154:

```sql
-- Version and PROJ availability
SELECT postgis_full_version();

-- Does the target system resolve at all?
SELECT srid, auth_name, proj4text
FROM   spatial_ref_sys
WHERE  srid IN (4326, 3857, 27700, 2154);

-- Round-trip sanity check: transform out and back, expect sub-millimetre drift
SELECT ST_Distance(
         ST_SetSRID(ST_MakePoint(-0.1276, 51.5072), 4326)::geography,
         ST_Transform(
           ST_Transform(ST_SetSRID(ST_MakePoint(-0.1276, 51.5072), 4326), 27700),
           4326)::geography
       ) AS round_trip_error_m;
```

A round-trip error above a millimetre means the grid-shift files are missing and PROJ has fallen back to a coarse seven-parameter approximation. That is a deployment bug, not a data bug — pin the PostGIS image tag and the `proj-data` package together, as covered in [Pinning PostGIS Versions in Production Images](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/).

## Decision Matrix: which system to store in

The storage SRID is a schema decision with API-wide consequences. The table below compares the four candidates that come up in practice for a general-purpose feature API.

| Storage choice | Units | Best for | Cost |
|---|---|---|---|
| `geometry(Point, 4326)` | degrees | Interchange, GeoJSON output, mixed clients | Distance and area need a cast to `geography` or a transform |
| `geometry(Point, 3857)` | metres (distorted) | Tile pipelines where every read is a web map | Area and distance wrong by `1/cos(latitude)`; unusable above 85° |
| `geography(Point, 4326)` | metres (true) | Global proximity search, "within 5 km" endpoints | Fewer supported functions; ~30–50 % slower on large polygon overlays |
| `geometry(Point, <local grid>)` | metres (accurate) | National datasets with a legal grid (27700, 2154, 25832) | Every non-local client needs a transform; cross-border data breaks |

For most APIs the answer is `geometry(…, 4326)` with a cast to `geography` at the point of measurement. It keeps the stored value identical to what clients send and receive, and confines the projection question to the two or three endpoints that actually measure something.

<svg viewBox="0 0 720 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision tree for choosing a storage coordinate system: start from whether the data is global or national, then whether measurement or tile rendering dominates" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Choosing a storage coordinate reference system</title>
  <desc>A decision tree. The first question asks whether the dataset spans one national grid or the whole globe. National datasets with a legal grid lead to a local projected SRID. Global datasets branch on the dominant workload: measurement-heavy APIs lead to geography over EPSG:4326, tile-only pipelines lead to EPSG:3857, and everything else lands on geometry in EPSG:4326, marked as the default answer.</desc>
  <rect x="0" y="0" width="720" height="300" fill="var(--surface, #f5f3ff)" rx="10"/>
  <rect x="250" y="16" width="220" height="42" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="360" y="35" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Where does the data live?</text>
  <text x="360" y="50" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">extent of the dataset</text>
  <path d="M310 58 L180 92" stroke="currentColor" stroke-width="1.4" fill="none" marker-end="url(#crsArrow)"/>
  <path d="M410 58 L540 92" stroke="currentColor" stroke-width="1.4" fill="none" marker-end="url(#crsArrow)"/>
  <text x="212" y="79" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">one country</text>
  <text x="512" y="79" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">global / mixed</text>
  <rect x="40" y="96" width="250" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="165" y="117" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Legal national grid required?</text>
  <text x="165" y="134" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">cadastral, survey, planning data</text>
  <path d="M165 148 L165 186" stroke="currentColor" stroke-width="1.4" fill="none" marker-end="url(#crsArrow)"/>
  <text x="176" y="171" font-size="10" fill="var(--muted, #7c6fb0)">yes</text>
  <rect x="40" y="190" width="250" height="52" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.3"/>
  <text x="165" y="211" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">geometry(&lt;local grid&gt;)</text>
  <text x="165" y="228" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">27700 · 2154 · 25832 — transform on output</text>
  <rect x="410" y="96" width="270" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="545" y="117" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">What dominates the workload?</text>
  <text x="545" y="134" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">measure · render · exchange</text>
  <path d="M470 148 L400 186" stroke="currentColor" stroke-width="1.4" fill="none" marker-end="url(#crsArrow)"/>
  <path d="M545 148 L545 186" stroke="currentColor" stroke-width="1.4" fill="none" marker-end="url(#crsArrow)"/>
  <path d="M620 148 L676 186" stroke="currentColor" stroke-width="1.4" fill="none" marker-end="url(#crsArrow)"/>
  <rect x="318" y="190" width="140" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="388" y="210" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">geography</text>
  <text x="388" y="226" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">proximity search</text>
  <text x="388" y="240" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">true metres</text>
  <rect x="472" y="190" width="146" height="70" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="545" y="210" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">geometry 4326</text>
  <text x="545" y="226" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">the default answer</text>
  <text x="545" y="240" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">cast when measuring</text>
  <rect x="632" y="190" width="76" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="670" y="210" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">3857</text>
  <text x="670" y="226" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">tiles only</text>
  <text x="670" y="240" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">no polar data</text>
  <text x="360" y="285" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">Storage is one decision; output projection is per-endpoint and cheap.</text>
  <defs>
    <marker id="crsArrow" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

The tree above resolves the storage question. Everything after it is mechanical: transform on the way out, measure in metres, and never let an unlabelled coordinate reach the table.

## Why degrees are not a unit of length

The single most common spatial bug in a young API is a distance filter written against a 4326 geometry. PostGIS answers the question you asked — the Cartesian distance between two points on a longitude/latitude plane — and that answer is in degrees. Because a degree of longitude shrinks with the cosine of latitude, the same numeric radius covers a wildly different ground distance depending on where the user is standing.

<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart showing how the ground distance covered by one degree of longitude shrinks from 111.3 kilometres at the equator to 38.2 kilometres at 70 degrees north" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Ground distance of one degree of longitude by latitude</title>
  <desc>A horizontal bar chart. One degree of longitude spans 111.3 km at the equator, 96.5 km at 30 degrees, 78.7 km at 45 degrees, 55.8 km at 60 degrees and 38.2 km at 70 degrees. A note records that one degree of latitude stays near 111 km everywhere, so a radius expressed in degrees is elliptical on the ground.</desc>
  <rect x="0" y="0" width="720" height="260" fill="var(--surface, #f5f3ff)" rx="10"/>
  <text x="20" y="28" font-size="13" font-weight="700" fill="currentColor">One degree of longitude, measured on the ground</text>
  <line x1="120" y1="46" x2="120" y2="206" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="300" y1="46" x2="300" y2="206" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="480" y1="46" x2="480" y2="206" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="660" y1="46" x2="660" y2="206" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="120" y="222" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">0 km</text>
  <text x="300" y="222" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">40 km</text>
  <text x="480" y="222" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">80 km</text>
  <text x="660" y="222" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">120 km</text>
  <text x="112" y="62" text-anchor="end" font-size="11" fill="currentColor">0° equator</text>
  <rect x="120" y="50" width="501" height="16" rx="3" fill="var(--accent, #7c3aed)" opacity="0.85"/>
  <text x="631" y="62" font-size="10.5" fill="currentColor">111.3 km</text>
  <text x="112" y="90" text-anchor="end" font-size="11" fill="currentColor">30° Cairo</text>
  <rect x="120" y="78" width="434" height="16" rx="3" fill="var(--accent, #7c3aed)" opacity="0.72"/>
  <text x="564" y="90" font-size="10.5" fill="currentColor">96.5 km</text>
  <text x="112" y="118" text-anchor="end" font-size="11" fill="currentColor">45° Milan</text>
  <rect x="120" y="106" width="354" height="16" rx="3" fill="var(--accent, #7c3aed)" opacity="0.6"/>
  <text x="484" y="118" font-size="10.5" fill="currentColor">78.7 km</text>
  <text x="112" y="146" text-anchor="end" font-size="11" fill="currentColor">60° Oslo</text>
  <rect x="120" y="134" width="251" height="16" rx="3" fill="var(--accent, #7c3aed)" opacity="0.48"/>
  <text x="381" y="146" font-size="10.5" fill="currentColor">55.8 km</text>
  <text x="112" y="174" text-anchor="end" font-size="11" fill="currentColor">70° Tromsø</text>
  <rect x="120" y="162" width="172" height="16" rx="3" fill="var(--accent, #7c3aed)" opacity="0.36"/>
  <text x="302" y="174" font-size="10.5" fill="currentColor">38.2 km</text>
  <line x1="120" y1="190" x2="660" y2="190" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4" stroke-dasharray="5,3"/>
  <text x="126" y="203" font-size="10.5" fill="var(--viz-warn, #8a5000)">1° of latitude stays ≈111 km everywhere — so a "0.05°" radius is an ellipse, not a circle</text>
  <text x="20" y="246" font-size="10.5" fill="var(--muted, #7c6fb0)">Values are 111.32 km × cos(latitude) on the WGS 84 ellipsoid.</text>
</svg>

The practical rule: the moment an endpoint accepts a radius, a tolerance, an area threshold or a buffer, that number is in metres and the query must run in a metric system. Use `geography` for point-to-point work and a projected SRID for heavy polygon overlays. The [K-Nearest Neighbor Routing Algorithms](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) topic covers the ordering side of the same problem, where the `<->` operator returns degrees for geometry and metres for geography.

## Step-by-Step Implementation

### 1. Pin the storage SRID in the column type

An untyped `geometry` column accepts anything: a 4326 point, a 3857 point and an SRID-0 point can coexist in the same table, and the failure only surfaces when a query compares two of them.

```sql
CREATE TABLE features (
    id          bigserial PRIMARY KEY,
    layer       text NOT NULL,
    -- Typed: PostgreSQL rejects any insert whose SRID is not 4326
    geom        geometry(MultiPolygon, 4326) NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX features_geom_gix ON features USING GIST (geom);
-- Second index for metric proximity queries against the same column
CREATE INDEX features_geog_gix ON features USING GIST ((geom::geography));
```

The typed column is the cheapest validation in the stack: it is enforced by the database, applies to every writer including migrations and manual `psql` sessions, and costs nothing at query time. Auditing an existing table for stragglers takes one query:

```sql
SELECT ST_SRID(geom) AS srid, count(*)
FROM   features
GROUP  BY 1
ORDER  BY 2 DESC;
```

### 2. Accept a declared input CRS and reject the rest

GeoJSON deliberately removed the `crs` member in RFC 7946 and mandates 4326, but real clients still post state-plane coordinates into a field labelled `geometry`. Accept an explicit query parameter, validate it against an allow-list, and fail loudly on anything else.

```python
from typing import Annotated
from fastapi import Depends, HTTPException, Query

# Only systems the API is prepared to transform from
SUPPORTED_SRIDS: dict[int, str] = {
    4326: "WGS 84 lon/lat",
    3857: "Web Mercator",
    27700: "OSGB36 / British National Grid",
    2154: "RGF93 / Lambert-93",
}
STORAGE_SRID = 4326


def input_srid(
    crs: Annotated[int, Query(description="EPSG code of the posted geometry")] = STORAGE_SRID,
) -> int:
    if crs not in SUPPORTED_SRIDS:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "unsupported_crs",
                "received": crs,
                "supported": sorted(SUPPORTED_SRIDS),
            },
        )
    return crs
```

Returning 422 with the supported list turns a silent 300-metre offset into a client-side fix on the first request. Pair it with the geometry-shape validation described in [Validating WKT and GeoJSON with Pydantic v2](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/), which rejects malformed rings before the coordinates ever reach PostGIS.

### 3. Transform inbound, once, at the boundary

Normalise on write. Every geometry that lands in the table is already in the storage SRID, so no read path ever has to think about it.

```sql
INSERT INTO features (layer, geom)
VALUES (
  $1,
  -- $2 is GeoJSON text, $3 the client's declared EPSG code
  ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($2), $3), 4326)
)
RETURNING id;
```

`ST_SetSRID` labels the coordinates; `ST_Transform` moves them. Calling `ST_SetSRID` alone is the classic corruption path — it relabels 3857 metres as degrees, producing a point somewhere past the edge of the map with no error raised.

### 4. Keep the predicate on the raw column

Transform placement decides whether the query uses the index. The predicate must compare the stored column against a constant that has already been transformed into storage space, not the other way round.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of two query shapes: transforming the indexed column forces a sequential scan, while transforming the constant keeps the GiST index scan" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where ST_Transform sits decides whether the index is used</title>
  <desc>Two query plans side by side. On the left, ST_Transform wraps the indexed geom column inside ST_Intersects, so the planner cannot use the GiST index and performs a sequential scan over 4.2 million rows. On the right, ST_Transform is applied to the constant bounds instead, so the predicate compares the raw column and the planner runs an index scan touching about 900 rows.</desc>
  <rect x="0" y="0" width="720" height="250" fill="var(--surface, #f5f3ff)" rx="10"/>
  <rect x="16" y="16" width="336" height="218" rx="9" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6"/>
  <text x="34" y="40" font-size="12.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕ transform wraps the column</text>
  <rect x="34" y="52" width="300" height="46" rx="6" fill="var(--viz-bad-soft, #fbe4e1)"/>
  <text x="46" y="70" font-size="10.5" font-family="monospace" fill="currentColor">WHERE ST_Intersects(</text>
  <text x="58" y="84" font-size="10.5" font-family="monospace" fill="currentColor">ST_Transform(geom, 3857), $bounds)</text>
  <text x="34" y="120" font-size="11" fill="currentColor">Planner cannot match the index expression</text>
  <rect x="34" y="130" width="300" height="26" rx="5" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.2"/>
  <text x="46" y="148" font-size="10.5" font-family="monospace" fill="currentColor">Seq Scan on features</text>
  <text x="34" y="178" font-size="11" fill="currentColor">rows scanned</text>
  <text x="334" y="178" text-anchor="end" font-size="13" font-weight="700" fill="var(--viz-bad, #a32b23)">4 200 000</text>
  <text x="34" y="202" font-size="11" fill="currentColor">execution time</text>
  <text x="334" y="202" text-anchor="end" font-size="13" font-weight="700" fill="var(--viz-bad, #a32b23)">6 480 ms</text>
  <text x="34" y="222" font-size="10" fill="var(--muted, #7c6fb0)">one reprojection per row, then a filter</text>
  <rect x="368" y="16" width="336" height="218" rx="9" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <text x="386" y="40" font-size="12.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓ transform wraps the constant</text>
  <rect x="386" y="52" width="300" height="46" rx="6" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="398" y="70" font-size="10.5" font-family="monospace" fill="currentColor">WHERE ST_Intersects(geom,</text>
  <text x="410" y="84" font-size="10.5" font-family="monospace" fill="currentColor">ST_Transform($bounds, 4326))</text>
  <text x="386" y="120" font-size="11" fill="currentColor">Predicate matches features_geom_gix</text>
  <rect x="386" y="130" width="300" height="26" rx="5" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.2"/>
  <text x="398" y="148" font-size="10.5" font-family="monospace" fill="currentColor">Index Scan using features_geom_gix</text>
  <text x="386" y="178" font-size="11" fill="currentColor">rows scanned</text>
  <text x="686" y="178" text-anchor="end" font-size="13" font-weight="700" fill="var(--viz-good, #1f6b3a)">912</text>
  <text x="386" y="202" font-size="11" fill="currentColor">execution time</text>
  <text x="686" y="202" text-anchor="end" font-size="13" font-weight="700" fill="var(--viz-good, #1f6b3a)">7.3 ms</text>
  <text x="386" y="222" font-size="10" fill="var(--muted, #7c6fb0)">one reprojection total, before the scan</text>
</svg>

The measurements come from a 4.2 million row parcel table on a `db.r6g.large`-class instance; the ratio, not the absolute number, is the point. Reading these plans is covered in depth in [Reading EXPLAIN ANALYZE for Spatial Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/).

If a projected form really is queried on every request — a tile server reading 3857 exclusively — add a functional index instead of moving the transform:

```sql
CREATE INDEX features_geom_3857_gix
    ON features USING GIST (ST_Transform(geom, 3857));
```

That index is only usable when the query expression matches exactly, and it doubles the write cost of the table, so reach for it after measuring rather than before.

### 5. Project on output, next to the serializer

Output projection belongs in the `SELECT` list, after filtering and pagination have already cut the row count down. Combine it with the serialization decision described in [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) so the coordinate precision matches the format.

```sql
SELECT id,
       layer,
       ST_AsGeoJSON(
         CASE WHEN $2::int = 4326 THEN geom
              ELSE ST_Transform(geom, $2::int) END,
         6   -- 6 decimal places ≈ 0.11 m; more is noise for most APIs
       )::json AS geometry
FROM   features
WHERE  ST_Intersects(geom, ST_MakeEnvelope($3, $4, $5, $6, 4326))
ORDER  BY id
LIMIT  $7;
```

## Production Code Example

A complete FastAPI route that accepts a client CRS for both input bounds and output geometry, keeps the predicate index-backed, and measures in metres.

```python
import json
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

router = APIRouter(prefix="/v1/features", tags=["features"])

STORAGE_SRID = 4326
SUPPORTED_SRIDS = {4326, 3857, 27700, 2154}

FEATURES_SQL = """
SELECT f.id,
       f.layer,
       ST_AsGeoJSON(
         CASE WHEN $6::int = 4326 THEN f.geom ELSE ST_Transform(f.geom, $6::int) END,
         6
       )::json                                        AS geometry,
       -- Metric distance from the viewport centre: cast, never subtract degrees
       ROUND(ST_Distance(
         f.geom::geography,
         ST_Centroid(ST_MakeEnvelope($1, $2, $3, $4, 4326))::geography
       )::numeric, 1)                                 AS distance_m
FROM   features f
-- Predicate compares the RAW column, so features_geom_gix is usable
WHERE  ST_Intersects(f.geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
ORDER  BY f.id
LIMIT  $5
"""


def validated_srid(code: int, field: str) -> int:
    if code not in SUPPORTED_SRIDS:
        raise HTTPException(
            status_code=422,
            detail={"error": "unsupported_crs", "field": field, "received": code,
                    "supported": sorted(SUPPORTED_SRIDS)},
        )
    return code


async def get_pool() -> asyncpg.Pool:      # wired at app startup
    raise NotImplementedError


@router.get("")
async def list_features(
    bbox: Annotated[str, Query(description="minx,miny,maxx,maxy in bbox_crs")],
    bbox_crs: Annotated[int, Query(description="EPSG code of the bbox")] = 4326,
    out_crs: Annotated[int, Query(description="EPSG code for returned geometry")] = 4326,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    validated_srid(bbox_crs, "bbox_crs")
    validated_srid(out_crs, "out_crs")

    try:
        minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(422, detail={"error": "bbox_must_be_four_numbers"})
    if minx >= maxx or miny >= maxy:
        raise HTTPException(422, detail={"error": "bbox_min_must_precede_max"})

    async with pool.acquire() as conn:
        if bbox_crs != STORAGE_SRID:
            # Transform the CONSTANT into storage space — one call, not one per row
            minx, miny, maxx, maxy = await conn.fetchrow(
                """
                SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e)
                FROM  (SELECT ST_Transform(
                                ST_MakeEnvelope($1, $2, $3, $4, $5), 4326) AS e) t
                """,
                minx, miny, maxx, maxy, bbox_crs,
            )

        rows = await conn.fetch(FEATURES_SQL, minx, miny, maxx, maxy, limit, out_crs)

    return {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": f"EPSG:{out_crs}"}},
        "features": [
            {
                "type": "Feature",
                "id": r["id"],
                "geometry": json.loads(r["geometry"]),
                "properties": {"layer": r["layer"], "distance_m": float(r["distance_m"])},
            }
            for r in rows
        ],
    }
```

Two details carry most of the value. The bounding box is transformed once, in a single round trip, before the main query runs — so the predicate still matches the index. And `distance_m` casts to `geography` rather than subtracting degrees, so the number means the same thing in Oslo as it does in Nairobi.

## Verification & Testing

Reprojection bugs are invisible to eyeball testing, so test them numerically. Assert against known control points with published coordinates in both systems.

```python
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

# Nelson's Column, London — published 4326 and OSGB36 grid coordinates
LON, LAT = -0.12776, 51.50735
EASTING, NORTHING = 530034.0, 180381.0


@pytest.mark.asyncio
async def test_bng_bbox_matches_wgs84_bbox(seeded_db):
    """The same viewport expressed in two systems returns the same features."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        wgs = await client.get("/v1/features", params={
            "bbox": f"{LON - 0.01},{LAT - 0.01},{LON + 0.01},{LAT + 0.01}"})
        bng = await client.get("/v1/features", params={
            "bbox": f"{EASTING - 700},{NORTHING - 1100},{EASTING + 700},{NORTHING + 1100}",
            "bbox_crs": 27700})

    assert wgs.status_code == bng.status_code == 200
    wgs_ids = {f["id"] for f in wgs.json()["features"]}
    bng_ids = {f["id"] for f in bng.json()["features"]}
    # Allow a small edge difference from the non-identical footprints
    assert len(wgs_ids ^ bng_ids) <= 2


@pytest.mark.asyncio
async def test_unknown_crs_is_rejected(seeded_db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        r = await client.get("/v1/features", params={"bbox": "0,0,1,1", "bbox_crs": 99999})
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "unsupported_crs"
```

The database side deserves an assertion too. This query fails loudly if any row has drifted out of the declared system:

```sql
-- Should return zero rows on a healthy table
SELECT id, ST_SRID(geom)
FROM   features
WHERE  ST_SRID(geom) <> 4326
LIMIT  10;
```

Wire both checks into the pipeline described in [GitHub Actions Integration Tests with a PostGIS Service Container](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/github-actions-integration-tests-with-a-postgis-service-container/) so a reprojection regression fails the build rather than the map.

## Failure Modes & Edge Cases

1. **`ERROR: Operation on mixed SRID geometries`** — two operands carry different SRIDs, usually because a constant was built with `ST_GeomFromText` without the SRID argument. Always pass it: `ST_GeomFromText('POINT(0 0)', 4326)`.
2. **`ST_SetSRID` used where `ST_Transform` was meant.** The coordinates do not move, only the label. Symptom: features land in the Gulf of Guinea (0, 0) or several hundred kilometres off. There is no error and no way to recover the original values once the raw import is gone.
3. **Axis order confusion.** EPSG:4326 formally defines latitude first, but GeoJSON, PostGIS and every web map use longitude first. A WMS or WFS client following the strict definition sends the pair reversed, producing points in the wrong hemisphere. Validate that latitude is within ±90 and reject the request rather than clamping.
4. **Antimeridian-crossing bounding boxes.** `ST_MakeEnvelope(179, -1, -179, 1, 4326)` produces an envelope that wraps the entire globe the wrong way. Split the request into two envelopes at ±180 and union the result sets.
5. **`geography` distance on huge polygons.** `ST_Distance` on `geography` uses geodesic maths and is markedly slower for complex polygons. For polygon-to-polygon work at national scale, transform both operands to a local equal-area projection instead.
6. **Missing grid-shift files.** Transformations to national grids silently degrade from centimetre to metre accuracy when `proj-data` is absent. The round-trip query in the prerequisites section is the canary — run it in a startup health check.
7. **Precision inflation.** `ST_AsGeoJSON(geom)` defaults to 15 significant digits, which triples payload size for no benefit. Six decimal places is roughly 11 cm; specify it explicitly.

## Performance Notes

`ST_Transform` costs roughly 1–3 µs per simple geometry once PROJ has cached the transformation pipeline, and the first call per connection pays an extra 2–10 ms while that pipeline is built. On a pooled connection this warm-up is amortised away, but it does show up as a latency spike after a [PgBouncer](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) restart in transaction pooling mode, where every backend is effectively cold.

Casting to `geography` is free in storage terms — it is the same coordinates with different semantics — but it needs its own GiST index, since a `geometry` index cannot serve a `geography` predicate. Budget roughly 15–20 % of the table's size for the second index and measure whether the proximity endpoint justifies it.

For output projection at volume, transforming 10 000 features in the `SELECT` list adds around 20–30 ms. That is usually cheaper than transforming client-side, but if the same viewport is requested repeatedly it is cheaper still to cache the projected payload, which is exactly what [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) is for — include the output EPSG code in the cache key so a 3857 response never gets served to a 4326 client.

---

## Related

- [Spatial Resource Modeling Patterns](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) — where the geometry column sits in the wider resource design
- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — coordinate precision and format selection on output
- [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — rejecting malformed and out-of-range coordinates at the edge
- [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — the index behaviour that transform placement protects
- [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — how to change a default output system without breaking clients

← Back to [Core Geospatial API Architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/)
