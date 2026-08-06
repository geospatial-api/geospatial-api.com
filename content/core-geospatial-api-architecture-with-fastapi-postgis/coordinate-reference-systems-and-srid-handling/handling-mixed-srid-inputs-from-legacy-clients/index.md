---
layout: layouts/page.njk
title: "Handling Mixed SRID Inputs from Legacy Clients"
description: "Accept geometry from clients that send eastings, reversed axis order or no CRS at all — and normalise it to one storage SRID before it reaches the table."
slug: handling-mixed-srid-inputs-from-legacy-clients
type: howto
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "Coordinate Reference Systems & SRID Handling"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/"
  - label: "Handling Mixed SRID Inputs from Legacy Clients"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/handling-mixed-srid-inputs-from-legacy-clients/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Handling Mixed SRID Inputs from Legacy Clients",
      "description": "Accept geometry from clients that send eastings, reversed axis order or no CRS at all — and normalise it to one storage SRID before it reaches the table.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/handling-mixed-srid-inputs-from-legacy-clients/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 2, "name": "Coordinate Reference Systems & SRID Handling", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/" },
        { "@type": "ListItem", "position": 3, "name": "Handling Mixed SRID Inputs from Legacy Clients", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/handling-mixed-srid-inputs-from-legacy-clients/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Normalise Mixed-CRS Geometry at the API Boundary",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Require a declared CRS", "text": "Accept an explicit EPSG code per request and refuse to guess when it is absent and the coordinates are ambiguous." },
        { "@type": "HowToStep", "position": 2, "name": "Sanity-check the magnitudes", "text": "Reject values that cannot belong to the declared system, such as a six-digit easting labelled as degrees." },
        { "@type": "HowToStep", "position": 3, "name": "Transform once, on write", "text": "Convert to the storage SRID in the INSERT statement so no read path ever encounters a foreign system." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Can the API infer the CRS from the coordinate values?",
          "acceptedAnswer": { "@type": "Answer", "text": "Only to reject, never to accept. A pair like 530034, 180381 is certainly not degrees, so refusing it is safe. But 51.5, -0.13 could be longitude and latitude in either order, and a small projected system can produce values in the same range. Inference is a validation tool, not a substitute for a declared code." }
        },
        {
          "@type": "Question",
          "name": "How do I detect reversed axis order?",
          "acceptedAnswer": { "@type": "Answer", "text": "Check the ranges. Latitude cannot exceed 90, so any pair whose first element is outside that band while the second is inside it is reversed for a lon/lat contract. That catches most WFS and WMS clients that follow the strict EPSG axis definition. Reject with a clear message rather than swapping silently, because a point at 51.5, 0.13 is valid in both readings." }
        },
        {
          "@type": "Question",
          "name": "What should the API do with a geometry that has SRID 0?",
          "acceptedAnswer": { "@type": "Answer", "text": "Treat it as undeclared. Apply the declared request CRS with ST_SetSRID before transforming, and if no CRS was declared, return 422. Assuming 4326 for an unlabelled geometry is how projected coordinates end up stored as degrees, which is unrecoverable once the raw payload is gone." }
        }
      ]
    }
  ]
}
</script>

← Back to [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/)

# Handling mixed SRID inputs from legacy clients

This page shows how to accept writes from clients that disagree about coordinate systems — eastings from a survey tool, reversed axis order from a WFS client, unlabelled pairs from a spreadsheet import — and land them all in one storage SRID with no silent corruption.

## Context & When to Use

An API that only ever talks to its own front end can mandate GeoJSON in EPSG:4326 and be done. The moment it is exposed to third parties, that assumption fails in three specific ways. Survey and planning tools emit a national grid, because that is what their instruments and legal records use. Standards-compliant WFS clients emit latitude first, because that is what the EPSG registry defines for 4326, even though GeoJSON mandates the opposite. And bulk imports emit whatever was in the file, frequently with no system recorded anywhere.

None of these produce an error on ingest. A British National Grid easting of 530034 stored as a longitude is a point in the Pacific; a reversed pair is a point in the Indian Ocean. Both draw fine on a map, in the wrong place, and are only noticed weeks later by someone who knows the area. That is why the defences belong on the write path, before the row exists — the same reasoning behind the [Pydantic geometry validators](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) that reject malformed rings.

Use this pattern on every public write endpoint, and on bulk ingestion in particular, where a single mislabelled file can contaminate a million rows before anyone looks at a map.

## Runnable Implementation

