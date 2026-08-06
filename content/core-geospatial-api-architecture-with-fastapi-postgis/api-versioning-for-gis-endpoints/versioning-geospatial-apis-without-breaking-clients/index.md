---
layout: layouts/page.njk
title: "Versioning Geospatial APIs Without Breaking Clients"
description: "How to use URL path versioning and Pydantic v2 adapters to evolve FastAPI + PostGIS endpoints safely — handling axis-order shifts, CRS URNs, and geometry format changes without breaking existing map clients."
slug: "versioning-geospatial-apis-without-breaking-clients"
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "API Versioning for GIS Endpoints"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/"
  - label: "Versioning Geospatial APIs Without Breaking Clients"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/versioning-geospatial-apis-without-breaking-clients/"
datePublished: "2025-03-12"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Versioning Geospatial APIs Without Breaking Clients",
      "description": "How to use URL path versioning and Pydantic v2 adapters to evolve FastAPI + PostGIS endpoints safely — handling axis-order shifts, CRS URNs, and geometry format changes without breaking existing map clients.",
      "datePublished": "2025-03-12",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 2, "name": "API Versioning for GIS Endpoints", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/" },
        { "@type": "ListItem", "position": 3, "name": "Versioning Geospatial APIs Without Breaking Clients", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/versioning-geospatial-apis-without-breaking-clients/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Versioning Geospatial APIs Without Breaking Clients",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Add versioned FastAPI routers with isolated prefixes" },
        { "@type": "HowToStep", "position": 2, "name": "Build a shared PostGIS service layer that all routers call" },
        { "@type": "HowToStep", "position": 3, "name": "Write Pydantic v2 adapters to normalize legacy coordinate orders and CRS URNs" },
        { "@type": "HowToStep", "position": 4, "name": "Return explicit Content-CRS headers and version-prefixed CDN cache keys" },
        { "@type": "HowToStep", "position": 5, "name": "Signal deprecation with Sunset and Deprecation response headers" }
      ]
    },
    {
      "@type": "Article",
      "headline": "Versioning Geospatial APIs Without Breaking Clients",
      "datePublished": "2025-03-12",
      "dateModified": "2026-06-23"
    }
  ]
}
</script>

← Back to [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) · [Core Geospatial API Architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/)

# Versioning Geospatial APIs Without Breaking Clients

Use URL path versioning (`/v1/`, `/v2/`), a shared PostGIS service layer, and version-specific Pydantic v2 adapters to let your spatial endpoints evolve without invalidating existing map clients.

## Context & When to Use

Spatial endpoints carry implicit contracts that ordinary CRUD APIs rarely face. Even a minor upgrade — a PostGIS minor release, an OGC compliance fix, or a field rename — can silently break downstream clients through axis-order shifts, coordinate-precision changes, or CRS representation differences. Locking every version behind a shared database path while isolating presentation logic at the routing layer lets you adopt modern standards at your own pace.

This pattern applies whenever two or more distinct consumer groups depend on the same PostGIS data source but need different response shapes. Typical triggers include: a legacy WMS/WMTS front-end that assumes `lat, lon` order; a new RFC 7946–compliant mobile SDK that requires `lon, lat`; or a migration from a flat `properties` map to a typed `attributes` object. If only one consumer exists and you can update client and server atomically, path versioning adds unnecessary complexity — a feature-flag on the response model is sufficient.

The preconditions are: FastAPI ≥ 0.111, Pydantic v2 (`pydantic>=2.0`), and asyncpg or SQLAlchemy + GeoAlchemy2 for async PostGIS access. Review the foundational routing conventions in [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) before proceeding — that page establishes the header vs. path trade-off analysis and the deprecation timeline model this page builds on.

### Why spatial versioning is harder than standard REST versioning

