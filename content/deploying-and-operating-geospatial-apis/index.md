---
layout: layouts/page.njk
title: "Deploying & Operating Geospatial APIs"
description: "A production operations reference for FastAPI + PostGIS spatial APIs: containerising PostGIS and FastAPI, CI/CD with real spatial integration tests, edge routing for vector tiles, and observability for spatial workloads."
slug: deploying-and-operating-geospatial-apis
breadcrumb: Deploying & Operating Geospatial APIs
datePublished: "2025-09-18"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Deploying & Operating Geospatial APIs",
      "description": "A production operations reference for FastAPI + PostGIS spatial APIs: containerising PostGIS and FastAPI, CI/CD with real spatial integration tests, edge routing for vector tiles, and observability for spatial workloads.",
      "datePublished": "2025-09-18",
      "dateModified": "2026-07-10",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com" },
      "mainEntityOfPage": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/"
    },
    {
      "@type": "Article",
      "headline": "Deploying & Operating Geospatial APIs",
      "datePublished": "2025-09-18",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Deploying & Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Deploy and Operate a FastAPI + PostGIS Spatial API in Production",
      "step": [
        { "@type": "HowToStep", "name": "Containerise PostGIS and FastAPI with pinned image tags and GDAL/GEOS/PROJ runtime dependencies", "position": 1 },
        { "@type": "HowToStep", "name": "Build a CI pipeline with a PostGIS service container running real spatial integration tests", "position": 2 },
        { "@type": "HowToStep", "name": "Configure gunicorn/uvicorn workers, Alembic + GeoAlchemy2 migrations, and env-based secrets", "position": 3 },
        { "@type": "HowToStep", "name": "Serve vector tiles from an edge/CDN tier with explicit Cache-Control", "position": 4 },
        { "@type": "HowToStep", "name": "Scale replicas behind PgBouncer and add observability, alerting, and rolling deploys", "position": 5 }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why must I pin the PostGIS image to a full patch tag in production?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Floating tags like postgis/postgis:16 resolve to whatever the latest 16-x build is at pull time. Minor PostGIS and GEOS releases occasionally change the output of functions such as ST_SimplifyPreserveTopology, ST_Buffer, and ST_AsMVT — vertex counts, coordinate rounding, or tile byte layout shift. If your API and your CI container disagree on the version, tests pass and production returns different geometry. Pin the full tag, for example postgis/postgis:16-3.4, and treat a PostGIS upgrade as a deliberate, tested change."
          }
        },
        {
          "@type": "Question",
          "name": "Can I run CREATE INDEX CONCURRENTLY inside an Alembic migration?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Not inside the default transactional migration. CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and Alembic wraps each migration in one, so it fails with 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block'. Building a GIST index non-concurrently instead takes an ACCESS EXCLUSIVE lock and blocks writes for the duration. The fix is to run the concurrent index build outside the migration transaction — set the connection to autocommit for that statement, or run it as a separate post-deploy step — so large tables stay writable during the deploy."
          }
        },
        {
          "@type": "Question",
          "name": "How do I stop the edge cache serving stale vector tiles after a data change?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Never rely on TTL expiry alone. Put a data version in the tile path or query string (for example /tiles/v42/{z}/{x}/{y}.mvt) and bump it when the underlying geometry changes, so new requests miss the old cache entries deterministically. Pair that with surrogate-key or tag-based purging at the edge and a short stale-while-revalidate window so clients get an immediate response while the edge refreshes in the background."
          }
        }
      ]
    }
  ]
}
</script>

# Deploying and operating geospatial APIs

Getting a FastAPI + PostGIS spatial API to pass tests on a laptop is a different problem from keeping it correct, fast, and observable under production traffic. This reference covers the operational stack backend and platform engineers actually have to build: containerising PostGIS and FastAPI so spatial outputs are reproducible, CI/CD pipelines that run real spatial integration tests against a live PostGIS, an edge tier that serves vector tiles at scale, and the observability signals that tell you when a spatial deploy has quietly gone wrong.

## Architectural Blueprint: Build-to-Edge Topology

A spatial API has two distinct flows that must be reasoned about separately: the **delivery pipeline** that turns a git push into a running, version-pinned image, and the **request path** where map clients hit an edge tier that offloads most tile traffic before it ever reaches the origin. Collapsing these two flows — deploying straight from a developer laptop, or serving tiles directly from FastAPI with no edge — is the root cause of most spatial-API incidents: non-reproducible geometry output, and origin databases melting under tile fan-out.

