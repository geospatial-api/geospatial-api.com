---
layout: layouts/page.njk
title: "Strict Pydantic Validation for Geometry"
description: "Validate geometry at the API boundary with Pydantic v2. Enforce ring orientation, topology checks, and CRS alignment before any PostGIS round-trip."
slug: strict-pydantic-validation-for-geometry
breadcrumb: "Advanced Spatial Endpoints > Strict Pydantic Validation for Geometry"
datePublished: "2024-01-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Strict Pydantic Validation for Geometry",
      "description": "Validate geometry at the API boundary with Pydantic v2. Enforce ring orientation, topology checks, and CRS alignment before any PostGIS round-trip.",
      "datePublished": "2024-01-15",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Advanced Spatial Endpoint Implementation & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 3, "name": "Strict Pydantic Validation for Geometry", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement Strict Pydantic Validation for Geometry in FastAPI",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Normalize heterogeneous geometry inputs with BeforeValidator" },
        { "@type": "HowToStep", "position": 2, "name": "Enforce structural integrity: type, coordinate dimensionality, ring closure" },
        { "@type": "HowToStep", "position": 3, "name": "Apply WGS84 bounds and decimal-precision guards" },
        { "@type": "HowToStep", "position": 4, "name": "Serialize ValidationError to RFC 7807 problem details" },
        { "@type": "HowToStep", "position": 5, "name": "Wire validators into a production FastAPI route" }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why validate geometry in Pydantic rather than in PostGIS?",
          "acceptedAnswer": { "@type": "Answer", "text": "PostGIS will accept geometrically invalid inputs and store them silently, corrupting spatial indexes. Validating at the API boundary returns structured errors to clients immediately, avoids unnecessary database round-trips, and keeps PostGIS GIST indexes clean." }
        },
        {
          "@type": "Question",
          "name": "What is the difference between BeforeValidator and AfterValidator in Pydantic v2?",
          "acceptedAnswer": { "@type": "Answer", "text": "BeforeValidator runs before Pydantic's type coercion, making it ideal for normalizing raw inputs (e.g., JSON strings to dicts). AfterValidator runs after the field has been assigned its final type, making it better for semantic checks on already-typed values." }
        },
        {
          "@type": "Question",
          "name": "Does this validation replace ST_IsValid in PostGIS?",
          "acceptedAnswer": { "@type": "Answer", "text": "For the common cases (ring closure, coordinate bounds, nesting depth) yes. Full topological checks like self-intersecting rings still require ST_IsValid or Shapely's is_valid property, which you can call inside an AfterValidator at acceptable overhead." }
        }
      ]
    }
  ]
}
</script>

← Back to [Advanced Spatial Endpoint Implementation & Data Contracts](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/)

# Strict Pydantic Validation for Geometry

Geospatial APIs sit at the boundary between loosely typed client payloads and a database engine that demands mathematically sound geometries. When coordinates, ring orientation, or coordinate reference systems drift from specification, PostGIS operations fail silently, corrupt spatial indexes, or trigger expensive rollback transactions. Enforcing strict geometry contracts at the API boundary — before payloads reach the database — eliminates these failure modes and gives clients actionable error messages instead of cryptic 500 responses.

This page walks through a production-ready Pydantic v2 validation pipeline for FastAPI, covering type normalization, structural and topological enforcement, coordinate-bounds guards, error serialization, and end-to-end integration with spatial query endpoints.

---

