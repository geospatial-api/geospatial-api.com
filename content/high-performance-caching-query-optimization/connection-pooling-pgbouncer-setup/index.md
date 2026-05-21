---
layout: layouts/page.njk
title: "Connection Pooling & PgBouncer Setup for FastAPI & PostGIS"
description: "Configure PgBouncer in transaction mode for FastAPI and PostGIS. Decouple client concurrency from PostgreSQL process limits and prevent connection pool exhaustion."
---

# Connection Pooling & PgBouncer Setup for FastAPI & PostGIS

PostgreSQL’s connection architecture is fundamentally process-based. Every client connection spawns a dedicated backend process, which guarantees strong isolation but creates immediate resource contention under high concurrency. When serving geospatial APIs, this bottleneck compounds rapidly. Spatial operations like `ST_Intersects`, `ST_Union`, or bounding-box filtering on large PostGIS tables consume disproportionate CPU and memory. If hundreds of concurrent FastAPI requests hit a raw PostGIS instance, the database quickly exhausts its `max_connections` limit, triggering connection queuing, request timeouts, and severe API latency degradation.

Implementing a lightweight connection multiplexer is a foundational requirement for any production-grade spatial platform. A properly configured **Connection Pooling & PgBouncer Setup** decouples client concurrency from database process limits, allowing your FastAPI application to scale horizontally without overwhelming the underlying PostGIS engine. As a core component of [High-Performance Caching & Query Optimization](/high-performance-caching-query-optimization/), strategic connection pooling ensures predictable throughput while preserving database stability.

## Prerequisites

Before deploying a production-ready pooling layer, verify your stack meets these baseline requirements:

- **PostgreSQL 14+ with PostGIS 3.3+**: Spatial function stability and GiST/SP-GiST index support must be mature.
- **FastAPI 0.100+**: Running on Python 3.10+ with native `async`/`await` routing.
- **Async Database Driver**: `asyncpg` is strongly recommended over `psycopg` for PostGIS due to its native binary protocol, zero-copy parsing, and superior prepared statement handling.
- **Docker & Docker Compose**: Required for reproducible PgBouncer orchestration and network isolation.
- **System Resources**: Minimum 2 vCPU / 4GB RAM for baseline testing. Scale vertically based on concurrent spatial query complexity and geometry payload size.

## Architecture & Pooling Strategy

PgBouncer operates in three distinct modes: `session`, `transaction`, and `statement`. For modern async frameworks, **transaction pooling** is the industry standard. It assigns a backend connection only for the duration of a single database transaction, releasing it back to the pool immediately after `COMMIT` or `ROLLBACK`. This allows thousands of FastAPI coroutines to share a small, fixed set of PostgreSQL backend processes.

A critical architectural constraint to note: transaction pooling disables server-side prepared statements by default. Since `asyncpg` relies heavily on prepared statements for query plan caching, you must configure PgBouncer to use `pool_mode = transaction` alongside `max_prepared_statements = 0` in your `pgbouncer.ini`, or explicitly disable prepared statements in your SQLAlchemy engine. For deeper parameter calibration, consult Tuning PgBouncer for high-concurrency PostGIS.

## Step-by-Step Deployment Workflow

### Step 1: Container Orchestration

Deploy PgBouncer as a lightweight sidecar or standalone service. The official `pgbouncer/pgbouncer` image is Alpine-based, minimal, and optimized for low memory overhead.

```yaml
services:
  postgis:
    image: postgis/postgis:15-3.3
    environment:
      POSTGRES_DB: gis_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: secure_root_password
    volumes:
      - pgdata:/var/lib/postgresql/data

  pgbouncer:
    image: pgbouncer/pgbouncer:latest
    ports:
      - "6432:6432"
    volumes:
      - ./pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini
      - ./userlist.txt:/etc/pgbouncer/userlist.txt
    depends_on:
      - postgis
    restart: unless-stopped

volumes:
  pgdata:
```

### Step 2: Authentication & Security

PgBouncer requires a plaintext `userlist.txt` for initial authentication. While `md5` is supported, modern deployments should use `scram-sha-256` if your PostgreSQL version supports it. Generate the hash securely:

```bash
# Generate MD5 hash (legacy)
echo -n "passwordapp_user" | md5sum | awk '{print "md5"$1}'
```

Format your `userlist.txt`:
```text
"app_user" "md5a1b2c3d4e5f6..."
"postgres" "md5f6e5d4c3b2a1..."
```

