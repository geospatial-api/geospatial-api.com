---
layout: layouts/page.njk
title: "Core Geospatial API Architecture with FastAPI & PostGIS"
description: "A complete architectural reference for backend engineers building production spatial APIs: PostGIS configuration, async FastAPI patterns, OGC-compliant serialisation, cursor-based pagination, and deployment hardening."
slug: core-geospatial-api-architecture-with-fastapi-postgis
breadcrumb: Core Geospatial API Architecture
datePublished: "2025-01-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Core Geospatial API Architecture with FastAPI & PostGIS",
      "description": "A complete architectural reference for backend engineers building production spatial APIs: PostGIS configuration, async FastAPI patterns, OGC-compliant serialisation, cursor-based pagination, and deployment hardening.",
      "datePublished": "2025-01-15",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com" },
      "mainEntityOfPage": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build a Production Geospatial API with FastAPI and PostGIS",
      "step": [
        { "@type": "HowToStep", "name": "Configure PostGIS geometry types and indexes", "position": 1 },
        { "@type": "HowToStep", "name": "Wire async FastAPI routes with dependency injection and Pydantic v2 validators", "position": 2 },
        { "@type": "HowToStep", "name": "Choose a serialisation format and streaming strategy", "position": 3 },
        { "@type": "HowToStep", "name": "Implement cursor-based spatial pagination", "position": 4 },
        { "@type": "HowToStep", "name": "Add versioning, rate limiting, and observability", "position": 5 }
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
            "text": "Use geometry for regional or local datasets where planar calculations are accurate enough and raw throughput matters. Use geography when you need ellipsoidal accuracy across large distances — but expect a 10–40 % query overhead. Never mix the two types in the same join or filter without an explicit cast."
          }
        },
        {
          "@type": "Question",
          "name": "Why does offset pagination break on spatial datasets?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "OFFSET n forces a full sequential scan up to row n, which is expensive for large tables and produces duplicate or missing records when concurrent writes shift row order. Cursor-based pagination using a spatially ordered key eliminates both problems."
          }
        },
        {
          "@type": "Question",
          "name": "Should spatial validation happen in FastAPI or PostGIS?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Both layers have a role. FastAPI (Pydantic v2) rejects malformed payloads before they reach the database — coordinate-bounds checks, geometry-type enforcement, and CRS normalisation. PostGIS then applies ST_IsValid and topology constraints as a second line of defence."
          }
        }
      ]
    }
  ]
}
</script>

# Core Geospatial API Architecture with FastAPI & PostGIS

Backend engineers and GIS platform architects building location-aware services face a set of structural decisions that plain CRUD patterns never surface: where spatial computation belongs, how to keep OGC schemas stable under evolving standards, and how to deliver binary or streaming geometry payloads without exhausting memory. This reference covers the full architectural stack — from PostGIS configuration and async FastAPI wiring through serialisation strategy, cursor-based pagination, production hardening, and the failure modes that sink spatial APIs in the first month of real traffic.

## Architectural Blueprint: Three-Tier Spatial Design

A production spatial API divides cleanly into three tiers. Blurring the boundaries between them is the single most common cause of lock contention, unpredictable query plans, and serialisation bottlenecks.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three-tier spatial API architecture diagram" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Three-Tier Spatial API Architecture</title>
  <desc>Diagram showing three stacked tiers: Ingestion and Validation (FastAPI + Pydantic v2), Spatial Processing (PostGIS), and Serialisation and Delivery (FastAPI response layer), with arrows showing request and response flow.</desc>
  <!-- tier boxes -->
  <rect x="40" y="20" width="640" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="360" y="48" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Tier 1 — Ingestion &amp; Validation</text>
  <text x="360" y="68" text-anchor="middle" font-size="12" fill="currentColor">FastAPI route handler · Pydantic v2 geometry validators · CRS normalisation · 422 fast-fail</text>
  <text x="360" y="86" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">Rejects malformed payloads before any database round-trip</text>
  <rect x="40" y="130" width="640" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="360" y="158" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Tier 2 — Spatial Processing</text>
  <text x="360" y="178" text-anchor="middle" font-size="12" fill="currentColor">PostGIS · ST_DWithin · ST_Intersects · ST_Union · GIST indexes · asyncpg sessions</text>
  <text x="360" y="196" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">All geometry computation stays inside the database — never leak spatial logic into Python</text>
  <rect x="40" y="240" width="640" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="360" y="268" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Tier 3 — Serialisation &amp; Delivery</text>
  <text x="360" y="288" text-anchor="middle" font-size="12" fill="currentColor">GeoJSON · GeoParquet · FlatGeobuf · StreamingResponse · Accept-header negotiation</text>
  <text x="360" y="306" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">Format adapts to client type; compression and rate-limit enforcement applied here</text>
  <!-- connecting arrows -->
  <line x1="360" y1="100" x2="360" y2="128" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="360" y1="210" x2="360" y2="238" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