<svg viewBox="0 0 720 300" role="img" aria-label="Diagram showing four categories of spatial breaking changes: axis order, precision, parameter types, and cursor invalidation" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Categories of Breaking Changes in Geospatial APIs</title>
  <desc>Four boxes arranged in a 2×2 grid, each describing a type of breaking change specific to spatial endpoints: axis-order shifts, precision drift, parameter ambiguity, and cursor invalidation.</desc>
  <rect x="0" y="0" width="720" height="300" rx="10" fill="var(--surface, #f5f3ff)"/>
  <defs>
    <style>
      .sv-box { fill: none; stroke: currentColor; stroke-width: 1.5; rx: 6; }
      .sv-head { font: 600 13px/1.4 system-ui, sans-serif; fill: currentColor; }
      .sv-body { font: 400 11.5px/1.5 system-ui, sans-serif; fill: currentColor; opacity: 0.82; }
      .sv-badge { rx: 4; opacity: 0.12; fill: currentColor; }
    </style>
  </defs>
  <!-- Row 1 -->
  <!-- Box 1: Axis order -->
  <rect class="sv-box" x="20" y="20" width="320" height="118" rx="6"/>
  <rect class="sv-badge" x="20" y="20" width="320" height="118" rx="6"/>
  <text class="sv-head" x="36" y="48">Axis-order shift</text>
  <text class="sv-body" x="36" y="68">EPSG:4326 historically: lat, lon.</text>
  <text class="sv-body" x="36" y="84">OGC / RFC 7946 modern: lon, lat.</text>
  <text class="sv-body" x="36" y="100">Legacy renderers break silently when</text>
  <text class="sv-body" x="36" y="116">the order flips between API versions.</text>
  <!-- Box 2: Precision drift -->
  <rect class="sv-box" x="380" y="20" width="320" height="118" rx="6"/>
  <rect class="sv-badge" x="380" y="20" width="320" height="118" rx="6"/>
  <text class="sv-head" x="396" y="48">Precision drift</text>
  <text class="sv-body" x="396" y="68">PostGIS upgrades alter ST_AsGeoJSON</text>
  <text class="sv-body" x="396" y="84">rounding. Client-side topology checks</text>
  <text class="sv-body" x="396" y="100">that rely on exact float equality fail</text>
  <text class="sv-body" x="396" y="116">without a version-isolated response.</text>
  <!-- Row 2 -->
  <!-- Box 3: Parameter ambiguity -->
  <rect class="sv-box" x="20" y="162" width="320" height="118" rx="6"/>
  <rect class="sv-badge" x="20" y="162" width="320" height="118" rx="6"/>
  <text class="sv-head" x="36" y="190">Parameter ambiguity</text>
  <text class="sv-body" x="36" y="210">Untyped bbox strings and CRS URNs</text>
  <text class="sv-body" x="36" y="226">accepted by v1 allow both lat/lon and</text>
  <text class="sv-body" x="36" y="242">lon/lat — clients make incompatible</text>
  <text class="sv-body" x="36" y="258">assumptions about the interpretation.</text>
  <!-- Box 4: Cursor invalidation -->
  <rect class="sv-box" x="380" y="162" width="320" height="118" rx="6"/>
  <rect class="sv-badge" x="380" y="162" width="320" height="118" rx="6"/>
  <text class="sv-head" x="396" y="190">Cursor invalidation</text>
  <text class="sv-body" x="396" y="210">Spatial pagination tokens tied to</text>
  <text class="sv-body" x="396" y="226">R-tree or BRIN indexes break when</text>
  <text class="sv-body" x="396" y="242">the indexing strategy changes, making</text>
  <text class="sv-body" x="396" y="258">existing cursors return wrong results.</text>
</svg>

## Runnable Implementation

The structure below separates concerns into three layers: a version-agnostic PostGIS service, a shared parameter-normalization dependency, and isolated per-version routers. Each router owns its Pydantic response model; the service executes one modern PostGIS query path for both.