<svg viewBox="0 0 760 470" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Deployment topology for a FastAPI and PostGIS spatial API, from developer through CI and container registry to an edge-fronted runtime cluster" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>Build-to-edge deployment topology for a spatial API</title>
  <desc>A developer pushes to GitHub Actions CI, which runs tests against a PostGIS service container and publishes a pinned image to a container registry. The registry rolls the image out to a runtime cluster containing FastAPI replicas, PgBouncer, PostGIS, and Redis. Separately, a map client requests vector tiles from an edge/CDN tier that caches tiles and only forwards cache misses to the FastAPI origin.</desc>
  <!-- Build & delivery pipeline -->
  <text x="40" y="22" font-size="11" font-weight="700" fill="var(--muted, #7c6fb0)">BUILD &amp; DELIVERY</text>
  <rect x="40" y="30" width="140" height="56" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="110" y="56" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Developer</text>
  <text x="110" y="74" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">git push · PR</text>
  <rect x="230" y="30" width="190" height="56" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="325" y="54" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">GitHub Actions CI</text>
  <text x="325" y="72" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">PostGIS service container</text>
  <rect x="470" y="30" width="160" height="56" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="550" y="54" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Container Registry</text>
  <text x="550" y="72" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">pinned image tags</text>
  <line x1="180" y1="58" x2="228" y2="58" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="420" y1="58" x2="468" y2="58" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Edge tier -->
  <text x="40" y="132" font-size="11" font-weight="700" fill="var(--muted, #7c6fb0)">REQUEST PATH</text>
  <rect x="40" y="142" width="140" height="52" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="110" y="166" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Map client</text>
  <text x="110" y="183" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">GET {z}/{x}/{y}.mvt</text>
  <rect x="230" y="142" width="270" height="52" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="365" y="166" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Edge / CDN — vector tile cache</text>
  <text x="365" y="183" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">Cache-Control · stale-while-revalidate</text>
  <line x1="180" y1="168" x2="228" y2="168" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Registry rollout arrow into runtime -->
  <line x1="550" y1="86" x2="550" y2="248" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arr)"/>
  <text x="562" y="150" font-size="10" fill="var(--muted, #7c6fb0)">rolling deploy</text>
  <!-- Edge miss → origin arrow -->
  <line x1="300" y1="194" x2="180" y2="288" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arr)"/>
  <text x="196" y="236" font-size="10" fill="var(--muted, #7c6fb0)">cache miss → origin</text>
  <!-- Runtime cluster -->
  <text x="40" y="242" font-size="11" font-weight="700" fill="var(--muted, #7c6fb0)">RUNTIME CLUSTER</text>
  <rect x="30" y="250" width="700" height="200" rx="10" fill="none" stroke="var(--border, #c4b5fd)" stroke-width="1.5" stroke-dasharray="6,3"/>
  <rect x="55" y="288" width="160" height="60" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="135" y="314" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">FastAPI × N</text>
  <text x="135" y="332" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">gunicorn + uvicorn</text>
  <rect x="270" y="296" width="130" height="44" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="335" y="316" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">PgBouncer</text>
  <text x="335" y="332" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">transaction pool</text>
  <rect x="455" y="288" width="160" height="60" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="535" y="314" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">PostGIS 16-3.4</text>
  <text x="535" y="332" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">GIST · asyncpg</text>
  <rect x="55" y="386" width="160" height="44" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="135" y="406" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Redis</text>
  <text x="135" y="422" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">tile + query cache</text>
  <line x1="215" y1="318" x2="268" y2="318" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="400" y1="318" x2="453" y2="318" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="135" y1="348" x2="135" y2="384" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="146" y="372" font-size="10" fill="var(--muted, #7c6fb0)">cache</text>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

The delivery pipeline (top) guarantees that the exact PostGIS and GDAL versions your integration tests ran against are the versions that reach production. The request path (bottom) keeps the origin cluster small by absorbing repeated tile requests at the edge. Everything downstream of the registry — replica count, pool sizing, cache TTLs — is a tuning exercise; the two structural rules are *pin what you ship* and *cache tiles before they reach the database*. The three areas that carry the most operational weight each have a dedicated guide: [containerising PostGIS and FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/), [CI/CD pipelines for spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/), and [edge routing and tile delivery at scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/).

