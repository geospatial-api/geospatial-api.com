---
layout: layouts/page.njk
title: "Spatial Resource Modeling Patterns"
description: "Master spatial resource modeling for FastAPI and PostGIS. Map geometry to endpoints, normalize CRS, optimize spatial queries, and prevent N+1 query traps at scale."
---

# Spatial Resource Modeling Patterns

Designing robust geospatial APIs requires more than mapping database tables to JSON endpoints. **Spatial Resource Modeling Patterns** establish repeatable, production-grade conventions for representing geographic entities, managing coordinate reference systems, optimizing spatial queries, and structuring API boundaries. When implemented correctly, these patterns reduce payload bloat, prevent N+1 query traps, and ensure that your geospatial services scale predictably under concurrent load. This guide builds directly on the foundational principles outlined in [Core Geospatial API Architecture with FastAPI & PostGIS](/core-geospatial-api-architecture-with-fastapi-postgis/), translating architectural theory into concrete, tested implementation workflows.

## Prerequisites

Before implementing these patterns, ensure your stack meets the following baseline requirements:

- **FastAPI 0.100+** with `asyncio`-compatible database drivers (`asyncpg`)
- **SQLAlchemy 2.0+** with `geoalchemy2` for PostGIS type mapping
- **PostgreSQL 14+** with **PostGIS 3.3+** extension enabled
- Familiarity with OGC Simple Features and coordinate reference systems (CRS)
- Basic understanding of RESTful resource boundaries and dependency injection

## Step 1: Define Spatial Boundaries & Select Storage Types

The first modeling decision dictates query performance and API contract stability. PostGIS offers two primary spatial types: `geometry` (planar, fast, metric-dependent) and `geography` (spheroidal, globally accurate, computationally heavier). Choosing incorrectly leads to silent precision loss or severe latency spikes. When modeling resources that span regional or global extents, default to the spheroidal type. For localized, high-throughput applications (e.g., indoor mapping, municipal zoning), planar coordinates with explicit CRS constraints outperform. A detailed breakdown of when to apply each type is covered in Using PostGIS geography vs geometry types in APIs.

**Workflow Implementation:**
1. Declare the column type explicitly in your SQLAlchemy model using `geoalchemy2.types.Geometry` or `geoalchemy2.types.Geography`.
2. Enforce SRID constraints at the schema level (`srid=4326` for WGS84).
3. Add a `CheckConstraint` to prevent null geometries if the business logic requires mandatory spatial data.
4. Document the expected coordinate order (X/Y vs Lat/Lon) in your OpenAPI schema to prevent client-side inversion bugs.

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
    
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    # Explicit SRID and geometry type for deterministic indexing
    geom = Column(Geometry(geometry_type="POLYGON", srid=4326, spatial_index=True))
```

## Step 2: Structure Routers Around Spatial Entities

Geospatial APIs often suffer from monolithic route files that mix CRUD operations, spatial analysis endpoints, and administrative utilities. Clean modeling requires isolating spatial resources by domain boundary (e.g., `/parcels`, `/sensors`, `/routes`). Each router should own its own Pydantic response models, query builders, and error handlers. Implementing a modular router layout prevents circular imports and makes it trivial to attach spatial middleware (e.g., CRS validation, bounding box sanitization). Reference [How to structure FastAPI routers for PostGIS tables](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/how-to-structure-fastapi-routers-for-postgis-tables/) for directory conventions and dependency injection patterns.

**Workflow Implementation:**
1. Create a dedicated `routers/` directory with one file per spatial entity.
2. Keep Pydantic schemas in a parallel `schemas/` directory, separating `Create`, `Update`, `Read`, and `SpatialQuery` variants.
3. Use FastAPI's `APIRouter` with explicit `prefix` and `tags` to auto-generate grouped OpenAPI documentation.
4. Inject spatial validation middleware at the router level to normalize incoming bounding boxes and reject out-of-bounds coordinates before they hit the database.

## Step 3: Implement Connection Pooling & Async Query Execution

Spatial queries are inherently I/O heavy. Without proper connection management, concurrent requests will exhaust your database pool and trigger cascading timeouts. FastAPI’s dependency injection system provides a clean mechanism for managing `asyncpg` connection lifecycles. By leveraging `Depends`, you can guarantee that connections are acquired, scoped to the request, and safely returned to the pool regardless of exception paths. The implementation details are documented in Using FastAPI Depends for database connection pooling.

**Workflow Implementation:**
1. Initialize `asyncpg` with a fixed pool size tuned to your CPU cores and expected spatial query complexity.
2. Wrap session acquisition in a context manager that handles transaction commits/rollbacks automatically.
3. Avoid synchronous `psycopg2` or blocking ORM calls inside async endpoints; they will freeze the event loop.
4. Use `selectinload` or explicit `JOIN` queries instead of lazy loading to eliminate N+1 spatial relationship fetches.

```python
from fastapi import Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from contextlib import asynccontextmanager