```python
# requirements: fastapi>=0.111, pydantic>=2.0, asyncpg>=0.29
from fastapi import FastAPI, APIRouter, Query, Depends, Response, HTTPException
from pydantic import BaseModel, Field, ConfigDict, model_validator
from typing import Optional, List, Dict, Any
from enum import Enum

app = FastAPI(title="Geospatial Feature API", version="2.0.0")

# ── Shared PostGIS Service (version-agnostic) ────────────────────────────────
# In production replace this stub with asyncpg or SQLAlchemy + GeoAlchemy2.
# ST_Transform normalises all incoming geometries to EPSG:4326 internally;
# ST_AsGeoJSON(geom, 6) caps precision at 6 decimal places (~11 cm accuracy).
async def fetch_features_postgis(
    bbox_wsen: Optional[str],   # lon_min,lat_min,lon_max,lat_max  (internal standard)
    crs: str,
    limit: int,
    offset: int,
) -> List[Dict[str, Any]]:
    # Simulate: SELECT id, ST_AsGeoJSON(geom, 6) AS geom, props FROM features
    #   WHERE ST_Within(geom, ST_MakeEnvelope($1,$2,$3,$4, 4326))
    #   ORDER BY id LIMIT $5 OFFSET $6
    return [
        {
            "id": "feat_001",
            "geom": {"type": "Point", "coordinates": [-122.419400, 37.774900]},
            "properties": {"name": "San Francisco", "area_sqkm": 121.4},
        }
    ]

# ── Parameter Normalisation Dependency ───────────────────────────────────────
class GeometryFormat(str, Enum):
    GEOJSON = "geojson"
    WKT = "wkt"

async def normalize_spatial_params(
    bbox: Optional[str] = Query(
        None,
        description="v2: lon_min,lat_min,lon_max,lat_max  |  v1 (legacy): lat_min,lon_min,lat_max,lon_max",
    ),
    crs: Optional[str] = Query("EPSG:4326"),
    geometry_format: Optional[GeometryFormat] = Query(GeometryFormat.GEOJSON),
    version: str = "v2",  # injected by each router
) -> Dict[str, Any]:
    """Translate legacy v1 lat/lon-first bbox into the v2 lon/lat internal standard."""
    out: Dict[str, Any] = {"crs": crs, "format": geometry_format, "bbox_wsen": None}
    if bbox:
        parts = [float(p) for p in bbox.split(",")]
        if len(parts) != 4:
            raise HTTPException(400, "bbox must be 4 comma-separated floats")
        if version == "v1":
            # v1 clients sent lat_min, lon_min, lat_max, lon_max → swap to lon/lat
            lat_min, lon_min, lat_max, lon_max = parts
            out["bbox_wsen"] = f"{lon_min},{lat_min},{lon_max},{lat_max}"
        else:
            out["bbox_wsen"] = bbox  # already lon/lat
    return out

# ── v1 Router (Legacy — maintained for backward compatibility) ────────────────
router_v1 = APIRouter(prefix="/v1", tags=["v1 (deprecated)"])

class FeatureV1(BaseModel):
    """GeoJSON Feature shape used by legacy v1 clients."""
    model_config = ConfigDict(from_attributes=True)
    id: str
    type: str = "Feature"
    geometry: Dict[str, Any]
    properties: Dict[str, Any]

def _v1_params(
    bbox: Optional[str] = Query(None),
    crs: Optional[str] = Query("EPSG:4326"),
    geometry_format: Optional[GeometryFormat] = Query(GeometryFormat.GEOJSON),
) -> Dict[str, Any]:
    # Wrap the shared dependency and inject version="v1"
    import asyncio
    return asyncio.get_event_loop().run_until_complete(
        normalize_spatial_params(bbox, crs, geometry_format, version="v1")
    )

@router_v1.get(
    "/features",
    response_model=List[FeatureV1],
    summary="List spatial features (deprecated v1 — lat/lon bbox order)",
)
async def get_features_v1(
    bbox: Optional[str] = Query(None),
    crs: Optional[str] = Query("EPSG:4326"),
    geometry_format: Optional[GeometryFormat] = Query(GeometryFormat.GEOJSON),
    limit: int = Query(50, le=1000),
    offset: int = Query(0, ge=0),
    response: Response = None,
):
    # Normalise bbox in-handler so we can pass version="v1"
    params = await normalize_spatial_params(bbox, crs, geometry_format, version="v1")
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = "Sat, 31 Jan 2026 23:59:59 GMT"  # RFC 8594
    response.headers["Link"] = '</v2/features>; rel="successor-version"'
    raw = await fetch_features_postgis(
        bbox_wsen=params["bbox_wsen"], crs=params["crs"],
        limit=limit, offset=offset,
    )
    return [
        {"id": r["id"], "type": "Feature", "geometry": r["geom"], "properties": r["properties"]}
        for r in raw
    ]

# ── v2 Router (Current) ───────────────────────────────────────────────────────
router_v2 = APIRouter(prefix="/v2", tags=["v2"])

class GeometryV2(BaseModel):
    type: str
    coordinates: List[Any]

class FeatureV2(BaseModel):
    id: str
    geometry: GeometryV2
    attributes: Dict[str, Any]   # 'properties' renamed to 'attributes' in v2
    metadata: Dict[str, Any] = Field(default_factory=dict)

@router_v2.get("/features", response_model=List[FeatureV2])
async def get_features_v2(
    bbox: Optional[str] = Query(None),
    crs: Optional[str] = Query("EPSG:4326"),
    geometry_format: Optional[GeometryFormat] = Query(GeometryFormat.GEOJSON),
    limit: int = Query(100, le=5000),
    offset: int = Query(0, ge=0),
    response: Response = None,
):
    params = await normalize_spatial_params(bbox, crs, geometry_format, version="v2")
    # Explicit CRS header eliminates client-side guessing (OGC API Features §7.14)
    response.headers["Content-CRS"] = "<http://www.opengis.net/def/crs/EPSG/0/4326>"
    raw = await fetch_features_postgis(
        bbox_wsen=params["bbox_wsen"], crs=params["crs"],
        limit=limit, offset=offset,
    )
    return [
        {
            "id": r["id"],
            "geometry": r["geom"],
            "attributes": r["properties"],
            "metadata": {"crs": params["crs"], "format": params["format"]},
        }
        for r in raw
    ]

app.include_router(router_v1)
app.include_router(router_v2)
```

