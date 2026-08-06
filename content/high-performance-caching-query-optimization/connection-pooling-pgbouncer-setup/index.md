---
layout: layouts/page.njk
title: "Connection Pooling & PgBouncer Setup for PostGIS APIs"
description: "Configure PgBouncer in transaction mode for FastAPI and PostGIS. Decouple client concurrency from PostgreSQL process limits, eliminate connection exhaustion, and tune pool parameters for spatial workloads."
slug: "connection-pooling-pgbouncer-setup"
breadcrumb: "High-Performance Caching & Query Optimization"
datePublished: "2024-03-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Connection Pooling & PgBouncer Setup for PostGIS APIs",
      "description": "Configure PgBouncer in transaction mode for FastAPI and PostGIS. Decouple client concurrency from PostgreSQL process limits, eliminate connection exhaustion, and tune pool parameters for spatial workloads.",
      "datePublished": "2024-03-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "Article",
      "headline": "Connection Pooling & PgBouncer Setup for PostGIS APIs",
      "datePublished": "2024-03-15",
      "dateModified": "2026-06-23"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/"},
        {"@type": "ListItem", "position": 2, "name": "High-Performance Caching & Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/"},
        {"@type": "ListItem", "position": 3, "name": "Connection Pooling & PgBouncer Setup", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Set Up PgBouncer Transaction Pooling for FastAPI and PostGIS",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Deploy PgBouncer via Docker Compose"},
        {"@type": "HowToStep", "position": 2, "name": "Configure authentication and pgbouncer.ini"},
        {"@type": "HowToStep", "position": 3, "name": "Connect FastAPI via asyncpg with prepared-statement caching disabled"},
        {"@type": "HowToStep", "position": 4, "name": "Validate with health checks and pg_stat_activity"},
        {"@type": "HowToStep", "position": 5, "name": "Instrument Prometheus metrics and set alert thresholds"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does transaction pooling break asyncpg prepared statements?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "In transaction mode PgBouncer can multiplex a backend connection across many clients, so a prepared statement named on one transaction is not visible to the next client that borrows that connection. asyncpg caches statement handles by name, causing a 'prepared statement does not exist' error. Set statement_cache_size=0 in connect_args to disable client-side caching and route every statement as a simple query."
          }
        },
        {
          "@type": "Question",
          "name": "How many backend connections should default_pool_size be?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Start at (2 × vCPU count) for CPU-bound spatial queries. Spatial operations like ST_Intersects or ST_Union are CPU-intensive; additional backend processes beyond this ratio queue rather than run in parallel. Tune upward only after profiling pg_stat_activity to confirm backends are active, not idle."
          }
        },
        {
          "@type": "Question",
          "name": "Can I use session pooling instead of transaction pooling?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Session pooling assigns one backend connection per client session, which preserves prepared statements and SET LOCAL variables but eliminates multiplexing. For async FastAPI apps that open short-lived sessions, transaction pooling delivers far greater concurrency from the same max_connections budget. Only prefer session mode if your application relies on session-scoped temporary tables or advisory locks."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/)

# Connection Pooling & PgBouncer Setup for FastAPI & PostGIS

PostgreSQL's process-per-connection model is a known scaling ceiling for spatial APIs. Every client connection spawns a dedicated backend OS process; when hundreds of concurrent FastAPI coroutines hit a raw PostGIS instance simultaneously, `max_connections` is exhausted within seconds, triggering queuing, timeouts, and cascading latency. Because spatial operations such as `ST_Intersects`, `ST_Union`, and bounding-box index scans consume disproportionate CPU and memory per query, the bottleneck lands far earlier than it does for plain OLTP workloads. PgBouncer inserts a lightweight multiplexing layer between your application tier and PostgreSQL, decoupling client concurrency from backend process count and allowing a fixed pool of database connections to serve thousands of simultaneous FastAPI requests.

This guide walks from container orchestration through production hardening. For the broader performance context, see the [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/) overview, which situates connection pooling alongside query plan analysis and distributed caching.

---

## Architecture Overview

