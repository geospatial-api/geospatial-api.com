---
layout: layouts/page.njk
title: "Advanced Spatial Endpoint Implementation & Data Contracts"
description: "Strict Pydantic v2 geometry validation, GiST index-aware query patterns, KNN routing, async bulk ingestion with Celery, and idempotent spatial writes at scale — a complete engineering reference for FastAPI + PostGIS APIs."
slug: advanced-spatial-endpoint-implementation-data-contracts
breadcrumb: Advanced Spatial Endpoints & Data Contracts
datePublished: "2025-01-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Advanced Spatial Endpoint Implementation & Data Contracts",
      "description": "Strict Pydantic v2 geometry validation, GiST index-aware query patterns, KNN routing, async bulk ingestion with Celery, and idempotent spatial writes at scale.",
      "datePublished": "2025-01-15",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" }
      ]
    },
    {
      "@type": "Article",
      "headline": "Advanced Spatial Endpoint Implementation & Data Contracts",
      "datePublished": "2025-01-15",
      "dateModified": "2026-06-23"
    },
    {
      "@type": "HowTo",
      "name": "How to implement advanced spatial endpoints with strict data contracts",
      "step": [
        { "@type": "HowToStep", "name": "Define spatial data contracts with Pydantic v2", "text": "Enforce geometry topology, CRS alignment, and coordinate precision at the validation layer before PostGIS receives the payload." },
        { "@type": "HowToStep", "name": "Configure GiST indexes for spatial query patterns", "text": "Create GiST indexes on geometry columns and structure queries to use the && bounding-box operator before applying precise predicates." },
        { "@type": "HowToStep", "name": "Implement KNN distance queries", "text": "Use the PostGIS <-> operator with GiST index support to retrieve the k nearest geometries without full-table scans." },
        { "@type": "HowToStep", "name": "Offload bulk geometry processing to Celery", "text": "Accept uploads with a 202 Accepted response, push to a message queue, and process asynchronously with idempotency guards." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is a spatial data contract in a FastAPI PostGIS API?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "A spatial data contract is an explicit schema — enforced via Pydantic v2 validators — that defines acceptable geometry formats, coordinate reference systems, precision levels, and topology rules. It prevents malformed GeoJSON, mismatched CRS payloads, and self-intersecting polygons from reaching PostGIS."
          }
        },
        {
          "@type": "Question",
          "name": "Why does ST_DWithin perform better than ST_Distance for proximity filters?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "ST_DWithin is index-aware when used with GEOGRAPHY types or projected GEOMETRY columns — it applies a bounding box pre-filter internally so PostGIS can use the GiST index to prune candidate rows before computing exact distances. ST_Distance forces a full sequential scan because it calculates the precise distance for every row first."
          }
        },
        {
          "@type": "Question",
          "name": "When should bulk geometry uploads use Celery vs direct database inserts?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use Celery for uploads exceeding a few hundred geometries, uploads requiring topology correction or CRS reprojection, and any batch where processing time would exceed a reasonable HTTP timeout. Direct inserts are acceptable for small, pre-validated payloads where the client can wait for a synchronous response."
          }
        }
      ]
    }
  ]
}
</script>

# Advanced Spatial Endpoint Implementation & Data Contracts

Backend engineers building production geospatial APIs with FastAPI and PostGIS face a distinct set of challenges: geometry payloads that violate topology rules, index-bypassing queries that collapse under load, and bulk ingestion pipelines that block the event loop. This guide covers the four sub-systems that determine whether a spatial API holds up at scale — data contract enforcement, index-aware query design, nearest-neighbor routing, and asynchronous bulk processing — with runnable code and specific PostGIS configuration at each layer.

---

## Architectural Blueprint

The diagram below shows how the four sub-systems compose into a layered request lifecycle. Validation happens before the query reaches the database; index selection determines query cost; heavy processing exits the synchronous path entirely.