FastAPI owns Tiers 1 and 3 because of its async runtime, Pydantic v2 validation, and OpenAPI documentation generation. PostGIS owns Tier 2 because C-level spatial algorithms cannot be meaningfully replicated in application code. The architecture succeeds when these tiers communicate through well-defined contracts rather than leaking concerns across boundaries — the exact principle behind [spatial resource modelling patterns](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/), which keeps geometries, attributes, and temporal metadata decoupled from routing logic.

## Database Layer: PostGIS as the Spatial Engine

PostGIS is not a passive data store. It is the computational core of the architecture, and misconfiguring it is far more damaging than a slow Python endpoint.

### Geometry vs Geography: Choosing the Right Column Type

| Factor | `geometry` | `geography` |
|---|---|---|
| Coordinate system | Planar (Cartesian) | Ellipsoidal (WGS 84) |
| Distance accuracy | Approximation for large spans | True geodesic distance |
| Supported functions | Full ST_ catalogue | Subset (no ST_Buffer area accuracy) |
| Query throughput | Faster — no ellipsoid math | 10–40 % overhead |
| Best for | Regional/local datasets, tile pipelines | Global tracking, cross-continental joins |

Never mix the two types in the same join or WHERE clause without an explicit `::geometry` or `::geography` cast. Implicit casting silently disables index usage and corrupts spatial predicates on large polygons.

### Indexing Strategy

A single `GIST` index on a geometry column rarely covers production workloads. Layer indexes by access pattern:

```sql
-- Standard GIST for geometry predicates
CREATE INDEX idx_parcels_geom
  ON parcels USING GIST (geom);

-- Partial index — only active records, smaller and faster
CREATE INDEX idx_active_parcels_geom
  ON parcels USING GIST (geom)
  WHERE status = 'active';

-- Functional index — pre-project to WGS 84 for API output
CREATE INDEX idx_parcels_geom_4326
  ON parcels USING GIST (ST_Transform(geom, 4326));

-- BRIN index for append-only GPS time series (enormous tables)
CREATE INDEX idx_gps_pings_geom_brin
  ON gps_pings USING BRIN (geom)
  WITH (pages_per_range = 128);
```

After bulk loads, always run `ANALYZE parcels;` before opening the endpoint to traffic. Monitor index bloat weekly with `pg_stat_user_indexes` and rebuild if `idx_blks_read / idx_blks_hit` climbs above 0.05.

### Connection Pooling and Async Compatibility

FastAPI's async runtime pairs with `asyncpg` (direct driver) and SQLAlchemy 2.0's `AsyncSession`. Run PgBouncer in **transaction pooling** mode in front of PostGIS — spatial queries hold locks longer than typical OLTP workloads, so session pooling wastes connections.

Recommended configuration for a single API replica:

```ini
# pgbouncer.ini — spatial workload settings
pool_mode = transaction
max_client_conn = 200
default_pool_size = 25        # 20–40 per replica is the practical ceiling
server_idle_timeout = 30      # reclaim connections after idle spatial reads
query_wait_timeout = 10       # fail-fast rather than queue-build
```

Set `statement_timeout = '8s'` at the database level to prevent runaway `ST_Union` or `ST_DWithin` aggregations from exhausting the pool.

## Application Layer: FastAPI Integration Patterns

### Dependency Injection for Spatial Validation

Attach geometry validators as FastAPI dependencies so malformed payloads fail before touching the database:

```python
from fastapi import Depends, HTTPException
from pydantic import BaseModel, field_validator
from shapely.wkt import loads as wkt_loads
from shapely.validation import make_valid

class GeometryPayload(BaseModel):
    wkt: str
    srid: int = 4326

    @field_validator("wkt")
    @classmethod
    def must_be_valid_geometry(cls, v: str) -> str:
        try:
            geom = wkt_loads(v)
        except Exception:
            raise ValueError("Unparseable WKT geometry")
        if not geom.is_valid:
            fixed = make_valid(geom)
            return fixed.wkt   # auto-repair rather than reject for minor issues
        return v

    @field_validator("srid")
    @classmethod
    def must_be_known_srid(cls, v: int) -> int:
        allowed = {4326, 3857, 27700, 32632}
        if v not in allowed:
            raise ValueError(f"SRID {v} not in allowed set {allowed}")
        return v

async def get_db_session():
    async with AsyncSession(engine) as session:
        yield session

@app.post("/features/")
async def create_feature(
    payload: GeometryPayload,
    session: AsyncSession = Depends(get_db_session),
):
    ...
```