## Infrastructure Layer: Reproducible Spatial Images

The infrastructure layer exists to make one promise: the geometry a request produces in production is byte-identical to what CI verified. Spatial correctness depends on native C libraries — GEOS, PROJ, and GDAL — whose versions are baked into the PostGIS image and, separately, into the FastAPI runtime image. If those two images drift apart, or if either floats to `latest`, you lose reproducibility.

### Base images and native dependencies

Two images anchor the stack. PostGIS runs from a **fully pinned** tag, and the application runs from a slim Python base with the native geospatial libraries explicitly installed:

```dockerfile
# --- Database image: pin to a full patch tag, never a floating major ---
# postgis/postgis:16-3.4  →  PostgreSQL 16, PostGIS 3.4, bundled GEOS/PROJ/GDAL
FROM postgis/postgis:16-3.4

# --- Application image: python:3.12-slim + native spatial stack ---
FROM python:3.12-slim AS runtime

# GDAL/GEOS/PROJ are required at runtime for shapely, pyproj, and any
# server-side ogr2ogr ingestion. Omitting these is the single most common
# "works in CI, 500s in prod" bug for spatial APIs.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgeos-c1v5 \
        libproj25 \
        gdal-bin \
        libgdal-dev \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
```

The image size penalty for `libgdal-dev` is real (200 MB+), so a production build should use a multi-stage pattern that compiles wheels in a builder stage and copies only the runtime shared libraries into the final image. That trade-off — and how to pin PostGIS deterministically — is worked through in [containerising PostGIS and FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/).

### Compose topology and healthchecks

For local development and single-node deployments, a Compose file wires the runtime cluster together. The critical detail for spatial APIs is that a healthcheck must prove **PostGIS is functional**, not merely that PostgreSQL accepts connections — the extension can fail to load after an upgrade while the server itself stays up:

```yaml
# docker-compose.yml
services:
  postgis:
    image: postgis/postgis:16-3.4
    environment:
      POSTGRES_DB: gis
      POSTGRES_USER: api
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      # Prove the extension answers, not just the server
      test: ["CMD-SHELL", "pg_isready -U api && psql -U api -d gis -tAc \"SELECT PostGIS_Version()\""]
      interval: 10s
      timeout: 5s
      retries: 6

  pgbouncer:
    image: pgbouncer/pgbouncer:1.23.1
    depends_on:
      postgis:
        condition: service_healthy
    volumes:
      - ./pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro

  api:
    image: registry.example.com/gis-api:1.8.3   # pinned, not :latest
    depends_on:
      pgbouncer:
        condition: service_started
    command: >
      gunicorn app.main:app
      --worker-class uvicorn.workers.UvicornWorker
      --workers 4 --bind 0.0.0.0:8000
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8000/health/spatial"]
      interval: 15s
      timeout: 4s
      retries: 4

  redis:
    image: redis:7.4-alpine
    command: ["redis-server", "--maxmemory", "512mb", "--maxmemory-policy", "allkeys-lru"]

volumes:
  pgdata:
```

PgBouncer sits between the API and PostGIS in transaction-pooling mode; the full parameter set for spatial workloads is covered in [connection pooling and PgBouncer setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/). The `depends_on: condition: service_healthy` gate is not optional — without the PostGIS-aware healthcheck, the API and PgBouncer start against a database whose extension has not finished initialising, and the first spatial query fails with `function st_asmvt does not exist`.

## Application Layer: Workers, Migrations, and Config

Once the images are reproducible, the application layer governs how the process runs, how the schema evolves, and how secrets reach the container.

### Gunicorn and uvicorn worker configuration

FastAPI is served by gunicorn managing `UvicornWorker` processes. Spatial endpoints are unusual: the CPU work happens *inside PostGIS*, not in Python, so the event loop rarely blocks — but each in-flight query holds a database connection. That makes worker and pool sizing interdependent rather than independent knobs:

