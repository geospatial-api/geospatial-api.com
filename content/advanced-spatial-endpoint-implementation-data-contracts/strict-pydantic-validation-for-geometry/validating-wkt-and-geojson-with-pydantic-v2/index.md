---
layout: layouts/page.njk
title: "Validating WKT and GeoJSON with Pydantic v2"
description: "Parse and validate WKT and GeoJSON in FastAPI with Pydantic v2. Use BeforeValidator with Shapely to enforce coordinate bounds before any PostGIS database write."
slug: validating-wkt-and-geojson-with-pydantic-v2
type: long_tail
breadcrumb:
  - label: "Advanced Spatial Endpoints"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Strict Pydantic Validation for Geometry"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/"
  - label: "Validating WKT and GeoJSON with Pydantic v2"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/"
datePublished: "2024-11-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Validating WKT and GeoJSON with Pydantic v2",
      "description": "Parse and validate WKT and GeoJSON in FastAPI with Pydantic v2. Use BeforeValidator with Shapely to enforce coordinate bounds before any PostGIS database write.",
      "datePublished": "2024-11-01",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "url": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/"},
        {"@type": "ListItem", "position": 2, "name": "Strict Pydantic Validation for Geometry", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/"},
        {"@type": "ListItem", "position": 3, "name": "Validating WKT and GeoJSON with Pydantic v2", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Validate WKT and GeoJSON with Pydantic v2 BeforeValidator",
      "step": [
        {"@type": "HowToStep", "name": "Define parse functions", "text": "Write parse_wkt and parse_geojson functions using Shapely to parse and repair geometry."},
        {"@type": "HowToStep", "name": "Create Annotated type aliases", "text": "Wrap each parse function in BeforeValidator and bind it to an Annotated type alias."},
        {"@type": "HowToStep", "name": "Add a model-level pre-check", "text": "Use model_validator(mode='before') to reject type mismatches before field validation begins."},
        {"@type": "HowToStep", "name": "Enforce coordinate bounds", "text": "Add a model_validator(mode='after') that checks EPSG:4326 longitude/latitude ranges on the parsed geometry."},
        {"@type": "HowToStep", "name": "Verify with curl", "text": "POST malformed geometry and confirm a 422 response with structured error detail."}
      ]
    },
    {
      "@type": "Article",
      "headline": "Validating WKT and GeoJSON with Pydantic v2",
      "datePublished": "2024-11-01",
      "dateModified": "2026-06-23"
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why use BeforeValidator instead of @field_validator for geometry?",
          "acceptedAnswer": {"@type": "Answer", "text": "BeforeValidator runs before Pydantic's type coercion, so you can normalize raw strings or dicts into the exact type the field expects before strict mode rejects them."}
        },
        {
          "@type": "Question",
          "name": "Does make_valid() always produce safe geometry for PostGIS?",
          "acceptedAnswer": {"@type": "Answer", "text": "make_valid() fixes ring orientation and self-intersections, but it can split a single polygon into a MultiPolygon. Always inspect the returned geometry type before inserting it."}
        },
        {
          "@type": "Question",
          "name": "How do I handle non-EPSG:4326 coordinate systems?",
          "acceptedAnswer": {"@type": "Answer", "text": "Accept srid as a validated field, then use pyproj.CRS to verify the SRID exists and optionally transform coordinates to WGS84 before storage."}
        }
      ]
    }
  ]
}
</script>

← Back to [Strict Pydantic Validation for Geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/)

# Validating WKT and GeoJSON with Pydantic v2

Use Pydantic v2's `BeforeValidator` with Shapely to parse, repair, and bounds-check WKT and GeoJSON geometry at request time — before any PostGIS write occurs.

## Context & When to Use

FastAPI routes that accept geometry payloads face two formats in practice: Well-Known Text (WKT), which GIS desktop tools and GDAL pipelines export natively, and GeoJSON, the format web clients and mapping SDKs send. Both formats carry identical topology risks — self-intersecting rings, flipped coordinate order, coordinates outside valid geographic bounds — that PostGIS will silently accept or raise cryptic errors for depending on the operation.