This pattern produces structured `422 Unprocessable Entity` responses for invalid geometries before a single database round-trip. For the full Pydantic v2 validation approach — including WKT vs GeoJSON handling and coordinate-bound enforcement — see [strict Pydantic validation for geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/).

### Async Execution and Avoiding Event-Loop Blocking

`ST_Union`, `ST_ConvexHull`, and complex `ST_Intersects` predicates are CPU-bound inside PostGIS. They do not block FastAPI's Python event loop because the work executes on the database server — but they do hold asyncpg connection slots. Two mitigations:

1. **Prepared statements** for repeated bounding-box shapes — reduces planning overhead by ~30 % on parameterised spatial filters.
2. **Query plan caching** — SQLAlchemy's `text()` with bound parameters allows PostGIS to reuse cached query plans across requests with different bounding boxes but identical predicate shapes.

```python
from sqlalchemy import text

BBOX_QUERY = text("""
    SELECT id, ST_AsGeoJSON(geom)::json AS geometry, properties
    FROM features
    WHERE geom && ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326)
      AND ST_Intersects(geom, ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326))
    ORDER BY id
    LIMIT :limit
""")

@app.get("/features/")
async def list_features(
    xmin: float, ymin: float, xmax: float, ymax: float,
    limit: int = 100,
    session: AsyncSession = Depends(get_db_session),
):
    result = await session.execute(
        BBOX_QUERY,
        {"xmin": xmin, "ymin": ymin, "xmax": xmax, "ymax": ymax, "limit": limit},
    )
    return {"features": [dict(row) for row in result.mappings()]}
```

Note the double predicate: `&&` uses the GIST index for a fast bounding-box pre-filter, then `ST_Intersects` applies the exact geometric test only to the candidates that survive. Removing the `&&` clause disables index usage entirely.

## Data Contracts and Serialisation

How you serialise spatial data determines bandwidth consumption, client rendering latency, and downstream pipeline compatibility. The choice is not binary — well-designed endpoints negotiate format per request.

### Format Selection Matrix

| Format | Size vs GeoJSON | Parse speed | Human-readable | Streaming | Best use |
|---|---|---|---|---|---|
| GeoJSON | 1× (baseline) | Moderate | Yes | Chunked | Web map clients, third-party tools |
| FlatGeobuf | 0.3–0.5× | Fast (columnar) | No | Yes (seekable) | Internal microservices, CDN tiles |
| GeoParquet | 0.1–0.2× | Very fast | No | Column-selective | Analytics pipelines, bulk exports |
| WKB (raw) | 0.2–0.3× | Very fast | No | Yes | Database-to-database transfer |