```python
# gunicorn.conf.py
import multiprocessing

# For spatial APIs the ceiling is database connections, not CPU. Start at
# (2 × cores) + 1 and validate against PgBouncer's default_pool_size — total
# in-flight queries = workers × per-worker pool must stay under the backend budget.
workers = min(multiprocessing.cpu_count() * 2 + 1, 8)
worker_class = "uvicorn.workers.UvicornWorker"

# Recycle workers to bound memory growth from large geometry buffers
# (a single ST_AsMVT over a dense tile can allocate tens of MB transiently).
max_requests = 2000
max_requests_jitter = 200

# Kill a worker whose request has hung — usually a runaway ST_Union or a
# lock wait — rather than letting it hold a pool slot indefinitely.
timeout = 30
graceful_timeout = 20
keepalive = 5
```

Set `workers` too high and every worker opens its own connection pool, multiplying total connections past what PgBouncer's `default_pool_size` can back — you exhaust PostGIS `max_connections` before you saturate CPU. The reliable pattern is a shallow per-worker SQLAlchemy pool and a single shared PgBouncer transaction pool doing the real multiplexing.

### Migrations with Alembic and GeoAlchemy2

Schema migrations for spatial tables have failure modes that ordinary migrations do not. GeoAlchemy2 emits `Geometry` column types, and Alembic's autogenerate must be told not to try to "drop" the `spatial_ref_sys` table and the GIST indexes that PostGIS and GeoAlchemy2 manage:

```python
# alembic/env.py — exclude PostGIS-managed objects from autogenerate
def include_object(obj, name, type_, reflected, compare_to):
    if type_ == "table" and name in {"spatial_ref_sys"}:
        return False
    # GeoAlchemy2 creates GIST indexes implicitly; don't let autogenerate
    # emit a second CREATE/DROP for them.
    if type_ == "index" and name.startswith("idx_") and name.endswith("_geom"):
        return False
    return True

context.configure(
    connection=connection,
    target_metadata=target_metadata,
    include_object=include_object,
    compare_type=True,
)
```

The concurrent-index build is the migration trap that catches most teams. `CREATE INDEX CONCURRENTLY` keeps a large table writable during the build, but it **cannot run inside a transaction**, and Alembic wraps every migration in one. The build must be lifted out of the transactional migration:

```python
# alembic/versions/xxxx_add_parcels_gist.py
from alembic import op

def upgrade():
    # Commit the surrounding transaction, then issue the concurrent build
    # on a raw autocommit connection so the table stays writable during deploy.
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parcels_geom "
            "ON parcels USING GIST (geom)"
        )
```

Automating this safely inside a pipeline — including how to gate the deploy on migration success — is the subject of [CI/CD pipelines for spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/).

### Configuration and secrets

Configuration comes from the environment, never from a committed file. Pydantic's `BaseSettings` gives you typed, validated config with a single source of truth:

```python
# app/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None)  # env/secret store only

    database_url: str          # postgresql+asyncpg://api@pgbouncer:6432/gis
    redis_url: str
    postgis_min_version: str = "3.4"
    tile_cache_ttl: int = 300
    data_version: int = 1      # bump to bust edge tile caches on data change

settings = Settings()          # raises at startup if a required var is missing
```

The database DSN points at PgBouncer (`:6432`), not PostGIS directly. Secrets — `POSTGRES_PASSWORD`, registry credentials, signing keys — are injected by the orchestrator's secret store and surfaced as environment variables at runtime, so they never appear in the image, the Compose file, or the repository.

## Delivery & Serialization: Tiles at the Edge

The request path is dominated by one workload: map clients requesting the same vector tiles over and over. A production spatial API must answer those requests from an edge cache, reaching the database only on a genuine miss. This is where deployment topology and response headers matter more than query tuning.

### Tile pipeline and cache headers

Vector tiles are generated by `ST_AsMVT` inside PostGIS, then cached at the edge keyed by the tile path. The origin's job is to set headers that let the edge and the browser cache correctly and revalidate cheaply:

```python
# app/routes/tiles.py
from fastapi import APIRouter, Response, Depends
from sqlalchemy import text
from .deps import get_db, settings

router = APIRouter()

TILE_SQL = text("""
    WITH bounds AS (SELECT ST_TileEnvelope(:z, :x, :y) AS geom)
    SELECT ST_AsMVT(t, 'parcels', 4096, 'geom') AS mvt
    FROM (
        SELECT id, ST_AsMVTGeom(p.geom, bounds.geom, 4096, 64, true) AS geom
        FROM parcels p, bounds
        WHERE p.geom && bounds.geom
    ) AS t
""")

@router.get("/tiles/v{ver}/{z}/{x}/{y}.mvt")
async def parcel_tile(ver: int, z: int, x: int, y: int, db=Depends(get_db)):
    row = await db.execute(TILE_SQL, {"z": z, "x": x, "y": y})
    mvt = row.scalar_one()
    return Response(
        content=bytes(mvt),
        media_type="application/vnd.mapbox-vector-tile",
        headers={
            # Long browser TTL; the version segment in the path makes it safe.
            "Cache-Control": "public, max-age=86400, stale-while-revalidate=60",
            # Surrogate key lets the edge purge exactly the affected tiles.
            "Surrogate-Key": f"parcels tiles-v{ver}",
            "ETag": f'"parcels-{ver}-{z}-{x}-{y}"',
        },
    )
```

The `&&` bounding-box operator uses the GIST index to select only candidate geometries before `ST_AsMVTGeom` clips them to the tile — the same index-first pattern that governs every spatial read. The version segment (`v{ver}`) is what makes an aggressive `max-age` safe: bumping `data_version` changes the URL, so stale tiles are never served after a data change. Edge configuration, surrogate-key purging, and worker-based routing are detailed in [edge routing and tile delivery at scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/), and the origin-side tile generation strategy is covered in [tile generation and CDN distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/).

### Content negotiation

Not every consumer wants MVT. The origin negotiates the serialization format by `Accept` header or path suffix, and each format carries different cacheability. Choosing between GeoJSON and a binary format is a decision matrix in its own right, laid out in [GeoJSON vs GeoParquet serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/); the operational summary for the edge is:

| Client / `Accept` | Media type | PostGIS producer | Typical `Cache-Control` | Edge cacheable |
|---|---|---|---|---|
| Web map (tiles) | `application/vnd.mapbox-vector-tile` | `ST_AsMVT` | `max-age=86400, swr=60` | Yes — highest hit rate |
| Web map (raw) | `application/geo+json` | `ST_AsGeoJSON` | `max-age=60` | Partial — bbox-keyed |
| Analytics export | `application/vnd.apache.parquet` | GeoParquet writer | `no-store` (signed URL) | No — one-shot |
| Internal service | `application/octet-stream` (WKB) | `ST_AsBinary` | `private, max-age=300` | No |

Tile responses are the only ones worth pushing hard to the edge; exports and internal binary transfers are deliberately kept out of the shared cache.

## Performance & Scalability

Scaling a spatial API is not "add more replicas". The database is the shared, hard-to-scale resource, and the edge is the lever that keeps load off it.

### Replica scaling within the connection budget

FastAPI replicas scale horizontally, but every replica draws from a **fixed** PostGIS connection budget. The governing inequality is:

```
replicas × workers_per_replica × sqlalchemy_pool_size  ≤  pgbouncer default_pool_size × (backend budget)
```