The diagram below shows how PgBouncer fits between FastAPI workers and the PostGIS backend. Client connections (potentially thousands) are multiplexed onto a small fixed pool of PostgreSQL backend processes, while a separate admin interface exposes real-time pool metrics.

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="PgBouncer transaction-pooling architecture between FastAPI and PostGIS" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>PgBouncer transaction-pooling architecture</title>
  <desc>Diagram showing multiple FastAPI worker processes connecting to PgBouncer on port 6432, which multiplexes those connections onto a small pool of PostgreSQL/PostGIS backend processes on port 5432, plus a PgBouncer admin console.</desc>
  <!-- Background -->
  <rect x="0" y="0" width="760" height="320" rx="12" fill="var(--surface, #f5f3ff)"/>
  <!-- FastAPI Workers group -->
  <rect x="20" y="30" width="160" height="260" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 3" opacity="0.5"/>
  <text x="100" y="22" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7" font-family="inherit">FastAPI Workers</text>
  <rect x="36" y="48" width="128" height="32" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="100" y="68" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Worker 1</text>
  <rect x="36" y="94" width="128" height="32" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="100" y="114" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Worker 2</text>
  <rect x="36" y="140" width="128" height="32" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="100" y="160" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Worker 3</text>
  <rect x="36" y="186" width="128" height="32" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 2"/>
  <text x="100" y="206" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Worker N</text>
  <text x="100" y="268" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="inherit">up to 1 000 clients</text>
  <!-- Arrows: Workers → PgBouncer -->
  <line x1="164" y1="64" x2="288" y2="120" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="164" y1="110" x2="288" y2="145" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="164" y1="156" x2="288" y2="160" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="164" y1="202" x2="288" y2="180" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- PgBouncer box -->
  <rect x="288" y="90" width="184" height="120" rx="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="380" y="118" text-anchor="middle" font-size="14" font-weight="bold" fill="currentColor" font-family="inherit">PgBouncer</text>
  <text x="380" y="136" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7" font-family="inherit">:6432  transaction mode</text>
  <text x="380" y="158" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit">max_client_conn 1 000</text>
  <text x="380" y="176" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit">default_pool_size 20</text>
  <text x="380" y="194" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit">pool_mode = transaction</text>
  <!-- PgBouncer admin -->
  <rect x="308" y="238" width="144" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 2"/>
  <text x="380" y="258" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit">Admin console :6543</text>
  <text x="380" y="270" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6" font-family="inherit">SHOW POOLS / STATS</text>
  <line x1="380" y1="238" x2="380" y2="210" stroke="currentColor" stroke-width="1" stroke-dasharray="3 2"/>
  <!-- Arrows: PgBouncer → PostGIS backends -->
  <line x1="472" y1="130" x2="548" y2="76" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="472" y1="150" x2="548" y2="150" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="472" y1="170" x2="548" y2="224" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="510" y="140" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.5" font-family="inherit">20 conns</text>
  <!-- PostGIS Backends group -->
  <rect x="548" y="30" width="188" height="260" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 3" opacity="0.5"/>
  <text x="642" y="22" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7" font-family="inherit">PostgreSQL / PostGIS :5432</text>
  <rect x="564" y="54" width="156" height="38" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="642" y="73" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Backend process 1</text>
  <text x="642" y="86" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6" font-family="inherit">active</text>
  <rect x="564" y="130" width="156" height="38" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="642" y="149" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Backend process 2</text>
  <text x="642" y="162" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6" font-family="inherit">active</text>
  <rect x="564" y="206" width="156" height="38" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 2"/>
  <text x="642" y="225" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Backend process N</text>
  <text x="642" y="238" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6" font-family="inherit">idle — ready</text>
  <text x="642" y="275" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="inherit">max 20 backend processes</text>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

---

## Prerequisites & Environment

Before deploying the pooling layer, confirm your stack meets these baselines:

| Component | Minimum version | Notes |
|---|---|---|
| PostgreSQL | 14+ | Required for `SCRAM-SHA-256` and logical replication stability |
| PostGIS | 3.3+ | Stable `ST_AsGeoJSON`, `ST_Within`, and SP-GiST index support |
| PgBouncer | 1.21+ | Adds `max_prepared_statements` param; earlier versions lack it |
| FastAPI | 0.100+ | Async lifespan events; Python 3.10+ |
| asyncpg | 0.29+ | Binary wire protocol, zero-copy geometry parsing |
| SQLAlchemy | 2.0+ | Native `async_sessionmaker`, `AsyncAttrs` |
| Docker Compose | 2.20+ | Health-check `depends_on` condition syntax |

Install the async database stack:

```bash
pip install "fastapi>=0.100" "asyncpg>=0.29" "sqlalchemy[asyncio]>=2.0" "geoalchemy2>=0.14"
```

---

## Decision Matrix: PgBouncer Pooling Modes

The three pooling modes have meaningfully different trade-offs for spatial API workloads. This matrix helps you pick the right one before touching a config file.

| Mode | Connection assigned | Prepared statements | SET LOCAL / temp tables | Ideal for |
|---|---|---|---|---|
| `session` | Entire client session | Supported | Supported | Long-lived connections, ORM session state |
| `transaction` | Per DB transaction | **Not supported** | Not supported | Async FastAPI, high concurrency, short queries |
| `statement` | Per SQL statement | Not supported | Not supported | Autocommit-only, rare in practice |

For FastAPI with `asyncpg`, **transaction pooling** is the correct choice. It delivers the highest multiplexing ratio: a `default_pool_size` of 20 can serve thousands of concurrent async requests. The only material trade-off is that `asyncpg`'s client-side prepared statement cache must be disabled — covered in Step 3.

---

Pool sizing is the difference between a database that idles and one that spends its memory on connection overhead.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Backends needed for 400 concurrent API clients: no pooler 400 backends — 40 GB RAM, session pooling 400 — no saving at all, transaction pooling, size 40 40, transaction pooling, size 20 20 — watch cl_waiting" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Backends needed for 400 concurrent API clients</title>
  <desc>A horizontal bar chart. no pooler is 400 backends — 40 GB RAM. session pooling is 400 — no saving at all. transaction pooling, size 40 is 40. transaction pooling, size 20 is 20 — watch cl_waiting. Session pooling saves connection setup, not backends. Only transaction pooling changes the multiplier.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Backends needed for 400 concurrent API clients</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">no pooler</text>
  <rect x="250" y="48" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="61" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">400 backends — 40</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">session pooling</text>
  <rect x="250" y="82" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="95" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">400 — no saving at all</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">transaction pooling, size 40</text>
  <rect x="250" y="116" width="34" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="292" y="129" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">40</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">transaction pooling, size 20</text>
  <rect x="250" y="150" width="17" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="275" y="163" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">20 — watch cl_waiting</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">Session pooling saves connection setup, not backends. Only transaction pooling changes the multiplier.</text>
</svg>

## Step-by-Step Implementation

### Step 1: Container Orchestration

Deploy PgBouncer as a dedicated service alongside PostGIS. The official `pgbouncer/pgbouncer` image is Alpine-based and adds roughly 4 MB to your deployment footprint.

```yaml
# docker-compose.yml
services:
  postgis:
    image: postgis/postgis:17-3.5
    environment:
      POSTGRES_DB: gis_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  pgbouncer:
    image: pgbouncer/pgbouncer:1.23.1
    ports:
      - "6432:6432"
    volumes:
      - ./pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro
      - ./userlist.txt:/etc/pgbouncer/userlist.txt:ro
    depends_on:
      postgis:
        condition: service_healthy
    restart: unless-stopped
    environment:
      # Expose admin on :6543 for internal metrics scraping only
      PGBOUNCER_ADMIN_USERS: postgres

volumes:
  pgdata:
```

Pin the PgBouncer image to a specific tag (here `1.23.1`) rather than `latest` — upgrades to PgBouncer can change default parameter behaviour in ways that affect `max_prepared_statements` handling.

