---
layout: layouts/page.njk
title: "Containerizing PostGIS & FastAPI"
description: "Build reliable container images and a local-to-production topology for a spatial API: PostGIS and python:3.12-slim base images, GDAL/GEOS/PROJ system dependencies, a docker-compose stack with pgbouncer and Redis, PostGIS-aware healthchecks, and non-root hardening."
slug: "containerizing-postgis-and-fastapi"
breadcrumb:
  - label: "Deploying & Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Containerizing PostGIS & FastAPI"
    url: "/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/"
datePublished: "2025-09-08"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Containerizing PostGIS & FastAPI",
      "description": "Build reliable container images and a local-to-production topology for a spatial API: PostGIS and python:3.12-slim base images, GDAL/GEOS/PROJ system dependencies, a docker-compose stack with pgbouncer and Redis, PostGIS-aware healthchecks, and non-root hardening.",
      "datePublished": "2025-09-08",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com"},
      "mainEntityOfPage": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/"
    },
    {
      "@type": "Article",
      "headline": "Containerizing PostGIS & FastAPI",
      "datePublished": "2025-09-08",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/"},
        {"@type": "ListItem", "position": 2, "name": "Deploying & Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/"},
        {"@type": "ListItem", "position": 3, "name": "Containerizing PostGIS & FastAPI", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Containerize a FastAPI and PostGIS spatial API",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Select base images for the database and the application"},
        {"@type": "HowToStep", "position": 2, "name": "Install GDAL, GEOS, and PROJ system dependencies for the Python geospatial stack"},
        {"@type": "HowToStep", "position": 3, "name": "Write a docker-compose stack with db, api, redis, and pgbouncer"},
        {"@type": "HowToStep", "position": 4, "name": "Add PostGIS-aware healthchecks and a non-root runtime user"},
        {"@type": "HowToStep", "position": 5, "name": "Verify with docker compose up and a curl against /health"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why do geospatial Python wheels break on Alpine-based images?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Alpine uses the musl C library rather than glibc, and the manylinux wheels published for shapely, pyproj, rasterio, and GDAL bindings are compiled against glibc. On Alpine, pip cannot use those prebuilt wheels and falls back to compiling from source, which requires the full GDAL, GEOS, and PROJ development headers plus a C/C++ toolchain. The build is slow, fragile, and frequently mismatches the runtime library versions. Use python:3.12-slim (Debian glibc) so the manylinux wheels install directly."
          }
        },
        {
          "@type": "Question",
          "name": "Should PostgreSQL and PostGIS run in the same container as FastAPI?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Keep the database and the application in separate containers with separate lifecycles. The database needs a persistent named volume, a controlled upgrade path, and a pinned postgis/postgis tag; the API is stateless and redeployed frequently. Co-locating them couples upgrade cadence, defeats horizontal scaling of the API tier, and puts your data volume at risk during routine app rollouts."
          }
        },
        {
          "@type": "Question",
          "name": "How should a container healthcheck verify PostGIS rather than just PostgreSQL?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "pg_isready only confirms the PostgreSQL process accepts connections; it does not confirm the PostGIS extension is installed and functional. Run SELECT PostGIS_Version() in the healthcheck so an image missing the extension, or a database where CREATE EXTENSION postgis never ran, is reported unhealthy instead of silently accepting traffic that will fail on the first ST_ call."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/)

# Containerizing PostGIS & FastAPI

A spatial API has a harder containerization problem than a plain CRUD service. The application layer depends on compiled C libraries — GDAL, GEOS, and PROJ — that must be present and version-aligned at runtime, and the database layer is not stock PostgreSQL but a PostGIS build whose exact tag determines the behaviour of every `ST_` function you call. Get either wrong and the failure is not a clean startup error: it is an `ImportError` deep in a request handler, or a `could not open extension control file` the first time a migration runs, or a subtly different `ST_SimplifyPreserveTopology` output after an unpinned image rebuild. This guide builds a reproducible image and a local-to-production topology that eliminate those failure classes.

This work sits at the base of the delivery stack described in the [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/) overview — everything downstream, from CI integration tests to edge tile delivery, assumes the image built here is deterministic.

---

## Topology Overview

The local and production stack is four services: a PostGIS database with a persistent volume, a PgBouncer pooler, a Redis cache, and the stateless FastAPI container. The API never connects to PostgreSQL directly; it goes through the pooler, exactly as described in [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Container topology for a spatial API: FastAPI app container talks to Redis and to PgBouncer, which fronts a PostGIS database container backed by a persistent volume" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>Containerized spatial API topology</title>
  <desc>The FastAPI application container (python:3.12-slim) connects to a Redis cache container and to a PgBouncer container on port 6432. PgBouncer forwards to the PostGIS container (postgis/postgis:16-3.4) on port 5432, which is backed by a named Docker volume holding the data directory and spatial_ref_sys table. Healthchecks run against each service.</desc>
  <!-- App container -->
  <rect x="30" y="130" width="170" height="80" rx="10" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="115" y="160" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">api</text>
  <text x="115" y="180" text-anchor="middle" font-size="11" fill="currentColor">python:3.12-slim</text>
  <text x="115" y="197" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">FastAPI · uvicorn · non-root</text>
  <!-- Redis -->
  <rect x="270" y="30" width="170" height="66" rx="10" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="355" y="58" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">redis</text>
  <text x="355" y="78" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">redis:7-alpine · :6379</text>
  <!-- PgBouncer -->
  <rect x="270" y="140" width="170" height="66" rx="10" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="355" y="168" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">pgbouncer</text>
  <text x="355" y="188" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">transaction pool · :6432</text>
  <!-- PostGIS -->
  <rect x="510" y="140" width="180" height="66" rx="10" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="600" y="168" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">db</text>
  <text x="600" y="188" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">postgis/postgis:16-3.4 · :5432</text>
  <!-- Volume -->
  <rect x="510" y="248" width="180" height="60" rx="10" fill="none" stroke="var(--border, #c4b5fd)" stroke-width="1.5" stroke-dasharray="6 3"/>
  <text x="600" y="274" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">named volume</text>
  <text x="600" y="292" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">pgdata · spatial_ref_sys</text>
  <!-- Arrows -->
  <line x1="200" y1="158" x2="270" y2="90" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="232" y="118" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">cache</text>
  <line x1="200" y1="172" x2="270" y2="172" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="235" y="165" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">SQL</text>
  <line x1="440" y1="173" x2="510" y2="173" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="600" y1="206" x2="600" y2="246" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

The two boxes that carry hard version constraints are outlined in the accent colour: the database, whose tag governs spatial algorithm output, and the app, whose base image governs whether the compiled geospatial wheels load at all.

---

## Prerequisites & Environment

Confirm the toolchain and pin the exact image tags before writing a line of Dockerfile. Floating tags are the root cause of the reproducibility failures covered later; the discipline of pinning is expanded in [Pinning PostGIS Versions in Production Images](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/).

| Component | Pinned choice | Why this exact value |
|---|---|---|
| Docker Engine | 24+ | BuildKit on by default; `--mount=type=cache` for pip |
| Compose | 2.20+ | `depends_on` `condition: service_healthy` support |
| DB image | `postgis/postgis:16-3.4` | PostgreSQL 16 + PostGIS 3.4, GEOS 3.12, PROJ 9.x baked in |
| App base | `python:3.12-slim` (Debian bookworm) | glibc — manylinux wheels install without compiling |
| shapely | 2.0+ | Ships GEOS in the wheel; no system GEOS needed at runtime for shapely itself |
| pyproj | 3.6+ | Bundles PROJ 9.x data in the wheel; align with DB PROJ |
| GDAL Python | matches system `libgdal` | Bindings are ABI-locked to the installed `libgdal.so` |
| PgBouncer | 1.23+ | Transaction pooling for the async workload |

The critical rule: the GDAL Python bindings are **not** self-contained. `shapely` and `pyproj` bundle their own copies of GEOS and PROJ inside the wheel, so on a `slim` image they work with no apt packages at all. `rasterio` and the GDAL bindings do not — they dynamically link against a `libgdal.so` that must exist on the system and whose major version must match the Python package.

Install the app dependencies with the runtime libraries present:

```bash
# Runtime .so libraries GDAL/rasterio link against at import time
apt-get install -y --no-install-recommends \
    libgdal32 libgeos-c1v5 libproj25

pip install "fastapi>=0.111" "uvicorn[standard]>=0.30" \
    "asyncpg>=0.29" "sqlalchemy[asyncio]>=2.0" "geoalchemy2>=0.15" \
    "shapely>=2.0" "pyproj>=3.6" "rasterio>=1.3"
```

---

## Decision Matrix: Base Image for the Application Layer

The single most consequential choice is the app base image. This matrix is the analytical anchor of the whole exercise — most broken geospatial containers trace back to picking the wrong row.

| Base image | libc | Geospatial wheel install | Image size (app + deps) | Cold start | Verdict for spatial APIs |
|---|---|---|---|---|---|
| `python:3.12-alpine` | musl | Compiles from source; frequent GEOS/PROJ mismatches | ~110 MB (after a 20-min build) | Fast | Avoid — musl breaks manylinux wheels |
| `python:3.12-slim` | glibc | Prebuilt manylinux wheels install cleanly | ~380 MB | Fast | Recommended default |
| `python:3.12` (full) | glibc | Same wheels as slim, plus unused build tooling | ~1.0 GB | Fast | Wasteful; slim is strictly better at runtime |
| `osgeo/gdal:ubuntu-small` | glibc | System GDAL matched to bindings out of the box | ~500 MB | Fast | Good when you need bleeding-edge GDAL from the OS |
| `ghcr.io/…/uv:python3.12` | glibc | Fast resolver; still needs runtime `.so` libs | ~380 MB | Fast | Fine if you already use uv |

Alpine looks attractive because the empty image is ~50 MB, but the moment `pip install shapely` runs it must compile against musl. The manylinux wheels on PyPI target glibc, so pip discards them and builds from the sdist, which requires `gdal-dev`, `geos-dev`, `proj-dev`, and a full `build-base`. The result is slower to build, larger than expected, and prone to the runtime `ImportError` failures below. `python:3.12-slim` is the correct default; if you need a GDAL newer than Debian ships, base on `osgeo/gdal` instead. The size gap between `slim` and full is pure runtime dead weight, and a [multi-stage build](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/multi-stage-docker-builds-for-postgis-fastapi/) closes it further by leaving the compiler toolchain out of the final image entirely.

---

## Step-by-Step Implementation

### Step 1: The application Dockerfile

A single-stage Dockerfile that is correct, non-root, and cache-friendly. Copy `requirements.txt` before the source so a code change does not invalidate the dependency layer.

```dockerfile
# Dockerfile
FROM python:3.12-slim

# Runtime shared libraries that rasterio and the GDAL bindings dlopen.
# --no-install-recommends keeps the layer minimal; clean apt lists in the
# same RUN so the cache never lands in an image layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgdal32 \
        libgeos-c1v5 \
        libproj25 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Create an unprivileged user up front; never run the API as root.
RUN groupadd --system app && useradd --system --gid app --home /app app

WORKDIR /app

# Dependency layer first — cached until requirements.txt actually changes.
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

# Application source last.
COPY --chown=app:app . .

USER app
EXPOSE 8000

# Healthcheck hits the app's own /health, which probes PostGIS (see Step 4).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Step 2: Verify the geospatial libraries resolve at build time

Do not wait for a request to discover a missing `.so`. Add an import smoke test as a build step so a broken image fails the build, not production:

```dockerfile
# Fail the build immediately if a compiled dependency cannot load.
RUN python -c "import shapely, pyproj, rasterio; \
from osgeo import gdal; \
print('GDAL', gdal.__version__, '| GEOS', shapely.geos_version_string, \
'| PROJ', pyproj.proj_version_str)"
```

If `libgdal32` is missing from Step 1, this line fails with `ImportError: libgdal.so.32: cannot open shared object file` — at build time, where it belongs.

### Step 3: The compose stack (db + api + redis + pgbouncer)

```yaml
# docker-compose.yml
services:
  db:
    image: postgis/postgis:16-3.4
    environment:
      POSTGRES_DB: gis
      POSTGRES_USER: gis
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./initdb:/docker-entrypoint-initdb.d:ro   # runs only on empty volume
    healthcheck:
      # Verify the PostGIS extension, not merely that Postgres accepts sockets.
      test: ["CMD-SHELL", "pg_isready -U gis && psql -U gis -d gis -tAc 'SELECT PostGIS_Version()'"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s
    restart: unless-stopped

  pgbouncer:
    image: edoburu/pgbouncer:1.23.1
    environment:
      DB_HOST: db
      DB_NAME: gis
      DB_USER: gis
      DB_PASSWORD: ${POSTGRES_PASSWORD}
      POOL_MODE: transaction
      MAX_CLIENT_CONN: "1000"
      DEFAULT_POOL_SIZE: "20"
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  api:
    build: .
    environment:
      DATABASE_URL: postgresql+asyncpg://gis:${POSTGRES_PASSWORD}@pgbouncer:6432/gis
      REDIS_URL: redis://redis:6379/0
    depends_on:
      pgbouncer:
        condition: service_started
      redis:
        condition: service_healthy
    ports:
      - "8000:8000"
    restart: unless-stopped

volumes:
  pgdata:
```

Two details matter for spatial correctness. First, the `db` healthcheck runs `SELECT PostGIS_Version()` so the stack does not report ready until the extension answers. Second, the `initdb` mount only executes on a fresh (empty) volume — it is the correct place to `CREATE EXTENSION postgis` and seed reference data, but it will never re-run against an existing volume, which is exactly why the `spatial_ref_sys` strategy in Step 5 must not depend on it for upgrades.

### Step 4: A PostGIS-aware healthcheck endpoint

The app's `/health` distinguishes "PostgreSQL is up" from "PostGIS is functional". A connection can succeed while the extension is absent — the failure then surfaces on the first `ST_AsGeoJSON` call, not at startup.

```python
# app/routes/health.py
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from ..dependencies import get_db

router = APIRouter()

@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    row = await db.execute(text(
        "SELECT PostGIS_Version() AS postgis, "
        "ST_AsText(ST_SetSRID(ST_MakePoint(0, 0), 4326)) AS probe"
    ))
    r = row.mappings().one()
    return {"status": "ok", "postgis": r["postgis"], "probe": r["probe"]}
```

### Step 5: Volume and `spatial_ref_sys` strategy

`spatial_ref_sys` — the table holding every SRID definition PROJ uses — is created by `CREATE EXTENSION postgis` and lives inside the data directory, so it is persisted by the `pgdata` named volume automatically. Two rules keep it correct:

1. **Never bind-mount over `/var/lib/postgresql/data` with an empty host directory.** That shadows the initialised cluster; the entrypoint then reinitialises an empty database and your `spatial_ref_sys` (and everything else) is gone. Use a *named* volume as above.
2. **Do not seed `spatial_ref_sys` from a script.** The extension owns it. If you need custom projections, insert additional rows with a versioned migration, not by editing the table the extension manages. Keeping the client-side PROJ data aligned with the database is covered in [Pinning PostGIS Versions in Production Images](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/).

---

## Production Code Example

A production-grade multi-stage Dockerfile that keeps the compiler toolchain out of the shipped image while guaranteeing the runtime `.so` libraries are present. This is the condensed form; the fully annotated build, including wheel caching and `ldd` verification, is in [Multi-Stage Docker Builds for PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/multi-stage-docker-builds-for-postgis-fastapi/).

```dockerfile
# syntax=docker/dockerfile:1.7
# ---------- builder ----------
FROM python:3.12-slim AS builder

# Build tooling + dev headers, needed only to compile any sdist-only deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libgdal-dev libgeos-dev libproj-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

# ---------- runtime ----------
FROM python:3.12-slim AS runtime

# ONLY the runtime shared libraries — no -dev packages, no compiler.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgdal32 libgeos-c1v5 libproj25 curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system app && useradd --system --gid app --home /app app

# Copy the fully built virtualenv from the builder stage.
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY --chown=app:app . .
USER app

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

The correctness hinge is that the `libgdal32` (runtime) major version in the `runtime` stage must match the `libgdal-dev` the bindings compiled against in the `builder` stage. Debian bookworm ships both from the same source package, so they align; mixing distributions between stages is the classic way to reintroduce the `ImportError` below.

---

## Verification & Testing

Bring the stack up and confirm every layer end to end:

```bash
# 1. Build and start; wait for healthchecks to go green.
docker compose up -d --build
docker compose ps         # every service should read "healthy" / "running"

# 2. Confirm the app can reach PostGIS through PgBouncer.
curl -fsS http://localhost:8000/health | jq .
# { "status": "ok",
#   "postgis": "3.4 USE_GEOS=1 USE_PROJ=1 USE_STATS=1",
#   "probe": "POINT(0 0)" }

# 3. Independently confirm the extension inside the db container.
docker compose exec db psql -U gis -d gis -tAc "SELECT PostGIS_Full_Version();"

# 4. Prove the geospatial wheels loaded in the API image.
docker compose exec api python -c \
  "import rasterio, shapely, pyproj; from osgeo import gdal; \
print(gdal.__version__, shapely.geos_version_string, pyproj.proj_version_str)"
```

If step 4 prints three version strings, the runtime libraries and the Python bindings agree. If it raises `ImportError`, the `runtime` stage is missing a `.so` — see the first failure mode.

---

## Failure Modes & Edge Cases

1. **`ImportError: libgdal.so.32: cannot open shared object file: No such file or directory`** — the Python `osgeo`/`rasterio` bindings were installed but the runtime shared library is absent from the final image. In a multi-stage build the `builder` had `libgdal-dev` but the `runtime` stage never installed `libgdal32`. Fix: add `libgdal32` (and `libgeos-c1v5`, `libproj25`) to the runtime stage's apt install.

2. **`could not open extension control file "/usr/share/postgresql/16/extension/postgis.control": No such file or directory`** — you ran `CREATE EXTENSION postgis` against a plain `postgres:16` image instead of `postgis/postgis:16-3.4`. Stock PostgreSQL does not ship the PostGIS control files. Fix: use the `postgis/postgis` image; never expect `CREATE EXTENSION postgis` to work on vanilla `postgres`.

3. **`ERROR: could not access file "$libdir/postgis-3": No such file or directory` after an image bump** — the data directory was created by one PostGIS minor and the container binary is now a different one. The extension's SQL objects reference a `.so` that no longer exists. Fix: pin the tag, and when you do upgrade, run `ALTER EXTENSION postgis UPDATE;` — the safe path is detailed in [Pinning PostGIS Versions in Production Images](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/).

4. **Empty database on every `docker compose up`** — a bind mount (`- ./data:/var/lib/postgresql/data`) pointed at an empty or wrong-permission host directory shadows the initialised cluster, so the entrypoint reinitialises. Fix: use a named volume; if you must bind-mount, ensure the directory is owned appropriately and is the same one across restarts.

5. **`FATAL: role "gis" does not exist` from PgBouncer but the db is healthy** — the `initdb` scripts only run on a *fresh* volume, so changing `POSTGRES_USER` after the volume exists has no effect. Fix: `docker compose down -v` to drop the stale volume in development, or `ALTER ROLE` / `CREATE ROLE` explicitly in a migration for existing data.

6. **`prepared statement "__asyncpg_..." does not exist` under load** — asyncpg's client-side statement cache collides with PgBouncer transaction pooling. Fix: set `statement_cache_size=0` in the asyncpg `connect_args`, exactly as in [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

7. **Healthcheck passes but geometry queries 500** — the healthcheck used `pg_isready` alone, so it reported ready before (or without) the extension existing. Fix: put `SELECT PostGIS_Version()` in the healthcheck and probe an `ST_` function in `/health`.

---

## Performance Notes

**Image size and cold start.** A single-stage `slim` image with the geospatial stack lands around 640 MB; the multi-stage build in the linked guide brings that to roughly 420 MB by dropping `build-essential` and the `-dev` headers. Neither changes cold start meaningfully — Python interpreter startup plus importing `shapely`, `pyproj`, and `rasterio` is 0.6–1.2 s regardless of image size, because the cost is dlopen-ing the shared libraries, not pulling layers. The size win matters for pull time in CI and at autoscale scale-out, not for per-request latency.

**Layer caching.** Ordering `COPY requirements.txt` before `COPY . .` means a code-only change reuses the cached dependency layer, cutting rebuild time from minutes (recompiling/reinstalling the geospatial stack) to seconds. The BuildKit `--mount=type=cache,target=/root/.cache/pip` cache survives across builds even when the layer is invalidated, so a single new dependency does not re-download the whole set.

**Runtime footprint.** The `libgdal32` runtime library is ~30 MB on disk but shared across every process in the container. The dominant memory cost of a spatial API is not the libraries but the geometry buffers each `ST_` result set materialises; keep response sizes bounded with the streaming and pagination patterns in the architecture reference rather than by trimming the image.

**PgBouncer placement.** Fronting PostGIS with PgBouncer in transaction mode lets a 20-connection backend pool serve hundreds of concurrent async coroutines from the API container; the ratios and tuning are in [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

---

## FAQ

### Why do geospatial Python wheels break on Alpine-based images?

Alpine uses the musl C library rather than glibc, and the manylinux wheels published for `shapely`, `pyproj`, `rasterio`, and the GDAL bindings are compiled against glibc. On Alpine, pip cannot use those prebuilt wheels and falls back to compiling from source, which requires the full GDAL, GEOS, and PROJ development headers plus a C/C++ toolchain. The build is slow, fragile, and frequently mismatches the runtime library versions. Use `python:3.12-slim` (Debian glibc) so the manylinux wheels install directly.

### Should PostgreSQL and PostGIS run in the same container as FastAPI?

No. Keep the database and the application in separate containers with separate lifecycles. The database needs a persistent named volume, a controlled upgrade path, and a pinned `postgis/postgis` tag; the API is stateless and redeployed frequently. Co-locating them couples upgrade cadence, defeats horizontal scaling of the API tier, and puts your data volume at risk during routine app rollouts.

### How should a container healthcheck verify PostGIS rather than just PostgreSQL?

`pg_isready` only confirms the PostgreSQL process accepts connections; it does not confirm the PostGIS extension is installed and functional. Run `SELECT PostGIS_Version()` in the healthcheck so an image missing the extension, or a database where `CREATE EXTENSION postgis` never ran, is reported unhealthy instead of silently accepting traffic that will fail on the first `ST_` call.

---

## Related

- [Multi-Stage Docker Builds for PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/multi-stage-docker-builds-for-postgis-fastapi/) — a builder stage that compiles the geospatial wheels and a slim final stage that ships only the venv and runtime libraries
- [Pinning PostGIS Versions in Production Images](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/) — pin by tag and digest, keep client GDAL aligned, and follow the safe `ALTER EXTENSION postgis UPDATE` upgrade path
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — transaction pooling for the async FastAPI workload behind PostGIS
- [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/) — the full delivery guide this container image sits at the base of, covering CI, migrations, and edge tile delivery

← Back to [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/)