```python
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

STORAGE_SRID = 4326
# Plausible coordinate magnitudes per system — used to REJECT, never to guess
SRID_BOUNDS: dict[int, tuple[float, float, float, float]] = {
    4326:  (-180.0, -90.0, 180.0, 90.0),
    3857:  (-20_037_509.0, -20_048_967.0, 20_037_509.0, 20_048_967.0),
    27700: (0.0, 0.0, 700_000.0, 1_300_000.0),      # British National Grid
    2154:  (-378_000.0, 6_000_000.0, 1_212_000.0, 7_230_000.0),  # Lambert-93
}


class GeometryIn(BaseModel):
    """A posted geometry plus the system its coordinates are expressed in."""

    type: Literal["Point", "LineString", "Polygon", "MultiPolygon"]
    coordinates: list[Any]
    crs: Annotated[int, Field(description="EPSG code of `coordinates`")] = STORAGE_SRID

    @model_validator(mode="after")
    def coordinates_must_suit_the_declared_crs(self) -> "GeometryIn":
        bounds = SRID_BOUNDS.get(self.crs)
        if bounds is None:
            raise ValueError(f"unsupported_crs: {self.crs}")
        minx, miny, maxx, maxy = bounds

        for x, y in _iter_positions(self.coordinates):
            if not (minx <= x <= maxx and miny <= y <= maxy):
                # Reversed axis order is the most likely cause for 4326 — say so
                if self.crs == 4326 and abs(x) <= 90 < abs(y) <= 180:
                    raise ValueError(
                        "axis_order: coordinates look like (lat, lon); "
                        "GeoJSON requires (lon, lat)"
                    )
                raise ValueError(
                    f"coordinate_out_of_range_for_crs: ({x}, {y}) cannot be EPSG:{self.crs}"
                )
        return self


def _iter_positions(coords: Any):
    """Yield every (x, y) pair from an arbitrarily nested coordinate array."""
    if coords and isinstance(coords[0], (int, float)):
        yield float(coords[0]), float(coords[1])
        return
    for part in coords:
        yield from _iter_positions(part)
```

The insert then labels and moves the coordinates in one statement — never one without the other:

```sql
INSERT INTO features (layer, geom)
VALUES (
  $1,
  -- $2 = GeoJSON text, $3 = the DECLARED EPSG code
  ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($2), $3), 4326)
)
RETURNING id, ST_SRID(geom) AS stored_srid;
```

