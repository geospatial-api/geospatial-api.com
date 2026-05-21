---
layout: layouts/page.njk
title: "How to Structure FastAPI Routers for PostGIS Tables"
description: "Structure FastAPI routers for PostGIS using domain-scoped files, GeoAlchemy2 type mapping, and spatial filter pushdown to the database layer via SQLAlchemy."
---

To structure FastAPI routers for PostGIS tables effectively, isolate spatial endpoints into modular, domain-scoped router files, map geometry columns with GeoAlchemy2, and enforce strict Pydantic schemas that validate GeoJSON payloads before database insertion. Mount routers under a versioned prefix (e.g., `/api/v1`), separate read and write operations, and push spatial filtering (`ST_Intersects`, `ST_DWithin`, `ST_Within`) into SQLAlchemy queries rather than loading full geometries into Python memory. This architecture minimizes serialization overhead, keeps routing logic decoupled from spatial computation, and aligns with scalable [Spatial Resource Modeling Patterns](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) for production geospatial platforms.

### Core Architectural Principles

When designing geospatial APIs, routing structure directly impacts query performance, maintainability, and deployment flexibility. Follow these rules:

- **Domain-Scoped Routing:** Group endpoints by spatial entity (`/parcels`, `/sensors`, `/zones`) instead of HTTP verb. Each router owns its models, schemas, and query helpers.
- **Geometry Pushdown:** Execute spatial predicates directly in PostgreSQL. Fetching raw WKB/WKT into Python for filtering causes massive memory spikes and defeats PostGIS indexing.
- **Strict Schema Boundaries:** Validate incoming GeoJSON at the edge. Strip unnecessary properties, enforce coordinate precision, and return consistent output shapes.
- **Async I/O & Connection Pooling:** Use `asyncpg` with SQLAlchemy’s async engine to handle concurrent spatial queries without blocking the event loop. FastAPI’s [async SQLAlchemy integration](https://fastapi.tiangolo.com/tutorial/sql-databases/) provides the foundation for non-blocking database sessions.

### Recommended Directory Layout

A maintainable structure separates concerns while keeping spatial logic explicit and testable:

```
app/
├── routers/
│   ├── __init__.py
│   └── parcels.py          # Domain-scoped spatial router
├── models/
│   └── spatial.py          # SQLAlchemy + GeoAlchemy2 ORM
├── schemas/
│   └── spatial.py          # Pydantic v2 validation & serialization
├── services/
│   └── spatial_queries.py  # Reusable PostGIS query functions
├── database.py             # Async engine & session factory
└── main.py                 # Router aggregation & app factory
```

This layout scales cleanly as your [Core Geospatial API Architecture with FastAPI & PostGIS](/core-geospatial-api-architecture-with-fastapi-postgis/) expands to include raster layers, topology checks, or multi-tenant spatial isolation. Each router imports only the models and schemas it requires, preventing circular dependencies and enabling independent deployment of spatial microservices.

### Complete Implementation

Below is a production-ready router setup for a `parcels` PostGIS table. It uses async SQLAlchemy, GeoAlchemy2 for geometry mapping, and Pydantic v2 for GeoJSON validation.

```python
# app/models/spatial.py
from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase
from geoalchemy2 import Geometry

class Base(DeclarativeBase):
    pass

class Parcel(Base):
    __tablename__ = "parcels"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    geom = Column(Geometry("POLYGON", srid=4326), nullable=False)
```

```python
# app/schemas/spatial.py
from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any

class ParcelCreate(BaseModel):
    name: str = Field(..., max_length=100)
    geom: Dict[str, Any] = Field(..., description="Valid GeoJSON geometry object")

class ParcelOut(BaseModel):
    id: int
    name: str
    geom: Optional[Dict[str, Any]] = None
    model_config = ConfigDict(from_attributes=True)
```

```python
# app/services/spatial_queries.py
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.spatial import Parcel

async def get_parcels_within_radius(
    db: AsyncSession,
    longitude: float,
    latitude: float,
    radius_meters: float = 500.0,
    limit: int = 50
) -> list[dict]:
    point_wkt = f"POINT({longitude} {latitude})"
    query = (
        select(Parcel.id, Parcel.name)
        .where(
            func.ST_DWithin(
                Parcel.geom,
                func.ST_SetSRID(func.ST_GeomFromText(point_wkt), 4326),
                radius_meters
            )
        )
        .limit(limit)
    )
    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]
```

```python
# app/routers/parcels.py
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from shapely.geometry import shape
from geoalchemy2.elements import WKTElement

from app.models.spatial import Parcel
from app.schemas.spatial import ParcelCreate, ParcelOut
from app.database import get_db
from app.services.spatial_queries import get_parcels_within_radius

router = APIRouter(prefix="/parcels", tags=["parcels"])

@router.post("/", response_model=ParcelOut, status_code=201)
async def create_parcel(payload: ParcelCreate, db: AsyncSession = Depends(get_db)):
    try:
        shp = shape(payload.geom)
        db_parcel = Parcel(name=payload.name, geom=WKTElement(shp.wkt, srid=4326))
        db.add(db_parcel)
        await db.commit()
        await db.refresh(db_parcel)
        return db_parcel
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"Invalid geometry: {str(e)}")

@router.get("/nearby", response_model=list[dict])
async def list_nearby_parcels(
    lng: float = Query(..., ge=-180, le=180),
    lat: float = Query(..., ge=-90, le=90),
    radius: float = Query(500.0, gt=0),
    db: AsyncSession = Depends(get_db)
):
    return await get_parcels_within_radius(db, lng, lat, radius)
```

```python
# app/main.py
from fastapi import FastAPI
from app.routers import parcels

app = FastAPI(title="Geospatial Platform API", version="1.0.0")
app.include_router(parcels.router, prefix="/api/v1")
```

### Spatial Query Optimization & Pushdown

The most common performance bottleneck in geospatial APIs is loading full geometries into Python memory for filtering. Instead, push spatial operations to PostGIS using SQLAlchemy’s `func` namespace. Functions like `ST_DWithin` leverage GiST indexes and execute entirely in the database kernel, returning only scalar IDs or attributes. For complex intersections, use `ST_Intersects` with bounding box pre-filtering (`&&` operator) to reduce candidate rows before exact geometry evaluation. This pattern aligns with official [PostGIS spatial function documentation](https://postgis.net/docs/ST_DWithin.html) and ensures sub-100ms response times even on million-row tables.

### Validation & Serialization Strategy

GeoJSON payloads vary widely in structure. Pydantic v2’s `model_config` and strict typing prevent malformed coordinates from reaching the database. For production systems, consider integrating `geojson-pydantic` to enforce RFC 7946 compliance automatically. When serializing outputs, strip geometry properties unless explicitly requested, and convert `WKTElement` objects to dictionaries using `shapely.geometry.shape` or PostGIS’s `ST_AsGeoJSON` in the query layer. This reduces response payload size by 40–70% and prevents client-side parsing errors.

### Testing & Deployment Notes

- **Unit Testing:** Mock `AsyncSession` and verify that spatial queries compile to valid SQL using `str(query.compile(compile_kwargs={"literal_binds": True}))`.
- **Connection Pooling:** Configure `pool_size=20` and `max_overflow=10` for async engines to handle concurrent spatial requests without exhausting database connections.
- **Indexing:** Ensure every geometry column has a GiST index (`CREATE INDEX idx_parcels_geom ON parcels USING GIST(geom);`). Without it, `ST_DWithin` degrades to sequential scans.

By following this structure, you achieve a clean separation between routing, validation, and spatial computation. The architecture scales horizontally, supports async concurrency, and maintains strict type safety across the request lifecycle.