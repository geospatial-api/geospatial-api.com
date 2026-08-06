---
layout: layouts/page.njk
title: "Health Checks and Readiness Probes for PostGIS APIs"
description: "A liveness probe that queries PostGIS restarts your API during a database blip. Separate liveness from readiness, check what each one is actually for, and keep the spatial extension check off the hot path."
slug: health-checks-and-readiness-probes-for-postgis-apis
type: howto
breadcrumb:
  - label: "Deploying and Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Containerizing PostGIS & FastAPI"
    url: "/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/"
  - label: "Health Checks and Readiness Probes for PostGIS APIs"
    url: "/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/health-checks-and-readiness-probes-for-postgis-apis/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Health Checks and Readiness Probes for PostGIS APIs",
      "description": "Separate liveness from readiness so a database blip does not restart the API, and keep the PostGIS extension check off the hot path.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/health-checks-and-readiness-probes-for-postgis-apis/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Deploying and Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/" },
        { "@type": "ListItem", "position": 2, "name": "Containerizing PostGIS & FastAPI", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/" },
        { "@type": "ListItem", "position": 3, "name": "Health Checks and Readiness Probes for PostGIS APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/health-checks-and-readiness-probes-for-postgis-apis/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Configure Liveness and Readiness for a Spatial API",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Make liveness local", "text": "Liveness must test only the process itself, with no database call, so an external blip cannot cause a restart." },
        { "@type": "HowToStep", "position": 2, "name": "Make readiness dependency-aware", "text": "Readiness checks the pool and a trivial PostGIS query, so an unhealthy replica is removed from the load balancer instead of restarted." },
        { "@type": "HowToStep", "position": 3, "name": "Verify the extension at startup", "text": "Check PostGIS availability and the PROJ data once at startup, not on every probe." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why should liveness not touch the database?",
          "acceptedAnswer": { "@type": "Answer", "text": "Because the remedy for a failed liveness probe is to kill the container, and restarting an application never fixes a database. During a brief database outage a database-backed liveness probe restarts every replica simultaneously, which discards warm pools and connection state and turns a thirty-second blip into a multi-minute recovery." }
        },
        {
          "@type": "Question",
          "name": "What belongs in a readiness check?",
          "acceptedAnswer": { "@type": "Answer", "text": "Whatever must be true for this instance to serve a real request: a connection available from the pool, a trivial query returning, and any cache client it cannot function without. Keep it under about fifty milliseconds and never let it run an expensive spatial query, because the probe runs every few seconds on every replica." }
        },
        {
          "@type": "Question",
          "name": "Should the probe check that PostGIS is installed?",
          "acceptedAnswer": { "@type": "Answer", "text": "At startup, yes — that is exactly when a missing extension or absent grid-shift files should stop the deployment. On every probe, no. The extension is not going to uninstall itself between two probes, and the check costs a round trip that adds nothing." }
        }
      ]
    }
  ]
}
</script>

← Back to [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/)

# Health checks and readiness probes for PostGIS APIs

This page covers the difference between liveness and readiness for a spatial API, and why conflating them turns a short database hiccup into a full outage.

## Context & When to Use

Kubernetes asks two different questions and takes two very different actions. Liveness asks "is this process broken beyond recovery?" and the answer being no results in the container being killed. Readiness asks "can this instance serve traffic right now?" and the answer being no results in it being taken out of the load balancer, still running, still able to come back.

Wiring both to the same handler — one that opens a connection and runs a query — collapses the distinction. When the database becomes briefly unreachable, every replica fails liveness at the same moment and the orchestrator restarts all of them. They come back with empty connection pools, cold PROJ pipeline caches and no warm statement plans, into a database that has just recovered and is now handling a thundering herd. A thirty-second blip becomes several minutes of degraded service, caused entirely by the health check.

The correct split is simple: liveness tests only what a restart could fix, readiness tests everything needed to serve. For a PostGIS API that also means being careful about *what* the readiness check asks the database, because it runs on every replica every few seconds — the same cost discipline as anything else on the hot path described in [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/).

## Runnable Implementation