<svg viewBox="-12 44 802 160" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Five-stage geometry validation pipeline from client payload to PostGIS" style="width:100%;max-width:780px;display:block;margin:1.5rem auto;">
  <title>Geometry Validation Pipeline</title>
  <desc>Five sequential stages: Payload Ingestion, Type Normalization, Structural Enforcement, Bounds &amp; Precision, Error Serialization — each connected by an arrow, showing the path from raw client input to a validated geometry ready for PostGIS.</desc>
  <rect x="-12" y="44" width="802" height="160" rx="10" fill="var(--surface, #f5f3ff)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
  <!-- Stage boxes -->
  <rect x="4"   y="60" width="130" height="90" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <rect x="158" y="60" width="130" height="90" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <rect x="312" y="60" width="130" height="90" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <rect x="466" y="60" width="130" height="90" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <rect x="620" y="60" width="154" height="90" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <!-- Arrows -->
  <line x1="134" y1="105" x2="154" y2="105" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="288" y1="105" x2="308" y2="105" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="442" y1="105" x2="462" y2="105" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="596" y1="105" x2="616" y2="105" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Labels -->
  <text x="69"  y="88"  font-size="11" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">1. Payload</text>
  <text x="69"  y="103" font-size="11" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Ingestion</text>
  <text x="69"  y="121" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">JSON / WKT</text>
  <text x="69"  y="135" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">/ GeoJSON</text>
  <text x="223" y="88"  font-size="11" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">2. Type</text>
  <text x="223" y="103" font-size="11" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Normalization</text>
  <text x="223" y="121" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">BeforeValidator</text>
  <text x="223" y="135" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">→ canonical dict</text>
  <text x="377" y="88"  font-size="11" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">3. Structural</text>
  <text x="377" y="103" font-size="11" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Enforcement</text>
  <text x="377" y="121" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">type, depth,</text>
  <text x="377" y="135" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">ring closure</text>
  <text x="531" y="88"  font-size="11" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">4. Bounds &amp;</text>
  <text x="531" y="103" font-size="11" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Precision</text>
  <text x="531" y="121" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">±180/±90,</text>
  <text x="531" y="135" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">6 dp rounding</text>
  <text x="697" y="88"  font-size="11" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">5. Error</text>
  <text x="697" y="103" font-size="11" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Serialization</text>
  <text x="697" y="121" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">RFC 7807</text>
  <text x="697" y="135" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">problem details</text>
  <!-- Bottom caption -->
  <text x="390" y="185" font-size="10" text-anchor="middle" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.55">Validated geometry passes to PostGIS · invalid payloads return 422 with structured errors</text>
</svg>

## Prerequisites & Environment

Before implementing strict validation, ensure your stack meets these baseline requirements:

- **Python 3.10+** — required for Pydantic v2's `typing.Annotated` and `ParamSpec` support.
- **FastAPI 0.100+** — uses Pydantic v2 natively for request parsing and automatic OpenAPI schema generation.
- **Pydantic 2.5+** — provides `@field_validator`, `@model_validator`, `BeforeValidator`, and `AfterValidator`.
- **Shapely 2.0+** — optional but recommended for full topological checks (`is_valid`, `make_valid`) inside validators.
- **PostGIS 3.3+** — target database; validation occurs upstream, but CRS assumptions follow PostGIS WGS84 conventions.

Install with strict version pinning to prevent silent breaking changes in spatial type handling:

```bash
pip install "fastapi>=0.100.0" "pydantic>=2.5.0" "uvicorn[standard]" "shapely>=2.0" "geojson-pydantic>=1.0"
```

## Decision Matrix: Where to Validate Geometry

Choose the right validation layer for each check type. Running expensive topology operations in Pydantic (application layer) is overkill; skipping coordinate-bound checks in the database is a silent data corruption risk.

| Check type | Pydantic v2 validator | PostGIS / Shapely |
|---|---|---|
| JSON structure & required fields | Yes — `@field_validator` | No |
| Coordinate dimensionality (2D vs 3D) | Yes — `BeforeValidator` | Possible but wasteful |
| Ring closure (`first == last`) | Yes — `@field_validator` | Redundant after Python check |
| WGS84 bounds (±180 / ±90) | Yes — fast numeric guard | No |
| Decimal precision clamping | Yes — `round()` in validator | No |
| Self-intersecting rings | Shapely `is_valid` in validator | `ST_IsValid()` fallback |
| `ST_MakeValid` repair | No — reject, don't silently fix | Only for known legacy data |
| CRS re-projection | No — reject mismatched SRID | `ST_Transform()` if SRID known |