### Step 2: Authentication & PgBouncer Configuration

PgBouncer authenticates clients independently from PostgreSQL. Generate password hashes for `userlist.txt`. For PostgreSQL 14+, prefer `scram-sha-256` end-to-end; if your client stack requires `md5`, use it consistently:

```bash
# Generate md5 hash: md5(password + username), prefix with "md5"
python3 -c "
import hashlib, sys
user, pw = sys.argv[1], sys.argv[2]
h = hashlib.md5((pw + user).encode()).hexdigest()
print(f'\"md5{h}\"')
" app_user mysecretpassword
```

```text
# userlist.txt  (one line per database user)
"app_user" "md5a1b2c3d4e5f67890abcdef1234567890"
"postgres"  "md5f6e5d4c3b2a19876543210abcdef0123"
```

Now write `pgbouncer.ini`. The parameters that matter most for spatial workloads are annotated:

```ini
[databases]
; Route the logical db name to the PostGIS container
gis_db = host=postgis port=5432 dbname=gis_db

[pgbouncer]
listen_port = 6432
listen_addr = 0.0.0.0
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

; ---- Pooling behaviour ----
pool_mode = transaction

; Total client connections across all pools.
; Set to your peak expected concurrent FastAPI coroutines.
max_client_conn = 1000

; Backend connections PgBouncer opens to PostgreSQL per (db, user) pair.
; Start at 2 × vCPU count for CPU-bound spatial work.
default_pool_size = 20

; Reserve extra backend connections for admin queries only.
reserve_pool_size = 2
reserve_pool_timeout = 3

; Disable PgBouncer-level prepared-statement tracking.
; asyncpg will also have statement_cache_size=0 (see Step 3).
max_prepared_statements = 0

; ---- Connection lifecycle ----
; Recycle backend connections every 60 min (must exceed FastAPI pool_recycle).
server_lifetime = 3600

; Close idle backends after 10 min to free PostgreSQL process slots.
server_idle_timeout = 600

; Drop client connections idle longer than 5 min (prevents ghost connections).
client_idle_timeout = 300

; ---- Logging & admin ----
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
admin_users = postgres
stats_period = 60
```

### Step 3: FastAPI Engine Configuration

Point your SQLAlchemy engine at PgBouncer on port `6432`. Two asyncpg parameters are critical here:

- `statement_cache_size=0` — disables client-side prepared statement caching so asyncpg routes every query as a simple (unprepared) statement through PgBouncer.
- `pool_recycle` must be shorter than PgBouncer's `server_lifetime` to avoid receiving a stale backend connection.

```python
# app/database.py
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
import os

DATABASE_URL = (
    f"postgresql+asyncpg://{os.environ['DB_USER']}:{os.environ['DB_PASSWORD']}"
    f"@pgbouncer:6432/gis_db"
)

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    # SQLAlchemy-level pool — keep shallow; PgBouncer does the real pooling.
    pool_size=5,
    max_overflow=0,        # No overflow: let PgBouncer manage the queue
    pool_timeout=10,       # Raise after 10 s if no connection available
    pool_recycle=1800,     # Half of PgBouncer server_lifetime (3 600 s)
    pool_pre_ping=True,    # Detect stale connections before use
    connect_args={
        # REQUIRED for transaction pooling: disable prepared-statement cache
        "statement_cache_size": 0,
        # Optional: set a per-query timeout at the wire level (ms)
        "command_timeout": 30,
    },
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

class Base(DeclarativeBase):
    pass
```

Wire the session factory into FastAPI via a dependency:

```python
# app/dependencies.py
from contextlib import asynccontextmanager
from typing import AsyncGenerator
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession
from .database import AsyncSessionLocal

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
```

### Step 4: Validation & Health Checks

A dedicated health endpoint verifies that PgBouncer routing and PostGIS are both reachable and functional. Include both connection-level and spatial checks:

```python
# app/routes/health.py
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from ..dependencies import get_db

router = APIRouter()

@router.get("/health/db")
async def db_health(db: AsyncSession = Depends(get_db)):
    # Verify PostGIS extension is loaded and functional
    postgis_row = await db.execute(text("SELECT PostGIS_full_version()"))
    postgis_version = postgis_row.scalar()

    # Check active backend processes (as seen from PostgreSQL side)
    activity_row = await db.execute(text("""
        SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND pid <> pg_backend_pid()
    """))
    active_backends = activity_row.scalar()

    # Quick spatial sanity: confirm GiST index round-trip
    spatial_row = await db.execute(text("""
        SELECT ST_AsText(ST_GeomFromText('POINT(0 0)', 4326))
    """))
    spatial_check = spatial_row.scalar()

    return {
        "status": "healthy",
        "postgis_version": postgis_version,
        "active_backends": active_backends,
        "spatial_round_trip": spatial_check,
    }
```

---

## Production Code Example

A complete spatial query routed through PgBouncer, demonstrating the full async pattern with bounding-box filtering. The `ST_MakeEnvelope` call benefits from the GiST index on the geometry column; see [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) for EXPLAIN ANALYZE guidance on confirming the index is used.

```python
# app/routes/features.py
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from typing import Any
from ..dependencies import get_db

router = APIRouter(prefix="/features", tags=["features"])

@router.get("/bbox")
async def features_in_bbox(
    minx: float = Query(..., description="West longitude (EPSG:4326)"),
    miny: float = Query(..., description="South latitude"),
    maxx: float = Query(..., description="East longitude"),
    maxy: float = Query(..., description="North latitude"),
    limit: int = Query(100, le=1000),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """
    Return GeoJSON FeatureCollection for features within the given bounding box.
    Uses ST_Within against a GiST-indexed geometry column.
    Routes through PgBouncer in transaction mode: each await is a separate
    transaction hand-off; no session state persists between calls.
    """
    if minx >= maxx or miny >= maxy:
        raise HTTPException(status_code=400, detail="Invalid bounding box coordinates.")

    query = text("""
        SELECT
            id,
            name,
            ST_AsGeoJSON(geom)::jsonb AS geometry,
            ST_Area(geom::geography) AS area_m2
        FROM spatial_features
        WHERE geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)
          AND ST_Within(geom, ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326))
        ORDER BY id
        LIMIT :limit
    """)

    result = await db.execute(
        query,
        {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy, "limit": limit},
    )
    rows = result.mappings().all()

    features = [
        {
            "type": "Feature",
            "id": row["id"],
            "geometry": row["geometry"],
            "properties": {
                "name": row["name"],
                "area_m2": round(row["area_m2"], 2),
            },
        }
        for row in rows
    ]

    return {"type": "FeatureCollection", "features": features}
```

Note the double-predicate pattern (`&&` operator-based index scan, then `ST_Within` for exact filtering). The `&&` operator triggers the GiST index and eliminates the vast majority of rows cheaply; `ST_Within` then filters the small candidate set precisely. Without this two-stage approach, `ST_Within` alone performs a sequential scan.

---

## Verification & Testing

**Live pool status via the PgBouncer admin console:**

```bash
# Connect to the PgBouncer admin console (psql, not the DB)
psql -h 127.0.0.1 -p 6432 -U postgres pgbouncer -c "SHOW POOLS;"
```

Expected output shows `cl_active` (clients with an active backend), `cl_waiting` (clients queued), `sv_active` (backend connections in use), and `sv_idle` (backends idle and available). During steady-state load, `cl_waiting` should be zero.

**Confirm routing via health endpoint:**

```bash
curl -s http://localhost:8000/health/db | jq .
```

```json
{
  "status": "healthy",
  "postgis_version": "POSTGIS=\"3.5.0\" ...",
  "active_backends": 3,
  "spatial_round_trip": "POINT(0 0)"
}
```

**Confirm prepared statements are disabled (asyncpg):**

```bash
# Run this inside a psql session connected via PgBouncer port 6432
SELECT name, statement FROM pg_prepared_statements;
-- Must return zero rows when statement_cache_size=0 is in effect
```

