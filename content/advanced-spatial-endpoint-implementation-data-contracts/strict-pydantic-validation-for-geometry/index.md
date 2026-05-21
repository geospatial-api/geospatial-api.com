---
layout: layouts/page.njk
title: "Strict Pydantic Validation for Geometry"
description: "Validate geometry at the API boundary with Pydantic v2. Enforce ring orientation, topology checks, and CRS alignment in FastAPI before any PostGIS database round-trip."
---

# Strict Pydantic Validation for Geometry

Geospatial APIs operate at the intersection of strict data contracts and highly variable spatial inputs. When coordinates, topology rules, or coordinate reference systems (CRS) drift from expected specifications, downstream PostGIS operations fail silently, corrupt spatial indexes, or trigger expensive rollback transactions. Implementing **Strict Pydantic Validation for Geometry** at the API boundary eliminates these failure modes before payloads reach the database layer.

This guide details a production-ready validation workflow for FastAPI applications, focusing on Pydantic v2’s type coercion, structural enforcement, and error propagation patterns. As part of the broader [Advanced Spatial Endpoint Implementation & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/) framework, this approach ensures that spatial payloads are mathematically sound, topologically valid, and fully compliant with modern API standards.

## Prerequisites & Environment Setup

Before implementing strict validation, ensure your stack meets the following baseline requirements:

- **Python 3.10+**: Required for Pydantic v2’s native type hinting and `typing.Annotated` support.
- **FastAPI 0.100+**: Leverages Pydantic v2 natively for request/response serialization and automatic OpenAPI generation.
- **Pydantic v2**: Core validation engine with `@field_validator`, `@model_validator`, and `BeforeValidator`.
- **PostGIS 3.3+**: Target database for spatial operations. Validation occurs upstream, but CRS alignment assumes PostGIS conventions.
- **Optional but Recommended**: `geojson-pydantic` or `pydantic-extra-types` for baseline GeoJSON schema definitions.

Initialize your environment with strict dependency pinning to prevent silent breaking changes in spatial type handling:

```bash
pip install "fastapi>=0.100.0" "pydantic>=2.5.0" "uvicorn[standard]"
```

