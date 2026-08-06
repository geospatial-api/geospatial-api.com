---
layout: layouts/page.njk
title: "How to Structure FastAPI Routers for PostGIS Tables"
description: "Step-by-step guide to structuring FastAPI routers for PostGIS tables: domain-scoped files, GeoAlchemy2 type mapping, async sessions, and spatial filter pushdown via SQLAlchemy."
slug: how-to-structure-fastapi-routers-for-postgis-tables
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "Spatial Resource Modeling Patterns"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/"
  - label: "How to Structure FastAPI Routers for PostGIS Tables"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/how-to-structure-fastapi-routers-for-postgis-tables/"
datePublished: "2025-06-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "How to Structure FastAPI Routers for PostGIS Tables",
      "description": "Step-by-step guide to structuring FastAPI routers for PostGIS tables: domain-scoped files, GeoAlchemy2 type mapping, async sessions, and spatial filter pushdown via SQLAlchemy.",
      "datePublished": "2025-06-01",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "Geospatial API" },
      "proficiencyLevel": "Intermediate"
    },
    {
      "@type": "Article",
      "headline": "How to Structure FastAPI Routers for PostGIS Tables",
      "datePublished": "2025-06-01",
      "dateModified": "2026-06-23"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 2, "name": "Spatial Resource Modeling Patterns", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/" },
        { "@type": "ListItem", "position": 3, "name": "How to Structure FastAPI Routers for PostGIS Tables", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/how-to-structure-fastapi-routers-for-postgis-tables/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "How to Structure FastAPI Routers for PostGIS Tables",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Set up the directory layout", "text": "Create domain-scoped router files under app/routers/, one file per spatial entity." },
        { "@type": "HowToStep", "position": 2, "name": "Define GeoAlchemy2 ORM models", "text": "Map PostGIS geometry columns using GeoAlchemy2 with explicit SRID and geometry type." },
        { "@type": "HowToStep", "position": 3, "name": "Write Pydantic v2 schemas", "text": "Validate incoming GeoJSON payloads and serialize output with strict models." },
        { "@type": "HowToStep", "position": 4, "name": "Implement async spatial query services", "text": "Push spatial predicates (ST_DWithin, ST_Intersects) into SQLAlchemy queries." },
        { "@type": "HowToStep", "position": 5, "name": "Wire routers into the app", "text": "Mount domain routers under a versioned prefix in main.py." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why should each spatial entity have its own router file?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Isolating entities into separate router files prevents circular imports, makes spatial middleware (CRS validation, bbox sanitisation) easy to attach per domain, and lets each router evolve its schema independently without breaking siblings."
          }
        },
        {
          "@type": "Question",
          "name": "Why does ST_DWithin return wrong distances without a geography cast?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "A plain geometry column with SRID 4326 measures distances in degrees. Passing 500 to ST_DWithin(geom, point, 500) without casting to geography matches features within ~500 degrees—the whole globe. Cast both arguments to geography so the threshold is interpreted as metres."
          }
        },
        {
          "@type": "Question",
          "name": "How do I return GeoJSON from a GeoAlchemy2 column?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use ST_AsGeoJSON in the SELECT clause and parse the returned string with json.loads(), or call shapely.geometry.mapping(to_shape(row.geom)) in Python. Avoid loading raw WKB into Python only to re-serialise—do the conversion in PostgreSQL."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Spatial Resource Modeling Patterns](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/)

# How to Structure FastAPI Routers for PostGIS Tables

Isolate spatial endpoints into modular, domain-scoped router files, map geometry columns with GeoAlchemy2, and enforce strict Pydantic schemas that validate GeoJSON payloads before any data reaches the database.

## Context & When to Use

This approach is the right choice when a FastAPI application exposes more than one spatial entity—for example, `parcels`, `sensors`, and `routes` in the same codebase. Monolithic route files that mix spatial CRUD, analysis endpoints, and admin utilities become impossible to test in isolation and make it hard to attach entity-specific middleware (CRS validation, bounding-box sanitisation, rate limiting).