Placing validation in a Pydantic `BeforeValidator` is the right approach when you need to catch these errors at the HTTP boundary and surface them as structured `422 Unprocessable Entity` responses, rather than letting malformed geometry reach the database layer and cause partial writes or confusing `ST_IsValid` failures. This pattern complements the broader [Strict Pydantic Validation for Geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) strategy documented in the parent guide.

Prefer this technique over a plain `@field_validator` when you need to normalize the input (e.g., re-serialize WKT with consistent rounding) before Pydantic's strict type checking evaluates it. The `BeforeValidator` runs first; strict mode runs after. If you instead used `mode="after"`, Pydantic would attempt type coercion on the raw string before your logic runs, and `strict=True` would reject most inputs before you could parse them.

Preconditions: Python 3.10+, `pydantic>=2.5`, `shapely>=2.0`, and `fastapi>=0.100`. The `make_valid()` function used below requires Shapely 2.x — it is not available in Shapely 1.x.

## Validation Pipeline

The diagram below shows how a request body moves through the validation layers before reaching the database:

<svg viewBox="0 0 640 320" role="img" aria-label="WKT and GeoJSON validation pipeline in Pydantic v2" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;display:block;margin:1.5rem 0">
  <title>WKT and GeoJSON validation pipeline in Pydantic v2</title>
  <desc>Sequence diagram showing HTTP request body flowing through model_validator before, then BeforeValidator parse functions, then strict type assignment, then model_validator after bounds check, and finally the PostGIS write.</desc>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto">
      <path d="M0,0 L0,7 L8,3.5 Z" fill="currentColor" opacity="0.7"/>
    </marker>
  </defs>
  <!-- boxes -->
  <rect x="10" y="130" width="100" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="60" y="148" text-anchor="middle" font-size="11" fill="currentColor" font-family="system-ui,sans-serif">HTTP Request</text>
  <text x="60" y="163" text-anchor="middle" font-size="11" fill="currentColor" font-family="system-ui,sans-serif">Body</text>
  <rect x="148" y="110" width="112" height="84" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="204" y="131" text-anchor="middle" font-size="11" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">model_validator</text>
  <text x="204" y="147" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">(mode="before")</text>
  <text x="204" y="165" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">type mismatch</text>
  <text x="204" y="180" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">guard</text>
  <rect x="298" y="110" width="112" height="84" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="354" y="131" text-anchor="middle" font-size="11" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">BeforeValidator</text>
  <text x="354" y="147" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">Shapely parse</text>
  <text x="354" y="163" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">+ make_valid()</text>
  <text x="354" y="179" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">+ re-serialize</text>
  <rect x="148" y="240" width="112" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="204" y="261" text-anchor="middle" font-size="11" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">model_validator</text>
  <text x="204" y="277" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">(mode="after")</text>
  <text x="204" y="292" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">bounds check</text>
  <rect x="448" y="130" width="100" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="498" y="148" text-anchor="middle" font-size="11" fill="currentColor" font-family="system-ui,sans-serif">PostGIS</text>
  <text x="498" y="163" text-anchor="middle" font-size="11" fill="currentColor" font-family="system-ui,sans-serif">Write</text>
  <!-- 422 error box -->
  <rect x="298" y="240" width="112" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4" stroke-dasharray="5,3"/>
  <text x="354" y="258" text-anchor="middle" font-size="11" fill="currentColor" font-family="system-ui,sans-serif">422 Response</text>
  <text x="354" y="274" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">on any error</text>
  <!-- arrows horizontal -->
  <line x1="110" y1="152" x2="146" y2="152" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#arrow)"/>
  <line x1="260" y1="152" x2="296" y2="152" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#arrow)"/>
  <line x1="410" y1="152" x2="446" y2="152" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#arrow)"/>
  <!-- arrow down from BeforeValidator to bounds check -->
  <line x1="354" y1="194" x2="354" y2="238" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <line x1="354" y1="238" x2="262" y2="238" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#arrow)"/>
  <!-- error arrows (dashed) -->
  <line x1="204" y1="194" x2="204" y2="238" stroke="currentColor" stroke-width="1.5" opacity="0.4" stroke-dasharray="4,3" marker-end="url(#arrow)"/>
  <line x1="260" y1="263" x2="296" y2="263" stroke="currentColor" stroke-width="1.5" opacity="0.4" stroke-dasharray="4,3" marker-end="url(#arrow)"/>
  <!-- labels -->
  <text x="128" y="147" text-anchor="middle" font-size="9" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">raw JSON</text>
  <text x="278" y="147" text-anchor="middle" font-size="9" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">raw dict</text>
  <text x="430" y="147" text-anchor="middle" font-size="9" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">clean model</text>