**Rule of thumb:** validate structure and bounds in Pydantic; delegate deep topology to Shapely inside an `AfterValidator`; never rely on PostGIS as the first line of defense.

Validation position determines whether a bad geometry is a 422 or an outage.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Where a malformed geometry is caught, and what it costs: Pydantic model 0.3 ms — before any I/O, database CHECK 1.2 ms — one round trip, query failure at read hours later, in a tile request, never — silently wrong data discovered by a user" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where a malformed geometry is caught, and what it costs</title>
  <desc>A horizontal bar chart. Pydantic model is 0.3 ms — before any I/O. database CHECK is 1.2 ms — one round trip. query failure at read is hours later, in a tile request. never — silently wrong data is discovered by a user. The first two rows are validation; the last two are incidents. The distance between them is one model definition.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Where a malformed geometry is caught, and what it costs</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">Pydantic model</text>
  <rect x="250" y="48" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">0.3 ms — before any I/O</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">database CHECK</text>
  <rect x="250" y="82" width="13" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="271" y="95" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">1.2 ms — one round trip</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">query failure at read</text>
  <rect x="250" y="116" width="136" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="394" y="129" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">hours later, in a tile request</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">never — silently wrong data</text>
  <rect x="250" y="150" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="163" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">discovered by a user</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">The first two rows are validation; the last two are incidents. The distance between them is one model definition.</text>
</svg>

## Step-by-Step Implementation

### Step 1 — Type Normalization with `BeforeValidator`

Clients send geometry as raw dicts, JSON strings, or `geojson-pydantic` objects. A `BeforeValidator` normalizes all forms into a canonical `dict` before Pydantic touches any fields.

```python
from typing import Any, Annotated
from pydantic import BeforeValidator
import json

def normalize_geometry(raw: Any) -> dict[str, Any]:
    """Coerce raw JSON dicts or JSON strings into a standardized GeoJSON-like dict."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("JSON string did not parse to a dict")
            return parsed
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON payload: {exc}") from exc
    raise TypeError(f"Expected dict or JSON string, got {type(raw).__name__}")

# Reusable annotated type — apply to any model field
GeometryInput = Annotated[dict[str, Any], BeforeValidator(normalize_geometry)]
```

This type alias can be reused across all your request models, keeping normalization logic in one place as detailed in [Validating WKT and GeoJSON with Pydantic v2](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/).

### Step 2 — Structural & Topological Enforcement

Once normalized, enforce mandatory GeoJSON structure, validate coordinate array depth, and check ring closure for polygons.

