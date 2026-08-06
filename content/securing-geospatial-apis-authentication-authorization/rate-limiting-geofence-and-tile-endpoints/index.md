---
layout: layouts/page.njk
title: "Rate Limiting Geofence & Tile Endpoints"
description: "Protect expensive PostGIS geofence, ST_DWithin radius, and vector-tile endpoints from abuse and accidental overload. Choose an algorithm, pick a keying strategy, and enforce Redis-backed limits in FastAPI with correct 429 and Retry-After responses."
slug: "rate-limiting-geofence-and-tile-endpoints"
breadcrumb: "Securing Geospatial APIs › Rate Limiting Geofence & Tile Endpoints"
datePublished: "2025-09-12"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Rate Limiting Geofence & Tile Endpoints",
      "description": "Protect expensive PostGIS geofence, ST_DWithin radius, and vector-tile endpoints from abuse and accidental overload. Choose an algorithm, pick a keying strategy, and enforce Redis-backed limits in FastAPI with correct 429 and Retry-After responses.",
      "datePublished": "2025-09-12",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "Article",
      "headline": "Rate Limiting Geofence & Tile Endpoints",
      "datePublished": "2025-09-12",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/"},
        {"@type": "ListItem", "position": 2, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/"},
        {"@type": "ListItem", "position": 3, "name": "Rate Limiting Geofence & Tile Endpoints", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Rate Limit Spatial Endpoints in FastAPI with Redis",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Classify spatial routes by cost and assign per-route budgets"},
        {"@type": "HowToStep", "position": 2, "name": "Choose an algorithm and keying strategy from the decision matrix"},
        {"@type": "HowToStep", "position": 3, "name": "Implement a Redis-backed FastAPI middleware that enforces the limit atomically"},
        {"@type": "HowToStep", "position": 4, "name": "Return 429 with Retry-After and rate-limit headers"},
        {"@type": "HowToStep", "position": 5, "name": "Set a database statement_timeout as a last line of defence"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why do spatial endpoints need different rate limits than ordinary REST routes?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "A single request can be arbitrarily expensive. An ST_DWithin call with a 200 km radius, or a vector tile at zoom 6 covering a dense polygon layer, can hold a backend connection for several seconds and burn CPU that a point lookup never touches. A flat requests-per-second limit that is comfortable for metadata routes lets a handful of large-radius or low-zoom requests saturate the connection pool. Spatial endpoints therefore need lower request ceilings, or cost-weighted budgets that price each request by its bounding-box area or radius before admitting it."
          }
        },
        {
          "@type": "Question",
          "name": "Where should I enforce the limit: at the edge, in FastAPI, or in PostgreSQL?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use all three as layers. The CDN or edge worker sheds volumetric floods before they reach your origin and is the right place for coarse per-IP tile limits. FastAPI middleware backed by Redis enforces per-API-key and per-tenant business limits and can price a request by its spatial cost. A PostgreSQL statement_timeout is the backstop that kills a runaway ST_DWithin or ST_Union that slipped through, so one pathological query cannot hold a pooled connection indefinitely."
          }
        },
        {
          "@type": "Question",
          "name": "What should a 429 response for a spatial endpoint contain?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Return HTTP 429 Too Many Requests with a Retry-After header giving the number of seconds until the caller may retry, plus RateLimit-Limit, RateLimit-Remaining, and RateLimit-Reset headers so well-behaved clients can self-throttle. The body should be a small JSON object naming the limit that was hit and the retry delay. Never return 503 for rate limiting: 503 signals server fault and encourages clients to retry immediately, which amplifies the overload you are trying to prevent."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/)

# Rate limiting geofence and tile endpoints

Spatial endpoints break the assumptions that ordinary rate limiters are built on. A `/users/{id}` lookup costs the same every time, so a flat requests-per-second ceiling protects it perfectly. A geofence query does not: `ST_DWithin(geom, :point, :radius)` with a 10 metre radius returns in a millisecond, while the same route with a 300 km radius scans a large candidate set, holds a pooled backend connection for seconds, and burns CPU that competes with every other query on the box. Vector-tile generation is worse still — a request for a low-zoom tile over a dense layer can serialise tens of thousands of features. Left unprotected, a handful of these requests will exhaust your [connection pool](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) and take down endpoints that have nothing to do with the offending route.