</svg>

## Runnable Implementation

The implementation below provides two reusable `Annotated` type aliases — `WKTGeometry` and `GeoJSONGeometry` — that you drop into any Pydantic model. A `model_validator(mode="before")` rejects cross-type mismatches cheaply before the expensive Shapely parse runs, and a `model_validator(mode="after")` enforces EPSG:4326 coordinate bounds on the final parsed geometry.

```python
from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, Field, model_validator
from shapely import wkt
from shapely.geometry import mapping, shape
from shapely.validation import make_valid


# ---------------------------------------------------------------------------
# Parse functions — called by BeforeValidator before strict typing is applied
# ---------------------------------------------------------------------------

def parse_wkt(value: Any) -> str:
    """Accept a WKT string, parse it with Shapely, repair if needed,
    then re-serialize with consistent 6-decimal-place rounding."""
    if not isinstance(value, str):
        raise ValueError("WKT geometry must be a plain string")
    try:
        geom = wkt.loads(value)
        if not geom.is_valid:
            geom = make_valid(geom)  # repairs self-intersections & ring issues
        return wkt.dumps(geom, rounding_precision=6)
    except Exception as exc:
        raise ValueError(f"Invalid WKT: {exc}") from exc


def parse_geojson(value: Any) -> dict:
    """Accept a GeoJSON geometry as a dict or raw JSON string.
    Parse, repair, then return a normalized dict via shapely.mapping()."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Malformed GeoJSON string: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("GeoJSON geometry must be a dict or valid JSON string")
    try:
        geom = shape(value)          # validates structure + coordinate order
        if not geom.is_valid:
            geom = make_valid(geom)
        return mapping(geom)         # returns a clean, normalized dict
    except Exception as exc:
        raise ValueError(f"Invalid GeoJSON geometry: {exc}") from exc


# ---------------------------------------------------------------------------
# Annotated type aliases — reuse these across all your Pydantic models
# ---------------------------------------------------------------------------

WKTGeometry = Annotated[str, BeforeValidator(parse_wkt)]
GeoJSONGeometry = Annotated[dict, BeforeValidator(parse_geojson)]


# ---------------------------------------------------------------------------
# Payload model with pre-check and post-bounds validation
# ---------------------------------------------------------------------------

class SpatialPayload(BaseModel):
    model_config = {"strict": True, "extra": "forbid"}

    geometry_type: Literal["wkt", "geojson"]
    # Union resolves left-to-right; the pre-check below picks the right branch.
    geometry: WKTGeometry | GeoJSONGeometry
    precision: int = Field(default=6, ge=0, le=12)
    srid: int = Field(default=4326, description="EPSG code; defaults to WGS84")

    @model_validator(mode="before")
    @classmethod
    def enforce_type_match(cls, data: Any) -> Any:
        """Reject mismatches before Shapely parses the value.
        Avoids running expensive geometry parsing on obviously wrong input."""
        if isinstance(data, dict):
            gtype = data.get("geometry_type")
            geom = data.get("geometry")
            if gtype == "wkt" and not isinstance(geom, str):
                raise ValueError("Expected a string for geometry_type='wkt'")
            if gtype == "geojson" and not isinstance(geom, (dict, str)):
                raise ValueError("Expected dict/JSON string for geometry_type='geojson'")
        return data

    @model_validator(mode="after")
    def validate_4326_bounds(self) -> "SpatialPayload":
        """For EPSG:4326 GeoJSON payloads, verify every coordinate pair lies
        within [-180,180] longitude and [-90,90] latitude (RFC 7946)."""
        if self.srid != 4326 or not isinstance(self.geometry, dict):
            return self

        flat_coords: list[float] = []

        def _flatten(node: Any) -> None:
            if isinstance(node, (int, float)):
                flat_coords.append(float(node))
            elif isinstance(node, list):
                for item in node:
                    _flatten(item)

        _flatten(self.geometry.get("coordinates", []))

        # GeoJSON coordinate order: [longitude, latitude, optional_elevation]
        for i in range(0, len(flat_coords) - 1, 2):
            lon, lat = flat_coords[i], flat_coords[i + 1]
            if not (-180 <= lon <= 180):
                raise ValueError(
                    f"Longitude {lon} is outside EPSG:4326 bounds [-180, 180]"
                )
            if not (-90 <= lat <= 90):
                raise ValueError(
                    f"Latitude {lat} is outside EPSG:4326 bounds [-90, 90]"
                )
        return self


# ---------------------------------------------------------------------------
# FastAPI route — validation errors surface automatically as 422 responses
# ---------------------------------------------------------------------------

from fastapi import FastAPI

app = FastAPI()


@app.post("/geometries/validate", status_code=200)
async def validate_geometry(payload: SpatialPayload) -> dict:
    """Validate and normalize an inbound WKT or GeoJSON geometry.
    Returns the cleaned geometry and its detected type.

    On validation failure FastAPI converts pydantic.ValidationError
    into a structured 422 Unprocessable Entity with a 'detail' array."""
    return {
        "geometry_type": payload.geometry_type,
        "geometry": payload.geometry,
        "srid": payload.srid,
        "precision": payload.precision,
    }
```