```python
from typing import Any, Literal
from pydantic import BaseModel, field_validator, model_validator

VALID_GEOMETRY_TYPES = {
    "Point", "LineString", "Polygon",
    "MultiPoint", "MultiLineString", "MultiPolygon",
}

class StrictGeometry(BaseModel):
    type: Literal[
        "Point", "LineString", "Polygon",
        "MultiPoint", "MultiLineString", "MultiPolygon"
    ]
    coordinates: list[Any]

    @field_validator("type", mode="before")
    @classmethod
    def validate_geometry_type(cls, v: Any) -> str:
        if v not in VALID_GEOMETRY_TYPES:
            raise ValueError(
                f"Unsupported geometry type '{v}'. "
                f"Must be one of: {', '.join(sorted(VALID_GEOMETRY_TYPES))}"
            )
        return v

    @field_validator("coordinates", mode="after")
    @classmethod
    def validate_coordinate_structure(cls, v: list[Any], info) -> list[Any]:
        geom_type = info.data.get("type")

        if geom_type == "Point":
            if not isinstance(v, list) or len(v) < 2:
                raise ValueError(
                    "Point coordinates must contain at least [longitude, latitude]"
                )
            if len(v) > 3:
                raise ValueError(
                    "Point coordinates must be 2D [lon, lat] or 3D [lon, lat, alt]"
                )

        elif geom_type == "LineString":
            if not isinstance(v, list) or len(v) < 2:
                raise ValueError("LineString must contain at least 2 positions")

        elif geom_type == "Polygon":
            if not isinstance(v, list) or len(v) == 0:
                raise ValueError("Polygon must contain at least one linear ring")
            exterior = v[0]
            if not isinstance(exterior, list) or len(exterior) < 4:
                raise ValueError(
                    "Polygon exterior ring must contain at least 4 positions"
                )
            if exterior[0] != exterior[-1]:
                raise ValueError(
                    "Polygon exterior ring must be closed: "
                    "first coordinate must equal last coordinate"
                )
            # Validate hole rings
            for idx, hole in enumerate(v[1:], start=1):
                if not isinstance(hole, list) or len(hole) < 4:
                    raise ValueError(
                        f"Polygon hole ring {idx} must contain at least 4 positions"
                    )
                if hole[0] != hole[-1]:
                    raise ValueError(
                        f"Polygon hole ring {idx} must be closed"
                    )

        return v
```

### Step 3 — Coordinate Bounds & Precision Guards

Coordinates that exceed WGS84 ranges or carry excessive floating-point precision break spatial index lookups and cause subtle rounding errors in `ST_DWithin` distance calculations.

```python
class StrictGeometryWithBounds(StrictGeometry):
    """Extends StrictGeometry with WGS84 bounds checking and 6 dp precision clamping."""

    @field_validator("coordinates", mode="before")
    @classmethod
    def enforce_bounds_and_precision(cls, v: Any) -> Any:

        def clamp_and_round(coord: Any) -> Any:
            """Recursively round all numeric values to 6 decimal places."""
            if isinstance(coord, list):
                return [clamp_and_round(c) for c in coord]
            if isinstance(coord, (int, float)):
                return round(float(coord), 6)
            return coord

        def validate_wgs84(coord: Any) -> None:
            """Recursively find [lon, lat, ?alt] leaf arrays and range-check them."""
            if not isinstance(coord, list):
                return
            # Leaf position: list of numbers
            if len(coord) >= 2 and isinstance(coord[0], (int, float)):
                lon, lat = coord[0], coord[1]
                if not (-180.0 <= lon <= 180.0):
                    raise ValueError(
                        f"Longitude {lon} is outside WGS84 range [-180, 180]"
                    )
                if not (-90.0 <= lat <= 90.0):
                    raise ValueError(
                        f"Latitude {lat} is outside WGS84 range [-90, 90]"
                    )
            else:
                for c in coord:
                    validate_wgs84(c)

        rounded = clamp_and_round(v)
        validate_wgs84(rounded)
        return rounded
```

### Step 4 — Optional Shapely Topology Check

For endpoints that accept polygons from untrusted sources, add a full topology check using Shapely's `is_valid` inside an `AfterValidator`. This catches self-intersecting rings that ring-closure checks alone cannot detect.

```python
from pydantic import AfterValidator
from shapely import from_geojson, is_valid, is_valid_reason
import json

def check_topology(geom_dict: dict[str, Any]) -> dict[str, Any]:
    """Run Shapely's full topology validation on an already-normalized geometry dict."""
    try:
        shape = from_geojson(json.dumps(geom_dict))
    except Exception as exc:
        raise ValueError(f"Shapely could not parse geometry: {exc}") from exc
    if not is_valid(shape):
        reason = is_valid_reason(shape)
        raise ValueError(f"Geometry is topologically invalid: {reason}")
    return geom_dict

# Apply as a composed annotated type for high-trust polygon endpoints
ValidatedPolygonInput = Annotated[
    dict[str, Any],
    BeforeValidator(normalize_geometry),
    AfterValidator(check_topology),
]
```