This guide covers why these endpoints need bespoke limits, where to enforce them, which algorithm to choose, how to key the counter, and how to return a correct `429`. It sits alongside [JWT authentication for spatial scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) and [row-level security for multi-tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) in the broader [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/) reference: authentication says *who* you are, row-level security says *what* you may see, and rate limiting says *how much* of the database's finite spatial capacity you may consume.

## Enforcement layers

Rate limiting a spatial API is defence in depth, not a single check. Each layer catches a different class of overload, and the request only reaches the database if it survives all three.

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three enforcement layers for spatial rate limiting: edge CDN, FastAPI middleware, and PostgreSQL statement timeout" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Three enforcement layers for spatial rate limiting</title>
  <desc>A request flows top to bottom through three defensive layers. The edge or CDN sheds volumetric floods with coarse per-IP tile limits. FastAPI middleware backed by Redis enforces per-API-key and cost-weighted business limits and returns 429 with Retry-After. PostgreSQL statement_timeout kills any runaway spatial query that slipped through. Only surviving requests reach PostGIS.</desc>
  <rect x="0" y="0" width="760" height="360" rx="12" fill="var(--surface, #f5f3ff)"/>
  <!-- incoming request -->
  <rect x="300" y="16" width="160" height="34" rx="6" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="380" y="38" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Incoming request</text>
  <line x1="380" y1="50" x2="380" y2="72" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#a)"/>
  <!-- layer 1 edge -->
  <rect x="60" y="74" width="640" height="66" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="80" y="98" font-size="13" font-weight="700" fill="currentColor">Layer 1 · Edge / CDN</text>
  <text x="80" y="118" font-size="11" fill="currentColor" opacity="0.8">Coarse per-IP tile limits · absorbs volumetric floods before the origin</text>
  <text x="80" y="133" font-size="11" fill="currentColor" opacity="0.6">Cloudflare Worker or CDN rule · cheapest place to drop traffic</text>
  <rect x="590" y="88" width="96" height="40" rx="6" fill="#fee2e2" stroke="#ef4444" stroke-width="1.3"/>
  <text x="638" y="106" text-anchor="middle" font-size="10.5" fill="#991b1b" font-weight="600">429</text>
  <text x="638" y="120" text-anchor="middle" font-size="9.5" fill="#991b1b">flood shed</text>
  <line x1="380" y1="140" x2="380" y2="164" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#a)"/>
  <!-- layer 2 fastapi -->
  <rect x="60" y="166" width="640" height="82" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="80" y="190" font-size="13" font-weight="700" fill="currentColor">Layer 2 · FastAPI middleware + Redis</text>
  <text x="80" y="210" font-size="11" fill="currentColor" opacity="0.8">Per-API-key / per-tenant sliding window · cost-weighted token bucket</text>
  <text x="80" y="225" font-size="11" fill="currentColor" opacity="0.8">Prices each request by bbox area or radius · atomic Lua check</text>
  <text x="80" y="240" font-size="11" fill="currentColor" opacity="0.6">Sets RateLimit-* headers · returns 429 + Retry-After</text>
  <rect x="590" y="184" width="96" height="46" rx="6" fill="#fee2e2" stroke="#ef4444" stroke-width="1.3"/>
  <text x="638" y="204" text-anchor="middle" font-size="10.5" fill="#991b1b" font-weight="600">429</text>
  <text x="638" y="218" text-anchor="middle" font-size="9.5" fill="#991b1b">Retry-After</text>
  <line x1="380" y1="248" x2="380" y2="272" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#a)"/>
  <!-- layer 3 postgres -->
  <rect x="60" y="274" width="640" height="66" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="80" y="298" font-size="13" font-weight="700" fill="currentColor">Layer 3 · PostgreSQL statement_timeout</text>
  <text x="80" y="318" font-size="11" fill="currentColor" opacity="0.8">Backstop · kills a runaway ST_DWithin / ST_Union that slipped through</text>
  <text x="80" y="333" font-size="11" fill="currentColor" opacity="0.6">Protects the connection pool from a single pathological query</text>
  <rect x="590" y="288" width="96" height="40" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.3"/>
  <text x="638" y="306" text-anchor="middle" font-size="10.5" fill="#92400e" font-weight="600">57014</text>
  <text x="638" y="320" text-anchor="middle" font-size="9.5" fill="#92400e">canceled</text>
  <defs>
    <marker id="a" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="var(--accent, #7c3aed)"/>
    </marker>
  </defs>