The key architectural decision is that `fetch_features_postgis` owns all PostGIS logic. Both routers call the same function; breaking changes in presentation (field names, coordinate order, response envelope) stay isolated in the router and Pydantic model layers. When you add `/v3/`, you extend that layer without touching the query path.

For context on how `ST_MakeEnvelope` and bounding-box query patterns interact with spatial indexing, see the [Bounding Box Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) guide. If any endpoint serves paginated feature collections, wire its cursor tokens to [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — token format is a version-sensitive contract and must be treated the same way as field names.

Four placements are possible and only one of them keeps tile caching simple.

<svg viewBox="0 0 720 234" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Where the version can live, and what each costs: Cacheable, OGC-friendly, Debuggable" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where the version can live, and what each costs</title>
  <desc>A comparison table. URL path /v2/features: Cacheable yes, OGC-friendly yes, Debuggable yes. the default choice Accept header: Cacheable no, OGC-friendly partly, Debuggable no. needs Vary; hard to curl query ?version=2: Cacheable partly, OGC-friendly no, Debuggable yes. pollutes the cache key subdomain v2.api…: Cacheable yes, OGC-friendly partly, Debuggable yes. extra TLS and CORS burden Path versioning wins on every axis that matters for a spatial API, mostly because tiles and features must cache cleanly.</desc>
  <rect x="0" y="0" width="720" height="234" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Where the version can live, and what each costs</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Cacheable</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">OGC-friendly</text>
  <text x="502" y="58" font-size="10" font-weight="700" fill="currentColor">Debuggable</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">URL path /v2/features</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="568" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">the default choice</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">Accept header</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="510" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">needs Vary; hard to curl</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">query ?version=2</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="510" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="568" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">pollutes the cache key</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">subdomain v2.api…</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="510" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="568" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">extra TLS and CORS burden</text>
  <text x="20" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">Path versioning wins on every axis that matters for a spatial API, mostly because tiles and features must cache cleanly.</text>
</svg>

## Key Parameters & Options

| Parameter / Header | Version | Accepted values | Notes |
|---|---|---|---|
| `bbox` query param | v1 | `lat_min,lon_min,lat_max,lon_max` | Adapter swaps to lon/lat internally |
| `bbox` query param | v2 | `lon_min,lat_min,lon_max,lat_max` | RFC 7946 / OGC standard order |
| `crs` query param | both | `EPSG:4326`, `OGC:CRS84`, `EPSG:3857` | Stored as-is; service runs `ST_Transform` |
| `geometry_format` | both | `geojson`, `wkt` | Controls serialization at response layer |
| `Deprecation` header | v1 | `true` | Signals end-of-life per draft IETF spec |
| `Sunset` header | v1 | RFC 7231 HTTP-date | Exact removal date; RFC 8594 §3 |
| `Content-CRS` header | v2 | OGC URN string | Eliminates implicit axis-order assumptions |
| `Link: rel=successor-version` | v1 | `/v2/features` | Guides clients to the current endpoint |

CDN cache keys must be prefixed with the version string (`v1:features:bbox=…`, `v2:features:bbox=…`). Without this isolation a stale v1 response can be served to a v2 client after a cache miss — coordinate-order differences make this a silent data corruption scenario. See the [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) patterns for version-aware key construction.

Migration curves for spatial clients are slower than for ordinary APIs, because a coordinate change usually means recalibrating something downstream.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Client migration after a v2 launch, by week: week 1 8 % on v2, week 4 31 %, week 12 74 %, week 26 93 %, week 52 98 % — the last 2 % never move" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Client migration after a v2 launch, by week</title>
  <desc>A horizontal bar chart. week 1 is 8 % on v2. week 4 is 31 %. week 12 is 74 %. week 26 is 93 %. week 52 is 98 % — the last 2 % never move. The tail is the whole story: plan the sunset around the stragglers, not around the median client.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Client migration after a v2 launch, by week</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">week 1</text>
  <rect x="250" y="48" width="27" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="285" y="61" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">8 % on v2</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">week 4</text>
  <rect x="250" y="82" width="107" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="365" y="95" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">31 %</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">week 12</text>
  <rect x="250" y="116" width="256" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="514" y="129" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">74 %</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">week 26</text>
  <rect x="250" y="150" width="322" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="580" y="163" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">93 %</text>
  <text x="20" y="197" font-size="10.5" fill="currentColor">week 52</text>
  <rect x="250" y="184" width="340" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="598" y="197" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">98 % — the last 2 %</text>
  <text x="20" y="234" font-size="10.5" fill="var(--muted, #7c6fb0)">The tail is the whole story: plan the sunset around the stragglers, not around the median client.</text>
</svg>

## Gotchas & Failure Modes

- **Forgetting the `Sunset` header on v1.** Without `Sunset`, external tooling (API gateways, developer portals, SDK generators) cannot auto-generate deprecation warnings. Add it the moment you ship v2 — not at sunset time.
- **Sharing the Pydantic model between versions.** If `FeatureV1` and `FeatureV2` inherit from a common base and you add a `model_validator` to the base, both versions run it. An axis-order fix in the validator silently changes v1 response shapes. Keep models entirely separate.
- **CRS URN mismatch between query and response.** A client sends `crs=OGC:CRS84` (lon/lat by definition), but your service stores in `EPSG:4326` (lat/lon in older drivers). Without an explicit `ST_Transform` and a `Content-CRS` echo header, the client cannot tell which axis order it received. Always echo the effective CRS in the response header.
- **Precision rounding via `ST_AsGeoJSON` default.** The default precision in PostGIS 3.3+ changed from 9 to 15 significant digits. A bbox filter that snapped to 6-digit coordinates in v1 may return marginally different feature sets in v2 if your query uses the geometry directly. Pin precision: `ST_AsGeoJSON(geom, 6)`.
- **Pydantic v2 `model_config` not propagating to nested models.** If `GeometryV2` is a nested BaseModel inside `FeatureV2` and you forget `ConfigDict(from_attributes=True)` on the nested class, serialisation from asyncpg `Record` objects will raise a `ValidationError` that looks like a missing-field error, not a config error.

## Verification Snippet

After starting the API locally (`uvicorn main:app --reload`), confirm both versions behave correctly:

```bash
# v1 endpoint — check for Deprecation + Sunset headers, legacy response shape
curl -si "http://localhost:8000/v1/features?bbox=37.7,-122.5,37.8,-122.4&limit=5" \
  | grep -E "^(Deprecation|Sunset|Link|Content-Type|\{)"

# Expected headers:
# Deprecation: true
# Sunset: Sat, 31 Jan 2026 23:59:59 GMT
# Link: </v2/features>; rel="successor-version"

# v2 endpoint — confirm Content-CRS and lon/lat-first geometry
curl -si "http://localhost:8000/v2/features?bbox=-122.5,37.7,-122.4,37.8&limit=5" \
  | grep -E "^(Content-CRS|content-type)"

# Expected:
# Content-CRS: <http://www.opengis.net/def/crs/EPSG/0/4326>

# Contract test: coordinates[0] (longitude) should be negative for SF
curl -s "http://localhost:8000/v2/features?limit=1" \
  | python3 -c "import sys,json; f=json.load(sys.stdin)[0]; lon=f['geometry']['coordinates'][0]; assert lon < 0, f'Expected negative longitude, got {lon}'; print('lon/lat order correct')"
```

For a deeper look at how `EXPLAIN ANALYZE` surfaces index usage in bounding-box queries, the [Reading EXPLAIN ANALYZE for Spatial Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/) walkthrough shows the exact plan difference between a sequential scan and a GiST index hit.

---

## Related

- [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — strategy overview: path vs. header versioning, deprecation lifecycle, and OpenAPI multi-version generation
- [Bounding Box Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — `ST_MakeEnvelope`, `ST_Within`, `ST_Intersects` patterns and GiST index configuration
- [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — version-safe cursor token design for paginated feature collections
- [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — Pydantic v2 validators for GeoJSON and WKT at the request boundary

← Back to [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/)