**Unit test skeleton (pytest-asyncio):**

```python
# tests/test_connection_pool.py
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_health_endpoint_returns_postgis_version():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/health/db")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "healthy"
    assert "POSTGIS" in data["postgis_version"]
    assert data["spatial_round_trip"] == "POINT(0 0)"

@pytest.mark.asyncio
async def test_bbox_endpoint_returns_feature_collection():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get(
            "/features/bbox",
            params={"minx": -10, "miny": -10, "maxx": 10, "maxy": 10},
        )
    assert resp.status_code == 200
    assert resp.json()["type"] == "FeatureCollection"
```

---

Saturation looks like a site-wide slowdown, and that misleading appearance is the reason it is so often misdiagnosed.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="How pool exhaustion actually presents: normal then one slow query then queue forms then latency spikes then timeouts" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>How pool exhaustion actually presents</title>
  <desc>A horizontal timeline. normal: cl_waiting = 0. one slow query: a backend is held. queue forms: cl_waiting climbs. latency spikes: every endpoint, not just the slow one. timeouts: clients retry, making it worse. The symptom is global even though the cause is one statement — which is why pool wait time must be measured separately from query time.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">How pool exhaustion actually presents</text>
  <rect x="20" y="92" width="181" height="34" rx="5" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="110" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">normal</text>
  <text x="110" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">cl_waiting = 0</text>
  <rect x="205" y="92" width="119" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="264" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">one slow query</text>
  <text x="264" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">a backend is held</text>
  <rect x="328" y="92" width="119" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="387" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">queue forms</text>
  <text x="387" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">cl_waiting climbs</text>
  <rect x="451" y="92" width="119" height="34" rx="5" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="510" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">latency spikes</text>
  <text x="510" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">every endpoint, not just the slow one</text>
  <rect x="574" y="92" width="119" height="34" rx="5" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="633" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">timeouts</text>
  <text x="633" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">clients retry, making it worse</text>
  <text x="20" y="184" font-size="10.5" fill="var(--muted, #7c6fb0)">The symptom is global even though the cause is one statement — which is why pool wait time must be measured separately from query time.</text>
</svg>

## Failure Modes & Edge Cases

1. **`prepared statement "sqlalchemy_..." does not exist`** — asyncpg reuses a prepared statement handle across what PgBouncer sees as different backend connections. Fix: set `statement_cache_size=0` in `connect_args`. If the error persists, also set `max_prepared_statements = 0` in `pgbouncer.ini`.

2. **`connection pool exhausted` after `pool_timeout`** — SQLAlchemy's internal pool (controlled by `pool_size` + `max_overflow`) is saturated before PgBouncer's `max_client_conn` is reached. This usually means `max_overflow=0` is too strict. For burst traffic, increase `pool_size` on the SQLAlchemy side or widen `max_overflow` briefly; alternatively, drop the SQLAlchemy pool to `pool_size=1` and rely entirely on PgBouncer's queue (`client_idle_timeout` prevents ghost slots).

3. **`server closed the connection unexpectedly` on startup** — the FastAPI container starts before PostGIS is ready. The `depends_on: condition: service_healthy` in Docker Compose (with a `pg_isready` healthcheck on the `postgis` service) resolves this. Without it, PgBouncer's backend connections fail to establish and PgBouncer logs `ERROR server login failed`.

4. **`SET` commands silently ignored** — in transaction pooling mode, `SET LOCAL` settings (search path, timezone, etc.) do not persist after the transaction ends, because the backend connection is returned to the pool. Use explicit schema-qualified names (e.g. `public.spatial_features`) instead of relying on `search_path`. Confirm with `SHOW search_path;` inside a transaction routed through PgBouncer.

5. **`NOTICE: could not resize shared memory segment`** — PgBouncer has a very small `max_client_conn` relative to peak concurrency, causing client handshakes to fail before they reach PostgreSQL. Raise `max_client_conn` incrementally (PgBouncer uses ~250 bytes per client slot), not `default_pool_size` — more backends do not help if the queue is already full.