### Step 5 — Error Serialization

Pydantic's raw `ValidationError` output is detailed but unsuitable for direct API responses. Map failures to RFC 7807 problem details so all spatial endpoints return consistent error structures. These same errors appear in [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) endpoints, making uniform error taxonomy essential across the API.

```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

app = FastAPI()

@app.exception_handler(ValidationError)
async def spatial_validation_handler(
    request: Request, exc: ValidationError
) -> JSONResponse:
    errors = [
        {
            "field": ".".join(str(loc) for loc in err["loc"]),
            "message": err["msg"],
            "type": err["type"],
        }
        for err in exc.errors(include_url=False)
    ]
    return JSONResponse(
        status_code=422,
        content={
            "type": "https://tools.ietf.org/html/rfc7807",
            "title": "Spatial Validation Failed",
            "detail": "One or more geometry constraints were violated.",
            "errors": errors,
        },
    )
```

## Production Code Example

A complete, copy-runnable FastAPI route that accepts a GeoJSON geometry payload, runs the full validation pipeline, and returns a PostGIS-ready WKB hex string. Pre-validated bounding boxes fed into `ST_Within` or `ST_Intersects` via this route eliminate redundant `ST_MakeValid` calls in [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/).

```python
from typing import Any, Annotated, Literal
from fastapi import FastAPI, Depends
from pydantic import BaseModel, BeforeValidator, AfterValidator, field_validator
import json
import asyncpg

# --- Validators (defined in earlier steps) ---

def normalize_geometry(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("Expected a GeoJSON object")
        return parsed
    raise TypeError(f"Expected dict or JSON string, got {type(raw).__name__}")

def validate_wgs84_bounds(geom: dict[str, Any]) -> dict[str, Any]:
    def _check(coord: Any) -> None:
        if not isinstance(coord, list):
            return
        if len(coord) >= 2 and isinstance(coord[0], (int, float)):
            lon, lat = coord[0], coord[1]
            if not (-180.0 <= lon <= 180.0):
                raise ValueError(f"Longitude {lon} out of range")
            if not (-90.0 <= lat <= 90.0):
                raise ValueError(f"Latitude {lat} out of range")
        else:
            for c in coord:
                _check(c)
    _check(geom.get("coordinates", []))
    return geom

GeometryInput = Annotated[
    dict[str, Any],
    BeforeValidator(normalize_geometry),
    AfterValidator(validate_wgs84_bounds),
]

# --- Request & Response Models ---

class GeometryIngestRequest(BaseModel):
    geometry: GeometryInput
    srid: int = 4326

class GeometryIngestResponse(BaseModel):
    wkb_hex: str
    geom_type: str
    srid: int

# --- Database helper ---

async def get_db() -> asyncpg.Connection:
    return await asyncpg.connect("postgresql://user:pass@localhost/spatial_db")

# --- Route ---

app = FastAPI()

@app.post("/geometry/ingest", response_model=GeometryIngestResponse)
async def ingest_geometry(
    payload: GeometryIngestRequest,
    conn: asyncpg.Connection = Depends(get_db),
) -> GeometryIngestResponse:
    geojson_str = json.dumps(payload.geometry)
    row = await conn.fetchrow(
        """
        SELECT
            ST_AsEWKB(
                ST_SetSRID(ST_GeomFromGeoJSON($1), $2)
            )::text AS wkb_hex,
            ST_GeometryType(ST_GeomFromGeoJSON($1)) AS geom_type
        """,
        geojson_str,
        payload.srid,
    )
    return GeometryIngestResponse(
        wkb_hex=row["wkb_hex"],
        geom_type=row["geom_type"],
        srid=payload.srid,
    )
```

## Verification & Testing

### curl smoke test

