---
layout: layouts/page.njk
title: "Implementing ST_Within and ST_Intersects in FastAPI"
description: "Use PostGIS ST_Within and ST_Intersects in FastAPI. Validate GeoJSON with Pydantic v2, map geometry with GeoAlchemy2, and leverage GiST index optimisation in queries."
---

# Implementing ST_Within and ST_Intersects in FastAPI

To implement `ST_Within` and `ST_Intersects` in FastAPI, validate incoming GeoJSON payloads with Pydantic, map PostGIS geometry columns using `GeoAlchemy2`, and execute spatial predicates via `sqlalchemy.func`. Both functions evaluate relationships at the database layer, meaning FastAPI should focus on request validation, SRID normalization, and query orchestration rather than in-memory geometry math. `ST_Intersects` returns `TRUE` when geometries share any space (including boundaries), while `ST_Within` returns `TRUE` only when the first geometry is completely contained inside the second. For production APIs, always pair these predicates with GiST spatial indexes and explicit SRID casting to prevent full-table scans and silent `FALSE` returns.

## Core Spatial Predicates

Understanding the mathematical difference between these two PostGIS functions is critical for correct API behavior:

- **`ST_Intersects(geomA, geomB)`**: Returns true if the geometries share at least one point. This includes touching boundaries, overlapping interiors, and complete containment. It is the most common choice for "find features near/inside this area" queries.
- **`ST_Within(geomA, geomB)`**: Returns true only if `geomA` is strictly inside `geomB`. Boundaries touching without interior overlap return `FALSE`. Use this when you need strict containment logic (e.g., verifying a parcel falls entirely within a zoning district).

Both functions leverage PostGIS's spatial indexing capabilities when available. For authoritative reference on parameter ordering and edge-case behavior, consult the official [PostGIS Spatial Functions documentation](https://postgis.net/docs/ST_Intersects.html).

## Request Validation & Data Contracts

FastAPI's strength in spatial routing comes from strict input contracts. GeoJSON follows [RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946), but raw payloads often contain invalid polygons, missing SRIDs, or self-intersecting rings. Pydantic enforces the structure, while `shapely` handles geometric validation before the query reaches the database.

When designing your endpoint, enforce:
1. Explicit `type` validation (`Polygon` or `MultiPolygon`)
2. Coordinate bounds checking (WGS84: `-180` to `180` longitude, `-90` to `90` latitude)
3. Automatic topology repair using `shapely.validation.make_valid()`

For broader patterns on structuring these payloads and handling versioned spatial schemas, review [Advanced Spatial Endpoint Implementation & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/).

## Complete FastAPI Implementation

The following endpoint accepts a GeoJSON geometry, validates it, normalizes the topology, and executes both spatial queries against a PostGIS-backed table. It uses SQLAlchemy 2.0 syntax and `GeoAlchemy2` for seamless WKB/WKT translation.

```python
from fastapi import FastAPI, HTTPException, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, select, func, Column, Integer, String
from sqlalchemy.orm import Session, sessionmaker, declarative_base
from geoalchemy2 import Geometry
from shapely.geometry import shape as shapely_shape
from shapely.validation import make_valid
import logging

app = FastAPI()
Base = declarative_base()

# Database configuration
DATABASE_URL = "postgresql+psycopg2://user:pass@localhost:5432/gis_db"
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)

# SQLAlchemy Model
class Location(Base):
    __tablename__ = "locations"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    geom = Column(Geometry(geometry_type="POLYGON", srid=4326))

# Pydantic Request Contract
class SpatialQuery(BaseModel):
    geometry: dict = Field(..., description="RFC 7946 GeoJSON Polygon or MultiPolygon")
    query_type: str = Field("intersects", pattern="^(intersects|within)$")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@app.post("/api/v1/spatial/query", status_code=status.HTTP_200_OK)
def run_spatial_query(query: SpatialQuery, db: Session = Depends(get_db)):
    try:
        # 1. Validate & normalize geometry
        shapely_geom = shapely_shape(query.geometry)
        if not shapely_geom.is_valid:
            shapely_geom = make_valid(shapely_geom)
            
        # Use WKT for safe, driver-agnostic geometry binding
        wkt = shapely_geom.wkt

        # 2. Build base query
        stmt = select(Location)

        # 3. Apply spatial predicate with explicit SRID casting
        if query.query_type == "intersects":
            stmt = stmt.where(func.ST_Intersects(
                Location.geom,
                func.ST_GeomFromText(wkt, 4326)
            ))
        elif query.query_type == "within":
            stmt = stmt.where(func.ST_Within(
                Location.geom,
                func.ST_GeomFromText(wkt, 4326)
            ))

        # 4. Execute & serialize
        results = db.scalars(stmt).all()
        return {
            "count": len(results),
            "query_type": query.query_type,
            "locations": [{"id": r.id, "name": r.name} for r in results]
        }
    except Exception as e:
        logging.error(f"Spatial query failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid geometry or database error. Ensure coordinates are valid WGS84."
        )
```

## Production Hardening & Query Optimization

Spatial queries degrade quickly without proper indexing. PostGIS relies on GiST indexes to accelerate bounding-box lookups before running expensive exact-geometry calculations. Ensure your table includes:

```sql
CREATE INDEX idx_locations_geom ON locations USING GIST (geom);
```

When scaling to millions of rows, exact `ST_Within` or `ST_Intersects` calls can still trigger sequential scans if the query planner lacks statistics. Run `ANALYZE locations` after bulk inserts, and consider adding a bounding-box pre-filter using `ST_Envelope` or `&&` operator to force index usage. For detailed indexing strategies and query plan analysis, see [Bounding Box & Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/).

Additional production safeguards:
- **SRID Enforcement**: Always cast input geometries to `4326` (or your project's standard SRID) using `ST_SetSRID` or `ST_Transform` if mismatched. Silent SRID mismatches return `FALSE` without errors.
- **Connection Pooling**: Use `pool_pre_ping=True` in SQLAlchemy to handle stale PostgreSQL connections under high concurrency.
- **GeoAlchemy2 Configuration**: Map complex geometry types (`MULTIPOLYGON`, `GEOMETRYCOLLECTION`) explicitly in your model to avoid `Geometry` type coercion overhead.
- **Response Serialization**: For large result sets, stream GeoJSON features instead of loading entire objects into memory. Use `db.stream()` with `cursor`-based pagination.

By combining strict Pydantic contracts, binary WKB transmission, and database-native spatial evaluation, you achieve sub-100ms response times even on complex polygon datasets.