</svg>

The edge is where you shed brute-force floods — it is the cheapest place to drop a request because it never touches your origin. FastAPI is where business logic lives: per-API-key quotas, per-tenant fairness, and cost-weighted pricing that a CDN cannot compute because it does not understand your geometry. PostgreSQL's `statement_timeout` is the last resort that guarantees no single query can hold a connection forever, no matter how the upstream limits are configured.

---

## Prerequisites & Environment

The middleware in this guide targets an async FastAPI stack with Redis as the shared counter store. Redis is mandatory because a limiter that lives in per-process memory does not survive horizontal scaling — two Uvicorn workers each admit the full quota, doubling your effective limit.

| Component | Minimum version | Why it matters |
|---|---|---|
| Python | 3.11+ | `asyncio.TaskGroup`, faster `asyncio` scheduling |
| FastAPI | 0.110+ | Stable `BaseHTTPMiddleware`, lifespan events |
| Starlette | 0.36+ | ASGI middleware contract used below |
| redis-py | 5.0+ | Native async client (`redis.asyncio`), server-side Lua via `EVALSHA` |
| Redis server | 7.0+ | Reliable `EVAL`/`EVALSHA`, `PEXPIRE` millisecond TTLs |
| PostgreSQL | 14+ | Per-transaction `SET LOCAL statement_timeout` |
| PostGIS | 3.3+ | `ST_DWithin`, `ST_Intersects`, `ST_AsMVT` availability |

```bash
pip install "fastapi>=0.110" "redis>=5.0" "uvicorn[standard]>=0.29"
```

Confirm the spatial functions you intend to protect actually exist in your image before you tune limits around them — `ST_AsMVT` for vector tiles arrived in PostGIS 2.4 but `ST_AsMVTGeom`'s clipping behaviour changed in 3.0:

```sql
SELECT proname FROM pg_proc
WHERE proname IN ('st_dwithin', 'st_asmvt', 'st_intersects');
```

---

## Decision matrix: rate-limiting algorithms

Four algorithms dominate. The right one depends on whether you care about burst smoothness, memory footprint, or the ability to price requests unequally — which spatial APIs almost always need.

| Algorithm | Burst behaviour | Memory per key | Accuracy at window edge | Cost weighting | Best fit for spatial routes |
|---|---|---|---|---|---|
| Fixed window | Allows 2× burst at boundary | 1 counter | Poor (double-count at edge) | Awkward | Coarse edge tile caps where precision is not critical |
| Sliding window (log) | Smooth, exact | O(N) sorted set | Exact | Natural (weighted `ZADD`) | Per-key limits on geofence and tile routes |
| Sliding window (counter) | Smooth, approximate | 2 counters | Good (weighted interpolation) | Awkward | High-cardinality keys where memory matters |
| Token bucket | Allows controlled bursts | 2 fields | Exact | **Native** — deduct N tokens | Cost-based throttling by bbox area / radius |

For a straightforward per-API-key ceiling on tile and geofence routes, the **sliding-window log** is the default: it is exact, smooths bursts, and its sorted-set structure makes weighting trivial. The full atomic implementation lives in [Redis sliding-window rate limits for spatial endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/redis-sliding-window-rate-limits-for-spatial-endpoints/).

When requests are wildly unequal in cost — a 10 m radius versus a 300 km radius on the same route — a flat request count is the wrong unit. A **token bucket** whose withdrawal is proportional to the estimated query cost prices each request fairly; a large-radius `ST_DWithin` withdraws many tokens and drains the budget quickly, while cheap point lookups barely move it. That approach is developed in full in [cost-based throttling for expensive PostGIS queries](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/cost-based-throttling-for-expensive-postgis-queries/).

---