```python
import asyncio
import time
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, Response, status

router = APIRouter(tags=["ops"])

STARTUP_CHECKS: dict[str, Any] = {}      # filled once, at startup


@router.get("/healthz", include_in_schema=False)
async def liveness() -> dict[str, str]:
    """Liveness: is THIS PROCESS alive? No I/O, no dependencies, no database."""
    return {"status": "ok"}


@router.get("/readyz", include_in_schema=False)
async def readiness(
    response: Response,
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Readiness: can this instance serve a request right now?"""
    checks: dict[str, Any] = {}
    healthy = True

    started = time.perf_counter()
    try:
        # A trivial query, with a hard timeout: the probe must never hang
        async with asyncio.timeout(2):
            async with pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
        checks["database"] = {"ok": True,
                              "ms": round((time.perf_counter() - started) * 1000, 1)}
    except (asyncio.TimeoutError, asyncpg.PostgresError, OSError) as exc:
        checks["database"] = {"ok": False, "error": exc.__class__.__name__}
        healthy = False

    # Pool saturation is a readiness concern: a full pool cannot serve
    checks["pool"] = {"size": pool.get_size(), "idle": pool.get_idle_size()}
    if pool.get_idle_size() == 0 and pool.get_size() >= pool.get_max_size():
        checks["pool"]["ok"] = False
        healthy = False

    # Startup facts, reported but not re-tested
    checks["postgis"] = STARTUP_CHECKS.get("postgis", {"ok": False})

    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ready" if healthy else "not_ready", "checks": checks}


async def verify_at_startup(pool: asyncpg.Pool) -> None:
    """Run the expensive, one-off checks once — and fail the deploy if they fail."""
    async with pool.acquire() as conn:
        version = await conn.fetchval("SELECT postgis_full_version()")
        # A round trip through PROJ proves the grid-shift data is present
        drift_m = await conn.fetchval(
            """
            SELECT ST_Distance(
                     ST_SetSRID(ST_MakePoint(-0.1276, 51.5072), 4326)::geography,
                     ST_Transform(ST_Transform(
                       ST_SetSRID(ST_MakePoint(-0.1276, 51.5072), 4326), 27700),
                       4326)::geography)
            """
        )
    if drift_m is None or drift_m > 0.001:
        raise RuntimeError(f"PROJ grid-shift data missing: round-trip drift {drift_m} m")
    STARTUP_CHECKS["postgis"] = {"ok": True, "version": version,
                                 "proj_round_trip_m": round(drift_m, 6)}
```

The startup check is where the strict assertions belong. A container built without `proj-data` transforms national grids at metre rather than centimetre accuracy — the failure described in [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/) — and it should stop the rollout, not degrade quietly in production.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of what happens during a database blip with a database-backed liveness probe versus a local one" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>A 30-second database blip, two probe designs</title>
  <desc>Two timelines through the same 30-second database outage. With liveness wired to the database, all six replicas fail liveness, are killed and restart, then reconnect with cold pools into a recovering database; full service resumes after four minutes twenty. With local liveness and database-backed readiness, the replicas stay running, are removed from the load balancer for the duration and rejoin with warm pools as soon as the database returns; full service resumes eighteen seconds after the database recovers.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Same 30-second database blip, two outcomes</text>
  <text x="20" y="56" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">liveness queries the database</text>
  <rect x="60" y="64" width="90" height="20" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.5"/>
  <text x="105" y="78" text-anchor="middle" font-size="9" fill="currentColor">healthy</text>
  <rect x="150" y="64" width="60" height="20" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <rect x="210" y="64" width="120" height="20" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.85"/>
  <text x="210" y="100" font-size="9" font-weight="700" fill="var(--viz-bad, #a32b23)">all replicas killed</text>
  <rect x="330" y="64" width="200" height="20" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="430" y="100" text-anchor="middle" font-size="9" fill="var(--viz-warn, #8a5000)">cold restart · empty pools · herd</text>
  <rect x="530" y="64" width="160" height="20" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.5"/>
  <text x="610" y="78" text-anchor="middle" font-size="9" fill="currentColor">healthy again</text>
  <text x="60" y="102" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">total degraded time: 4 min 20 s</text>
  <line x1="20" y1="118" x2="700" y2="118" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="146" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">liveness local, readiness queries the database</text>
  <rect x="60" y="154" width="90" height="20" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.5"/>
  <text x="105" y="168" text-anchor="middle" font-size="9" fill="currentColor">healthy</text>
  <rect x="150" y="154" width="60" height="20" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <rect x="210" y="154" width="70" height="20" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.45"/>
  <text x="245" y="168" text-anchor="middle" font-size="9" fill="currentColor">out of LB</text>
  <rect x="280" y="154" width="410" height="20" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.5"/>
  <text x="485" y="168" text-anchor="middle" font-size="9" fill="currentColor">rejoins with warm pools — no restart ever happened</text>
  <text x="60" y="192" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">total degraded time: 48 s</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">Restarting an application cannot fix a database. Wiring liveness to one only guarantees that a dependency</text>
  <text x="20" y="238" font-size="10.5" fill="var(--muted, #7c6fb0)">failure becomes an application failure too.</text>