Because PostGIS spatial operations are CPU-bound, the effective backend budget is roughly `2 × vCPU` on the database host — beyond that, extra backends queue at the OS scheduler instead of running in parallel. So horizontal replica scaling buys request concurrency and failure isolation, not raw query throughput; that ceiling is set by database vCPUs and by how much traffic the edge absorbs. Sizing the pool against replica count is exactly the calculation in [connection pooling and PgBouncer setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

### Edge offload benchmarks

The single biggest scalability win is edge cache hit rate. Representative numbers from a parcels tile workload at zoom 12–16, 4 vCPU database, `default_pool_size = 20`:

| Scenario | Origin RPS at edge | DB query p95 | Sustained client RPS |
|---|---|---|---|
| No edge (FastAPI serves every tile) | ~950 | 34 ms | ~950 (DB-bound) |
| Edge, 85 % hit rate | ~140 | 34 ms | ~6,300 |
| Edge, 97 % hit rate + `stale-while-revalidate` | ~30 | 34 ms | ~30,000+ |

The database query latency never changes — what changes is how few requests reach it. Moving from no edge to a 97 % hit rate raises sustainable client throughput by more than an order of magnitude without touching PostGIS. This is why tile-heavy endpoints must be designed edge-first rather than optimised query-first.

### Caching layers and cursoring

Behind the edge, Redis caches serialized responses for endpoints that are dynamic but repetitive (bbox feature lists, precomputed boundaries), invalidated on write. And for large non-tile result sets, keyset paging keeps the database from doing offset scans — the [spatial pagination and cursor strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) guide covers the Z-order and tile-aligned cursors that keep page latency flat as offsets grow. A cache hit at any of these layers is a database connection you did not spend.

## Production Readiness

Readiness is the set of guarantees that let you deploy on a Tuesday afternoon: the pipeline gates bad builds, deploys are reversible, and the running system tells you when spatial behaviour degrades.

### CI gating and deploy strategy

The pipeline must gate on spatial correctness, not just unit tests. A PostGIS **service container** runs alongside the CI job so integration tests execute against the same version pinned for production, exercising real `ST_` functions rather than mocks:

```yaml
# .github/workflows/ci.yml (excerpt)
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgis:
        image: postgis/postgis:16-3.4          # identical to production
        env: { POSTGRES_PASSWORD: ci, POSTGRES_DB: gis }
        ports: ["5432:5432"]
        options: >-
          --health-cmd="pg_isready -U postgres"
          --health-interval=5s --health-retries=10
    steps:
      - uses: actions/checkout@v4
      - run: pip install -r requirements-dev.txt
      - run: alembic upgrade head        # migrations must apply cleanly
      - run: pytest -q tests/spatial     # real ST_Intersects / ST_AsMVT assertions
```

Deploys should be **rolling or blue/green** so a bad image never takes down every replica at once. Roll one replica, wait for its `/health/spatial` probe to pass, then continue; keep the previous image tag one command away from a rollback. Building this pipeline end to end — including migration ordering against a live schema — is the focus of [CI/CD pipelines for spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/).

### Observability signals for spatial operations

Generic HTTP dashboards miss the failure modes that actually hurt spatial APIs. Instrument these signals and export them to Prometheus:

| Signal | What it measures | Source | Alert threshold |
|---|---|---|---|
| Tile route p95 latency | Origin response time for `.mvt` routes | FastAPI middleware histogram | > 250 ms |
| Edge cache hit ratio | Edge hits ÷ total tile requests | CDN analytics / logs | < 0.90 |
| `ST_` function p95 | Slowest spatial function per query | `pg_stat_statements` + `auto_explain` | > 500 ms |
| PgBouncer `cl_waiting` | Clients queued for a backend | `SHOW POOLS` exporter | > 0 for 30 s |
| GIST index hit rate | `idx_blks_hit / (hit + read)` | `pg_statio_user_indexes` | < 0.95 |
| Migration lock wait | Time blocked on `ACCESS EXCLUSIVE` | `pg_locks` during deploy | > 5 s |
| Container restart count | Crash-looping replicas | orchestrator | > 0 in 5 min |
| PostGIS version drift | Running version vs pinned | `/health/spatial` payload | any mismatch |

The spatial health probe is what surfaces the last row — it returns the live PostGIS and GEOS versions so an alert fires the moment a rebuilt image drifts from the pinned tag:

```python
@app.get("/health/spatial")
async def spatial_health(db=Depends(get_db)):
    row = (await db.execute(text(
        "SELECT PostGIS_Version() AS postgis, "
        "postgis_geos_version() AS geos, "
        "ST_AsText(ST_MakePoint(0,0)) AS probe"
    ))).mappings().one()
    return {"status": "ok", **row}
```

Set `auto_explain.log_min_duration = '1s'` on the database so slow spatial plans are captured without manual `EXPLAIN ANALYZE`, and alert on p95 `ST_` duration and PgBouncer `cl_waiting` rather than on raw CPU — those two signals lead every spatial incident.

## Failure Modes and Common Misconfigurations

Each of the following has caused a real production incident on a FastAPI + PostGIS deployment. They are ordered roughly by how often they bite.

1. **Floating PostGIS image tag changes `ST_` output.** Deploying from `postgis/postgis:16` (not `:16-3.4`) means a rebuild can silently pull a newer GEOS, changing `ST_SimplifyPreserveTopology` vertex counts or `ST_AsMVT` byte layout. Tiles that were cached against the old output now mismatch new ones. Pin the full patch tag everywhere — CI, Compose, and the deployed manifest — and treat upgrades as reviewed changes.

2. **`CREATE INDEX CONCURRENTLY` inside a migration transaction.** The build fails with `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`, and the naive fix — dropping `CONCURRENTLY` — takes an `ACCESS EXCLUSIVE` lock that blocks all writes to a large table for the length of the build. Use Alembic's `autocommit_block()` (shown above) so the index builds without locking out traffic.

3. **Missing GDAL/GEOS/PROJ in the runtime image.** Everything imports fine until the first request that touches `shapely`, `pyproj`, or `ogr2ogr`, which then fails with `OSError: could not find libgdal` or a `proj` data error. `python:3.12-slim` ships none of these — install `gdal-bin`, `libgdal-dev`, `libgeos-c1v5`, and `libproj25` explicitly, and verify with an import in CI.

4. **Edge cache serving stale tiles after a data change.** With a long `max-age` and no versioning, updated geometry stays invisible for hours because clients keep hitting cached tiles. Put a `data_version` in the tile path and bump it on write, and use surrogate-key purging at the edge so a change invalidates exactly the affected tiles.

5. **Health check proves PostgreSQL, not PostGIS.** A `pg_isready` or `SELECT 1` probe passes while the PostGIS extension failed to load after an upgrade, so the orchestrator routes traffic to a replica that 500s on every spatial query with `function st_asmvt does not exist`. The probe must call a `PostGIS_Version()` / `ST_` function.

6. **Session pooling on PgBouncer for an async app.** Long-held spatial transactions in session mode pin one backend per client and exhaust the pool under load. Spatial APIs must use transaction pooling with `statement_cache_size=0` on asyncpg, or every burst of tile traffic ends in `connection pool exhausted`.

7. **Worker count untethered from the connection budget.** Scaling replicas or `--workers` without recomputing `replicas × workers × pool_size` blows past PostGIS `max_connections`; new replicas fail startup with `FATAL: sorry, too many clients already`. Size workers and pools against the backend budget, not against CPU alone.

8. **Untuned `statement_timeout` letting a runaway aggregation hold the pool.** A single unbounded `ST_Union` or a giant-radius `ST_DWithin` can hold a backend for seconds, starving tile traffic. Set `statement_timeout` (e.g. `8s`) at the database and a gunicorn `timeout` at the app so one pathological spatial query cannot cascade into a pool-wide stall.

## FAQ

### Why must I pin the PostGIS image to a full patch tag in production?

Floating tags like `postgis/postgis:16` resolve to whatever the latest `16-x` build is at pull time. Minor PostGIS and GEOS releases occasionally change the output of functions such as `ST_SimplifyPreserveTopology`, `ST_Buffer`, and `ST_AsMVT` — vertex counts, coordinate rounding, or tile byte layout shift. If your API and your CI container disagree on the version, tests pass and production returns different geometry. Pin the full tag, for example `postgis/postgis:16-3.4`, and treat a PostGIS upgrade as a deliberate, tested change.

### Can I run CREATE INDEX CONCURRENTLY inside an Alembic migration?

Not inside the default transactional migration. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, and Alembic wraps each migration in one, so it fails with `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. Building a GIST index non-concurrently instead takes an `ACCESS EXCLUSIVE` lock and blocks writes for the duration. The fix is to run the concurrent build outside the migration transaction — use Alembic's `autocommit_block()` for that statement, or run it as a separate post-deploy step — so large tables stay writable during the deploy.

### How do I stop the edge cache serving stale vector tiles after a data change?

Never rely on TTL expiry alone. Put a data version in the tile path or query string (for example `/tiles/v42/{z}/{x}/{y}.mvt`) and bump it when the underlying geometry changes, so new requests miss the old cache entries deterministically. Pair that with surrogate-key or tag-based purging at the edge and a short `stale-while-revalidate` window so clients get an immediate response while the edge refreshes in the background.

## Related

- [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/) — multi-stage builds, GDAL/GEOS/PROJ runtime deps, and deterministic PostGIS version pinning
- [CI/CD Pipelines for Spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/) — GitHub Actions with a PostGIS service container, spatial integration tests, and automated migrations
- [Edge Routing & Tile Delivery at Scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/) — worker-based edge routing, surrogate-key purging, and `Cache-Control` for vector tiles
- [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — origin-side `ST_AsMVT` pipelines and CDN offload for high-traffic tile routes
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — transaction-mode pooling that lets FastAPI replicas share a fixed PostGIS connection budget
- [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/) — authentication, tenant isolation, and rate limiting for the endpoints you deploy