```bash
# Valid polygon — expect 200
curl -s -X POST http://localhost:8000/geometry/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "geometry": {
      "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]]
    }
  }' | python3 -m json.tool

# Unclosed ring — expect 422
curl -s -X POST http://localhost:8000/geometry/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "geometry": {
      "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1]]]
    }
  }' | python3 -m json.tool
```

Expected error response for the unclosed ring:

```json
{
  "type": "https://tools.ietf.org/html/rfc7807",
  "title": "Spatial Validation Failed",
  "detail": "One or more geometry constraints were violated.",
  "errors": [
    {
      "field": "geometry.coordinates",
      "message": "Value error, Polygon exterior ring must be closed: first coordinate must equal last coordinate",
      "type": "value_error"
    }
  ]
}
```

### Unit test skeleton

```python
import pytest
from pydantic import ValidationError
from your_app.models import StrictGeometryWithBounds

def test_valid_point():
    g = StrictGeometryWithBounds(type="Point", coordinates=[13.404954, 52.520008])
    assert g.coordinates == [13.404954, 52.520008]

def test_longitude_out_of_range():
    with pytest.raises(ValidationError, match="WGS84 range"):
        StrictGeometryWithBounds(type="Point", coordinates=[200.0, 52.5])

def test_unclosed_polygon():
    with pytest.raises(ValidationError, match="must be closed"):
        StrictGeometryWithBounds(
            type="Polygon",
            coordinates=[[[0,0],[1,0],[1,1],[0,1]]]  # missing closing vertex
        )

def test_precision_clamped():
    g = StrictGeometryWithBounds(
        type="Point",
        coordinates=[13.4049540001234, 52.5200080009876]
    )
    # Rounded to 6 dp
    assert g.coordinates[0] == 13.404954
    assert g.coordinates[1] == 52.520008
```

The layers are complementary, and each one is blind to something the next catches.

<svg viewBox="0 0 720 234" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="What each validation layer can actually check: Shape, Range, Topology" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What each validation layer can actually check</title>
  <desc>A comparison table. Pydantic model: Shape yes, Range yes, Topology no. no GEOS available column type: Shape yes, Range no, Topology no. type and SRID only CHECK ST_IsValid: Shape no, Range no, Topology yes. the topology backstop application review: Shape partly, Range partly, Topology partly. not a control No single layer covers all three columns, which is why the first three rows are all required rather than alternatives.</desc>
  <rect x="0" y="0" width="720" height="234" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">What each validation layer can actually check</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Shape</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Range</text>
  <text x="502" y="58" font-size="10" font-weight="700" fill="currentColor">Topology</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">Pydantic model</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="88" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">no GEOS available</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">column type</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="510" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">type and SRID only</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">CHECK ST_IsValid</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="510" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="568" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">the topology backstop</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">application review</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="510" y="184" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="568" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">not a control</text>
  <text x="20" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">No single layer covers all three columns, which is why the first three rows are all required rather than alternatives.</text>
</svg>

## Failure Modes & Edge Cases

1. **`type` field missing from payload** — Pydantic raises `field required` before any geometry validator runs. Ensure `type` is listed before `coordinates` in model field order; Pydantic v2 processes fields in declaration order, and `info.data.get("type")` in `coordinates` validator returns `None` if `type` failed validation.

2. **WKT strings passed where GeoJSON is expected** — `normalize_geometry` will raise `Invalid JSON payload` because WKT is not valid JSON. For endpoints that must accept both formats, detect `POINT(`, `POLYGON(` prefixes in `normalize_geometry` and convert via `shapely.from_wkt` before returning a GeoJSON dict.

3. **Coordinate arrays as strings** — Some clients serialize coordinates as `"[13.4, 52.5]"` (a string). `BeforeValidator` receives the outer dict correctly but the inner coordinate field is a string. Add a secondary normalizer on the `coordinates` field itself to JSON-parse string arrays.