</svg>

## Key Parameters & Options

| Probe | Endpoint | Checks | Failure action |
|---|---|---|---|
| liveness | `/healthz` | process responds | container killed |
| readiness | `/readyz` | pool + `SELECT 1` + cache client | removed from load balancer |
| startup | `verify_at_startup` | PostGIS version, PROJ round trip | deployment fails |
| `timeoutSeconds` | 3 | must exceed the internal 2 s timeout | — |
| `periodSeconds` | 10 readiness, 30 liveness | probe cost × replicas × frequency | — |
| `failureThreshold` | 3 readiness, 5 liveness | tolerate a transient blip | — |

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 8000 }
  periodSeconds: 30
  failureThreshold: 5          # generous: only a truly wedged process should die
readinessProbe:
  httpGet: { path: /readyz, port: 8000 }
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3          # tight: stop sending traffic quickly
startupProbe:
  httpGet: { path: /readyz, port: 8000 }
  failureThreshold: 30         # allow 5 minutes for migrations on first boot
  periodSeconds: 10
```

## What the probe costs at scale

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of database queries per minute generated by readiness probes at three probe designs and replica counts" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Probe traffic against the database</title>
  <desc>Three probe designs at 24 replicas probing every ten seconds. A trivial SELECT 1 generates 144 queries per minute costing under one millisecond each, which is negligible. Adding a PostGIS version check doubles it to 288 queries. A probe that runs a representative spatial query generates 144 queries at 23 milliseconds each, consuming about 3.3 seconds of database time every minute purely on health checks — more than some real endpoints.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">24 replicas, probing every 10 s — what the database sees</text>
  <text x="20" y="62" font-size="10.5" font-family="monospace" fill="currentColor">SELECT 1</text>
  <rect x="230" y="48" width="60" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="300" y="62" font-size="10" fill="currentColor">144 queries/min · &lt;0.1 s total DB time</text>
  <text x="20" y="102" font-size="10.5" font-family="monospace" fill="currentColor">SELECT 1 + postgis_version()</text>
  <rect x="230" y="88" width="120" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="360" y="102" font-size="10" fill="currentColor">288 queries/min · pointless, but harmless</text>
  <text x="20" y="142" font-size="10.5" font-family="monospace" fill="currentColor">representative spatial query</text>
  <rect x="230" y="128" width="420" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <text x="230" y="164" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">144 queries/min × 23 ms = 3.3 s of database time per minute, forever</text>
  <line x1="20" y1="180" x2="700" y2="180" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="202" font-size="10.5" fill="var(--muted, #7c6fb0)">A "realistic" probe query sounds thorough and quietly becomes one of the busiest statements in the database.</text>
  <text x="20" y="218" font-size="10.5" fill="var(--muted, #7c6fb0)">Prove the spatial stack once at startup; prove reachability cheaply thereafter.</text>
</svg>

## Which dependency belongs in readiness

The last judgement call is which dependencies get a vote. The test is whether the instance can serve a *useful* response without the dependency — not whether everything is nominal.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Table of dependencies and whether each should make an instance unready" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Should this dependency affect readiness?</title>
  <desc>Five dependencies assessed. The primary database gets a vote because no endpoint works without it. The connection pool gets a vote because a saturated pool cannot serve. The Redis cache does not, because the API degrades to origin queries and still answers. The tile CDN does not, because it sits in front of the API rather than behind it. The authentication JWKS endpoint gets a partial vote: a cached key set means brief unavailability is survivable, so it should only affect readiness once the cache has expired.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Readiness means "can serve", not "all is well"</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="34" y="58" font-size="10.5" font-weight="700" fill="currentColor">Dependency</text>
  <text x="330" y="58" font-size="10.5" font-weight="700" fill="currentColor">Vote?</text>
  <text x="430" y="58" font-size="10.5" font-weight="700" fill="currentColor">Reason</text>
  <text x="34" y="86" font-size="10.5" fill="currentColor">primary database</text>
  <text x="346" y="86" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="430" y="86" font-size="9.5" fill="var(--muted, #7c6fb0)">no endpoint works without it</text>
  <line x1="20" y1="96" x2="700" y2="96" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="116" font-size="10.5" fill="currentColor">connection pool saturated</text>
  <text x="346" y="116" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="430" y="116" font-size="9.5" fill="var(--muted, #7c6fb0)">shed load to healthier replicas</text>
  <line x1="20" y1="126" x2="700" y2="126" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="146" font-size="10.5" fill="currentColor">Redis cache</text>
  <text x="346" y="146" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="430" y="146" font-size="9.5" fill="var(--muted, #7c6fb0)">degrades to origin queries and still answers</text>
  <line x1="20" y1="156" x2="700" y2="156" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="176" font-size="10.5" fill="currentColor">tile CDN</text>
  <text x="346" y="176" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="430" y="176" font-size="9.5" fill="var(--muted, #7c6fb0)">sits in front of the API, not behind it</text>
  <line x1="20" y1="186" x2="700" y2="186" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="206" font-size="10.5" fill="currentColor">auth JWKS endpoint</text>
  <text x="346" y="206" font-size="12" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="430" y="206" font-size="9.5" fill="var(--muted, #7c6fb0)">only once the cached key set has expired</text>
  <text x="20" y="226" font-size="10" fill="var(--muted, #7c6fb0)">Every extra vote is another way for a healthy instance to be taken out of service by something it could survive.</text>
</svg>

## Gotchas & Failure Modes

- **Liveness and readiness pointing at the same handler.** The most common configuration and the most damaging. One line of YAML separates a blip from an outage.
- **No timeout inside the readiness handler.** A probe that hangs on a wedged connection never returns, the kubelet times out, and the instance is marked unready for a reason nobody can see in the logs. Use an explicit internal timeout shorter than the probe's.
- **Readiness that ignores the pool.** An instance whose pool is fully saturated will accept a request and queue it behind everything else. Reporting unready sheds load to healthier replicas — the saturation signal from [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).
- **A `startupProbe` that is too strict.** First boot may run migrations. Without a generous startup probe the container is killed mid-migration, which is considerably worse than a slow deploy.
- **Probes exposed publicly.** `/readyz` reveals pool sizes, versions and error classes. Bind them to an internal port or restrict by network policy.
- **Checking a dependency the API does not need.** If the service can serve tiles from cache without Redis, a failed Redis check should not mark it unready. Readiness means "can serve", not "everything is perfect".

One further nuance is worth stating explicitly: readiness should be allowed to flap. An instance that goes unready for twenty seconds during a connection storm and then recovers has done exactly what the mechanism is for, and treating that as an incident encourages people to loosen the check until it never fires. Alert on the *proportion* of replicas unready at once, not on any single replica flipping — one replica shedding load is the system working, and all of them doing it at once is the thing worth waking someone for.

## Verification Snippet

```bash
# Liveness must answer even with the database stopped
docker compose stop db
curl -s -o /dev/null -w '%{http_code}\n' localhost:8000/healthz   # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:8000/readyz    # 503
docker compose start db
sleep 5
curl -s localhost:8000/readyz | jq '{status, db: .checks.database.ok}'
# {"status":"ready","db":true}
```

```python
async def test_liveness_does_not_touch_the_database(client, broken_pool):
    r = await client.get("/healthz")
    assert r.status_code == 200          # no dependency, no failure

async def test_readiness_reports_503_when_pool_is_dead(client, broken_pool):
    r = await client.get("/readyz")
    assert r.status_code == 503
    assert r.json()["checks"]["database"]["ok"] is False
```

---

## Related

- [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/) — the deployment these probes belong to
- [Pinning PostGIS Versions in Production Images](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/) — what the startup check verifies
- [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) — the signals that explain why readiness flipped

← Back to [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/)