The pattern fits best when you are using [SQLAlchemy 2.0 async with PostGIS](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) and need geometry filtering to stay inside the database. If you are building a single-entity prototype or a read-only tile proxy, the added structure is premature—but for anything that will carry production traffic, separating router, schema, and query layers pays off quickly.

One precondition: every geometry column must carry an explicit SRID (typically EPSG:4326) and a GiST index. Without the index, `ST_DWithin` and `ST_Intersects` degrade to sequential scans that make router-level optimisations irrelevant.

## Recommended Directory Layout

The layout below separates concerns while keeping spatial logic explicit and testable. One router file per domain entity; Pydantic schemas and query services in parallel directories.

```
app/
├── routers/
│   ├── __init__.py
│   └── parcels.py          # Domain-scoped spatial router
├── models/
│   └── spatial.py          # SQLAlchemy + GeoAlchemy2 ORM
├── schemas/
│   └── spatial.py          # Pydantic v2 validation & serialisation
├── services/
│   └── spatial_queries.py  # Reusable PostGIS query functions
├── database.py             # Async engine & session factory
└── main.py                 # Router aggregation & app factory
```

This structure scales as your platform grows to include raster layers, topology checks, or [multi-tenant spatial isolation](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/). Each router imports only the models and schemas it requires, preventing circular dependencies and enabling independent deployment if you later migrate to microservices.

<svg viewBox="-6 74 647 187" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="FastAPI router architecture diagram showing request flow from client through router to service and PostGIS" style="width:100%;max-width:640px;height:auto;display:block;margin:1.5rem auto;">
  <title>FastAPI router architecture for PostGIS</title>
  <desc>A request flows from the HTTP client into a domain-scoped FastAPI router, which validates the payload through a Pydantic schema, delegates spatial query logic to a service layer, and pushes ST_DWithin or ST_Intersects predicates into PostgreSQL/PostGIS via an async SQLAlchemy session.</desc>
  <!-- Background -->
  <rect x="-6" y="74" width="647" height="187" fill="var(--surface, #f5f3ff)"/>
  <!-- Client box -->
  <rect x="10" y="115" width="90" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="55" y="136" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">HTTP</text>
  <text x="55" y="152" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">Client</text>
  <!-- Arrow: client → router -->
  <line x1="100" y1="140" x2="145" y2="140" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="122" y="132" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif">POST</text>
  <text x="122" y="143" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif">/parcels</text>
  <!-- Router box -->
  <rect x="145" y="100" width="120" height="80" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="205" y="122" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" font-weight="bold">Router</text>
  <text x="205" y="138" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif">routers/parcels.py</text>
  <text x="205" y="153" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif">APIRouter prefix</text>
  <text x="205" y="168" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif">= "/parcels"</text>
  <!-- Arrow: router → schema -->
  <line x1="265" y1="120" x2="315" y2="120" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="290" y="113" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif">validate</text>
  <!-- Schema box -->
  <rect x="315" y="90" width="120" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="375" y="115" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" font-weight="bold">Pydantic v2</text>
  <text x="375" y="131" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif">ParcelCreate schema</text>
  <text x="375" y="145" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif">GeoJSON → WKT</text>
  <!-- Arrow: schema back to router (validated) -->
  <line x1="315" y1="140" x2="265" y2="155" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" stroke-dasharray="4 3"/>
  <!-- Arrow: router → service -->
  <line x1="265" y1="160" x2="315" y2="200" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="287" y="188" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif">call</text>
  <!-- Service box -->
  <rect x="315" y="185" width="120" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="375" y="207" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" font-weight="bold">Service layer</text>
  <text x="375" y="223" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif">spatial_queries.py</text>
  <text x="375" y="238" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif">ST_DWithin / ST_Intersects</text>
  <!-- Arrow: service → PostGIS -->
  <line x1="435" y1="215" x2="490" y2="215" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="462" y="208" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif">async SQL</text>
  <!-- PostGIS box -->
  <rect x="490" y="185" width="135" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="557" y="210" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" font-weight="bold">PostgreSQL</text>
  <text x="557" y="226" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif">+ PostGIS</text>
  <text x="557" y="241" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif">GiST index scan</text>
  <!-- Arrow marker -->
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