<svg viewBox="0 0 760 420" role="img" aria-label="Layered architecture diagram showing the four sub-systems of a spatial API: contract validation, index-aware queries, KNN routing, and async bulk processing" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:760px;display:block;margin:2rem auto;">
  <title>Spatial API Architecture: Four Sub-Systems</title>
  <desc>A layered architecture diagram with four horizontal bands: (1) Client / API Gateway at the top, (2) Contract &amp; Validation Layer with Pydantic v2 geometry validators, (3) Query Engine with GiST index selection, KNN routing, and ST_DWithin, and (4) PostGIS + Celery Workers at the bottom. Arrows show the synchronous request path on the left and the async bulk-upload path on the right.</desc>
  <!-- Background bands -->
  <rect x="0" y="0" width="760" height="420" rx="10" fill="none"/>
  <!-- Band 1: Client layer -->
  <rect x="10" y="10" width="740" height="64" rx="8" fill="#ede9f6" stroke="#7c6fcd" stroke-width="1.5"/>
  <text x="380" y="32" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="#3b2f70">Client / API Gateway</text>
  <rect x="80" y="42" width="180" height="22" rx="4" fill="#c4b5f4" opacity="0.6"/>
  <text x="170" y="57" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#3b2f70">POST /geometries  (sync)</text>
  <rect x="500" y="42" width="180" height="22" rx="4" fill="#c4b5f4" opacity="0.6"/>
  <text x="590" y="57" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#3b2f70">POST /bulk-upload  (async)</text>
  <!-- Arrows layer 1→2 -->
  <line x1="170" y1="74" x2="170" y2="102" stroke="#7c6fcd" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="590" y1="74" x2="590" y2="102" stroke="#7c6fcd" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Band 2: Validation layer -->
  <rect x="10" y="102" width="740" height="74" rx="8" fill="#f0f4ff" stroke="#6872c8" stroke-width="1.5"/>
  <text x="380" y="122" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="#3b2f70">Contract &amp; Validation Layer</text>
  <rect x="50" y="130" width="220" height="34" rx="4" fill="#c7d2fe" opacity="0.7"/>
  <text x="160" y="148" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#2d3a8c">Pydantic v2 geometry validator</text>
  <text x="160" y="160" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#4a5568">CRS · topology · precision · WKT/WKB</text>
  <rect x="490" y="130" width="220" height="34" rx="4" fill="#c7d2fe" opacity="0.7"/>
  <text x="600" y="148" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#2d3a8c">202 Accepted + task ID</text>
  <text x="600" y="160" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#4a5568">validate schema → push to queue</text>
  <!-- Arrows layer 2→3 -->
  <line x1="160" y1="176" x2="160" y2="206" stroke="#6872c8" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="600" y1="176" x2="600" y2="330" stroke="#6872c8" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arr)"/>
  <!-- Band 3: Query engine -->
  <rect x="10" y="206" width="450" height="100" rx="8" fill="#eef6ee" stroke="#4a7c59" stroke-width="1.5"/>
  <text x="235" y="226" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="#1a3d28">Query Engine</text>
  <rect x="30" y="234" width="130" height="56" rx="4" fill="#bbf7d0" opacity="0.6"/>
  <text x="95" y="255" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="600" fill="#14532d">GiST Index</text>
  <text x="95" y="268" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#14532d">&amp;&amp; bbox pre-filter</text>
  <text x="95" y="281" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#14532d">ST_DWithin / ST_Within</text>
  <rect x="180" y="234" width="120" height="56" rx="4" fill="#bbf7d0" opacity="0.6"/>
  <text x="240" y="255" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="600" fill="#14532d">KNN Routing</text>
  <text x="240" y="268" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#14532d">&lt;-&gt; operator</text>
  <text x="240" y="281" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#14532d">ORDER BY … LIMIT k</text>
  <rect x="320" y="234" width="120" height="56" rx="4" fill="#bbf7d0" opacity="0.6"/>
  <text x="380" y="255" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="600" fill="#14532d">Serialization</text>
  <text x="380" y="268" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#14532d">ST_AsGeoJSON</text>
  <text x="380" y="281" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#14532d">precision rounding</text>
  <!-- Arrow layer 3→4 -->
  <line x1="235" y1="306" x2="235" y2="334" stroke="#4a7c59" stroke-width="1.5" marker-end="url(#arr2)"/>
  <!-- Band 4: PostGIS + Workers -->
  <rect x="10" y="334" width="740" height="74" rx="8" fill="#fef9ec" stroke="#b45309" stroke-width="1.5"/>
  <text x="380" y="354" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="#78350f">PostGIS (PostgreSQL)</text>
  <rect x="40" y="362" width="340" height="34" rx="4" fill="#fde68a" opacity="0.5"/>
  <text x="210" y="381" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#78350f">spatial_features table · GiST index · pg_stat_statements</text>
  <rect x="400" y="362" width="340" height="34" rx="4" fill="#fde68a" opacity="0.5"/>
  <text x="570" y="374" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#78350f">Celery Workers (Redis broker)</text>
  <text x="570" y="387" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#92400e">idempotent COPY · ON CONFLICT DO UPDATE</text>
  <!-- Arrow markers -->
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#7c6fcd"/>
    </marker>
    <marker id="arr2" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#4a7c59"/>
    </marker>
  </defs>
