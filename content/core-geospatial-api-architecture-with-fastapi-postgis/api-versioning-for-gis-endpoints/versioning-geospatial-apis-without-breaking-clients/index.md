---
layout: layouts/page.njk
title: "Versioning geospatial APIs without breaking clients"
description: "Safely version geospatial APIs with URL path versioning and Pydantic v2 adapters to handle legacy coordinate orders, CRS URNs, and geometry format changes cleanly."
---

# Versioning geospatial APIs without breaking clients

**Versioning geospatial APIs without breaking clients** requires URL path versioning (`/v1/`, `/v2/`), a shared PostGIS service layer, and version-specific Pydantic adapters that normalize legacy spatial parameters. Never mutate existing endpoints in place. Route requests through isolated adapters that translate deprecated coordinate orders, CRS URNs, and geometry formats into your current internal standard while returning backward-compatible GeoJSON.

## Why Geospatial Contracts Break Under Change

Spatial endpoints carry implicit contracts that standard CRUD APIs rarely face. A minor platform update can silently invalidate client integrations through:

- **Axis order shifts:** `EPSG:4326` historically defaults to `lat, lon`, but modern OGC standards mandate `lon, lat`. Legacy map renderers break when this flips.
- **Precision drift:** PostGIS upgrades often change `ST_AsGeoJSON` coordinate rounding, causing client-side topology validation failures.
- **Parameter ambiguity:** `bbox` strings, `crs` URNs, and `geometry_format` flags lack strict typing, leading to inconsistent query planning.
- **Cursor invalidation:** Spatial pagination tokens tied to R-tree or BRIN indexes break when indexing strategies change.

Header-based versioning (`Accept: application/vnd.api+json; version=2`) exacerbates these issues by breaking CDN caching, complicating browser-based map clients, and forcing custom interceptors. Path versioning keeps routing explicit, enables parallel deployment, and maps cleanly to OpenAPI generators. Align your routing layer with the patterns in [API Versioning for GIS Endpoints](/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) to guarantee predictable cache behavior and safe deprecation cycles.

## Architecture: Path Versioning + Shared Service Layer

The safest pattern isolates breaking changes at the routing layer while centralizing database logic. Each API version gets a dedicated FastAPI router, its own Pydantic response model, and a dependency that normalizes incoming spatial parameters. A shared service layer executes the actual PostGIS queries using modern functions, ensuring all versions hit the same optimized execution pipeline.

This approach mirrors the foundational structure outlined in [Core Geospatial API Architecture with FastAPI & PostGIS](/core-geospatial-api-architecture-with-fastapi-postgis/), where data access remains version-agnostic and presentation logic handles backward compatibility.

## Implementation in FastAPI

The example below demonstrates a production-ready structure. It uses Pydantic v2, explicit dependency injection for parameter translation, and a shared async service that returns raw dictionaries. Each router applies its own schema mapping and response headers.