## Runnable Implementation

The four files below form a self-contained, production-ready setup for a `parcels` PostGIS table. Copy them in order; each step references the previous one.

**Step 1 — ORM model (`app/models/spatial.py`)**

```python
from sqlalchemy import Column, Integer, String, CheckConstraint
from sqlalchemy.orm import DeclarativeBase
from geoalchemy2 import Geometry

class Base(DeclarativeBase):
    pass

class Parcel(Base):
    __tablename__ = "parcels"
    __table_args__ = (
        CheckConstraint("geom IS NOT NULL", name="parcels_geom_not_null"),
    )
    id   = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    # Explicit geometry type + SRID triggers automatic GiST index creation
    geom = Column(Geometry("POLYGON", srid=4326, spatial_index=True), nullable=False)
```

**Step 2 — Pydantic v2 schemas (`app/schemas/spatial.py`)**

```python
from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any

class ParcelCreate(BaseModel):
    name: str = Field(..., max_length=100)
    # Accept any valid GeoJSON geometry object; validated further in the router
    geom: Dict[str, Any] = Field(..., description="RFC 7946 GeoJSON geometry object")

class ParcelOut(BaseModel):
    id:   int
    name: str
    geom: Optional[Dict[str, Any]] = None
    model_config = ConfigDict(from_attributes=True)
```

For stricter RFC 7946 validation—enforcing correct coordinate ranges, geometry type constraints, and ring orientation—replace the `Dict[str, Any]` field with `geojson-pydantic`'s typed geometry models. See [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) for a complete migration path.

**Step 3 — Async database session (`app/database.py`)**

```python
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from typing import AsyncGenerator

DATABASE_URL = "postgresql+asyncpg://user:pass@localhost/gis_db"

engine = create_async_engine(
    DATABASE_URL,
    pool_size=20,        # tune to CPU count × expected concurrent spatial queries
    max_overflow=10,
    echo=False,
)

AsyncSessionFactory = async_sessionmaker(engine, expire_on_commit=False)

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionFactory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
```

**Step 4 — Spatial query service (`app/services/spatial_queries.py`)**

```python
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.spatial import Parcel

async def get_parcels_within_radius(
    db:             AsyncSession,
    longitude:      float,
    latitude:       float,
    radius_meters:  float = 500.0,
    limit:          int   = 50,
) -> list[dict]:
    """
    ST_DWithin with geography casts uses metric distances (metres).
    Without the cast, the threshold would be interpreted as degrees—
    500 degrees matches the entire globe.
    """
    point_geog = func.ST_SetSRID(
        func.ST_MakePoint(longitude, latitude), 4326
    ).cast(func.geography())

    query = (
        select(Parcel.id, Parcel.name)
        .where(
            func.ST_DWithin(
                func.cast(Parcel.geom, func.geography()),
                point_geog,
                radius_meters,
            )
        )
        .limit(limit)
    )
    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]
```

**Step 5 — Domain-scoped router (`app/routers/parcels.py`)**

```python
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from shapely.geometry import shape
from geoalchemy2.elements import WKTElement

from app.models.spatial  import Parcel
from app.schemas.spatial import ParcelCreate, ParcelOut
from app.database        import get_db
from app.services.spatial_queries import get_parcels_within_radius

router = APIRouter(prefix="/parcels", tags=["parcels"])

@router.post("/", response_model=ParcelOut, status_code=201)
async def create_parcel(
    payload: ParcelCreate,
    db:      AsyncSession = Depends(get_db),
):
    try:
        shp = shape(payload.geom)          # validates geometry topology via Shapely
        db_parcel = Parcel(
            name=payload.name,
            geom=WKTElement(shp.wkt, srid=4326),
        )
        db.add(db_parcel)
        await db.commit()
        await db.refresh(db_parcel)
        return db_parcel
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"Invalid geometry: {exc}")

@router.get("/nearby", response_model=list[dict])
async def list_nearby_parcels(
    lng:    float = Query(..., ge=-180, le=180),
    lat:    float = Query(..., ge=-90,  le=90),
    radius: float = Query(500.0, gt=0, description="Search radius in metres"),
    db:     AsyncSession = Depends(get_db),
):
    return await get_parcels_within_radius(db, lng, lat, radius)
```