Expose format negotiation via the `Accept` header or a `?format=` query parameter. Use the [GeoJSON vs GeoParquet serialisation](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision matrix to choose the right approach for each endpoint family, and reserve `StreamingResponse` for exports that may return millions of features.

```python
from fastapi.responses import StreamingResponse
import json

async def stream_geojson(session, bbox):
    async def feature_generator():
        yield '{"type":"FeatureCollection","features":['
        first = True
        async for row in await session.stream(BBOX_QUERY, bbox):
            if not first:
                yield ","
            yield json.dumps({"type": "Feature", "geometry": row.geometry, "properties": row.properties})
            first = False
        yield "]}"

    return StreamingResponse(feature_generator(), media_type="application/geo+json")
```

### OGC Compliance

Align response schemas with [RFC 7946](https://www.rfc-editor.org/rfc/rfc7946) to guarantee interoperability with QGIS, Mapbox GL JS, and OGC API Features consumers. At minimum:

- `type` must be a valid GeoJSON geometry type string — never a custom alias.
- `coordinates` must be `[longitude, latitude]` order (not lat/lon) unless the CRS is explicitly declared otherwise.
- Feature `id` must be a string or number, not a composite object.
- `properties` must be a JSON object or `null`, never an array.

Use `ST_AsGeoJSON(geom, 6)` (six decimal places ≈ 0.1 m precision) rather than `ST_AsText` to avoid a Python-side WKT-to-GeoJSON conversion step.

## Performance and Scalability

### Query Plan Guidance

Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` on every new spatial query before deploying it. Watch for three anti-patterns:

1. **Seq Scan on a large table** — missing or disabled GIST index. Check `enable_seqscan` is not set to `off` globally (a common "debug" setting left in production).
2. **Nested Loop on unindexed join column** — a spatial join missing an index on the non-geometry join key (e.g. `tenant_id`). Add a composite index: `(tenant_id, geom)` using `GIST (geom)` with a standard btree on `tenant_id` as a separate index, then let the planner intersect them.
3. **Hash Aggregate on large geometry sets** — `ST_Union` without a prior `ST_Simplify` pre-pass. Simplify geometries to the resolution required by the client before aggregating.

### Caching Hooks

Spatial query results are cacheable when the underlying dataset changes infrequently. Layer caches at two levels:

- **PostGIS materialized views** — refresh on a schedule for analytical endpoints (e.g., pre-computed administrative boundaries).
- **Redis geometry cache** — store `ST_AsGeoJSON` output keyed by `(feature_id, srid)`. Invalidate on write. Avoid caching raw WKB; cache the serialised form the endpoint would return.

```python
import hashlib, json
from redis.asyncio import Redis

async def cached_feature(feature_id: int, redis: Redis, session: AsyncSession):
    cache_key = f"feature:{feature_id}:geojson"
    cached = await redis.get(cache_key)
    if cached:
        return json.loads(cached)
    row = await session.execute(
        text("SELECT ST_AsGeoJSON(geom, 6)::json AS geometry FROM features WHERE id = :id"),
        {"id": feature_id},
    )
    result = row.mappings().one()
    await redis.setex(cache_key, 3600, json.dumps(result["geometry"]))
    return result["geometry"]
```

### Concurrency Limits

Spatial aggregations (`ST_Union`, `ST_ConvexHull`) should never share a connection pool with lightweight metadata queries. Separate endpoints into two FastAPI routers backed by different database pools: a lightweight pool (50 connections) for point-lookup and bounding-box queries, and a heavy pool (5–10 connections) for aggregation and export endpoints. This prevents one slow `ST_Union` from blocking a hundred tile requests.

## Pagination, Versioning, and Production Readiness

### Cursor-Based Spatial Pagination

Offset pagination (`LIMIT n OFFSET m`) is unsuitable for spatial datasets: it triggers a full sequential scan to reach offset `m`, produces duplicates during concurrent inserts, and returns different rows as the dataset shifts. Replace it with keyset pagination using a stable spatial ordering.

Three strategies are covered in depth in [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/):

- **Z-order (Morton) cursors**: Map `(x, y)` coordinates to a 1D integer key. Range scans on the Z-order index are fast and deterministic.
- **Tile-based pagination**: Align pages with map tile boundaries (`/features?tile=z/x/y`). Each response corresponds to exactly one tile, eliminating overlap.
- **Temporal-spatial cursors**: Combine `(created_at, id)` for real-time tracking endpoints where insert order is the natural traversal direction.

A minimal keyset implementation:

```python
@app.get("/features/page/")
async def paginate_features(
    after_id: int = 0,
    limit: int = 100,
    session: AsyncSession = Depends(get_db_session),
):
    result = await session.execute(
        text("""
            SELECT id, ST_AsGeoJSON(geom, 6)::json AS geometry, properties
            FROM features
            WHERE id > :after_id
            ORDER BY id
            LIMIT :limit
        """),
        {"after_id": after_id, "limit": limit},
    )
    rows = result.mappings().all()
    next_cursor = rows[-1]["id"] if len(rows) == limit else None
    return {"features": [dict(r) for r in rows], "next_cursor": next_cursor}
```

For the full implementation including Z-order cursors and tile-aligned paging, see [implementing cursor-based pagination for spatial queries](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/).

### API Versioning for GIS Endpoints

OGC standards evolve. GeoJSON, OGC API Features, 3D coordinate support, and SRID conventions change between specification versions. Enforce URL-based versioning (`/v1/features`, `/v2/features`) and route each version to its own FastAPI router, sharing only the database session dependency:

```python
from fastapi import APIRouter

v1_router = APIRouter(prefix="/v1")
v2_router = APIRouter(prefix="/v2")

@v1_router.get("/features/")
async def features_v1(...): ...   # GeoJSON with EPSG:4326

@v2_router.get("/features/")
async def features_v2(...): ...   # GeoJSON + GeoParquet negotiation, SRID-aware
```

When migrating spatial schemas, use PostgreSQL views to keep the v1 endpoint pointing at a stable projection of the new table. Deprecation guidance for each version lives in [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/).

### Security: Rate Limiting and Row-Level Security

Spatial queries are expensive. A single malicious or buggy `ST_DWithin` call with a 1,000 km radius can hold a connection for seconds. Layer defences:

- **Per-endpoint rate limiting** — use Redis sliding-window counters. Apply strict limits (5 req/s) to complex spatial joins and looser limits (200 req/s) to tile and metadata endpoints.
- **PostgreSQL row-level security** — enforce tenant isolation at the database row level so application bugs cannot leak cross-tenant geometry:

```sql
ALTER TABLE features ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON features
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

Set `app.tenant_id` in the asyncpg connection initialisation block, not in the query itself — this ensures the RLS policy is active even when raw SQL bypasses the ORM.

### Observability and Monitoring Signals

Standard HTTP metrics are insufficient for spatial APIs. Add these signals:

| Signal | What to measure | Alert threshold |
|---|---|---|
| `ST_` function duration | p95 execution time per function | > 500 ms |
| Geometry vertex count | Average vertices per inbound payload | > 10,000 |
| GIST index hit rate | `idx_blks_hit / (idx_blks_hit + idx_blks_read)` | < 0.95 |
| Connection pool saturation | Active connections / max connections | > 0.85 |
| `ST_IsValid` failure rate | Invalid geometry rejections per minute | > 1 % of requests |

Export via Prometheus and set Grafana alerts on p95 `ST_DWithin` durations and pool saturation. The `auto_explain` PostgreSQL extension (with `auto_explain.log_min_duration = '1s'`) captures query plans for slow spatial operations without manual `EXPLAIN ANALYZE` instrumentation.

### Health Checks

A health-check endpoint must verify that PostGIS extensions are loaded, not just that the database connection works:

```python
@app.get("/health")
async def health(session: AsyncSession = Depends(get_db_session)):
    result = await session.execute(
        text("SELECT PostGIS_Version() AS postgis, ST_AsText(ST_MakePoint(0,0)) AS point")
    )
    row = result.mappings().one()
    return {"status": "ok", "postgis": row["postgis"], "probe": row["point"]}
```

This distinguishes "PostgreSQL is up" from "PostGIS extension is installed and functional" — a distinction that matters after major upgrades.

## Failure Modes and Common Misconfigurations

The following mistakes appear repeatedly in production spatial APIs. Each has caused measurable outages or data corruption.

1. **Using `OFFSET` pagination on spatial tables.** Full table scans on millions of geometry rows. Replace with keyset pagination before going to production.

2. **Mixing `geometry` and `geography` in a single query without explicit casts.** PostgreSQL applies an implicit cast that disables index usage and returns incorrect distance values. Always audit cross-type comparisons with `EXPLAIN` and watch for "Cast" nodes in the plan.

3. **Omitting `ST_IsValid` checks before `ST_Union` or `ST_Intersection`.** Invalid input geometries cause these functions to return `NULL` silently. Add a `WHERE ST_IsValid(geom)` guard or run `ST_MakeValid` during ingestion.

4. **Setting PgBouncer to session pooling mode with spatial APIs.** Long-lived spatial transactions hold session connections, defeating the pool. Always use transaction pooling for PostGIS workloads.

5. **Indexing `geography` columns with a plain GIST index without specifying the cast operator class.** Use `USING GIST (geom geography_ops)` explicitly — the default operator class is for `geometry`.

6. **Returning raw `ST_AsBinary` (WKB) in GeoJSON endpoints without conversion.** WKB is binary; embedding it in a JSON string produces base64 or garbled output. Always use `ST_AsGeoJSON` for JSON responses.

7. **Not pinning PostGIS version in Docker images.** Minor PostGIS releases sometimes change spatial algorithm outputs (e.g., `ST_SimplifyPreserveTopology` tolerance handling). Pin versions in `FROM postgis/postgis:16-3.4` to prevent silent algorithmic regressions after image rebuilds.

8. **Skipping `ANALYZE` after bulk geometry inserts.** The query planner relies on table statistics that go stale after large loads. An un-analyzed table causes the planner to underestimate row counts and choose sequential scans over index paths.

## Related

- [Spatial Resource Modelling Patterns](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) — how to structure FastAPI routers and PostGIS tables around spatial domain entities
- [GeoJSON vs GeoParquet Serialisation](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — format decision matrix and streaming strategy for spatial responses
- [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — keyset, Z-order, and tile-based pagination for geometry endpoints
- [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — URL versioning, view-backed migrations, and deprecation patterns
- [Advanced Spatial Endpoint Implementation & Data Contracts](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/) — strict Pydantic v2 validators, async bulk uploads, and bounding-box query patterns
- [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/) — JWT spatial scope claims, PostGIS row-level security, and rate limiting for spatial endpoints
- [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/) — containerizing PostGIS and FastAPI, CI/CD with spatial integration tests, and edge tile delivery