Standard algorithms count requests; a spatial API cares much more about what each request costs.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Rate-limiting algorithms for spatial traffic: Smooth, Memory" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Rate-limiting algorithms for spatial traffic</title>
  <desc>A comparison table. fixed window: Smooth no, Memory yes. boundary bursts of 2× the limit sliding window log: Smooth yes, Memory no. one entry per request sliding window counter: Smooth yes, Memory yes. the usual compromise token bucket: Smooth yes, Memory yes. allows a controlled burst cost-based bucket: Smooth yes, Memory yes. charges by envelope area Only the last row prices a request by how much work it asks for, which is what a spatial API actually needs.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Rate-limiting algorithms for spatial traffic</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Smooth</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Memory</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">fixed window</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">boundary bursts of 2× the limit</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">sliding window log</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="460" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">one entry per request</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">sliding window counter</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">the usual compromise</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">token bucket</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">allows a controlled burst</text>
  <line x1="20" y1="194" x2="700" y2="194" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="216" font-size="10.5" fill="currentColor">cost-based bucket</text>
  <text x="294" y="216" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="216" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="216" font-size="9.5" fill="var(--muted, #7c6fb0)">charges by envelope area</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">Only the last row prices a request by how much work it asks for, which is what a spatial API actually needs.</text>
</svg>

## Step-by-Step Implementation

### Step 1: Classify routes by cost and assign budgets

Not every route deserves the same ceiling. Group your endpoints into cost tiers and pick a limit for each. The tiers below are a realistic starting point for a single-tenant plan on a modest replica; halve them for a free tier, multiply for enterprise.

| Route class | Example | Typical DB time | Limit (per API key) |
|---|---|---|---|
| Metadata / lookup | `GET /layers`, `GET /features/{id}` | < 5 ms | 200 req/s |
| Bounding-box read | `GET /features?bbox=...` | 10–50 ms | 50 req/s |
| Geofence / radius | `GET /within?lng&lat&radius` | 20 ms – 3 s | 10 req/s |
| Vector tile | `GET /tiles/{z}/{x}/{y}.mvt` | 30–800 ms | 25 req/s (lower at z ≤ 8) |
| Aggregation / export | `GET /stats/coverage` | 1–30 s | 2 req/min |

The geofence and low-zoom tile classes are the ones that hurt, because their worst case is orders of magnitude slower than their median. A limit chosen for the median lets the worst case run wild; a limit chosen for the worst case throttles legitimate median traffic. This tension is exactly what cost-based throttling resolves — see the [bounding-box spatial index queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) guide for how to derive a cost from the requested `bbox` before the query runs.

### Step 2: Choose the algorithm and the key

The **key** decides who shares a budget. Three strategies, from coarse to fine:

- **Per API key / tenant** — the fairness unit for a paid product. Extract the key from the `Authorization` header or a validated JWT scope. This is what a paying customer expects to be metered on, and it composes cleanly with the tenant identity already established for [row-level security](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/).
- **Per IP** — the only option for anonymous tile traffic. Coarse and easily defeated by rotating IPs, so use it at the edge, not as your only defence.
- **Per IP + bbox cell** — snap the requested bounding box to a coarse grid (say 0.1°) and key on `ip:cell`. This stops a scraper from walking a dense area tile-by-tile at full speed while leaving a normal panning user unaffected.

### Step 3: Enforce atomically in middleware

The check-then-set race is the classic rate-limiter bug: two workers read "9 of 10 used", both admit, and you served 11. The fix is to make the read-decide-write a single atomic Redis operation via a Lua script (which Redis runs without interleaving). The production example below does exactly that; the sliding-window variant is dissected line by line in [Redis sliding-window rate limits for spatial endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/redis-sliding-window-rate-limits-for-spatial-endpoints/).

### Step 4: Return a correct 429

On rejection, return `429 Too Many Requests` — never `503`, which tells clients the server is broken and invites an immediate retry. Include `Retry-After` (seconds) plus the `RateLimit-*` header family so disciplined clients self-throttle before they are throttled.

### Step 5: Backstop with statement_timeout

Set a per-transaction timeout so a query that slips past every counter still cannot hold a connection forever:

```python
await conn.execute("SET LOCAL statement_timeout = '3000ms'")
```

A cancelled query surfaces as PostgreSQL error `57014` (`canceling statement due to statement timeout`); catch it and return `429` or `504` rather than a raw `500`.

---

## Production Code Example