**Step 6 — App factory (`app/main.py`)**

```python
from fastapi import FastAPI
from app.routers import parcels

app = FastAPI(title="Geospatial Platform API", version="1.0.0")
# Versioned prefix isolates breaking changes from existing clients;
# see API Versioning for GIS Endpoints for migration strategies.
app.include_router(parcels.router, prefix="/api/v1")
```

Mount additional entity routers (`sensors`, `zones`, `routes`) with the same pattern: one `include_router` call per domain, each carrying its own prefix and tags. For a full strategy on evolving these prefixes without breaking existing clients, see [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/).

The layout question is really an ownership question — each concern has exactly one right home.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Where each concern belongs in the router tree: Router, Dependency, Query layer" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where each concern belongs in the router tree</title>
  <desc>A comparison table. bbox parsing: Router no, Dependency yes, Query layer no. reusable across routes auth and scope check: Router no, Dependency yes, Query layer no. runs before the handler SQL text: Router no, Dependency no, Query layer yes. one module per table response shaping: Router yes, Dependency no, Query layer no. route-specific pagination cursor: Router no, Dependency yes, Query layer partly. decoded once, applied in SQL A route that contains SQL is a route that cannot be tested without a database.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Where each concern belongs in the router tree</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Router</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Dependency</text>
  <text x="502" y="58" font-size="10" font-weight="700" fill="currentColor">Query layer</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">bbox parsing</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="88" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">reusable across routes</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">auth and scope check</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">runs before the handler</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">SQL text</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="510" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="568" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">one module per table</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">response shaping</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="510" y="184" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">route-specific</text>
  <line x1="20" y1="194" x2="700" y2="194" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="216" font-size="10.5" fill="currentColor">pagination cursor</text>
  <text x="294" y="216" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="216" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="216" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="568" y="216" font-size="9.5" fill="var(--muted, #7c6fb0)">decoded once, applied in SQL</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">A route that contains SQL is a route that cannot be tested without a database.</text>
</svg>

## Key Parameters & Options

| Parameter / setting | Where it lives | Effect |
|---|---|---|
| `Geometry("POLYGON", srid=4326, spatial_index=True)` | ORM column | Creates a GiST index automatically; change the type string for `POINT`, `LINESTRING`, or `MULTIPOLYGON` |
| `pool_size=20, max_overflow=10` | `create_async_engine` | Caps concurrent DB connections; raise for high-concurrency PostGIS workloads, lower for serverless deployments |
| `expire_on_commit=False` | `async_sessionmaker` | Prevents stale-state errors when accessing model attributes after `await db.commit()` |
| `radius_meters` in `ST_DWithin` | Service layer | Only meaningful with a `geography` cast; without it the unit is degrees |
| `limit=50` in spatial queries | Service layer | Hard cap prevents runaway responses on large tables; combine with [cursor-based pagination](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) for full result sets |
| `prefix="/api/v1"` | `include_router` | Namespaces all routes; bump to `/api/v2` for breaking schema changes |

