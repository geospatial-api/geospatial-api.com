---
layout: layouts/page.njk
title: "Spatial Resource Modeling Patterns"
description: "Master spatial resource modeling for FastAPI and PostGIS. Map geometry to endpoints, normalize CRS, optimize spatial queries, and prevent N+1 query traps at scale."
slug: spatial-resource-modeling-patterns
breadcrumb: "Core Geospatial API Architecture > Spatial Resource Modeling Patterns"
datePublished: "2024-01-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Spatial Resource Modeling Patterns",
      "description": "Master spatial resource modeling for FastAPI and PostGIS. Map geometry to endpoints, normalize CRS, optimize spatial queries, and prevent N+1 query traps at scale.",
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
          "name": "Spatial Resource Modeling Patterns",
          "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/"
        }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Spatial Resource Modeling Patterns for FastAPI and PostGIS",
      "step": [
        { "@type": "HowToStep", "name": "Define spatial boundaries and select storage types", "position": 1 },
        { "@type": "HowToStep", "name": "Structure routers around spatial entities", "position": 2 },
        { "@type": "HowToStep", "name": "Implement connection pooling and async query execution", "position": 3 },
        { "@type": "HowToStep", "name": "Optimize payload serialization and format selection", "position": 4 },
        { "@type": "HowToStep", "name": "Design pagination and cursor boundaries for spatial data", "position": 5 }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "When should I use PostGIS geometry vs geography types?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use geography for data spanning large extents where spheroidal accuracy matters (e.g., global asset tracking). Use geometry with an explicit SRID for localized, high-throughput applications like municipal zoning or indoor mapping — it is faster and supports a wider set of PostGIS functions."
          }
        },
        {
          "@type": "Question",
          "name": "How do I prevent N+1 spatial queries in FastAPI?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use selectinload or explicit JOIN queries with SQLAlchemy 2.0 async sessions. Never rely on lazy loading inside async endpoints — lazy loads trigger synchronous I/O that blocks the event loop and causes cascading timeouts under concurrent load."
          }
        },
        {
          "@type": "Question",
          "name": "What is the correct coordinate order for GeoJSON in a FastAPI API?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "RFC 7946 mandates longitude, then latitude (x, y order). Document this explicitly in your OpenAPI schema and validate it with a Pydantic field_validator to prevent client-side coordinate inversion bugs."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Core Geospatial API Architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/)

# Spatial Resource Modeling Patterns

Designing production-grade geospatial APIs requires more than mapping database tables to JSON endpoints. This page establishes repeatable conventions for representing geographic entities, managing coordinate reference systems, optimizing spatial queries, and structuring API boundaries in FastAPI with PostGIS — the decisions that determine whether your service scales predictably or collapses under concurrent load.

<svg viewBox="0 0 820 340" role="img" aria-label="Spatial resource modeling layer diagram: client, FastAPI application, and PostGIS database layers with labeled data flow" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:820px;font-family:inherit">
  <title>Spatial Resource Modeling: Three-Layer Architecture</title>
  <desc>Diagram showing the flow from Client through FastAPI Application Layer (Pydantic validation, router, serialization) down to PostGIS Database Layer (geometry type, GIST index, async pool), with labeled arrows for each handoff.</desc>
  <rect x="0" y="0" width="820" height="340" rx="10" fill="var(--surface, #f5f3ff)"/>
  <!-- Background panels -->
  <rect x="10" y="10" width="800" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.3"/>
  <rect x="10" y="100" width="800" height="140" rx="8" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.3"/>
  <rect x="10" y="265" width="800" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.3"/>
  <!-- Layer labels -->
  <text x="26" y="46" font-size="13" fill="currentColor" opacity="0.6" font-weight="600">CLIENT</text>
  <text x="26" y="113" font-size="11" fill="currentColor" opacity="0.6" font-weight="600">FASTAPI APPLICATION LAYER</text>
  <text x="26" y="259" font-size="11" fill="currentColor" opacity="0.6" font-weight="600">POSTGIS DATABASE LAYER</text>
  <!-- Client box -->
  <rect x="330" y="20" width="160" height="38" rx="6" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1.5"/>
  <text x="410" y="44" text-anchor="middle" font-size="13" fill="currentColor">HTTP Request / GeoJSON</text>
  <!-- FastAPI boxes -->
  <rect x="80" y="120" width="150" height="38" rx="6" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1.5"/>
  <text x="155" y="144" text-anchor="middle" font-size="13" fill="currentColor">Pydantic Validation</text>
  <rect x="335" y="112" width="150" height="38" rx="6" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1.5"/>
  <text x="410" y="136" text-anchor="middle" font-size="13" fill="currentColor">APIRouter + Deps</text>
  <rect x="590" y="112" width="160" height="38" rx="6" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1.5"/>
  <text x="670" y="136" text-anchor="middle" font-size="13" fill="currentColor">Serialization / Format</text>
  <!-- Sub-labels for FastAPI row -->
  <text x="155" y="174" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.55">CRS check · bbox bounds</text>
  <text x="410" y="166" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.55">prefix · tags · middleware</text>
  <text x="670" y="166" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.55">GeoJSON · GeoParquet · stream</text>
  <!-- DB boxes -->
  <rect x="80" y="276" width="150" height="38" rx="6" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1.5"/>
  <text x="155" y="300" text-anchor="middle" font-size="13" fill="currentColor">Geometry / Geography</text>
  <rect x="335" y="276" width="150" height="38" rx="6" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1.5"/>
  <text x="410" y="300" text-anchor="middle" font-size="13" fill="currentColor">GIST Spatial Index</text>
  <rect x="590" y="276" width="160" height="38" rx="6" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1.5"/>
  <text x="670" y="300" text-anchor="middle" font-size="13" fill="currentColor">asyncpg Pool</text>
  <!-- Arrows: client → validation -->
  <line x1="380" y1="58" x2="200" y2="120" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.5" marker-end="url(#arr)"/>
  <!-- Arrows: client → router -->
  <line x1="410" y1="58" x2="410" y2="112" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.5" marker-end="url(#arr)"/>
  <!-- Arrows: client → serialization -->
  <line x1="440" y1="58" x2="630" y2="112" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.5" marker-end="url(#arr)"/>
  <!-- Arrows: app → db -->
  <line x1="155" y1="158" x2="155" y2="276" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.5" marker-end="url(#arr)"/>
  <line x1="410" y1="150" x2="410" y2="276" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.5" marker-end="url(#arr)"/>
  <line x1="670" y1="150" x2="670" y2="276" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.5" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Prerequisites & Environment

Before implementing these patterns, confirm your stack meets the following baseline:

- `fastapi>=0.100` with `asyncio`-compatible database drivers (`asyncpg>=0.29`)
- `sqlalchemy>=2.0` with `geoalchemy2>=0.14` for PostGIS type mapping
- `PostgreSQL 14+` with `PostGIS 3.3+` — verify with `SELECT PostGIS_Full_Version();`
- `pydantic>=2.0` for field validators and model serialization
- Familiarity with OGC Simple Features geometry types and coordinate reference systems

## Decision Matrix: Geometry Type Selection

This is the first modeling decision you make and the one that most affects query performance and API contract stability. Choose incorrectly and you get silent precision loss or severe latency spikes.

| Criterion | `geometry` (planar) | `geography` (spheroidal) |
|---|---|---|
| Coordinate system | Projected (e.g. UTM, EPSG:3857) or geographic with planar math | WGS84 (EPSG:4326) with ellipsoidal math |
| Distance accuracy | Exact within projection zone; degrades near poles | Globally accurate — metres without projection |
| PostGIS function support | Full (`ST_Buffer`, `ST_Union`, all overlay ops) | Subset only (`ST_DWithin`, `ST_Distance`, `ST_Area`) |
| Query performance | Faster — GIST index on planar coordinates is highly optimized | ~20–30% slower for complex operations |
| Best for | Municipal zoning, indoor mapping, sub-regional analytics | Global asset tracking, shipping routes, country-level analysis |
| Type declaration | `Geometry(geometry_type="POLYGON", srid=4326)` | `Geography(geometry_type="POLYGON", srid=4326)` |

When modeling resources that span regional or global extents, default to the spheroidal `geography` type. For localized, high-throughput applications, planar `geometry` with an explicit SRID constraint outperforms at scale.

The column type is the first and strongest validation layer, and the untyped option gives all of it away.

<svg viewBox="0 0 720 234" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Choosing a geometry column type: Mixed types, Indexable, Validated" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Choosing a geometry column type</title>
  <desc>A comparison table. geometry: Mixed types yes, Indexable yes, Validated no. accepts anything, including SRID 0 geometry(Point, 4326): Mixed types no, Indexable yes, Validated yes. the default for point layers geometry(MultiPolygon, 4326): Mixed types no, Indexable yes, Validated yes. survives ST_MakeValid geography(Point, 4326): Mixed types no, Indexable yes, Validated yes. metric, fewer functions Typing the column is the cheapest validation available: enforced by the database, applied to every writer.</desc>
  <rect x="0" y="0" width="720" height="234" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Choosing a geometry column type</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Mixed types</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Indexable</text>
  <text x="502" y="58" font-size="10" font-weight="700" fill="currentColor">Validated</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">geometry</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="88" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">accepts anything, including</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">geometry(Point, 4326)</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="568" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">the default for point layers</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">geometry(MultiPolygon, 4326)</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="568" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">survives ST_MakeValid</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">geography(Point, 4326)</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="568" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">metric, fewer functions</text>
  <text x="20" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">Typing the column is the cheapest validation available: enforced by the database, applied to every writer.</text>
</svg>

## Step-by-Step Implementation

### Step 1: Define Spatial Column Types with Enforced Constraints

Declare the column type explicitly in your SQLAlchemy model. The SRID and spatial index must be co-defined with the column — post-hoc migration of SRID constraints is error-prone and may silently accept mismatched incoming coordinates.

```python
from sqlalchemy import Column, Integer, String, CheckConstraint
from sqlalchemy.orm import DeclarativeBase
from geoalchemy2 import Geometry

class Base(DeclarativeBase):
    pass

class Parcel(Base):
    __tablename__ = "parcels"
    __table_args__ = (
        # Reject null geometries at the DB level — not just the application layer
        CheckConstraint("geom IS NOT NULL", name="parcels_geom_not_null"),
    )

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    # geometry_type constrains the column; spatial_index=True creates the GIST index
    geom = Column(
        Geometry(geometry_type="POLYGON", srid=4326, spatial_index=True)
    )
```

Document the expected coordinate order (longitude, then latitude, per RFC 7946) in your OpenAPI schema. Failing to do so causes client-side inversion bugs that produce geometries mirrored across the prime meridian — a notoriously difficult runtime error to diagnose.

### Step 2: Structure Routers Around Spatial Entities

Geospatial APIs frequently suffer from monolithic route files that mix CRUD, spatial analysis, and administrative operations. Clean modeling requires isolating spatial resources by domain boundary: `/parcels`, `/sensors`, `/routes`. Each router owns its Pydantic response models, query builders, and error handlers.

For the full directory convention and dependency injection patterns, see [FastAPI Routers for PostGIS Tables](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/how-to-structure-fastapi-routers-for-postgis-tables/).

```python
# routers/parcels.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from schemas.parcel import ParcelRead, ParcelCreate
from db.session import get_db_session

router = APIRouter(prefix="/parcels", tags=["Parcels"])

@router.get("/{parcel_id}", response_model=ParcelRead)
async def get_parcel(
    parcel_id: int,
    db: AsyncSession = Depends(get_db_session),
):
    result = await db.get(Parcel, parcel_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Parcel not found")
    return result
```

Keep Pydantic schemas in a parallel `schemas/` directory, separating `Create`, `Update`, `Read`, and `SpatialQuery` variants. Inject spatial validation middleware at the router level to normalize incoming bounding boxes and reject out-of-bounds coordinates before they reach the database.

### Step 3: Implement Async Connection Pooling

Spatial queries are I/O heavy. Without proper connection management, concurrent requests exhaust your database pool and trigger cascading timeouts. FastAPI's dependency injection system provides a clean mechanism for managing `asyncpg` connection lifecycles.

```python
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Pool size formula: (2 × CPU cores) + effective_spindle_count
# For a 4-core host with SSD: pool_size=9, max_overflow=5
engine = create_async_engine(
    "postgresql+asyncpg://user:pass@localhost/gis_db",
    pool_size=9,
    max_overflow=5,
    pool_timeout=30,
    pool_pre_ping=True,  # detect stale connections before use
)
AsyncSessionFactory = async_sessionmaker(engine, expire_on_commit=False)

async def get_db_session():
    async with AsyncSessionFactory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
```

Avoid synchronous `psycopg2` or blocking ORM calls inside async endpoints — they freeze the event loop and collapse throughput under concurrent load. Use `selectinload` or explicit `JOIN` queries instead of lazy loading to eliminate N+1 spatial relationship fetches.

### Step 4: Optimize Payload Serialization

A single complex polygon with thousands of vertices can inflate a JSON response to several megabytes. Modern spatial APIs must support format negotiation and selective serialization. The [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision matrix covers the full trade-off between human-readable interchange and columnar compression for analytical workloads.

```python
from fastapi import Request
from fastapi.responses import StreamingResponse, Response
import orjson

@router.get("/export", summary="Stream spatial dataset with format negotiation")
async def export_parcels(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    accept = request.headers.get("Accept", "application/geo+json")

    if "vnd.apache.parquet" in accept:
        # Return GeoParquet for data pipeline consumers
        return await stream_geoparquet(db)

    # Default: stream GeoJSON with coordinate precision trimming
    async def geojson_stream():
        yield b'{"type":"FeatureCollection","features":['
        first = True
        async for row in await db.stream(select(Parcel)):
            feature = row_to_geojson_feature(row, precision=6)
            prefix = b"" if first else b","
            yield prefix + orjson.dumps(feature)
            first = False
        yield b"]}"

    return StreamingResponse(geojson_stream(), media_type="application/geo+json")
```

Apply coordinate precision trimming (6 decimals for metre-level accuracy, 4 for kilometre-level) before serialization. This reduces payload size by 30–50% without perceptible visual loss in web mapping clients.

### Step 5: Design Spatial-Aware Pagination

Traditional offset-based pagination breaks down with spatial datasets. Sorting by `id` or `created_at` ignores geographic proximity and produces inconsistent results across pages when used alongside map-viewport filtering. As detailed in [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/), cursor-based pagination with bounding-box boundaries maintains deterministic ordering and respects spatial indexes.

```python
import base64, json
from sqlalchemy import select, and_

@router.get("/", response_model=ParcelPage)
async def list_parcels(
    bbox: str | None = None,          # "minx,miny,maxx,maxy" (WGS84)
    cursor: str | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db_session),
):
    filters = []

    if bbox:
        minx, miny, maxx, maxy = [float(v) for v in bbox.split(",")]
        filters.append(
            Parcel.geom.ST_Intersects(
                f"SRID=4326;POLYGON(({minx} {miny},{maxx} {miny},"
                f"{maxx} {maxy},{minx} {maxy},{minx} {miny}))"
            )
        )

    if cursor:
        last_id = json.loads(base64.b64decode(cursor))["last_id"]
        filters.append(Parcel.id > last_id)

    stmt = (
        select(Parcel)
        .where(and_(*filters))
        .order_by(Parcel.id)
        .limit(limit + 1)  # fetch one extra to detect next page
    )
    rows = (await db.execute(stmt)).scalars().all()

    has_next = len(rows) > limit
    rows = rows[:limit]
    next_cursor = None
    if has_next:
        payload = json.dumps({"last_id": rows[-1].id})
        next_cursor = base64.b64encode(payload.encode()).decode()

    return {"features": rows, "next_cursor": next_cursor}
```

## Production Code Example

The following route demonstrates the full modeling pattern: geometry validation, async query, `ST_AsGeoJSON` serialization, and coordinate precision enforcement in a single cohesive endpoint.

```python
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from db.session import get_db_session
import orjson

router = APIRouter(prefix="/parcels", tags=["Parcels"])

@router.get("/{parcel_id}/geojson")
async def get_parcel_geojson(
    parcel_id: int,
    precision: int = Query(default=6, ge=1, le=10),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Return a single parcel as a GeoJSON Feature.
    ST_AsGeoJSON handles coordinate ordering (lon, lat) per RFC 7946.
    precision controls decimal places (6 = ~0.1m accuracy at equator).
    """
    sql = text("""
        SELECT
            id,
            name,
            ST_AsGeoJSON(geom, :precision)::jsonb AS geometry
        FROM parcels
        WHERE id = :parcel_id
    """)
    result = await db.execute(sql, {"parcel_id": parcel_id, "precision": precision})
    row = result.mappings().one_or_none()

    if row is None:
        raise HTTPException(status_code=404, detail=f"Parcel {parcel_id} not found")

    feature = {
        "type": "Feature",
        "id": row["id"],
        "properties": {"name": row["name"]},
        "geometry": row["geometry"],
    }
    return Response(content=orjson.dumps(feature), media_type="application/geo+json")
```

## Verification & Testing

After implementing the patterns above, confirm correctness with the following checks.

**Curl smoke test:**

```bash
# Should return HTTP 200 with Content-Type: application/geo+json
curl -s -I "http://localhost:8000/parcels/1/geojson" | grep -E "HTTP|content-type"

# Check geometry coordinates are in lon, lat order
curl -s "http://localhost:8000/parcels/1/geojson" | python3 -c \
  "import sys,json; g=json.load(sys.stdin); print(g['geometry']['coordinates'])"
```

**EXPLAIN ANALYZE — confirm GIST index is used:**

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, ST_AsGeoJSON(geom, 6)
FROM parcels
WHERE ST_Intersects(
    geom,
    ST_MakeEnvelope(-0.5, 51.3, 0.5, 51.6, 4326)
);
-- Expected: "Index Scan using parcels_geom_idx on parcels"
-- Red flag: "Seq Scan" means the GIST index is not being used
```

**Unit test skeleton:**

```python
import pytest
from httpx import AsyncClient
from main import app

@pytest.mark.asyncio
async def test_parcel_geojson_structure():
    async with AsyncClient(app=app, base_url="http://test") as client:
        response = await client.get("/parcels/1/geojson")
    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "Feature"
    assert "geometry" in body
    assert body["geometry"]["type"] == "Polygon"
    # Validate coordinate order: first coordinate is [lon, lat] — lon must be in [-180, 180]
    first_coord = body["geometry"]["coordinates"][0][0]
    assert -180 <= first_coord[0] <= 180, "Longitude out of range — likely swapped with latitude"
```

Resource modelling is deciding which of these four is canonical — and the answer should always be the leftmost.

<svg viewBox="0 0 720 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="One feature resource, four representations: row then model then payload then tile" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>One feature resource, four representations</title>
  <desc>A left to right pipeline. Stage 1, row: geometry(…, 4326) canonical. Stage 2, model: Pydantic Feature validated. Stage 3, payload: GeoJSON Feature negotiated. Stage 4, tile: MVT layer rendered. Each representation drops something: the tile has no attributes to speak of, the payload has no index, the model has no persistence.</desc>
  <rect x="0" y="0" width="720" height="210" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">One feature resource, four representations</text>
  <rect x="18" y="52" width="154" height="86" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="95" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">row</text>
  <text x="95" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">geometry(…, 4326)</text>
  <text x="95" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">canonical</text>
  <path d="M175 95 L189 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#aronefeature)"/>
  <rect x="194" y="52" width="154" height="86" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="271" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">model</text>
  <text x="271" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">Pydantic Feature</text>
  <text x="271" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">validated</text>
  <path d="M351 95 L365 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#aronefeature)"/>
  <rect x="370" y="52" width="154" height="86" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="447" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">payload</text>
  <text x="447" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">GeoJSON Feature</text>
  <text x="447" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">negotiated</text>
  <path d="M527 95 L541 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#aronefeature)"/>
  <rect x="546" y="52" width="154" height="86" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="623" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">tile</text>
  <text x="623" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">MVT layer</text>
  <text x="623" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">rendered</text>
  <text x="20" y="168" font-size="10.5" fill="var(--muted, #7c6fb0)">Each representation drops something: the tile has no attributes to speak of, the payload has no index, the model has no persistence.</text>
  <defs><marker id="aronefeature" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker></defs>
</svg>

## One more modelling decision: where identity lives

A spatial resource usually has two candidate identifiers: the database key and whatever the source system calls the feature — a parcel reference, an asset tag, a national grid identifier. Exposing the database key is simpler and couples clients to an implementation detail that changes on every migration. Exposing the source identifier is more stable and forces the API to handle the case where two sources disagree about the same real-world object.

The workable compromise is to expose both: the database key as the canonical `id` used in URLs, and the source identifier as an indexed property that supports lookup. That keeps URLs stable across a re-import, which is the failure this decision actually protects against.

## One more modelling decision: where identity lives

A spatial resource usually has two candidate identifiers: the database key and whatever the source system calls the feature — a parcel reference, an asset tag, a national grid identifier. Exposing the database key is simpler and couples clients to an implementation detail that changes on every migration. Exposing the source identifier is more stable and forces the API to handle the case where two sources disagree about the same real-world object.

The workable compromise is to expose both: the database key as the canonical `id` used in URLs, and the source identifier as an indexed property that supports lookup. That keeps URLs stable across a re-import, which is the failure this decision actually protects against.

Whichever identifier scheme is chosen, document it as part of the resource contract rather than leaving it implied by the URL structure. Clients build their own indexes against whatever the API returns, and discovering after a year that the stable-looking identifier was never guaranteed to be stable is an expensive conversation.

## Failure Modes & Edge Cases

1. **Silent coordinate inversion.** Accepting `(lat, lon)` instead of `(lon, lat)` creates geometries that map to the wrong hemisphere. `ST_IsValid` cannot catch this — only a bounds check against the expected region will. Validate incoming coordinate arrays with a Pydantic `@field_validator` that asserts longitude is in `[-180, 180]` and latitude in `[-90, 90]`.

2. **GIST index not used after type migration.** If you add a spatial column to an existing table and then run `CREATE INDEX CONCURRENTLY`, the planner may still prefer a sequential scan until `ANALYZE parcels;` is run. Always run `ANALYZE` after bulk inserts or schema changes.

3. **N+1 spatial joins under lazy loading.** SQLAlchemy 2.0 async sessions raise `MissingGreenlet` if lazy relationships are accessed outside the session scope. Use `selectinload` or write explicit JOIN queries — do not rely on the ORM's default lazy strategy in async contexts.

4. **Pool exhaustion under slow spatial queries.** `ST_Buffer` and `ST_Union` on large polygon sets can hold a connection for seconds. With the default pool size, 10 simultaneous slow queries will exhaust a pool of 10. Set `statement_timeout` at the PostgreSQL role level (`ALTER ROLE api_user SET statement_timeout = '5s'`) and handle `asyncpg.exceptions.QueryCanceledError` gracefully.

5. **`GEOSException: TopologyException` on malformed input.** Invalid geometries (self-intersecting rings, unclosed polygons) cause PostGIS to raise this at query time, not at insert time, unless `AddGeometryColumn` constraints or a `CHECK (ST_IsValid(geom))` constraint is in place. Add the validity check constraint during schema creation, not after data has been loaded.

6. **`CheckConstraint` not enforced on bulk loads.** `COPY` and `INSERT ... SELECT` bypass row-level triggers but do enforce `CHECK` constraints. However, if you disable constraints for a bulk load (`SET session_replication_role = replica`), re-enable and validate with `SELECT id FROM parcels WHERE NOT ST_IsValid(geom)` before re-exposing the API.

## Performance Notes

- **GIST vs BRIN indexes:** GIST indexes are the default for spatial columns and support all PostGIS operators. BRIN indexes are smaller but only useful for spatially sorted data (e.g., sensor readings inserted in geographic order). For most API use cases, GIST is the correct choice.
- **`ST_Simplify` before serialization:** For zoom levels below 10 in web mapping, apply `ST_Simplify(geom, 0.001)` server-side before serializing. This can reduce geometry vertex counts by 80% with no visible impact at the target zoom.
- **Async vs sync latency:** On a 4-core server, an async FastAPI endpoint with `asyncpg` handles ~3× the concurrent spatial requests of a synchronous `psycopg2` endpoint before latency degrades, because spatial I/O wait time is spent yielding the event loop rather than blocking it.
- **Connection pool tuning:** Start with `pool_size = (2 × vCPU) + 1`. For workloads dominated by long-running analytical queries, reduce `pool_size` and increase `max_overflow` to prevent pool exhaustion while keeping idle connections low.

## Frequently Asked Questions

### When should I use PostGIS `geometry` vs `geography` types?

Use `geography` for data spanning large extents where spheroidal accuracy matters (global asset tracking, shipping routes). Use `geometry` with an explicit SRID for localized, high-throughput applications like municipal zoning or indoor mapping — it is faster and supports a wider set of PostGIS functions including all topology operations.

### How do I prevent N+1 spatial queries in FastAPI?

Use `selectinload` or explicit `JOIN` queries with SQLAlchemy 2.0 async sessions. Never rely on lazy loading inside async endpoints — lazy loads trigger synchronous I/O that blocks the event loop and causes cascading timeouts under concurrent load.

### What is the correct coordinate order for GeoJSON in a FastAPI API?

RFC 7946 mandates longitude, then latitude (x, y order). Document this explicitly in your OpenAPI schema and validate it with a Pydantic `field_validator` to prevent client-side coordinate inversion bugs that produce geometries mirrored across the prime meridian.

---

## Related

- [FastAPI Routers for PostGIS Tables](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/how-to-structure-fastapi-routers-for-postgis-tables/) — directory layout, dependency injection, and middleware wiring for spatial routers
- [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — cursor encoding, bounding-box pagination, and index-safe ordering
- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — format selection decision matrix and streaming implementation
- [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — versioning strategies that keep spatial contracts stable across client generations

← Back to [Core Geospatial API Architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/)