</svg>

---

## Database & Infrastructure Layer

### PostGIS Geometry Types and Column Configuration

The first decision in a spatial schema is whether a column uses `GEOMETRY` or `GEOGRAPHY`. `GEOMETRY` stores coordinates in any projection and performs calculations in planar (Euclidean) space. `GEOGRAPHY` always uses WGS 84 (EPSG:4326) and performs calculations on a spheroid — more accurate for large distances but ~10% slower for index-intersectable predicates.

```sql
-- Preferred schema for a mixed-precision feature store
CREATE TABLE spatial_features (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    -- GEOMETRY(MultiPolygon, 4326): planar ops, explicit SRID
    geom        GEOMETRY(MultiPolygon, 4326) NOT NULL,
    -- GEOGRAPHY for accurate distance calculations
    geog        GEOGRAPHY(MultiPolygon, 4326) GENERATED ALWAYS AS (geom::geography) STORED,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- GiST index on geometry (bbox operations, ST_Intersects, ST_Within)
CREATE INDEX idx_spatial_features_geom
    ON spatial_features USING GIST (geom);

-- GiST index on geography (ST_DWithin with metres, KNN <-> on geography)
CREATE INDEX idx_spatial_features_geog
    ON spatial_features USING GIST (geog);
```

The generated `geog` column lets you keep a single source of truth (`geom`) while exposing a properly typed `GEOGRAPHY` column for distance predicates without runtime casts — casts bypass indexes.

### Connection Pooling for Spatial Workloads

Spatial queries hold database connections longer than typical CRUD operations because `ST_Intersects`, `ST_Union`, and geometry aggregation functions are CPU-bound. Configure [PgBouncer for spatial workloads](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) in **transaction mode** with a pool size matched to your PostGIS server's CPU count, not your application replica count:

```ini
# pgbouncer.ini — tuned for spatial query concurrency
[databases]
spatial_db = host=127.0.0.1 port=5432 dbname=spatial_db pool_size=20

[pgbouncer]
pool_mode = transaction
max_client_conn = 400
default_pool_size = 20
reserve_pool_size = 5
reserve_pool_timeout = 3
server_idle_timeout = 600
```

Use `asyncpg` (not `psycopg2`) as your database driver in FastAPI. It handles PostgreSQL binary protocol natively, avoids Python's GIL on I/O waits, and works with SQLAlchemy's async engine without threading overhead.

---

## Application Layer Patterns

### FastAPI Dependency Injection for Spatial Validation

Centralise geometry validation in a FastAPI dependency so every route receives a validated, topology-corrected geometry object rather than raw JSON. This prevents validation logic from duplicating across endpoints.

```python
from fastapi import Depends, HTTPException, status
from pydantic import BaseModel, Field, model_validator
from typing import Any, Annotated
import shapely.geometry
import shapely.validation
import shapely.ops

class SpatialPayload(BaseModel):
    geometry: dict[str, Any]
    buffer_meters: float = Field(ge=0.0, le=50_000.0)
    crs: str = Field(default="EPSG:4326", pattern=r"^EPSG:\d+$")
    precision: int = Field(default=6, ge=4, le=10)

    @model_validator(mode="after")
    def validate_and_normalise(self) -> "SpatialPayload":
        try:
            geom = shapely.geometry.shape(self.geometry)
        except (ValueError, KeyError) as exc:
            raise ValueError(f"Invalid GeoJSON geometry: {exc}") from exc

        if not geom.is_valid:
            # Attempt automatic repair before rejecting
            geom = geom.buffer(0)
            if not geom.is_valid:
                raise ValueError(
                    f"Geometry invalid after repair attempt: "
                    f"{shapely.validation.explain_validity(geom)}"
                )

        # Enforce right-hand rule (RFC 7946 §3.1.6)
        self.geometry = shapely.ops.orient(geom, sign=1.0).__geo_interface__
        return self


async def validated_spatial_payload(payload: SpatialPayload) -> SpatialPayload:
    """FastAPI dependency — raises HTTP 422 on contract violation."""
    return payload


# Route usage
from fastapi import APIRouter
router = APIRouter()

@router.post("/features/query", status_code=200)
async def query_features(
    payload: Annotated[SpatialPayload, Depends(validated_spatial_payload)],
    db=Depends(get_db),
):
    ...
```