Router files grow quietly, and the point at which they stop being readable is fairly predictable.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Routes per module, and what happens past the knee: 1–6 routes one module — comfortable, 7–12 routes split by resource, 13–25 routes split by resource and verb, 26+ routes the file nobody opens willingly" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Routes per module, and what happens past the knee</title>
  <desc>A horizontal bar chart. 1–6 routes is one module — comfortable. 7–12 routes is split by resource. 13–25 routes is split by resource and verb. 26+ routes is the file nobody opens willingly. The split that scales is by resource, not by HTTP verb — a features module, a tiles module, an exports module.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Routes per module, and what happens past the knee</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">1–6 routes</text>
  <rect x="250" y="48" width="51" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="309" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">one module — comfortable</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">7–12 routes</text>
  <rect x="250" y="82" width="102" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="360" y="95" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">split by resource</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">13–25 routes</text>
  <rect x="250" y="116" width="212" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="470" y="129" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">split by resource and verb</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">26+ routes</text>
  <rect x="250" y="150" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="163" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">the file nobody opens</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">The split that scales is by resource, not by HTTP verb — a features module, a tiles module, an exports module.</text>
</svg>

## Gotchas & Failure Modes

- **Missing GiST index causes full table scans.** GeoAlchemy2's `spatial_index=True` creates the index for new tables, but existing tables need a manual migration: `CREATE INDEX CONCURRENTLY idx_parcels_geom ON parcels USING GIST(geom);`. Without it, `ST_DWithin` on a million-row table takes seconds instead of milliseconds.

- **`geography` cast omitted in distance queries.** `ST_DWithin(geom, point, 500)` with a `geometry` column uses degree-based distance. 500 degrees covers the entire globe. Always cast both arguments to `geography` when the threshold is in metres.

- **`WKTElement` without SRID silently defaults to SRID 0.** PostGIS stores the geometry but spatial index lookups that compare against SRID 4326 data return empty result sets. Always pass `srid=4326` (or your target CRS) to `WKTElement`.

- **Blocking ORM calls inside async handlers.** Using synchronous `psycopg2` sessions or calling `session.execute()` without `await` freezes the event loop under concurrent load. All SQLAlchemy calls inside async route handlers must use `await`.

- **Lazy-loading N+1 on spatial relationships.** If a `Parcel` has a relationship to `Zone` objects and you access `parcel.zones` inside a loop, SQLAlchemy fires one query per parcel. Use `selectinload` or an explicit `JOIN` with a single `ST_Intersects` predicate. The [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) page covers serialisation strategies that compound with this problem for large response payloads.

## Verification

Confirm the setup is working with three quick checks:

**1. SQL compilation check (unit test, no database needed)**

```python
from sqlalchemy.dialects import postgresql
from app.services.spatial_queries import get_parcels_within_radius
from sqlalchemy import select, func
from app.models.spatial import Parcel

query = (
    select(Parcel.id, Parcel.name)
    .where(func.ST_DWithin(
        func.cast(Parcel.geom, func.geography()),
        func.ST_SetSRID(func.ST_MakePoint(-0.1, 51.5), 4326).cast(func.geography()),
        500,
    ))
    .limit(50)
)
print(query.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
# Expect: ... WHERE ST_DWithin(CAST(parcels.geom AS geography), ...::geography, 500) ...
```

**2. Live endpoint test**

```bash
curl -s "http://localhost:8000/api/v1/parcels/nearby?lng=-0.1&lat=51.5&radius=1000" \
  | python3 -m json.tool
# Expect: a JSON array of {id, name} objects; empty array is fine if no data exists yet
```

**3. Index usage via EXPLAIN**

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, name
FROM parcels
WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(-0.1, 51.5), 4326)::geography, 1000);
```

The plan should show `Index Scan using idx_parcels_geom` (or the auto-generated name). A `Seq Scan` confirms the index is missing or the SRID mismatch is preventing its use.

---

## Related

- [Spatial Resource Modeling Patterns](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) — the parent page covering geometry type selection, connection pooling, and pagination design across all spatial entities
- [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — replace offset pagination with bounding-box cursors that respect GiST indexes
- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — format decision matrix for router response serialisation at scale
- [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — evolve router prefixes and schema versions without breaking existing clients
- [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — enforce RFC 7946 geometry constraints in the Pydantic layer before touching the database

← Back to [Spatial Resource Modeling Patterns](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/)