# Engine must be created before the session factory is constructed
engine = create_async_engine("postgresql+asyncpg://user:pass@localhost/gis_db")
AsyncSessionFactory = async_sessionmaker(engine, expire_on_commit=False)

@asynccontextmanager
async def get_db_session():
    async with AsyncSessionFactory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise HTTPException(status_code=500, detail="Spatial transaction failed")
        finally:
            await session.close()
```

## Step 4: Optimize Payload Serialization & Format Selection

Raw spatial data can quickly overwhelm network bandwidth. A single complex polygon with thousands of vertices can inflate a JSON response to several megabytes. Modern APIs must support format negotiation and selective serialization. While GeoJSON remains the default for web mapping, binary formats like GeoParquet drastically reduce payload size and parsing overhead for analytical workloads. Understanding the trade-offs between human-readable interchange and columnar compression is critical for API design. We explore serialization benchmarks and implementation strategies in [GeoJSON vs GeoParquet Serialization](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/).

**Workflow Implementation:**
1. Implement `Accept` header routing in FastAPI to serve `application/json` for browsers and `application/vnd.apache.parquet` for data pipelines.
2. Use `orjson` for synchronous JSON serialization to bypass Python’s GIL bottlenecks during large geometry encoding.
3. Apply coordinate precision trimming (e.g., 6 decimals for meters, 4 for kilometers) before serialization to reduce payload size by 30–50% without perceptible visual loss.
4. Stream large spatial datasets using `StreamingResponse` with chunked generators to prevent memory exhaustion on the server.

## Step 5: Design Pagination & Cursor Boundaries for Spatial Data

Traditional offset-based pagination breaks down when applied to spatial datasets. Sorting by `id` or `created_at` ignores geographic proximity, causing inconsistent results across pages and defeating the purpose of map-based exploration. Spatial APIs require cursor-based or bounding-box-driven pagination strategies that maintain deterministic ordering and respect spatial indexes. Implementing a spatial cursor typically involves encoding the last returned geometry’s centroid or bounding box into an opaque token. For a complete breakdown of cursor encoding, index utilization, and edge-case handling, see [Spatial Pagination & Cursor Strategies](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/).

**Workflow Implementation:**
1. Replace `OFFSET` with `WHERE` clauses using `ST_Intersects` or `ST_DWithin` combined with a deterministic sort key (e.g., `ST_AsBinary(geom)` or a Hilbert curve index).
2. Generate opaque cursor tokens using Base64-encoded JSON containing the bounding box coordinates and the last primary key.
3. Validate cursor tokens server-side to prevent injection or malformed geometry attacks.
4. Return pagination metadata (`next_cursor`, `total_estimated`, `bbox`) in a standardized envelope to enable seamless client-side map tiling.

## Validation, Error Mapping & Production Hardening

Reliable spatial APIs enforce strict validation at the boundary. Accepting malformed coordinates or invalid CRS identifiers silently corrupts downstream analytics. Use Pydantic validators to enforce WGS84 bounds, validate GeoJSON structure against [RFC 7946](https://www.rfc-editor.org/rfc/rfc7946), and catch PostGIS topology exceptions before they reach the client. Always map database-level spatial errors (e.g., `GEOSException`, `InvalidGeometry`) to standardized HTTP 400 responses with actionable error codes.

**Workflow Implementation:**
1. Attach a Pydantic `@validator` to coordinate arrays to verify `min <= max` for bounding boxes and reject NaN/Infinity values.
2. Wrap PostGIS function calls in `try/except` blocks that catch `sqlalchemy.exc.DBAPIError` and parse the underlying PostgreSQL error code.
3. Return structured error payloads containing `code`, `message`, and `spatial_context` (e.g., the offending geometry ID) to accelerate client debugging.
4. Align your API contract with the [OGC API - Features specification](https://ogcapi.ogc.org/features/) to ensure interoperability with third-party GIS platforms and government data portals.

## Conclusion

Adopting **Spatial Resource Modeling Patterns** transforms geospatial APIs from fragile data dumps into resilient, scalable services. By enforcing strict type selection, modular routing, async connection pooling, intelligent serialization, and spatial-aware pagination, you eliminate the most common failure points in production GIS systems. These workflows are designed to be stacked incrementally: start with schema constraints and router isolation, then layer in connection management and cursor pagination as traffic grows. The result is an API that handles millions of spatial queries predictably while maintaining strict contract compliance and minimal latency.