In `pgbouncer.ini`, enforce strict routing and timeouts:
```ini
[databases]
gis_db = host=postgis port=5432 dbname=gis_db

[pgbouncer]
listen_port = 6432
listen_addr = 0.0.0.0
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 20
server_lifetime = 3600
server_idle_timeout = 600
admin_users = postgres
```

### Step 3: FastAPI Engine Configuration

Update your FastAPI database connection string to route through PgBouncer on port `6432`. When using SQLAlchemy's async extension, align the application pool size with PgBouncer's `default_pool_size` to prevent connection starvation.

```python
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = "postgresql+asyncpg://app_user:password@pgbouncer:6432/gis_db"

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_size=20,          # Must match PgBouncer default_pool_size
    max_overflow=0,        # Disable overflow in transaction mode
    pool_timeout=10,
    pool_recycle=1800,     # Recycle connections before PgBouncer server_lifetime
    pool_pre_ping=True
)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)
```

For comprehensive guidance on handling connection lifecycle in async environments, review Optimizing connection pool recycling for long-running queries. Note that `pool_recycle` should always be lower than PgBouncer's `server_lifetime` to prevent stale backend handoffs.

### Step 4: Validation & Observability

Deploy a lightweight health check endpoint to verify routing and spatial readiness. Query `pg_stat_activity` to confirm connections originate from the PgBouncer process rather than direct FastAPI clients.

```python
from fastapi import FastAPI, Depends
from sqlalchemy import text

app = FastAPI()

@app.get("/health/db")
async def db_health():
    async with engine.begin() as conn:
        # Verify PostGIS extension
        postgis_ver = await conn.execute(text("SELECT PostGIS_Version()"))
        pg_ver = postgis_ver.scalar()
        
        # Verify routing: should show 'pgbouncer' in application_name
        activity = await conn.execute(text("""
            SELECT count(*) FROM pg_stat_activity 
            WHERE application_name = 'pgbouncer' AND state = 'active'
        """))
        active_pools = activity.scalar()
        
    return {
        "postgis_version": pg_ver,
        "pgbouncer_active_connections": active_pools,
        "status": "healthy"
    }
```

Monitor `pg_stat_activity` continuously. In transaction pooling, you will see `pgbouncer` as the `application_name` for pooled connections, while idle backend processes remain available for rapid handoff.

## Production Hardening & Scaling

Connection pooling solves the immediate bottleneck, but spatial APIs require holistic resource management. FastAPI's async event loop excels at I/O multiplexing, but CPU-bound spatial operations can block the loop if not properly isolated. Align your deployment with Configuring Uvicorn workers for CPU-bound spatial tasks to prevent event-loop starvation during heavy geometry processing.

To further reduce database load, implement application-level caching for immutable spatial responses. Frequently requested bounding boxes, static feature collections, or precomputed distance matrices are ideal candidates for in-memory caching. Integrating a distributed cache layer, as outlined in [Redis Caching for Spatial Queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/), dramatically reduces PgBouncer pool contention during traffic spikes.

For map-heavy endpoints, shift computation away from the database entirely. Instead of returning raw GeoJSON for every viewport request, pre-render vector tiles or raster layers at the infrastructure level. This architectural shift, detailed in [Tile Generation & CDN Distribution](/high-performance-caching-query-optimization/tile-generation-cdn-distribution/), allows PgBouncer to focus exclusively on transactional and analytical queries while static assets are served from edge networks.

Finally, instrument your pool with Prometheus-compatible exporters. Track `pgbouncer_pools_client_active`, `pgbouncer_pools_server_idle`, and `pgbouncer_pools_client_waiting`. A rising `client_waiting` metric indicates pool exhaustion, signaling either a need to increase `default_pool_size`, optimize slow spatial queries, or implement query-level timeouts. Refer to the official [PgBouncer configuration documentation](https://www.pgbouncer.org/config.html) for metric definitions and threshold tuning.

## Conclusion

A robust Connection Pooling & PgBouncer Setup transforms a fragile, process-limited PostGIS instance into a highly concurrent spatial API foundation. By enforcing transaction pooling, aligning SQLAlchemy engine parameters, and implementing strict lifecycle recycling, you eliminate connection exhaustion while preserving query performance. Pair this architecture with strategic caching, worker-level CPU isolation, and edge distribution to deliver sub-100ms geospatial responses at scale.