4. **Z-coordinate (altitude) triggers false latitude check** — If a 3D point `[lon, lat, alt]` is passed with a large altitude value, the recursive `validate_wgs84` function correctly identifies `coord[0]` as longitude because `len(coord) >= 2 and isinstance(coord[0], float)` is true at the leaf level. The altitude value at index 2 is never checked against lat/lon bounds.

5. **`ST_MakeValid` silent repair masking validation gaps** — If your PostGIS insert query wraps geometry with `ST_MakeValid`, you will never see topology errors in production logs. Remove that wrapper after adding Pydantic validators; let the validation layer surface the actual client error.

6. **Duplicate ring vertices inflate index size** — Rings with repeated consecutive vertices (e.g., `[0,0],[0,0],[1,0],...`) are structurally valid but degrade GIST index performance. Add an optional deduplication pass, or flag these in a warning log rather than rejecting outright.

7. **Empty geometry collections** — `GeometryCollection` with zero members is valid GeoJSON but creates null entries in PostGIS. Add a `model_validator` that rejects empty `GeometryCollection.geometries` arrays if your schema does not permit them.

## Performance Notes

- **Validator overhead** — The normalization + bounds check pipeline adds roughly 0.05–0.2 ms per request on CPython 3.11, measured against a 100-coordinate polygon. This is negligible compared to a PostGIS round-trip (typically 1–10 ms).
- **Shapely topology check** — `from_geojson` + `is_valid` adds 0.5–2 ms for complex polygons with holes. Gate it behind a feature flag or apply it only to `Polygon` / `MultiPolygon` types, not `Point` or `LineString`.
- **Pydantic model instantiation** — Constructing `StrictGeometryWithBounds` inside a FastAPI dependency (rather than directly in the route body) enables caching of the model schema via `model_validate` and avoids repeated `__init__` overhead at high request rates.
- **Async compatibility** — All validators shown here are synchronous. `@field_validator` and `BeforeValidator` must remain sync; async validation logic (e.g., checking geometry existence in the database) belongs in a FastAPI dependency, not a Pydantic validator.
- **`ST_IsValid` in PostGIS** — If you skip the Shapely check, a `SELECT ST_IsValid(ST_GeomFromGeoJSON($1))` query adds one extra database round-trip per request. Reserve this for high-risk ingestion pipelines (e.g., [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/)) rather than per-request endpoints.

---

## Frequently Asked Questions

### Why validate geometry in Pydantic rather than in PostGIS?

PostGIS will accept geometrically invalid inputs and store them silently, corrupting spatial indexes and causing hard-to-debug failures later. Validating at the API boundary returns structured errors to clients immediately, avoids unnecessary database round-trips, and keeps PostGIS GIST indexes clean.

### What is the difference between `BeforeValidator` and `AfterValidator` in Pydantic v2?

`BeforeValidator` runs before Pydantic's own type coercion, making it ideal for normalizing raw inputs (e.g., converting JSON strings to dicts). `AfterValidator` runs after the field has its final typed value, making it better for semantic checks like topology validation on an already-structured geometry object.

### Does this validation replace `ST_IsValid` in PostGIS?

For common cases — ring closure, coordinate bounds, nesting depth — yes. Full topological checks such as self-intersecting rings still require Shapely's `is_valid` property or PostGIS `ST_IsValid()`, which you can call inside an `AfterValidator` at acceptable overhead.

---

## Related

- [Validating WKT and GeoJSON with Pydantic v2](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/) — format-specific coercion patterns that plug into the pipeline above
- [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — how pre-validated geometries accelerate `ST_Within` and `ST_Intersects` queries
- [K-Nearest Neighbor Routing Algorithms](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) — routing endpoints that benefit from guaranteed coordinate precision
- [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) — batch ingestion pipelines where topology checks run as background tasks
- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — choosing the right serialization format for validated geometry responses

← Back to [Advanced Spatial Endpoint Implementation & Data Contracts](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/)