A cohesive, copy-runnable FastAPI middleware. It selects a per-route limit, keys on the API key, and enforces a sliding-window limit atomically with a Lua script. On rejection it emits a spec-compliant `429`.

```python
# app/ratelimit.py
import time
from redis.asyncio import Redis
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

# Per-route (window_seconds, max_requests). Match your cost tiers from Step 1.
ROUTE_LIMITS: dict[str, tuple[int, int]] = {
    "/within":  (1, 10),    # geofence / radius — expensive, tight limit
    "/tiles":   (1, 25),    # vector tiles
    "/features": (1, 50),   # bounding-box reads
}
DEFAULT_LIMIT = (1, 200)    # metadata / everything else

# Atomic sliding-window log: trim old entries, count, admit-or-reject, then
# only record the hit if admitted. KEYS[1]=zset, ARGV=now_ms, window_ms, limit, member
SLIDING_WINDOW_LUA = """
local key   = KEYS[1]
local now   = tonumber(ARGV[1])
local window= tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local used = redis.call('ZCARD', key)
if used < limit then
    redis.call('ZADD', key, now, ARGV[4])
    redis.call('PEXPIRE', key, window)
    return {1, limit - used - 1}
end
-- rejected: compute Retry-After from the oldest entry in the window
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry_ms = window - (now - tonumber(oldest[2]))
return {0, retry_ms}
"""


def route_class(path: str) -> str:
    for prefix in ROUTE_LIMITS:
        if path.startswith(prefix):
            return prefix
    return "__default__"


def client_key(request: Request) -> str:
    # Prefer the validated API key; fall back to peer IP for anonymous traffic.
    api_key = request.headers.get("x-api-key")
    if api_key:
        return f"key:{api_key}"
    return f"ip:{request.client.host}"


class SpatialRateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, redis: Redis):
        super().__init__(app)
        self.redis = redis
        self._sha: str | None = None

    async def _script(self) -> str:
        if self._sha is None:
            self._sha = await self.redis.script_load(SLIDING_WINDOW_LUA)
        return self._sha

    async def dispatch(self, request: Request, call_next):
        cls = route_class(request.url.path)
        window_s, limit = ROUTE_LIMITS.get(cls, DEFAULT_LIMIT)
        redis_key = f"rl:{cls}:{client_key(request)}"
        now_ms = int(time.time() * 1000)
        member = f"{now_ms}-{id(request)}"  # unique member so equal timestamps don't collide

        try:
            sha = await self._script()
            allowed, meta = await self.redis.evalsha(
                sha, 1, redis_key,
                now_ms, window_s * 1000, limit, member,
            )
        except Exception:
            # Fail OPEN for tiles (availability), FAIL CLOSED for expensive routes.
            if cls == "/within":
                return JSONResponse(
                    {"detail": "Rate limiter unavailable; try again shortly."},
                    status_code=503,
                )
            return await call_next(request)

        if allowed == 0:
            retry_after = max(1, round(int(meta) / 1000))
            return JSONResponse(
                {"detail": "Rate limit exceeded.", "retry_after": retry_after,
                 "limit": limit, "window_seconds": window_s},
                status_code=429,
                headers={
                    "Retry-After": str(retry_after),
                    "RateLimit-Limit": str(limit),
                    "RateLimit-Remaining": "0",
                    "RateLimit-Reset": str(retry_after),
                },
            )

        response: Response = await call_next(request)
        response.headers["RateLimit-Limit"] = str(limit)
        response.headers["RateLimit-Remaining"] = str(max(0, int(meta)))
        return response
```

Wire it into the app with a Redis client created in the lifespan handler:

```python
# app/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from redis.asyncio import Redis
from app.ratelimit import SpatialRateLimitMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.redis = Redis.from_url("redis://redis:6379/0", decode_responses=True)
    yield
    await app.state.redis.aclose()


app = FastAPI(lifespan=lifespan)
# Middleware needs the client at construction; build it after state is set.
app.add_middleware(SpatialRateLimitMiddleware, redis=Redis.from_url("redis://redis:6379/0", decode_responses=True))
```