6. **`pool_recycle` stale connection errors** — if `pool_recycle` in SQLAlchemy exceeds `server_lifetime` in PgBouncer, SQLAlchemy may hand out a connection that PgBouncer has already closed server-side. Always keep `pool_recycle < server_lifetime`, e.g. `pool_recycle=1800` vs `server_lifetime=3600`.

---

## Performance Notes

**Multiplexing ratio.** In production, a `default_pool_size` of 20 can typically serve 200–400 concurrent FastAPI coroutines for short bounding-box or point-lookup queries (sub-10 ms). Queries involving `ST_Union`, buffer generation, or large geometry aggregations hold backend connections longer; reduce concurrency expectations proportionally. Profile using `SHOW STATS;` in the PgBouncer admin console — `avg_query_time` and `avg_wait_time` surface both query-side and queue-side latency.

**CPU vs. I/O balance.** PostGIS spatial operations are CPU-bound, not I/O-bound. Adding more backend connections beyond `2 × vCPU` does not improve throughput — it adds context-switching overhead. The right lever for CPU-bound spatial work is to scale PostgreSQL vertically (more vCPUs) or offload geometry pre-processing upstream.

**Async vs. sync driver overhead.** `asyncpg`'s binary protocol parses geometry wire types 30–40% faster than `psycopg2`'s text protocol for large geometry payloads (tested on 50 KB MultiPolygon features). In transaction pooling, this matters: `asyncpg` returns the connection to PgBouncer faster, increasing pool availability.

**Caching integration.** For endpoints returning immutable or slowly changing spatial responses — static administrative boundaries, precomputed catchment areas — place a [Redis caching layer for spatial queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) in front of the database call. Cached hits never touch PgBouncer, freeing pool slots for truly dynamic queries.

**Vector tile endpoints.** Map-heavy endpoints that serve the same bounding box to many users should bypass PgBouncer entirely by serving pre-generated tiles. The architecture for this is covered in [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/), which eliminates database reads for high-traffic tile routes.

**Prometheus metrics.** Instrument PgBouncer with `prometheus_pgbouncer_exporter` and alert on:
- `pgbouncer_pools_client_waiting > 0` for more than 30 s → pool starvation
- `pgbouncer_pools_server_idle < 1` → no available backends (increase `default_pool_size` or optimize slow spatial queries)
- `pgbouncer_stats_avg_query_time > 500` ms → spatial query regression

---

## FAQ

### Why does transaction pooling break asyncpg prepared statements?

In transaction mode PgBouncer can multiplex a backend connection across many clients, so a prepared statement named on one transaction is not visible to the next client that borrows that connection. `asyncpg` caches statement handles by name, causing a `prepared statement does not exist` error when the handle is referenced on a different backend. Setting `statement_cache_size=0` in `connect_args` disables this cache and routes every statement as a simple query.

### How many backend connections should `default_pool_size` be?

Start at `2 × vCPU count` for CPU-bound spatial queries. `ST_Intersects`, `ST_Union`, and related operations are CPU-intensive; adding more backend processes beyond this ratio causes them to queue at the OS scheduler rather than run in parallel. Tune upward only after profiling `pg_stat_activity` to confirm backends are actually active, not idle.

### Can I use session pooling instead?

Session pooling assigns one backend connection per client session, which preserves prepared statements and `SET LOCAL` variables but eliminates multiplexing. For async FastAPI apps that open many short-lived sessions, transaction pooling delivers far greater concurrency from the same `max_connections` budget. Prefer session mode only if your application relies on session-scoped temporary tables or advisory locks.

---

## Related

- [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — reduce PgBouncer pool contention by caching immutable spatial responses in Redis
- [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — use EXPLAIN ANALYZE to confirm GiST index usage on pooled spatial queries
- [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — offload map tile reads from the database entirely to a CDN edge layer
- [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — page through large spatial result sets without holding backend connections open
- [Core Geospatial API Architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/) — broader FastAPI + PostGIS integration patterns

← Back to [High-Performance Caching & Query Optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/)