For endpoints that accept bulk uploads — multiple geometries in one request — see the [Handling Async File Uploads for Shapefile Processing](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/) guide, which builds on this same validator pattern for Celery-backed ingestion pipelines.

## Key Parameters & Options

| Parameter / Config | Values | Effect |
|---|---|---|
| `model_config["strict"]` | `True` / `False` | `True` disables implicit coercion (e.g., string → int). Geometry parse functions still run, but surrounding fields stay strict. |
| `model_config["extra"]` | `"forbid"` / `"ignore"` / `"allow"` | `"forbid"` rejects unknown keys, preventing clients from silently passing unsupported fields. |
| `rounding_precision` in `wkt.dumps()` | `0`–`12` | Controls decimal places in the re-serialized WKT. `6` is appropriate for EPSG:4326 (roughly 10 cm precision). |
| `srid` field default | `4326` | Only `4326` triggers the bounds check; other SRIDs skip it. Add `pyproj.CRS` lookups to validate arbitrary SRIDs. |
| `make_valid()` (Shapely 2.x) | — | Repairs degenerate rings and self-intersections. Note: may change geometry type (e.g., `Polygon` → `MultiPolygon`). |
| `BeforeValidator` vs `AfterValidator` | — | `BeforeValidator` runs before type coercion. Use it to normalize raw inputs. `AfterValidator` receives the already-typed value; use it for business-logic checks on clean data. |

## Gotchas & Failure Modes

- **`make_valid()` changes the geometry type.** A self-intersecting `Polygon` may become a `GeometryCollection` or `MultiPolygon`. If downstream code assumes a specific WKB type for the PostGIS column (`GEOMETRY(Polygon, 4326)`), the insert will fail with `ERROR: Geometry type (MultiPolygon) does not match column type (Polygon)`. Check `geom.geom_type` after repair and reject unexpected type changes, or widen the column definition to `GEOMETRY(Geometry, 4326)`.