The **fail-open versus fail-closed** decision is a deliberate policy choice. If Redis is unreachable, cheap tile routes fail open (serve the request — availability wins), while the expensive `/within` geofence route fails closed (reject with `503` — protecting the database wins). Getting this backwards means a Redis outage either takes down your whole map or lets a scraper hammer your most expensive query unmetered.

---

## Verification & Testing

**Drive the limit with a curl loop** and watch the transition from `200` to `429`:

```bash
# Fire 15 requests at a route limited to 10/s and print each status code.
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code} " \
    -H "x-api-key: test-key-123" \
    "http://localhost:8000/within?lng=13.4&lat=52.5&radius=500"
done; echo
# Expected: 200 200 200 200 200 200 200 200 200 200 429 429 429 429 429
```

**Inspect the 429 headers** to confirm `Retry-After` is present and sane:

```bash
curl -s -D - -o /dev/null \
  -H "x-api-key: test-key-123" \
  "http://localhost:8000/within?lng=13.4&lat=52.5&radius=500" | grep -i 'ratelimit\|retry-after'
# retry-after: 1
# ratelimit-limit: 10
# ratelimit-remaining: 0
# ratelimit-reset: 1
```

**Unit test the middleware** against a real or fake Redis (`fakeredis` supports `EVALSHA`):

```python
# tests/test_ratelimit.py
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_geofence_route_rejects_after_limit():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        codes = []
        for _ in range(15):
            r = await c.get("/within", params={"lng": 13.4, "lat": 52.5, "radius": 500},
                            headers={"x-api-key": "k"})
            codes.append(r.status_code)
    assert codes.count(200) == 10
    assert codes[-1] == 429
    assert int((await c.get("/within", headers={"x-api-key": "k"},
                params={"lng": 13.4, "lat": 52.5, "radius": 500})
        ).headers["retry-after"]) >= 1
```

---

A per-minute request limit says nothing about the load those requests create.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Database time consumed per minute at the same request rate: 60 tile requests, z14 1.4 s, 60 bbox requests, small 1.1 s, 60 bbox requests, continental 42 s, 60 export requests 180 s — three machines’ worth" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Database time consumed per minute at the same request rate</title>
  <desc>A horizontal bar chart. 60 tile requests, z14 is 1.4 s. 60 bbox requests, small is 1.1 s. 60 bbox requests, continental is 42 s. 60 export requests is 180 s — three machines’ worth. The same limit permits wildly different loads, which is the entire argument for charging by cost rather than by count.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Database time consumed per minute at the same request rate</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">60 tile requests, z14</text>
  <rect x="250" y="48" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">1.4 s</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">60 bbox requests, small</text>
  <rect x="250" y="82" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="95" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">1.1 s</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">60 bbox requests, continental</text>
  <rect x="250" y="116" width="79" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="337" y="129" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">42 s</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">60 export requests</text>
  <rect x="250" y="150" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="163" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">180 s — three</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">The same limit permits wildly different loads, which is the entire argument for charging by cost rather than by count.</text>
</svg>

## Failure Modes & Edge Cases

1. **In-memory counters under horizontal scaling.** A limiter that stores counts in a Python dict admits the full quota *per worker*. With four Uvicorn workers a "10 req/s" limit becomes 40 req/s. Always back the counter with shared Redis, and confirm every replica points at the same Redis database.

