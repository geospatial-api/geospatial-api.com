---
layout: layouts/page.njk
title: "Validating WKT and GeoJSON with Pydantic v2"
description: "Parse and validate WKT and GeoJSON in FastAPI with Pydantic v2. Use BeforeValidator with Shapely to enforce coordinate bounds before any PostGIS database write."
---

# Validating WKT and GeoJSON with Pydantic v2

To validate spatial formats in modern Python APIs, you must replace legacy `@validator` decorators with Pydantic v2’s `BeforeValidator` or `@field_validator` patterns. By parsing raw strings with `shapely` and enforcing coordinate bounds before serialization, you catch malformed geometries during request ingestion. Pydantic v2’s `pydantic_core` engine executes this validation at C-speed, ensuring synchronous spatial checks don’t bottleneck your FastAPI routes. For teams building location-aware microservices, this approach forms the foundation of [Strict Pydantic Validation for Geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/).

The most reliable implementation wraps geometry parsing in a `BeforeValidator` that normalizes inputs, validates CRS assumptions, and returns a typed `shapely` representation or raises a `ValueError`. FastAPI automatically converts these errors into structured `422 Unprocessable Entity` responses, keeping your API contract predictable.

## Production-Ready Validation Models

```python
from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, Field, model_validator
from shapely import wkt
from shapely.geometry import shape, mapping
from shapely.validation import make_valid

def parse_wkt(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("WKT geometry must be a string")
    try:
        geom = wkt.loads(value)
        if not geom.is_valid:
            geom = make_valid(geom)
        return wkt.dumps(geom, rounding_precision=6)
    except Exception as e:
        raise ValueError(f"Invalid WKT: {e}")

def parse_geojson(value: Any) -> dict:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as e:
            raise ValueError(f"Malformed GeoJSON string: {e}")
    if not isinstance(value, dict):
        raise ValueError("GeoJSON geometry must be a dict or valid JSON string")
    try:
        geom = shape(value)
        if not geom.is_valid:
            geom = make_valid(geom)
        return mapping(geom)
    except Exception as e:
        raise ValueError(f"Invalid GeoJSON geometry: {e}")

WKTGeometry = Annotated[str, BeforeValidator(parse_wkt)]
GeoJSONGeometry = Annotated[dict, BeforeValidator(parse_geojson)]

class SpatialPayload(BaseModel):
    model_config = {"strict": True, "extra": "forbid"}
    
    geometry_type: Literal["wkt", "geojson"]
    geometry: WKTGeometry | GeoJSONGeometry
    precision: int = Field(default=6, ge=0, le=12)
    srid: int = Field(default=4326, description="Assumes EPSG:4326 unless overridden")

    @model_validator(mode="before")
    @classmethod
    def enforce_type_match(cls, data: Any) -> Any:
        if isinstance(data, dict):
            gtype = data.get("geometry_type")
            geom = data.get("geometry")
            if gtype == "wkt" and not isinstance(geom, str):
                raise ValueError("Expected string for geometry_type='wkt'")
            if gtype == "geojson" and not isinstance(geom, (dict, str)):
                raise ValueError("Expected dict/string for geometry_type='geojson'")
        return data
```

## How the Validation Pipeline Works

Pydantic v2 decouples type coercion from business logic validation. The `BeforeValidator` runs before the model’s type system evaluates the field, allowing you to intercept raw payloads and transform them safely. When a client submits a request, the following sequence occurs:

1. **Raw Ingestion**: FastAPI passes the JSON body to Pydantic.
2. **Pre-Validation Routing**: `@model_validator(mode="before")` checks `geometry_type` against the raw `geometry` payload. This prevents type mismatches before expensive parsing begins.
3. **Spatial Parsing**: The appropriate `BeforeValidator` executes. `shapely.wkt.loads()` or `shapely.geometry.shape()` attempts to construct a geometry object.
4. **Normalization & Repair**: `make_valid()` silently fixes common topology errors (e.g., self-intersecting polygons). The result is serialized back to a standardized string or dict with controlled rounding.
5. **Type Assignment**: The cleaned payload is assigned to the model field, satisfying Pydantic’s strict type constraints.

This pipeline aligns with the [OGC GeoJSON specification (RFC 7946)](https://datatracker.ietf.org/doc/html/rfc7946), which mandates strict coordinate ordering and structure. By validating early, you prevent downstream database errors in PostGIS or MongoDB.

## Coordinate Bounds & CRS Enforcement

Spatial validation isn’t complete without bounding checks. While Shapely handles topology, it doesn’t enforce geographic limits. For `EPSG:4326` (WGS84), coordinates must fall within `[-180, 180]` longitude and `[-90, 90]` latitude. You can enforce this in a `model_validator(mode="after")`:

```python
    @model_validator(mode="after")
    def validate_4326_bounds(self) -> "SpatialPayload":
        if self.srid == 4326 and isinstance(self.geometry, dict):
            coords = self.geometry.get("coordinates", [])
            # Flatten nested coordinate arrays for validation
            flat_coords: list = []
            def _flatten(c):
                if isinstance(c, (int, float)):
                    flat_coords.append(c)
                elif isinstance(c, list):
                    for x in c:
                        _flatten(x)
            _flatten(coords)

            # GeoJSON coordinates are [longitude, latitude, ...] pairs
            for i in range(0, len(flat_coords) - 1, 2):
                lon, lat = flat_coords[i], flat_coords[i + 1]
                if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    raise ValueError(f"Coordinate ({lon}, {lat}) exceeds EPSG:4326 bounds")
        return self
```

For complex projections, integrate `pyproj` to transform and validate coordinates against the target CRS. This step is critical when building [Advanced Spatial Endpoint Implementation & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/) that serve multiple geographic regions.

## Error Handling & FastAPI Integration

Pydantic v2’s validation engine surfaces errors through `pydantic.ValidationError`. FastAPI intercepts these exceptions and formats them into RFC 7807-compliant JSON responses. To improve developer experience:

- **Custom Error Messages**: Replace generic `ValueError` strings with actionable hints (e.g., `"Expected WKT string, got dict"`).
- **Strict Mode**: Setting `model_config = {"strict": True}` disables implicit type coercion. A float won’t silently convert to an int, and a string won’t parse as a dict.
- **Contextual Validation**: Use `ValidationInfo` to access sibling fields during validation. This enables cross-field rules without manual parsing.

When validation fails, FastAPI returns a `422` status with a structured `detail` array. Each error includes `loc` (field path), `msg` (human-readable explanation), and `type` (Pydantic error code). This consistency simplifies frontend error mapping and automated API testing.

## Performance Considerations

Pydantic v2’s `pydantic_core` backend compiles validation schemas to Rust, delivering ~10-50x faster execution than v1. However, spatial parsing introduces Python-level overhead:

- **Sync vs Async**: Geometry validation runs synchronously. For high-throughput endpoints, avoid blocking the event loop by offloading heavy parsing to a thread pool or using async-compatible libraries.
- **Caching**: If clients repeatedly submit identical geometries, cache parsed `shapely` objects using `functools.lru_cache` or Redis.
- **Memory Footprint**: Large MultiPolygon GeoJSON payloads can spike memory during `shape()` conversion. Implement size limits (`max_length` on strings, custom validators on dict depth) before parsing.

By combining `BeforeValidator` routing, strict typing, and early bounds checking, you create a resilient spatial ingestion layer. This pattern scales cleanly across FastAPI services, ensuring that every geometry entering your system conforms to OGC standards and database constraints before it touches your query planner.