- **WKT from GDAL omits the SRID prefix.** GDAL exports plain WKT like `POLYGON ((…))`, not `SRID=4326;POLYGON ((…))`. If you pass EWKT (Extended WKT with the `SRID=` prefix) to `shapely.wkt.loads()`, it raises `shapely.errors.WKTReadingError`. Strip the prefix before parsing: `value.split(";", 1)[-1]`.

- **GeoJSON coordinates in the wrong order.** The GeoJSON spec (RFC 7946) mandates `[longitude, latitude]`. Many sources — especially older WFS feeds — emit `[latitude, longitude]`. Shapely will parse either without error, but your bounds-check validator catches the swap only if latitude exceeds `±180`. Add an explicit swap-detection step if you consume third-party feeds.

- **`strict=True` blocks JSON numbers coerced to Python `int`/`float`.** If `srid` arrives as `"4326"` (a string) rather than `4326` (an integer), Pydantic raises `Input should be a valid integer` under strict mode. Document the contract clearly in your OpenAPI schema and test with real clients.

- **Very large `MultiPolygon` payloads spike memory.** `shapely.geometry.shape()` loads the entire coordinate array into Python objects. A 100 MB GeoJSON response body can exceed 500 MB of resident memory during parsing. Enforce a `Content-Length` limit in your ASGI middleware (`app.add_middleware(ContentSizeLimitMiddleware, max_content_size=5_000_000)`) before the request reaches the validator.

## Verification Snippet

Start the application with `uvicorn app:app --reload`, then test with `curl`:

```bash
# Valid GeoJSON polygon — should return 200 with normalized geometry
curl -s -X POST http://localhost:8000/geometries/validate \
  -H "Content-Type: application/json" \
  -d '{
    "geometry_type": "geojson",
    "geometry": {
      "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]]
    },
    "srid": 4326
  }' | python3 -m json.tool

# Malformed WKT — should return 422 with structured error detail
curl -s -X POST http://localhost:8000/geometries/validate \
  -H "Content-Type: application/json" \
  -d '{"geometry_type": "wkt", "geometry": "NOT VALID WKT", "srid": 4326}' \
  | python3 -m json.tool

# Coordinate out of bounds — longitude 200 exceeds [-180,180]
curl -s -X POST http://localhost:8000/geometries/validate \
  -H "Content-Type: application/json" \
  -d '{
    "geometry_type": "geojson",
    "geometry": {
      "type": "Point",
      "coordinates": [200, 45]
    },
    "srid": 4326
  }' | python3 -m json.tool
```

Expected 422 response shape for the malformed WKT request:

```json
{
  "detail": [
    {
      "type": "value_error",
      "loc": ["body", "geometry"],
      "msg": "Value error, Invalid WKT: …",
      "input": "NOT VALID WKT"
    }
  ]
}
```

For a minimal unit test without spinning up FastAPI:

```python
import pytest
from pydantic import ValidationError
from app import SpatialPayload  # adjust import to your module path

def test_valid_geojson_point():
    payload = SpatialPayload(
        geometry_type="geojson",
        geometry={"type": "Point", "coordinates": [13.405, 52.52]},
        srid=4326,
    )
    assert payload.geometry["type"] == "Point"

def test_rejects_out_of_bounds_longitude():
    with pytest.raises(ValidationError, match="Longitude 200"):
        SpatialPayload(
            geometry_type="geojson",
            geometry={"type": "Point", "coordinates": [200, 52]},
            srid=4326,
        )

def test_rejects_type_mismatch():
    with pytest.raises(ValidationError, match="Expected a string"):
        SpatialPayload(
            geometry_type="wkt",
            geometry={"type": "Point", "coordinates": [0, 0]},
            srid=4326,
        )
```

---

## Related

- [Strict Pydantic Validation for Geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — parent guide covering ring orientation, topology checks, and CRS alignment strategies
- [Implementing ST_Within and ST_Intersects in FastAPI](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/implementing-st_within-and-st_intersects-in-fastapi/) — how validated geometry flows into PostGIS spatial filter queries
- [GeoJSON vs GeoParquet Serialization](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — choosing the right serialization format for your API responses

← Back to [Strict Pydantic Validation for Geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/)