```python
from fastapi import FastAPI, APIRouter, Query, Depends, Response, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, List, Dict, Any
from enum import Enum

app = FastAPI(title="Geospatial Feature API", version="2.0.0")

# --- Shared PostGIS Service Layer (Version-Agnostic) ---
async def fetch_features_postgis(
    bbox_normalized: Optional[str],
    crs: str,
    limit: int,
    offset: int
) -> List[Dict[str, Any]]:
    """
    Executes modern PostGIS queries (ST_MakeEnvelope, ST_Transform).
    Returns raw dicts. In production, use asyncpg or SQLAlchemy + GeoAlchemy2.
    """
    # Simulated DB response
    return [
        {
            "id": "feat_001",
            "geom": {"type": "Point", "coordinates": [-122.4194, 37.7749]},
            "properties": {"name": "San Francisco", "area_sqkm": 121.4}
        }
    ]

# --- Parameter Normalization Dependency ---
class GeometryFormat(str, Enum):
    GEOJSON = "geojson"
    WKT = "wkt"

async def normalize_spatial_params(
    bbox: Optional[str] = Query(None, description="minx,miny,maxx,maxy or miny,minx,maxy,maxx"),
    crs: Optional[str] = Query("EPSG:4326"),
    geometry_format: Optional[GeometryFormat] = Query(GeometryFormat.GEOJSON)
) -> Dict[str, Any]:
    """
    Translates legacy v1 parameters into v2 internal standards.
    Handles axis-order flipping, CRS URN normalization, and format mapping.
    """
    normalized = {"crs": crs, "format": geometry_format}
    
    if bbox:
        parts = [float(p) for p in bbox.split(",")]
        # v1 accepted lat/lon; v2 enforces lon/lat
        if len(parts) == 4:
            normalized["bbox_normalized"] = f"{parts[1]},{parts[0]},{parts[3]},{parts[2]}"
        else:
            raise HTTPException(400, "Invalid bbox format. Expected 4 comma-separated floats.")
            
    return normalized

# --- v1 Router (Legacy) ---
router_v1 = APIRouter(prefix="/v1", tags=["v1"])

class FeatureV1(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    type: str = "Feature"
    geometry: Dict[str, Any]
    properties: Dict[str, Any]

@router_v1.get("/features", response_model=List[FeatureV1])
async def get_features_v1(
    params: Dict[str, Any] = Depends(normalize_spatial_params),
    limit: int = Query(50, le=1000),
    offset: int = Query(0, ge=0),
    response: Response = None
):
    # v1 returns flat GeoJSON features without strict schema evolution
    raw = await fetch_features_postgis(
        bbox_normalized=params.get("bbox_normalized"),
        crs=params["crs"],
        limit=limit,
        offset=offset
    )
    return [{"id": r["id"], "geometry": r["geom"], "properties": r["properties"]} for r in raw]

# --- v2 Router (Current) ---
router_v2 = APIRouter(prefix="/v2", tags=["v2"])

class GeometryV2(BaseModel):
    type: str
    coordinates: List[float]

class FeatureV2(BaseModel):
    id: str
    geometry: GeometryV2
    attributes: Dict[str, Any]  # Renamed from 'properties'
    metadata: Dict[str, Any] = {}

@router_v2.get("/features", response_model=List[FeatureV2])
async def get_features_v2(
    params: Dict[str, Any] = Depends(normalize_spatial_params),
    limit: int = Query(100, le=5000),
    offset: int = Query(0, ge=0),
    response: Response = None
):
    # v2 enforces strict typing, renamed fields, and OGC-compliant structure
    raw = await fetch_features_postgis(
        bbox_normalized=params.get("bbox_normalized"),
        crs=params["crs"],
        limit=limit,
        offset=offset
    )
    return [
        {
            "id": r["id"],
            "geometry": r["geom"],
            "attributes": r["properties"],
            "metadata": {"crs": params["crs"], "format": params["format"]}
        }
        for r in raw
    ]

app.include_router(router_v1)
app.include_router(router_v2)
```

For deeper routing patterns, consult the official [FastAPI Bigger Applications guide](https://fastapi.tiangolo.com/tutorial/bigger-applications/) to scale this structure across microservices.

## Handling Spatial Schema Evolution

When field names, types, or spatial representations change, follow these rules:

1. **Additive-only changes in minor versions:** Introduce new fields without removing old ones. Mark deprecated fields with `@deprecated` in OpenAPI.
2. **Strict coordinate typing:** Always validate `coordinates` as `List[float]` and reject malformed GeoJSON at the adapter layer.
3. **Explicit CRS headers:** Return `Content-CRS: <http://www.opengis.net/def/crs/EPSG/0/4326>` to eliminate client-side guessing.
4. **Cache segmentation:** Prefix CDN cache keys with the API version (`v1:features:bbox=...`). Spatial queries are expensive; cache isolation prevents stale geometry from bleeding across versions.

Align your geometry serialization with the [OGC API Features specification](https://ogcapi.ogc.org/features/) to ensure interoperability across GIS clients and avoid reinventing spatial response contracts.

## Deprecation & Migration Checklist

- **Announce sunset windows:** Attach `Sunset: <date>` and `Deprecation: true` headers to legacy endpoints. Follow [RFC 8594](https://www.rfc-editor.org/rfc/rfc8594) for standardized deprecation signaling.
- **Traffic shadowing:** Route 1–5% of production traffic to `/v2/` in read-only mode. Compare response payloads using schema diffing tools to catch silent breaking changes.
- **Contract testing:** Use tools like Schemathesis or Pact to validate that `/v1/` still satisfies legacy client expectations while `/v2/` enforces new constraints.
- **SDK generation:** Regenerate OpenAPI clients per version. Distribute versioned SDKs so frontend teams can upgrade incrementally without coordinate-order regressions.

Versioning geospatial APIs without breaking clients is fundamentally about isolating presentation logic from spatial execution. Keep PostGIS queries centralized, normalize parameters at the router boundary, and enforce strict Pydantic schemas per version. This guarantees backward compatibility while allowing your platform to adopt modern spatial standards safely.