2. **`prepared statement does not exist` after a limiter deploy through PgBouncer.** Unrelated to the limiter itself, but a Redis outage that trips fail-open floods the pool, surfacing latent transaction-pooling bugs. Keep `statement_cache_size=0` as covered in [connection pooling & PgBouncer setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

3. **Check-then-set race admits over the limit.** Reading the count and writing the increment in two round trips lets concurrent requests both pass the check. The symptom is intermittent over-admission under load that disappears when you serialise the test. Fix: perform the whole decision in one Lua script, as above.

4. **`Retry-After` computed from wall clock, not the window.** Returning a fixed `Retry-After: 60` when the window is 1 second makes honest clients back off far too long. Compute it from the oldest entry still inside the window (the Lua script returns exactly this).

5. **Returning `503` instead of `429`.** `503 Service Unavailable` signals a server fault; many HTTP clients retry it immediately and aggressively, amplifying the overload. Reserve `503` strictly for the fail-closed limiter-unavailable case, and use `429` for actual limit hits.

6. **Keying tiles on API key when they are anonymous.** Public basemap tiles usually carry no key, so `client_key` falls back to IP. A single corporate NAT then shares one bucket across thousands of users and gets throttled unfairly. For public tiles, key on `IP + bbox cell` or move the limit to the [edge](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) where per-colo budgets are wider.

7. **No database backstop.** If you rely solely on the counter and a bug lets one request through, a 30-second `ST_Union` still holds a connection. `SET LOCAL statement_timeout` guarantees an upper bound regardless of limiter state.

8. **Sorted-set memory growth.** The sliding-window log stores one member per request in the window. A very high limit (say 100k/min) makes each key large; set `PEXPIRE` on every write so idle keys evict, and prefer the counter variant for very high-cardinality limits.

---

## Performance Notes

**Limiter overhead.** The `EVALSHA` round trip to a co-located Redis adds roughly 0.2–0.5 ms per request on a warm connection — negligible next to a 20 ms bounding-box query and trivial next to a multi-second geofence. Load the script once (`SCRIPT LOAD` at startup) and call it by SHA; sending the full script body on every request wastes bandwidth and CPU.

**Where the limit pays off.** The point of the limiter is not the happy path — it is the tail. Without a limit, p99 latency on your geofence route is unbounded because it is set by whoever requests the largest radius. With a cost-weighted limit, a single client cannot monopolise the pool, so p99 stays bounded even under adversarial load. This is the same tail-latency argument that motivates a separate heavy-query connection pool in the [connection pooling guide](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

**Redis sizing.** A sliding-window log at 50 req/s over a 1-second window holds ~50 members per key. Ten thousand active keys is roughly 5–15 MB — comfortably in RAM. If you push limits into the thousands-per-window range, switch to the two-counter sliding-window approximation to cap memory at O(1) per key.

**Tile caching beats limiting.** The cheapest request is the one you never compute. Cache generated tiles at the [CDN edge](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) and in [Redis](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) so repeat requests for the same `z/x/y` never reach PostGIS; the rate limiter then only guards genuine cache misses. For confirming that your surviving geofence queries actually use the GiST index, run the plans through [query plan analysis & index tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/).

---

## FAQ

### Why do spatial endpoints need different rate limits than ordinary REST routes?

A single request can be arbitrarily expensive. An `ST_DWithin` call with a 200 km radius, or a vector tile at zoom 6 covering a dense polygon layer, can hold a backend connection for several seconds and burn CPU that a point lookup never touches. A flat requests-per-second limit that is comfortable for metadata routes lets a handful of large-radius or low-zoom requests saturate the connection pool. Spatial endpoints therefore need lower request ceilings, or cost-weighted budgets that price each request by its bounding-box area or radius before admitting it.

### Where should I enforce the limit: at the edge, in FastAPI, or in PostgreSQL?

Use all three as layers. The CDN or edge worker sheds volumetric floods before they reach your origin and is the right place for coarse per-IP tile limits. FastAPI middleware backed by Redis enforces per-API-key and per-tenant business limits and can price a request by its spatial cost. A PostgreSQL `statement_timeout` is the backstop that kills a runaway `ST_DWithin` or `ST_Union` that slipped through, so one pathological query cannot hold a pooled connection indefinitely.

### What should a 429 response for a spatial endpoint contain?

Return HTTP `429 Too Many Requests` with a `Retry-After` header giving the number of seconds until the caller may retry, plus `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers so well-behaved clients can self-throttle. The body should be a small JSON object naming the limit that was hit and the retry delay. Never return `503` for rate limiting: `503` signals server fault and encourages clients to retry immediately, which amplifies the overload you are trying to prevent.

---

## Related

- [Redis Sliding-Window Rate Limits for Spatial Endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/redis-sliding-window-rate-limits-for-spatial-endpoints/) — the atomic sorted-set + Lua limiter, dissected line by line
- [Cost-Based Throttling for Expensive PostGIS Queries](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/cost-based-throttling-for-expensive-postgis-queries/) — price each request by bbox area or radius and deduct from a token budget
- [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/) — authentication, authorization, and tenant isolation for spatial services
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — the pool that rate limiting exists to protect
- [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — cache tiles at the edge so the limiter only guards cache misses

← Back to [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/)