<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Flow diagram of the write path showing four client shapes converging on one validation gate and a single transform into storage" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Four client dialects, one storage system</title>
  <desc>Four inbound shapes on the left: a GeoJSON client sending longitude and latitude, a WFS client sending latitude first, a survey tool sending British National Grid eastings and northings, and a spreadsheet import with no declared system. Each passes through a validation gate that checks the coordinate magnitudes against the declared code. Valid inputs are relabelled with ST_SetSRID and moved with ST_Transform into EPSG 4326 storage. The undeclared input is rejected with a 422 rather than assumed.</desc>
  <rect x="0" y="0" width="720" height="260" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Normalising on the write path</text>
  <rect x="16" y="42" width="176" height="38" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="28" y="60" font-size="10.5" font-weight="600" fill="currentColor">GeoJSON client</text>
  <text x="28" y="74" font-size="10" font-family="monospace" fill="var(--muted, #7c6fb0)">[-0.1276, 51.5072] crs=4326</text>
  <rect x="16" y="88" width="176" height="38" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="28" y="106" font-size="10.5" font-weight="600" fill="currentColor">WFS client</text>
  <text x="28" y="120" font-size="10" font-family="monospace" fill="var(--muted, #7c6fb0)">[51.5072, -0.1276] crs=4326</text>
  <rect x="16" y="134" width="176" height="38" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="28" y="152" font-size="10.5" font-weight="600" fill="currentColor">Survey tool</text>
  <text x="28" y="166" font-size="10" font-family="monospace" fill="var(--muted, #7c6fb0)">[530034, 180381] crs=27700</text>
  <rect x="16" y="180" width="176" height="38" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="28" y="198" font-size="10.5" font-weight="600" fill="currentColor">Spreadsheet import</text>
  <text x="28" y="212" font-size="10" font-family="monospace" fill="var(--muted, #7c6fb0)">[530034, 180381] crs=?</text>
  <path d="M192 61 L246 118" stroke="currentColor" stroke-width="1.3" marker-end="url(#mxArr)"/>
  <path d="M192 107 L246 124" stroke="currentColor" stroke-width="1.3" marker-end="url(#mxArr)"/>
  <path d="M192 153 L246 136" stroke="currentColor" stroke-width="1.3" marker-end="url(#mxArr)"/>
  <path d="M192 199 L246 142" stroke="currentColor" stroke-width="1.3" marker-end="url(#mxArr)"/>
  <rect x="248" y="96" width="164" height="72" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.6"/>
  <text x="330" y="118" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Magnitude gate</text>
  <text x="330" y="136" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">do the numbers fit</text>
  <text x="330" y="150" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">the declared code?</text>
  <path d="M412 118 L470 96" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5" marker-end="url(#mxArrOk)"/>
  <path d="M412 148 L470 196" stroke="var(--viz-bad, #a32b23)" stroke-width="1.5" marker-end="url(#mxArrBad)"/>
  <rect x="472" y="66" width="230" height="62" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="587" y="88" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">ST_SetSRID → ST_Transform</text>
  <text x="587" y="106" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">label, then move — never one alone</text>
  <text x="587" y="120" text-anchor="middle" font-size="10" fill="currentColor">stored as geometry(…, 4326)</text>
  <rect x="472" y="168" width="230" height="62" rx="8" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="587" y="190" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">422 unsupported / ambiguous</text>
  <text x="587" y="208" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">names the field and the likely cause</text>
  <text x="587" y="222" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">no row is written</text>
  <text x="20" y="248" font-size="10.5" fill="var(--muted, #7c6fb0)">The WFS client is caught by the axis-order branch: latitude first is detectable, so it gets a specific message.</text>
  <defs>
    <marker id="mxArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
    <marker id="mxArrOk" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="var(--viz-good, #1f6b3a)"/></marker>
    <marker id="mxArrBad" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="var(--viz-bad, #a32b23)"/></marker>
  </defs>
</svg>

## Key Parameters & Options

| Control | Setting | Why |
|---|---|---|
| `crs` parameter | required on write, defaulted on read | A default on write is what allows silent corruption |
| `SRID_BOUNDS` | per supported EPSG code | Cheap magnitude check that catches the three common dialects |
| Axis-order branch | 4326 only | Latitude above 90 is impossible, so the reading is unambiguous |
| `ST_SetSRID` | always paired with `ST_Transform` | Alone it relabels without moving — the classic corruption |
| Column type | `geometry(<type>, 4326)` | Database-level backstop for anything the API misses |

## Detection reliability by dialect

Not every wrong input is detectable. Knowing which ones slip through decides how much you invest in the rest of the pipeline.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart rating how reliably each kind of coordinate-system mistake can be detected from the values alone" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>How detectable each dialect mistake is from the numbers alone</title>
  <desc>Five failure modes rated. A projected coordinate labelled as degrees is caught essentially always, because six-digit values cannot be degrees. Reversed axis order is caught about 95 percent of the time, failing only when both values are under 90. A wrong national grid, such as Lambert-93 labelled as British National Grid, is caught about 70 percent of the time by bounds. Web Mercator labelled as 4326 is caught almost always. A point in the wrong hemisphere with a valid sign is never detectable and needs a business rule instead.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Detectability of each mistake from coordinate values alone</text>
  <line x1="290" y1="40" x2="290" y2="196" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="490" y1="40" x2="490" y2="196" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="690" y1="40" x2="690" y2="196" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="290" y="212" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">0 %</text>
  <text x="490" y="212" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">50 %</text>
  <text x="690" y="212" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">100 %</text>
  <text x="20" y="60" font-size="10.5" fill="currentColor">Eastings labelled as degrees</text>
  <rect x="290" y="48" width="400" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="282" y="60" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">~100 %</text>
  <text x="20" y="90" font-size="10.5" fill="currentColor">Web Mercator labelled 4326</text>
  <rect x="290" y="78" width="396" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="282" y="90" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">99 %</text>
  <text x="20" y="120" font-size="10.5" fill="currentColor">Reversed axis order</text>
  <rect x="290" y="108" width="380" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="282" y="120" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">95 %</text>
  <text x="20" y="150" font-size="10.5" fill="currentColor">Wrong national grid</text>
  <rect x="290" y="138" width="280" height="16" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="282" y="150" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">70 %</text>
  <text x="20" y="180" font-size="10.5" fill="currentColor">Valid values, wrong place</text>
  <rect x="290" y="168" width="4" height="16" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.85"/>
  <text x="282" y="180" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">0 %</text>
  <text x="20" y="232" font-size="10.5" fill="var(--muted, #7c6fb0)">The last row is why a coverage constraint — "features must fall inside the tenant's operating area" — belongs in the schema too.</text>
</svg>

That final case is the argument for a coverage `CHECK` constraint or an [row-level security](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) policy that bounds where a tenant may write: no value inspection catches a plausible point in the wrong country, but a business rule does.

## Gotchas & Failure Modes

- **`ERROR: Operation on mixed SRID geometries`** at query time means normalisation was skipped somewhere — usually a bulk path that writes with `COPY` and bypasses the API. Audit with `SELECT DISTINCT ST_SRID(geom) FROM features`.
- **Swapping axes automatically.** Tempting and wrong: a point at 51.5, 0.13 is valid either way, so a silent swap corrupts exactly the data it cannot verify. Reject with the axis-order message and let the client fix its request.
- **Defaulting `crs` on write.** A default turns "the client forgot" into "the server guessed". Make it required for writes even though it is defaulted for reads.
- **Bounds that are too tight.** Lambert-93 legitimately extends past mainland France to overseas grids; a bounds check calibrated only to Paris rejects valid data. Take the bounds from the EPSG area of use, not from the sample data.
- **`ST_GeomFromGeoJSON` on a `crs` member.** RFC 7946 removed it, and PostGIS ignores it. A client that helpfully embeds `"crs": {...}` in the geometry object will be silently ignored — read the system from your own parameter, never from the payload.

## What a rejection should tell the client

A 422 that says "invalid geometry" costs the integrator an afternoon. A 422 that names the field, echoes the value it rejected and states the likely cause is usually fixed on the next request. The error bodies in the verification section below follow that shape deliberately: each one is specific enough that the client can tell which of the three dialect problems it has without reading the API documentation.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of a vague rejection message and a specific one, with the integrator time each implies" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Two rejections for the same request</title>
  <desc>Two panels. On the left, a vague response reading invalid geometry with a 400 status, annotated as requiring the integrator to guess among coordinate order, wrong system and malformed payload, typically hours of work. On the right, a specific 422 naming the axis_order cause, echoing the received coordinates and stating the required order, annotated as a one-line client fix.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Same bad request, two error contracts</text>
  <rect x="16" y="40" width="330" height="132" rx="9" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6"/>
  <text x="32" y="62" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕ vague</text>
  <rect x="32" y="72" width="298" height="42" rx="5" fill="var(--viz-bad-soft, #fbe4e1)"/>
  <text x="44" y="90" font-size="10.5" font-family="monospace" fill="currentColor">400 Bad Request</text>
  <text x="44" y="106" font-size="10.5" font-family="monospace" fill="currentColor">{"error": "invalid geometry"}</text>
  <text x="32" y="134" font-size="10.5" fill="currentColor">Client must guess: order? system? payload?</text>
  <text x="32" y="154" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">typical time to fix: hours</text>
  <rect x="358" y="40" width="346" height="132" rx="9" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <text x="374" y="62" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓ specific</text>
  <rect x="374" y="72" width="314" height="56" rx="5" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="386" y="90" font-size="10.5" font-family="monospace" fill="currentColor">422 Unprocessable</text>
  <text x="386" y="105" font-size="10.5" font-family="monospace" fill="currentColor">axis_order: got (51.5072, -0.1276);</text>
  <text x="386" y="120" font-size="10.5" font-family="monospace" fill="currentColor">GeoJSON requires (lon, lat)</text>
  <text x="374" y="148" font-size="10.5" fill="currentColor">Cause named, value echoed, contract stated</text>
  <text x="374" y="166" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">typical time to fix: one line</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">Echoing the rejected value matters: it proves to the integrator what the server actually parsed, which is</text>
  <text x="20" y="214" font-size="10.5" fill="var(--muted, #7c6fb0)">often different from what they believe they sent.</text>
</svg>

## Verification Snippet

```bash
# Correct: declared national grid, transformed on write
curl -s -X POST localhost:8000/v1/features -H 'content-type: application/json' \
  -d '{"layer":"parcels","geometry":{"type":"Point","coordinates":[530034,180381],"crs":27700}}'
# {"id":8412,"stored_srid":4326}

# Reversed axis order: caught, with a specific message
curl -s -X POST localhost:8000/v1/features -H 'content-type: application/json' \
  -d '{"layer":"parcels","geometry":{"type":"Point","coordinates":[51.5072,-0.1276],"crs":4326}}'
# 422 {"detail":[{"msg":"Value error, axis_order: coordinates look like (lat, lon); GeoJSON requires (lon, lat)"}]}

# Eastings mislabelled as degrees: caught by magnitude
curl -s -X POST localhost:8000/v1/features -H 'content-type: application/json' \
  -d '{"layer":"parcels","geometry":{"type":"Point","coordinates":[530034,180381],"crs":4326}}'
# 422 {"detail":[{"msg":"Value error, coordinate_out_of_range_for_crs: (530034.0, 180381.0) cannot be EPSG:4326"}]}
```

```sql
-- The table should only ever hold one system
SELECT ST_SRID(geom) AS srid, count(*) FROM features GROUP BY 1;
--  srid | count
-- ------+--------
--  4326 | 412903
```

---

## Related

- [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/) — the storage decision these validators protect
- [Validating WKT and GeoJSON with Pydantic v2](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/) — the shape checks that run alongside these range checks
- [Handling Async File Uploads for Shapefile Processing](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/) — where mislabelled bulk data enters

← Back to [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/)