The `model_validator` fires before the dependency returns, so validation errors surface as standard 422 responses with structured error detail — no custom exception handling required. For complete validator patterns covering WKT, WKB, and multi-geometry inputs, see [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/).

### Async Database Sessions with SQLAlchemy 2.x

Spatial queries must run through async sessions to avoid blocking FastAPI's event loop. SQLAlchemy 2.x's `async_sessionmaker` with `asyncpg` eliminates thread-pool overhead:

```python
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from contextlib import asynccontextmanager
from typing import AsyncGenerator

DATABASE_URL = "postgresql+asyncpg://user:pass@localhost/spatial_db"

engine = create_async_engine(
    DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,        # detect stale connections
    pool_recycle=1800,         # recycle connections after 30 min
    connect_args={"server_settings": {"statement_timeout": "8000"}},  # 8 s hard limit
)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session
```

The `statement_timeout` in `connect_args` caps every query at 8 seconds at the PostgreSQL level — a non-negotiable guardrail when exposing arbitrary spatial predicates to clients.

---

## Data Contracts & Serialization

### Format Selection: GeoJSON vs GeoParquet vs FlatGeobuf

Choosing the right output format is a function of client type, payload size, and streaming requirements. Use the [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision matrix as your primary reference, but the table below summarises the trade-offs specific to this API's domain:

| Format | Best for | Avg. size vs raw | Index-friendly streaming | OGC compliant |
|---|---|---|---|---|
| GeoJSON (RFC 7946) | Browser clients, Mapbox/Leaflet, small payloads | baseline | No | Yes |
| GeoParquet | Analytics, data lake exports, large result sets | ~40–60% smaller | Yes (row group filters) | Partial |
| FlatGeobuf | Sequential tile delivery, HTTP range requests | ~30–50% smaller | Yes (spatial index) | Partial |
| WKB (hex) | Internal service calls, PostGIS inter-process | ~20% smaller | No | No |

For standard REST endpoints consumed by mapping frontends, GeoJSON remains the default. Apply coordinate precision reduction at the serialization layer — `ST_AsGeoJSON(geom, 6)` rounds to six decimal places (~11 cm accuracy), shrinking payload size by 15–30% for complex polygons.

```sql
-- Controlled precision GeoJSON serialization from PostGIS
SELECT
    id,
    name,
    ST_AsGeoJSON(geom, 6)::jsonb AS geometry,
    ST_Area(geog) AS area_m2
FROM spatial_features
WHERE geom && ST_MakeEnvelope(-122.45, 37.73, -122.40, 37.77, 4326)
ORDER BY name;
```

### OGC Compliance Rules

Any endpoint consumed by external GIS clients must follow OGC Simple Features rules: exterior rings counter-clockwise (RFC 7946 §3.1.6), interior rings clockwise, no duplicate vertices, no self-intersections. Enforce these in the Pydantic validator as shown above — do not rely on PostGIS to silently accept non-compliant geometry, as `ST_IsValid` behaviour differs between PostGIS versions and can produce inconsistent results under topology edge cases.

---

## Performance & Scalability

### Index-Aware Query Patterns

PostGIS spatial indexes are R-tree structures (GiST) that partition geometry bounding boxes. The `&&` operator asks "do the bounding boxes overlap?" and is the only predicate that directly uses the index. Every precise predicate — `ST_Intersects`, `ST_Within`, `ST_Contains`, `ST_DWithin` on `GEOMETRY` columns — should be preceded by an explicit `&&` pre-filter, or the query planner will fall back to a sequential scan. For complete bounding box index patterns, see [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/).

```sql
-- Correct two-stage spatial filter: bbox prune → precise predicate
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, name, ST_AsGeoJSON(geom, 6) AS geometry
FROM spatial_features
WHERE geom && ST_Expand(
          ST_SetSRID(ST_Point(-122.42, 37.75), 4326),
          0.02  -- ~2 km in degrees at this latitude
      )
  AND ST_DWithin(
          geog,                                              -- uses GEOGRAPHY index
          ST_SetSRID(ST_Point(-122.42, 37.75), 4326)::geography,
          2000                                               -- metres
      )
LIMIT 50;
```

Run `EXPLAIN (ANALYZE, BUFFERS)` before every new query pattern in production. Confirm you see `Index Scan using idx_spatial_features_geom` or `Bitmap Index Scan`, not `Seq Scan`. If the planner falls back to sequential execution, check: (1) outdated table statistics — run `ANALYZE spatial_features`; (2) index bloat from high-write workloads — check `pg_stat_user_indexes.idx_scan`; (3) implicit type casts that disable index access (e.g. `geom::geography` in the `WHERE` clause instead of the indexed `geog` column).

### KNN Distance Queries

Nearest-neighbor lookups with `ORDER BY geom <-> point LIMIT k` use GiST's KNN-GiST algorithm, which traverses the index tree in distance order without computing exact distances for every row. This delivers sub-10ms latency for millions of rows. For the complete implementation including recheck predicates and distance-threshold guards, see [K-Nearest Neighbor Routing Algorithms](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/).

```sql
-- True KNN using the <-> index operator (no full-table scan)
SELECT
    id,
    name,
    geom <-> ST_SetSRID(ST_Point(-122.42, 37.75), 4326) AS dist_degrees
FROM spatial_features
ORDER BY geom <-> ST_SetSRID(ST_Point(-122.42, 37.75), 4326)
LIMIT 5;
```

Important: `<->` on `GEOMETRY` types returns degrees, not metres. Convert to metres either by casting to `GEOGRAPHY` (`geog <-> point::geography`) or by wrapping the KNN result in a `ST_Distance` recheck. Always document the unit in your OpenAPI schema.

### Caching Strategy

Bounding box queries, administrative boundary lookups, and precomputed spatial aggregates are excellent cache targets. Derive cache keys from normalized query parameters — sort the bounding box coordinates, round precision, and canonicalize the CRS string — so that semantically equivalent queries hit the same cache entry. Use Redis with geometry-aware TTLs: static boundaries (country/state polygons) can cache for 24 hours; real-time feature layers should use 30–60 seconds. For cache invalidation patterns tied to geometry writes, see [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/).

### Concurrency Limits

Spatial operations — especially union, buffer, and intersection of large polygons — are CPU-bound. Under high concurrency, a single slow spatial query can saturate all available CPU cores, starving the connection pool and causing cascading timeouts. Enforce concurrency limits at the FastAPI layer using a semaphore:

```python
import asyncio

# Allow at most 8 concurrent heavy spatial operations
_spatial_semaphore = asyncio.Semaphore(8)

@router.post("/features/heavy-operation")
async def heavy_spatial_op(payload: SpatialPayload, db=Depends(get_db)):
    async with _spatial_semaphore:
        result = await db.execute(...)
    return result
```

---

## Production Readiness

### API Versioning for Spatial Endpoints

Spatial data contracts evolve — CRS defaults change, geometry type constraints tighten, new fields become mandatory. Version spatial endpoints using URL prefixes (`/v1/features`, `/v2/features`) rather than query parameters or `Accept` headers, as URL-based versioning is unambiguous for caching layers and CDNs. For a complete versioning strategy including deprecation timelines and migration paths, see [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/).

### Health Checks and Readiness Probes

A spatial API's health depends on PostGIS function availability, not just database connectivity. Standard connection checks miss scenarios where the PostGIS extension is corrupted or the GiST index is inaccessible:

```python
from fastapi import APIRouter
from sqlalchemy import text

health_router = APIRouter()

@health_router.get("/healthz")
async def health_check(db=Depends(get_db)):
    try:
        result = await db.execute(
            text("SELECT PostGIS_Version(), ST_AsGeoJSON(ST_Point(0, 0), 4)")
        )
        version, test_geojson = result.one()
    except Exception as exc:
        return {"status": "unhealthy", "detail": str(exc)}, 503
    return {"status": "healthy", "postgis_version": version}
```

### Rate Limiting Geospatial Endpoints

Unbounded spatial queries are a denial-of-service vector: a client can submit a complex polygon covering the entire dataset and trigger a full-index scan. Apply rate limiting at two levels: (1) request rate per API key using a sliding window in Redis, and (2) geometry complexity limits in the Pydantic validator — cap coordinate count, reject envelopes exceeding a maximum area threshold, and reject geometries with more than N rings.

```python
from pydantic import model_validator
import shapely.geometry

MAX_COORDINATE_COUNT = 10_000
MAX_BBOX_AREA_DEG2 = 25.0  # ~25 square degrees ≈ region of France

@model_validator(mode="after")
def enforce_complexity_limits(self) -> "SpatialPayload":
    geom = shapely.geometry.shape(self.geometry)
    coords = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
    total_coords = sum(len(list(g.exterior.coords)) for g in coords if hasattr(g, "exterior"))
    if total_coords > MAX_COORDINATE_COUNT:
        raise ValueError(f"Geometry exceeds {MAX_COORDINATE_COUNT} coordinate limit")
    bbox = geom.bounds
    area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    if area > MAX_BBOX_AREA_DEG2:
        raise ValueError("Query bounding box exceeds maximum allowed area")
    return self
```

### Monitoring Signals

Track these metrics to detect spatial query degradation before it impacts users:

| Signal | Source | Alert threshold |
|---|---|---|
| `pg_stat_user_indexes.idx_scan` drop | PostgreSQL | >20% decrease week-over-week |
| `pg_stat_statements` mean execution time | PostgreSQL | p95 > 2 s for indexed queries |
| Celery task queue depth | Redis / Flower | > 500 pending geometry tasks |
| `ST_IsValid` error rate | Application logs | > 0.1% of submitted geometries |
| Connection pool saturation | asyncpg / PgBouncer | > 90% pool utilization for > 30 s |

Run `VACUUM ANALYZE spatial_features` after bulk imports and during low-traffic windows. GiST indexes degrade under high-write workloads due to page splits — schedule monthly `REINDEX CONCURRENTLY` to rebuild without table locks.

---

## Failure Modes & Gotchas

1. **Implicit cast `geom::geography` in the WHERE clause disables the GiST index.** Use a dedicated `geog GEOGRAPHY` column (or generated column) and reference it directly. The cast itself is not the problem; casting inside the predicate prevents index access.

2. **`ST_IsValid` returning `true` with PostGIS 3.x does not guarantee OGC compliance.** PostGIS 3.x relaxed some validity rules for performance. Run `ST_IsValidDetail(geom, 1)` with flags=1 (OGC strict mode) in your validator, not `ST_IsValid(geom)`.

3. **Shapely `buffer(0)` repair silently changes polygon topology.** It fixes self-intersections but can remove small rings, collapse thin slivers, and alter area measurements. Log a warning when repair triggers in production; do not silently discard the mutation.

4. **Celery workers accumulate memory when large geometries stay in scope across task iterations.** Call `del geom` and `gc.collect()` explicitly at the end of each geometry processing loop, and configure `worker_max_tasks_per_child` to recycle workers periodically.

5. **`ORDER BY geom <-> point` without a `LIMIT` clause performs a full sequential scan.** The KNN-GiST algorithm only activates when the query planner can bound the result set. Always pair `<->` with `LIMIT`.

6. **Bulk inserts using `executemany` send one round-trip per row.** Use PostgreSQL's `COPY` protocol via `asyncpg.copy_records_to_table()` for batch inserts exceeding ~1 000 geometries — it is 10–50x faster and generates a single WAL entry.

7. **Missing `SRID` on incoming geometries causes silent SRID=0 storage.** PostGIS will store geometry without raising an error, but subsequent spatial predicates comparing SRID=0 to SRID=4326 return incorrect results. Always assert `ST_SRID(geom) = 4326` or your target CRS in a database-level CHECK constraint.

8. **Async file uploads for shapefiles require special handling.** Shapefiles arrive as multi-file ZIP archives (`.shp`, `.dbf`, `.prj`, `.shx`). Validate and unpack the archive in the Celery task, not in the FastAPI route, and always check the `.prj` file for CRS before processing. See [Handling Async File Uploads for Shapefile Processing](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/) for the complete pattern.

---

## Related

- [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — schema validators, WKT/WKB parsing, and topology enforcement with Pydantic v2
- [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — `ST_Within`, `ST_Intersects`, GiST index exploitation, and query plan analysis
- [K-Nearest Neighbor Routing Algorithms](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) — KNN-GiST with the `<->` operator, recheck predicates, and distance-unit handling
- [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) — 202 Accepted pattern, task queuing, idempotent COPY, and worker memory management
- [OpenAPI Schema Generation for Spatial Types](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/) — emit correct OpenAPI 3.1 for GeoJSON geometry types so docs and generated clients stay accurate
- [Async PostGIS Transaction Patterns](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/) — `AsyncSession` transaction scoping, savepoints, bulk-write batching, and deadlock handling
- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — format selection decision matrix for spatial API responses
- [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/) — Redis cache patterns, query plan tuning, and index maintenance for spatial workloads