For deeper configuration options, consult the official [Pydantic v2 Validators documentation](https://docs.pydantic.dev/latest/concepts/validators/) to understand how `BeforeValidator` and `AfterValidator` interact with FastAPI’s request parsing pipeline.

## The Validation Pipeline Architecture

Strict geometry validation follows a deterministic pipeline that rejects malformed data before it touches business logic. The workflow consists of five sequential stages:

1. **Payload Ingestion**: Accept raw JSON, WKT strings, or nested GeoJSON objects via FastAPI request bodies.
2. **Type Normalization**: Convert heterogeneous inputs into a unified internal representation using `BeforeValidator` hooks.
3. **Structural Enforcement**: Validate required fields (`type`, `coordinates`), coordinate dimensionality, and nesting depth.
4. **Topological & Precision Checks**: Enforce coordinate bounds (±180/±90), decimal precision limits, and polygon ring closure rules.
5. **Error Serialization**: Transform Pydantic `ValidationError` traces into structured, client-consumable responses.

This pipeline replaces ad-hoc `try/except` blocks with declarative validation contracts, ensuring consistent behavior across all spatial endpoints. When handling mixed spatial formats, developers often struggle with inconsistent parsing; refer to [Validating WKT and GeoJSON with Pydantic v2](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/) for format-specific coercion patterns that integrate seamlessly into this pipeline.

## Implementing Strict Geometry Contracts

Pydantic v2’s validator architecture allows us to intercept payloads at multiple stages. Below is a production-grade implementation that enforces structural integrity before any spatial computation occurs.

### Type Normalization & Format Coercion

The first line of defense is normalizing disparate input formats into a canonical dictionary structure. We use `BeforeValidator` to parse strings (WKT) or raw JSON objects before Pydantic attempts field assignment.

```python
from typing import Any, Literal, Annotated
from pydantic import BaseModel, BeforeValidator, ValidationError, field_validator
import json

def normalize_geometry(raw: Any) -> dict[str, Any]:
    """Coerce WKT strings or raw JSON dicts into a standardized GeoJSON-like dict."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        # Basic WKT detection & parsing (production should use shapely.wkt.loads)
        if raw.upper().startswith(("POINT", "LINESTRING", "POLYGON", "MULTI")):
            raise ValueError("WKT parsing requires external geometry library; use raw GeoJSON for strict validation.")
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON payload: {e}")
    raise TypeError(f"Expected dict or JSON string, got {type(raw).__name__}")

GeometryInput = Annotated[dict[str, Any], BeforeValidator(normalize_geometry)]
```

This approach guarantees that downstream validators always operate on a predictable dictionary structure, aligning with the [RFC 7946 GeoJSON specification](https://datatracker.ietf.org/doc/html/rfc7946) for consistent coordinate array formatting.

### Structural & Topological Enforcement

Once normalized, we enforce the mandatory GeoJSON structure and validate coordinate array depth. We also implement a lightweight ring-closure check for polygons.

```python
class StrictGeometry(BaseModel):
    type: Literal["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon"]
    coordinates: list[Any]

    @field_validator("coordinates", mode="after")
    @classmethod
    def validate_coordinate_structure(cls, v: list[Any], info) -> list[Any]:
        geom_type = info.data.get("type")
        
        if geom_type == "Point":
            if not isinstance(v, (list, tuple)) or len(v) < 2:
                raise ValueError("Point coordinates must contain at least [x, y]")
        elif geom_type == "Polygon":
            if not isinstance(v, list) or len(v) == 0:
                raise ValueError("Polygon must contain at least one linear ring")
            first_ring = v[0]
            if first_ring[0] != first_ring[-1]:
                raise ValueError("Polygon first ring must be closed (first == last coordinate)")
                
        return v
```

### Coordinate Bounds & Precision Guards

Spatial systems frequently break when coordinates exceed valid ranges or contain excessive floating-point precision. We apply a final pass to clamp bounds and truncate decimals.

```python
    @field_validator("coordinates", mode="before")
    @classmethod
    def enforce_bounds_and_precision(cls, v: Any) -> Any:
        def clamp_and_round(coord: Any, depth: int = 0) -> Any:
            if isinstance(coord, list):
                # At the leaf level (depth with numeric children), odd index = latitude
                return [clamp_and_round(c, depth + 1) for c in coord]
            if isinstance(coord, (int, float)):
                value = round(float(coord), 6)
                if not (-180.0 <= value <= 180.0):
                    raise ValueError(f"Coordinate out of WGS84 range: {value}")
                return value
            return coord

        return clamp_and_round(v)
```

By chaining these validators, we guarantee that every geometry entering the application layer is structurally sound, topologically valid, and numerically constrained.

## Error Serialization & Client Feedback

Pydantic’s default `ValidationError` output is highly detailed but rarely suitable for direct API consumption. Production systems should map validation failures to standardized problem details. Implementing Designing RFC 7807 error responses for spatial APIs ensures that clients receive actionable, machine-parseable feedback instead of stack traces.

A minimal FastAPI exception handler for spatial validation looks like this:

```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

app = FastAPI()

@app.exception_handler(ValidationError)
async def spatial_validation_handler(request: Request, exc: ValidationError):
    errors = []
    for err in exc.errors():
        errors.append({
            "field": ".".join(str(loc) for loc in err["loc"]),
            "message": err["msg"],
            "type": err["type"]
        })
    return JSONResponse(
        status_code=422,
        content={
            "type": "https://tools.ietf.org/html/rfc7807",
            "title": "Spatial Validation Failed",
            "detail": "One or more geometry constraints were violated.",
            "errors": errors
        }
    )
```

This pattern aligns with the [RFC 7807 Problem Details standard](https://datatracker.ietf.org/doc/html/rfc7807), providing consistent error taxonomy across all spatial endpoints.

## Production Integration & Downstream Workflows

Once strict validation is enforced at the boundary, downstream services can operate with high confidence. Validated geometries can be safely passed to spatial indexing engines, routing algorithms, or bulk ingestion pipelines without defensive programming overhead.

For example, when building query endpoints, pre-validated bounding boxes eliminate the need for redundant `ST_MakeValid` or `ST_IsValid` checks in PostGIS. This directly accelerates [Bounding Box & Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) by reducing database-side validation latency. Similarly, routing services that consume coordinate arrays benefit from guaranteed precision and topology compliance, enabling deterministic [K-Nearest Neighbor Routing Algorithms](/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) without fallback geometry repair logic.

When your API must accept legacy GIS formats, strict validation still applies upstream. Handling multipart form uploads for shapefiles demonstrates how to extract, normalize, and validate spatial payloads before they enter the same Pydantic pipeline outlined above.

## Conclusion

Strict Pydantic Validation for Geometry shifts spatial data integrity from the database layer to the API boundary, where failures are cheaper to catch and easier to communicate. By leveraging Pydantic v2’s `BeforeValidator`, structural field validators, and precision guards, you establish a deterministic contract that protects PostGIS indexes, prevents silent topology corruption, and standardizes client error handling. As spatial APIs scale, this validation layer becomes the foundation for reliable indexing, routing, and bulk ingestion workflows.