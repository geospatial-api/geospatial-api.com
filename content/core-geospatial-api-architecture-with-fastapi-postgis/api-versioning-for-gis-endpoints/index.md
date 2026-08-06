---
layout: layouts/page.njk
title: "API Versioning for GIS Endpoints"
description: "Version GIS endpoints in FastAPI without breaking clients. Compare URL path, header, and query-param strategies, then implement version-specific Pydantic schemas and a shared PostGIS service layer."
slug: api-versioning-for-gis-endpoints
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "API Versioning for GIS Endpoints"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/"
datePublished: "2024-01-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "API Versioning for GIS Endpoints",
      "description": "Version GIS endpoints in FastAPI without breaking clients. Compare URL path, header, and query-param strategies, then implement version-specific Pydantic schemas and a shared PostGIS service layer.",
      "datePublished": "2024-01-15",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Core Geospatial API Architecture",
          "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "API Versioning for GIS Endpoints",
          "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/"
        }
      ]
    },
    {
      "@type": "HowTo",
      "name": "How to Version GIS Endpoints in FastAPI",
      "step": [
        { "@type": "HowToStep", "name": "Choose a versioning strategy", "text": "Evaluate URL path, header, and query-parameter versioning for spatial workloads and CDN compatibility." },
        { "@type": "HowToStep", "name": "Architect the router structure", "text": "Isolate each version into dedicated FastAPI APIRouter instances with independent prefixes and middleware." },
        { "@type": "HowToStep", "name": "Define evolving Pydantic schemas", "text": "Create version-specific geometry models that enforce CRS, coordinate precision, and strictness per contract." },
        { "@type": "HowToStep", "name": "Maintain PostGIS query compatibility", "text": "Use versioned repository classes to decouple spatial query logic from schema evolution." },
        { "@type": "HowToStep", "name": "Manage serialization and deprecation", "text": "Expose new serialization formats within the versioned router and communicate Sunset headers to clients." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why is URL path versioning preferred for spatial APIs over header versioning?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "URL path versioning aligns with CDN caching strategies, simplifies API gateway routing, and makes the active spatial contract immediately visible in logs and debugging sessions. Header versioning adds ambiguity when tracing spatial query failures across middleware layers."
          }
        },
        {
          "@type": "Question",
          "name": "How do I prevent GIST index invalidation when migrating PostGIS schemas between versions?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use versioned repository classes that isolate spatial query logic per version. After any geometry column type change (e.g., geometry to geography), run REINDEX on the affected GIST index and validate with EXPLAIN ANALYZE that the planner still uses the index rather than a sequential scan."
          }
        },
        {
          "@type": "Question",
          "name": "When should I sunset a spatial API version?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Add Deprecation and Sunset response headers from day one of the successor version. Monitor per-version traffic via OpenTelemetry traces and retire the old version once it falls below 5% of total requests, giving clients at least 90 days notice after the Sunset date is set."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Core Geospatial API Architecture with FastAPI & PostGIS](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/)

# API Versioning for GIS Endpoints

Evolving spatial data models while keeping downstream clients functional is one of the most persistent challenges in geospatial platform engineering. As coordinate reference systems shift, geometry precision requirements tighten, and serialization standards mature, a deliberate versioning strategy becomes a structural necessity rather than an afterthought. This page walks through the decision points, implementation patterns, and production guardrails for versioning spatial endpoints in FastAPI backed by PostGIS — ensuring that spatial queries, schema evolution, and client routing remain predictable at scale.

---

## Prerequisites & Environment

Before implementing versioned spatial endpoints, verify your stack meets these baselines:

| Dependency | Minimum version | Why it matters |
|---|---|---|
| FastAPI | 0.100+ | `APIRouter` prefix isolation, Pydantic v2 integration |
| Pydantic | 2.0+ | `model_config`, `ConfigDict`, and strict geometry validators |
| SQLAlchemy | 2.0+ | Async session support, `asyncpg` / `psycopg3` drivers |
| PostGIS | 3.3+ | `ST_AsGeoJSON`, `ST_Intersects`, `GIST` index improvements |
| geojson-pydantic | 1.0+ | Typed GeoJSON geometry models with built-in validation |
| Shapely | 2.0+ | Optional local geometry validation before PostGIS round-trips |

PostGIS functions referenced in this page — `ST_MakeEnvelope`, `ST_Intersects`, `ST_AsGeoJSON` — require PostGIS 3.3+ and are only available once the `postgis` extension is active (`CREATE EXTENSION IF NOT EXISTS postgis;`).

---

## Decision Matrix: Versioning Strategies for Spatial APIs

The diagram below maps the three mainstream versioning approaches against the concerns that matter most for GIS workloads: CDN cacheability, OGC routing compatibility, and debuggability.

<svg viewBox="0 0 820 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision matrix comparing URL path versioning, header versioning, and query-parameter versioning for GIS endpoints" style="width:100%;max-width:820px;display:block;margin:1.5rem auto;">
  <title>Versioning Strategy Decision Matrix for GIS Endpoints</title>
  <desc>A table comparing three versioning strategies — URL path, header-based, and query parameter — across five criteria: CDN cacheability, OGC routing compatibility, debuggability, gateway routing simplicity, and recommended use case.</desc>
  <rect x="0" y="0" width="820" height="320" rx="10" fill="var(--surface, #f5f3ff)"/>
  <defs>
    <style>
      .dm-header { font-family: inherit; font-size: 13px; font-weight: 600; fill: #fff; }
      .dm-label  { font-family: inherit; font-size: 12px; fill: currentColor; }
      .dm-good   { fill: #22c55e; }
      .dm-warn   { fill: #f59e0b; }
      .dm-bad    { fill: #ef4444; }
      .dm-row-a  { fill: var(--surface, #f5f3ff); }
      .dm-row-b  { fill: var(--surface2, #ede9fe); }
    </style>
  </defs>
  <!-- Header row -->
  <rect x="0" y="0" width="820" height="38" rx="6" fill="#5b4fcf"/>
  <text x="10" y="24" class="dm-header" font-size="13">Criterion</text>
  <text x="210" y="24" class="dm-header" font-size="13">URL Path  /v2/features</text>
  <text x="390" y="24" class="dm-header" font-size="13">Header  Accept: vnd.v2</text>
  <text x="590" y="24" class="dm-header" font-size="13">Query Param  ?version=2</text>
  <!-- Row 1 -->
  <rect x="0" y="38" width="820" height="40" class="dm-row-a"/>
  <text x="10" y="63" class="dm-label">CDN cacheability</text>
  <circle cx="300" cy="58" r="7" class="dm-good"/>
  <text x="312" y="63" class="dm-label">Excellent</text>
  <circle cx="480" cy="58" r="7" class="dm-warn"/>
  <text x="492" y="63" class="dm-label">Poor (Vary header)</text>
  <circle cx="670" cy="58" r="7" class="dm-warn"/>
  <text x="682" y="63" class="dm-label">Moderate</text>
  <!-- Row 2 -->
  <rect x="0" y="78" width="820" height="40" class="dm-row-b"/>
  <text x="10" y="103" class="dm-label">OGC routing compat.</text>
  <circle cx="300" cy="98" r="7" class="dm-good"/>
  <text x="312" y="103" class="dm-label">Full</text>
  <circle cx="480" cy="98" r="7" class="dm-warn"/>
  <text x="492" y="103" class="dm-label">Requires adaptation</text>
  <circle cx="670" cy="98" r="7" class="dm-bad"/>
  <text x="682" y="103" class="dm-label">Conflicts w/ filters</text>
  <!-- Row 3 -->
  <rect x="0" y="118" width="820" height="40" class="dm-row-a"/>
  <text x="10" y="143" class="dm-label">Debuggability in logs</text>
  <circle cx="300" cy="138" r="7" class="dm-good"/>
  <text x="312" y="143" class="dm-label">Immediate (URL)</text>
  <circle cx="480" cy="138" r="7" class="dm-bad"/>
  <text x="492" y="143" class="dm-label">Hidden in headers</text>
  <circle cx="670" cy="138" r="7" class="dm-warn"/>
  <text x="682" y="143" class="dm-label">Visible, polluting</text>
  <!-- Row 4 -->
  <rect x="0" y="158" width="820" height="40" class="dm-row-b"/>
  <text x="10" y="183" class="dm-label">Gateway routing simplicity</text>
  <circle cx="300" cy="178" r="7" class="dm-good"/>
  <text x="312" y="183" class="dm-label">Straightforward</text>
  <circle cx="480" cy="178" r="7" class="dm-bad"/>
  <text x="492" y="183" class="dm-label">Complex header matching</text>
  <circle cx="670" cy="178" r="7" class="dm-warn"/>
  <text x="682" y="183" class="dm-label">Moderate</text>
  <!-- Row 5 -->
  <rect x="0" y="198" width="820" height="40" class="dm-row-a"/>
  <text x="10" y="223" class="dm-label">OpenAPI doc isolation</text>
  <circle cx="300" cy="218" r="7" class="dm-good"/>
  <text x="312" y="223" class="dm-label">Automatic per router</text>
  <circle cx="480" cy="218" r="7" class="dm-bad"/>
  <text x="492" y="223" class="dm-label">Manual separation</text>
  <circle cx="670" cy="218" r="7" class="dm-warn"/>
  <text x="682" y="223" class="dm-label">Shared schema</text>
  <!-- Row 6 recommendation -->
  <rect x="0" y="238" width="820" height="40" class="dm-row-b"/>
  <text x="10" y="263" class="dm-label">Verdict for spatial APIs</text>
  <text x="210" y="263" class="dm-label" font-weight="600" fill="#5b4fcf">Recommended</text>
  <text x="390" y="263" class="dm-label">Avoid</text>
  <text x="590" y="263" class="dm-label">Avoid</text>
  <!-- Legend -->
  <circle cx="14" cy="296" r="6" class="dm-good"/>
  <text x="24" y="300" class="dm-label">Good</text>
  <circle cx="80" cy="296" r="6" class="dm-warn"/>
  <text x="90" y="300" class="dm-label">Caution</text>
  <circle cx="160" cy="296" r="6" class="dm-bad"/>
  <text x="170" y="300" class="dm-label">Avoid</text>
</svg>

**URL path versioning** wins for GIS workloads. It aligns with CDN caching strategies, simplifies routing in API gateways, avoids ambiguity when debugging spatial query failures across mixed client fleets, and integrates cleanly with the [spatial resource modeling patterns](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) already established in the core architecture. Header-based versioning forces every cache layer to handle `Vary` headers, which destroys tile and feature cacheability. Query parameters conflict with OGC-compliant spatial filter parameters like `bbox` and `datetime`, which makes them error-prone and semantically confusing.

---

Before choosing a versioning mechanism, classify the change — most changes need no version at all.

<svg viewBox="0 0 720 198" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two kinds of change, two mechanisms: additive — no version needed versus breaking — version or sunset" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Two kinds of change, two mechanisms</title>
  <desc>Two panels. additive — no version needed: a new optional query parameter a new property on a feature a new output format behind Accept a wider allow-list of CRS codes breaking — version or sunset: removing or renaming a property changing the default projection changing a unit or an axis order tightening validation on existing input The test is whether an untouched client keeps working. If it does not, no amount of documentation makes the change additive.</desc>
  <rect x="0" y="0" width="720" height="198" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Two kinds of change, two mechanisms</text>
  <rect x="16" y="40" width="336" height="122" rx="9" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="34" y="62" font-size="11" font-weight="700" fill="var(--viz-good, #1f6b3a)">additive — no version needed</text>
  <text x="34" y="84" font-size="10" fill="currentColor">a new optional query parameter</text>
  <text x="34" y="106" font-size="10" fill="currentColor">a new property on a feature</text>
  <text x="34" y="128" font-size="10" fill="currentColor">a new output format behind Accept</text>
  <text x="34" y="150" font-size="10" fill="currentColor">a wider allow-list of CRS codes</text>
  <rect x="368" y="40" width="336" height="122" rx="9" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.5"/>
  <text x="386" y="62" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">breaking — version or sunset</text>
  <text x="386" y="84" font-size="10" fill="currentColor">removing or renaming a property</text>
  <text x="386" y="106" font-size="10" fill="currentColor">changing the default projection</text>
  <text x="386" y="128" font-size="10" fill="currentColor">changing a unit or an axis order</text>
  <text x="386" y="150" font-size="10" fill="currentColor">tightening validation on existing input</text>
  <text x="20" y="194" font-size="10.5" fill="var(--muted, #7c6fb0)">The test is whether an untouched client keeps working. If it does not, no amount of documentation makes the change additive.</text>
</svg>

## Step-by-Step Implementation

### 1. Architect the Versioned Router Structure

Isolate each API version into dedicated FastAPI `APIRouter` instances. This prevents schema collisions and allows independent middleware, rate-limiting policies, and deprecation headers per version without touching the shared PostGIS service layer.

```python
# app/routers/__init__.py
from fastapi import APIRouter

v1_router = APIRouter(prefix="/v1", tags=["GIS v1"])
v2_router = APIRouter(prefix="/v2", tags=["GIS v2"])
```

Mount both routers in the main application. FastAPI automatically generates separate OpenAPI schemas per version, which eliminates cross-version documentation pollution:

```python
# app/main.py
from fastapi import FastAPI
from app.routers import v1_router, v2_router

app = FastAPI(title="Geospatial API")
app.include_router(v1_router)
app.include_router(v2_router)
```

For larger deployments where v1 and v2 have divergent dependency graphs or database pools, mount them as sub-applications using `app.mount()`. This allows fully independent lifespan events and middleware stacks per version.

### 2. Define Evolving Pydantic Schemas

Spatial schemas must explicitly declare geometry types, coordinate precision, and CRS metadata. As your platform matures you will need stricter validation or new geometry primitives. Rather than mutating existing models, create version-specific schemas that share a common base where the contract is stable.

```python
# app/schemas/v1.py
from pydantic import BaseModel, Field
from typing import Optional

class FeatureV1(BaseModel):
    id: str
    geometry: dict  # Raw GeoJSON dict — permissive for legacy clients
    properties: dict
    crs: Optional[str] = Field(default="EPSG:4326")
```

```python
# app/schemas/v2.py
from pydantic import BaseModel, Field, ConfigDict
from geojson_pydantic import Feature as GeoJSONFeature
from typing import Literal

class FeatureV2(GeoJSONFeature):
    """Strict GeoJSON Feature with enforced CRS and no extra fields."""
    model_config = ConfigDict(extra="forbid")
    # geojson-pydantic validates geometry type, coordinates structure,
    # and required GeoJSON keys automatically.
    crs: Literal["EPSG:4326", "EPSG:3857"] = "EPSG:4326"
```

The v1 schema accepts any dictionary as `geometry`, which is safe for legacy clients that send non-standard extensions. V2 enforces full [strict Pydantic geometry validation](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) using `geojson-pydantic`, rejecting malformed rings or unknown geometry types at the boundary layer before they reach PostGIS.

This pattern prevents accidental field drift and makes breaking changes explicit at the schema level rather than at runtime.

### 3. Maintain PostGIS Query Compatibility

Database layer changes are the most common source of versioning friction. When altering column types (e.g., `geometry` to `geography`) or upgrading PostGIS, your ORM queries must remain version-aware. Use versioned repository classes to isolate query logic:

```python
# app/repositories/spatial_v1.py
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import FeatureModel

async def get_features_v1(
    session: AsyncSession,
    bbox: tuple[float, float, float, float],
) -> list[FeatureModel]:
    """v1: uses ST_Intersects with a plain geometry envelope."""
    stmt = select(FeatureModel).where(
        FeatureModel.geom.ST_Intersects(
            func.ST_MakeEnvelope(bbox[0], bbox[1], bbox[2], bbox[3], 4326)
        )
    )
    result = await session.execute(stmt)
    return result.scalars().all()
```

```python
# app/repositories/spatial_v2.py
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import FeatureModel

async def get_features_v2(
    session: AsyncSession,
    bbox: tuple[float, float, float, float],
    limit: int = 100,
    cursor: str | None = None,
) -> list[FeatureModel]:
    """v2: cursor-aware query — see spatial pagination strategies."""
    envelope = func.ST_MakeEnvelope(bbox[0], bbox[1], bbox[2], bbox[3], 4326)
    stmt = (
        select(FeatureModel)
        .where(FeatureModel.geom.ST_Intersects(envelope))
        .order_by(FeatureModel.id)
        .limit(limit)
    )
    if cursor:
        stmt = stmt.where(FeatureModel.id > cursor)
    result = await session.execute(stmt)
    return result.scalars().all()
```

The v2 repository adds cursor-based pagination — a pattern covered in detail in [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — without touching the v1 path. Always validate that `GIST` indexes remain effective after schema migrations: PostGIS query planners are highly sensitive to geometry type changes, and a column alteration can silently flip a spatial query from an index scan to a sequential scan.

By decoupling repository implementations per version, you can safely deprecate legacy spatial functions (e.g., `ST_AsText` in v1) without disrupting active clients.

### 4. Handle Serialization and Format Negotiation

Early API versions default to verbose GeoJSON for maximum interoperability. Later versions may adopt binary or columnar formats to reduce latency and bandwidth. The [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision matrix covers the trade-offs between text-based and binary spatial formats in detail.

When introducing new serialization options, expose them as distinct endpoints within the same versioned router rather than through content negotiation headers (which reintroduce the CDN caching problem):

```python
# app/routers/v2_features.py
from fastapi import APIRouter, Depends
from fastapi.responses import Response
from app.repositories.spatial_v2 import get_features_v2
from app.schemas.v2 import FeatureCollectionV2
from app.deps import get_db_session
import pyarrow as pa
import pyarrow.parquet as pq
import io

router = APIRouter()

@router.get("/v2/features", response_model=FeatureCollectionV2)
async def list_features_geojson(
    bbox: str,
    cursor: str | None = None,
    session=Depends(get_db_session),
):
    """GeoJSON response — broad client compatibility."""
    xmin, ymin, xmax, ymax = map(float, bbox.split(","))
    features = await get_features_v2(session, (xmin, ymin, xmax, ymax), cursor=cursor)
    return build_feature_collection(features)

@router.get("/v2/features.parquet")
async def list_features_parquet(
    bbox: str,
    session=Depends(get_db_session),
):
    """GeoParquet binary response — optimised for analytics clients."""
    xmin, ymin, xmax, ymax = map(float, bbox.split(","))
    features = await get_features_v2(session, (xmin, ymin, xmax, ymax))
    table = features_to_arrow_table(features)
    buf = io.BytesIO()
    pq.write_table(table, buf)
    return Response(content=buf.getvalue(), media_type="application/vnd.apache.parquet")
```

This keeps CDN caching working on both endpoints while making the format explicit in the URL.

---

## Production Code Example: Full Versioned Route Pair

The following is a cohesive, copy-runnable example that wires together the router, schema, repository, and deprecation headers for a v1/v2 feature endpoint:

```python
# app/main.py — complete versioned feature API
from fastapi import FastAPI, Depends, Header
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.deps import get_db_session
from app.repositories.spatial_v1 import get_features_v1
from app.repositories.spatial_v2 import get_features_v2
from app.schemas.v1 import FeatureV1
from app.schemas.v2 import FeatureV2
from typing import Annotated
import datetime

app = FastAPI(title="Geospatial API", version="2.0.0")

SUNSET_DATE = "2025-06-01"  # ISO 8601 date after which v1 is retired

def add_deprecation_headers(response: JSONResponse, successor: str) -> JSONResponse:
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = SUNSET_DATE
    response.headers["Link"] = f'<{successor}>; rel="successor-version"'
    return response

@app.get("/v1/features", tags=["GIS v1"])
async def v1_list_features(
    bbox: str,
    session: AsyncSession = Depends(get_db_session),
):
    xmin, ymin, xmax, ymax = map(float, bbox.split(","))
    rows = await get_features_v1(session, (xmin, ymin, xmax, ymax))
    body = [FeatureV1.model_validate(r.__dict__) for r in rows]
    resp = JSONResponse(content=[f.model_dump() for f in body])
    return add_deprecation_headers(resp, successor="/v2/features")

@app.get("/v2/features", tags=["GIS v2"])
async def v2_list_features(
    bbox: str,
    cursor: str | None = None,
    session: AsyncSession = Depends(get_db_session),
):
    xmin, ymin, xmax, ymax = map(float, bbox.split(","))
    rows = await get_features_v2(session, (xmin, ymin, xmax, ymax), cursor=cursor)
    body = [FeatureV2.model_validate(r.__dict__) for r in rows]
    next_cursor = rows[-1].id if rows else None
    return {
        "type": "FeatureCollection",
        "features": [f.model_dump() for f in body],
        "next_cursor": next_cursor,
    }
```

---

## Verification & Testing

### Confirming version routing with curl

```bash
# Confirm v1 deprecation headers are present
curl -si "http://localhost:8000/v1/features?bbox=-74.01,40.70,-73.97,40.73" \
  | grep -E "Deprecation|Sunset|Link"
# Expected:
# Deprecation: true
# Sunset: 2025-06-01
# Link: </v2/features>; rel="successor-version"

# Confirm v2 returns cursor for pagination
curl -s "http://localhost:8000/v2/features?bbox=-74.01,40.70,-73.97,40.73" \
  | python3 -m json.tool | grep next_cursor
```

### Confirming PostGIS index usage after a schema migration

Run `EXPLAIN ANALYZE` to verify the `GIST` index is active after any column type change:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, ST_AsGeoJSON(geom)
FROM features
WHERE geom && ST_MakeEnvelope(-74.01, 40.70, -73.97, 40.73, 4326)
  AND ST_Intersects(geom, ST_MakeEnvelope(-74.01, 40.70, -73.97, 40.73, 4326));
```

The plan should show `Index Scan using features_geom_idx on features`. If you see `Seq Scan`, the index is missing or the geometry type changed from `geometry(Polygon,4326)` to an untyped `geometry`, which defeats the planner's type-specific statistics. Re-create the index:

```sql
CREATE INDEX CONCURRENTLY features_geom_idx ON features USING GIST (geom);
ANALYZE features;
```

### Unit test skeleton

```python
# tests/test_versioning.py
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_v1_has_deprecation_headers():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/v1/features?bbox=-74.01,40.70,-73.97,40.73")
    assert r.headers.get("deprecation") == "true"
    assert "sunset" in r.headers

@pytest.mark.asyncio
async def test_v2_returns_cursor():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/v2/features?bbox=-74.01,40.70,-73.97,40.73")
    body = r.json()
    assert "next_cursor" in body
```

---

The cost of a version bump is not the release — it is the overlap that follows it.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="How long each version actually lives: v1 only then v1 + v2 overlap then v2 default then v2 only" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>How long each version actually lives</title>
  <desc>A horizontal timeline. v1 only: launch. v1 + v2 overlap: both served. v2 default: v1 deprecated. v2 only: v1 sunset. The overlap is the expensive phase: two code paths, two test suites, two sets of behaviour to keep straight.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">How long each version actually lives</text>
  <rect x="20" y="92" width="141" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="90" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">v1 only</text>
  <text x="90" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">launch</text>
  <rect x="165" y="92" width="190" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="260" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">v1 + v2 overlap</text>
  <text x="260" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">both served</text>
  <rect x="359" y="92" width="141" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="429" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">v2 default</text>
  <text x="429" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">v1 deprecated</text>
  <rect x="504" y="92" width="190" height="34" rx="5" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="599" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">v2 only</text>
  <text x="599" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">v1 sunset</text>
  <text x="20" y="184" font-size="10.5" fill="var(--muted, #7c6fb0)">The overlap is the expensive phase: two code paths, two test suites, two sets of behaviour to keep straight.</text>
</svg>

## Failure Modes & Edge Cases

1. **GIST index silently dropped after `ALTER COLUMN`** — Changing a geometry column type with `ALTER TABLE features ALTER COLUMN geom TYPE geography` drops the existing `GIST` index. Queries revert to sequential scans without any error. Always run `\d features` and `EXPLAIN ANALYZE` after column migrations to confirm index presence.

2. **`geometry` vs `geography` type mismatch across versions** — If v1 stored coordinates as `geometry(Point,4326)` and v2 switches to `geography`, spatial predicates that mix the two types raise `operator does not exist: geometry && geography`. Keep the column type stable across versions and use explicit casts (`::geography`) only at the query layer.

3. **OpenAPI schema collision when routers share a model name** — FastAPI deduplicates schema names by appending numeric suffixes if `FeatureV1` and `FeatureV2` are both named `Feature` in their respective modules. Always use distinct class names or set `model_config = ConfigDict(title="FeatureV2")` explicitly to prevent collisions in generated OpenAPI JSON.

4. **CDN caching v1 and v2 responses at the same path fragment** — If a proxy strips the version prefix before caching, v1 and v2 clients share the same cache key. Ensure your CDN or API gateway preserves the full path (including `/v1/` or `/v2/`) as part of the cache key.

5. **Cursor invalidation after backfill migrations** — If a v2 migration reassigns primary keys or re-sequences IDs during a bulk geometry correction, existing cursors issued before the migration become invalid. Return `410 Gone` for stale cursors rather than silently returning incorrect result windows.

6. **Timestamp serialization drift between versions** — A common breakage is switching from Unix epoch integers (v1) to ISO 8601 strings with timezone offsets (v2) in temporal-spatial endpoints. Clients expecting integers break silently if they receive strings. Document timestamp format changes as explicit breaking changes in your migration guide.

7. **`Extra inputs are not permitted` on `FeatureV2` with legacy clients** — `ConfigDict(extra="forbid")` will reject requests from legacy clients that send deprecated proprietary fields. Keep `extra="ignore"` in v2 until the client fleet has migrated, then harden to `extra="forbid"` in v3.

---

## Performance Notes

- **Router isolation overhead is negligible.** FastAPI's `APIRouter` resolves at startup, not per-request. Mounting ten versioned routers adds no measurable per-request latency.
- **Version-specific database sessions** allow you to point v1 at a read replica and v2 at the primary, reducing write contention during migration windows. Wire this via `Depends` factory functions rather than a shared session pool.
- **GIST index selectivity drops with `geography` columns on large datasets.** For bounding boxes covering more than ~5% of the indexed area, PostGIS may switch to sequential scans even with a healthy index. Partition large tables by tile or region boundary before introducing a new version to keep query plans predictable.
- **Deprecation header overhead.** Adding four response headers per v1 request adds roughly 0.1 µs per response — immeasurable in practice but worth noting if you serve millions of small tile requests per second through a shared endpoint.
- **Contract testing between versions prevents regressions.** Run [Schemathesis](https://schemathesis.readthedocs.io/) or a similar property-based API tester against both `/v1` and `/v2` OpenAPI specs in CI. Schema regressions in spatial endpoints (e.g., a geometry field changing from `object` to `string` in the spec) will surface immediately rather than at client integration time.

---

## FAQ

### Why is URL path versioning preferred for spatial APIs over header versioning?

URL path versioning aligns with CDN caching strategies, simplifies API gateway routing, and makes the active spatial contract immediately visible in logs and debugging sessions. Header versioning adds ambiguity when tracing spatial query failures across middleware layers and forces `Vary` headers that break feature and tile cacheability.

### How do I prevent GIST index invalidation when migrating PostGIS schemas between versions?

Use versioned repository classes that isolate spatial query logic per version. After any geometry column type change, run `REINDEX` on the affected `GIST` index and validate with `EXPLAIN ANALYZE` that the planner still uses the index rather than a sequential scan.

### When should I sunset a spatial API version?

Add `Deprecation` and `Sunset` response headers from day one of the successor version. Monitor per-version traffic via OpenTelemetry traces and retire the old version once it falls below 5% of total requests, giving clients at least 90 days notice after the `Sunset` date is set.

---

## Related

- [Versioning Geospatial APIs Without Breaking Clients](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/versioning-geospatial-apis-without-breaking-clients/) — contract testing, shadow routing, and gradual rollout patterns
- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — choosing the right format for versioned spatial responses
- [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — cursor-based pagination in versioned spatial endpoints
- [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — enforcing geometry contracts at the v2 schema boundary
- [Spatial Resource Modeling Patterns](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) — structuring FastAPI routers and PostGIS table hierarchies

← Back to [Core Geospatial API Architecture with FastAPI & PostGIS](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/)
