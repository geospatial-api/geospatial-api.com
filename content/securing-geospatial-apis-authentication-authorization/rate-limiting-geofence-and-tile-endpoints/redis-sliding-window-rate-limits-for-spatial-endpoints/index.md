---
layout: layouts/page.njk
title: "Redis Sliding-Window Rate Limits for Spatial Endpoints"
description: "Build an atomic sliding-window rate limiter in Redis using a sorted set (ZADD/ZREMRANGEBYSCORE/ZCARD) driven by a Lua script, applied per API key on FastAPI tile and geofence routes."
slug: "redis-sliding-window-rate-limits-for-spatial-endpoints"
type: "long_tail"
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "Rate Limiting Geofence & Tile Endpoints"
    url: "/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/"
  - label: "Redis Sliding-Window Rate Limits for Spatial Endpoints"
    url: "/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/redis-sliding-window-rate-limits-for-spatial-endpoints/"
datePublished: "2026-01-22"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Redis Sliding-Window Rate Limits for Spatial Endpoints",
      "description": "Build an atomic sliding-window rate limiter in Redis using a sorted set (ZADD/ZREMRANGEBYSCORE/ZCARD) driven by a Lua script, applied per API key on FastAPI tile and geofence routes.",
      "datePublished": "2026-01-22",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Securing Geospatial APIs", "item": "https://geospatial-api.com/securing-geospatial-apis-authentication-authorization/"},
        {"@type": "ListItem", "position": 2, "name": "Rate Limiting Geofence & Tile Endpoints", "item": "https://geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/"},
        {"@type": "ListItem", "position": 3, "name": "Redis Sliding-Window Rate Limits for Spatial Endpoints", "item": "https://geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/redis-sliding-window-rate-limits-for-spatial-endpoints/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement an atomic Redis sliding-window rate limiter for FastAPI spatial routes",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Model each client's request timestamps as a Redis sorted set scored by millisecond time."},
        {"@type": "HowToStep", "position": 2, "text": "In a single Lua script, trim entries older than the window, count survivors, and admit or reject."},
        {"@type": "HowToStep", "position": 3, "text": "On admit, ZADD the new timestamp and PEXPIRE the key to the window length."},
        {"@type": "HowToStep", "position": 4, "text": "On reject, derive Retry-After from the oldest in-window entry."},
        {"@type": "HowToStep", "position": 5, "text": "Call the script by SHA from a FastAPI dependency on tile and geofence routes."}
      ]
    },
    {
      "@type": "Article",
      "headline": "Redis Sliding-Window Rate Limits for Spatial Endpoints",
      "datePublished": "2026-01-22",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [Rate Limiting Geofence & Tile Endpoints](/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/)

# Redis sliding-window rate limits for spatial endpoints

Enforce an exact, burst-smooth per-API-key request limit on FastAPI tile and geofence routes using a Redis sorted set trimmed and counted inside one atomic Lua script.

## Context & when to use

A fixed-window counter — increment a key, reset it every second — is trivial but wrong at the boundary: a client can fire the full limit in the last 10 ms of one window and again in the first 10 ms of the next, sending 2× the intended rate in a 20 ms burst. For a cheap route nobody notices. For a geofence route where each request can hold a [pooled connection](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) for seconds, that doubled burst is exactly the overload the limit was meant to prevent.

A sliding-window log fixes this by remembering the *timestamp of every request* in a rolling window rather than a single bucket count. At each request it discards timestamps older than the window and counts what remains; the limit is enforced against a window that slides continuously with the clock, so there is no boundary to exploit. Reach for this when you need exact, fair per-client limits on expensive spatial routes and your per-window limit is modest (up to a few thousand). When requests differ enormously in cost, layer [cost-based throttling](/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/cost-based-throttling-for-expensive-postgis-queries/) on top so a large-radius `ST_DWithin` counts for more than a point lookup. The algorithm trade-offs against fixed-window and token-bucket are laid out in the parent [rate limiting geofence and tile endpoints](/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/) guide.

The single hard requirement is **atomicity**. Trim, count, and conditionally add must happen with no other client interleaving, or two concurrent requests both read "9 used" and both get admitted. Redis runs a Lua script to completion without interleaving other commands, which is what makes the check-decide-write a single indivisible step.

---

## How the window slides

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sliding window over request timestamps in a Redis sorted set" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Sliding window over a Redis sorted set of request timestamps</title>
  <desc>A timeline of request timestamps stored as sorted-set members. The window of fixed width slides to now. Timestamps older than now-minus-window are trimmed by ZREMRANGEBYSCORE. ZCARD counts survivors inside the window. If the count is below the limit the new request is admitted and ZADDed; otherwise it is rejected with a 429 and Retry-After equal to when the oldest in-window entry expires.</desc>
  <rect x="0" y="0" width="760" height="300" rx="12" fill="none"/>
  <!-- timeline axis -->
  <line x1="40" y1="150" x2="720" y2="150" stroke="currentColor" stroke-width="1.5"/>
  <text x="40" y="176" font-size="10" fill="currentColor" opacity="0.6">older</text>
  <text x="690" y="176" font-size="10" fill="currentColor" opacity="0.6">now</text>
  <!-- window band -->
  <rect x="300" y="70" width="425" height="120" rx="8" fill="var(--accent, #7c3aed)" opacity="0.12" stroke="var(--accent, #7c3aed)" stroke-width="1.5" stroke-dasharray="6 3"/>
  <text x="500" y="60" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">window = 1000 ms (slides with now)</text>
  <line x1="300" y1="150" x2="300" y2="150" stroke="currentColor" stroke-width="0"/>
  <text x="300" y="210" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">now − window</text>
  <!-- trimmed timestamps (left of window) -->
  <circle cx="110" cy="150" r="8" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.4"/>
  <circle cx="170" cy="150" r="8" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.4"/>
  <circle cx="235" cy="150" r="8" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.4"/>
  <text x="172" y="120" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.55">ZREMRANGEBYSCORE</text>
  <text x="172" y="134" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.55">trims these</text>
  <!-- in-window timestamps (survivors) -->
  <circle cx="340" cy="150" r="8" fill="var(--accent, #7c3aed)"/>
  <circle cx="400" cy="150" r="8" fill="var(--accent, #7c3aed)"/>
  <circle cx="470" cy="150" r="8" fill="var(--accent, #7c3aed)"/>
  <circle cx="545" cy="150" r="8" fill="var(--accent, #7c3aed)"/>
  <circle cx="620" cy="150" r="8" fill="var(--accent, #7c3aed)"/>
  <text x="500" y="248" text-anchor="middle" font-size="11" fill="currentColor">ZCARD counts survivors → compare to limit</text>
  <!-- oldest survivor annotation (retry-after source) -->
  <line x1="340" y1="150" x2="340" y2="115" stroke="#d97706" stroke-width="1.2"/>
  <text x="332" y="108" text-anchor="start" font-size="10" fill="#92400e">oldest → Retry-After</text>
  <!-- incoming request at now -->
  <circle cx="690" cy="150" r="9" fill="none" stroke="#10b981" stroke-width="2"/>
  <text x="690" y="126" text-anchor="middle" font-size="10.5" fill="#065f46" font-weight="600">new</text>
  <text x="690" y="272" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">ZADD if admitted</text>
</svg>

---

## Runnable implementation

The Lua script is the whole limiter; the Python around it just loads it once and calls it by SHA. Every operation runs server-side inside Redis, so the trim-count-add sequence is atomic with respect to every other client.

```python
# app/sliding_window.py
import time
from dataclasses import dataclass
from redis.asyncio import Redis

# Atomic sliding-window log.
#   KEYS[1] = the per-client sorted set
#   ARGV[1] = now in milliseconds
#   ARGV[2] = window width in milliseconds
#   ARGV[3] = max requests allowed in the window
#   ARGV[4] = a unique member id (so two requests at the same ms don't collide)
# Returns {allowed(1|0), remaining_or_retry_ms}
SLIDING_WINDOW_LUA = """
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

-- 1. Drop every timestamp that has slid out of the window.
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- 2. How many requests remain inside the window?
local used = redis.call('ZCARD', key)

if used < limit then
    -- 3a. Admit: record this request and refresh the key's TTL.
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, window)
    return {1, limit - used - 1}
end

-- 3b. Reject: Retry-After is when the oldest in-window entry falls out.
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry_ms = window - (now - tonumber(oldest[2]))
return {0, retry_ms}
"""


@dataclass
class Decision:
    allowed: bool
    remaining: int       # requests left in window (when allowed)
    retry_after: int     # seconds until retry (when rejected)


class SlidingWindowLimiter:
    def __init__(self, redis: Redis, window_seconds: int, limit: int, prefix: str = "rl"):
        self.redis = redis
        self.window_ms = window_seconds * 1000
        self.limit = limit
        self.prefix = prefix
        self._sha: str | None = None

    async def _load(self) -> str:
        if self._sha is None:
            self._sha = await self.redis.script_load(SLIDING_WINDOW_LUA)
        return self._sha

    async def check(self, identity: str) -> Decision:
        key = f"{self.prefix}:{identity}"
        now_ms = int(time.time() * 1000)
        # A monotonic-ish unique member: ms plus a counter avoids collisions
        # when the same client fires several requests within one millisecond.
        member = f"{now_ms}:{time.perf_counter_ns()}"
        sha = await self._load()
        try:
            allowed, meta = await self.redis.evalsha(
                sha, 1, key, now_ms, self.window_ms, self.limit, member,
            )
        except Exception as exc:
            # NOSCRIPT after a Redis restart flushes the cache: reload once.
            if "NOSCRIPT" in str(exc):
                self._sha = None
                sha = await self._load()
                allowed, meta = await self.redis.evalsha(
                    sha, 1, key, now_ms, self.window_ms, self.limit, member,
                )
            else:
                raise
        if allowed == 1:
            return Decision(allowed=True, remaining=int(meta), retry_after=0)
        return Decision(allowed=False, remaining=0, retry_after=max(1, round(int(meta) / 1000)))
```

Apply it as a FastAPI dependency scoped to the expensive routes, keyed on the API key extracted from the request (the same identity your [JWT spatial scopes](/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) establish):

```python
# app/deps.py
from fastapi import Depends, Request, HTTPException
from app.sliding_window import SlidingWindowLimiter

def get_limiter(request: Request) -> SlidingWindowLimiter:
    # 10 requests per 1 s per key — a geofence-route budget.
    return SlidingWindowLimiter(request.app.state.redis, window_seconds=1, limit=10)

async def enforce_geofence_limit(
    request: Request,
    limiter: SlidingWindowLimiter = Depends(get_limiter),
):
    api_key = request.headers.get("x-api-key") or request.client.host
    decision = await limiter.check(f"geofence:{api_key}")
    if not decision.allowed:
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded.",
            headers={
                "Retry-After": str(decision.retry_after),
                "RateLimit-Limit": "10",
                "RateLimit-Remaining": "0",
                "RateLimit-Reset": str(decision.retry_after),
            },
        )

# Usage on a route:
# @router.get("/within", dependencies=[Depends(enforce_geofence_limit)])
```

---

## Key parameters & options

| Parameter | Meaning | Typical value | Notes |
|---|---|---|---|
| `window_seconds` | Width of the rolling window | `1`–`60` | Shorter windows smooth bursts harder; longer ones tolerate spikes |
| `limit` | Max requests admitted per window | `10` (geofence), `25` (tiles) | Match the cost tier from the parent guide |
| Key format | `rl:{route}:{identity}` | `rl:geofence:key:abc123` | Namespace by route so budgets don't bleed across endpoints |
| `member` | Unique sorted-set member per request | `"{ms}:{perf_ns}"` | Must be unique or same-ms requests overwrite each other in the ZSET |
| `PEXPIRE` | TTL applied on every admit | `= window_ms` | Lets idle keys evict; without it the ZSET lingers forever |
| Score | Sorted-set score for each member | `now_ms` | Millisecond time; drives both trimming and Retry-After |

---

## Gotchas & failure modes

- **Non-unique members silently undercount.** If two requests in the same millisecond use the same member string, the second `ZADD` updates the first instead of adding a row, so `ZCARD` reports one request where there were two — the client gets free capacity. Always append a high-resolution counter (`perf_counter_ns`) to the timestamp, as above.

- **`NOSCRIPT: No matching script` after a Redis restart or failover.** Redis flushes its script cache on restart, so a cached SHA stops resolving and `EVALSHA` raises `NOSCRIPT`. Catch it, `SCRIPT LOAD` again, and retry once — the handler above does this. A limiter that crashes on failover fails the whole route.

- **Clock skew across API replicas.** The score is `time.time()` on the *application* host, not Redis. If replicas' clocks drift by more than a few tens of milliseconds, windows shift per replica and the limit becomes fuzzy. Run NTP on every node, or read the reference time from Redis with `TIME` inside the script if you need strict correctness.

- **Unbounded memory at high limits.** The log stores one member per request in the window; a `limit` of 100,000 makes each key ~2–4 MB. For very high limits switch to a two-counter sliding-window approximation, which is O(1) per key at the cost of small edge inaccuracy.

- **Forgetting `PEXPIRE`.** If you `ZADD` but never set a TTL, a client that sends one request and vanishes leaves a sorted set in Redis forever. Over millions of one-shot keys this leaks memory until eviction kicks in. Refresh `PEXPIRE` on every admit so active keys stay alive and idle ones expire.

---

## Verification

Drive the limiter past its ceiling and confirm the exact admit/reject split, then confirm the key self-expires:

```bash
# 12 requests at a 10-per-second limit → 10x200 then 2x429
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code} " \
    -H "x-api-key: demo" "http://localhost:8000/within?lng=13.4&lat=52.5&radius=500"
done; echo

# Inspect the sorted set directly (should hold <= limit members, all in-window)
redis-cli ZCARD "rl:geofence:key:demo"        # -> (integer) 10
redis-cli PTTL  "rl:geofence:key:demo"         # -> a value <= 1000 (ms), proving PEXPIRE ran
```

A quick atomicity assertion in Python — fire the limit concurrently and confirm no over-admission:

```python
import asyncio
async def test_no_overadmit(limiter):
    results = await asyncio.gather(*[limiter.check("race") for _ in range(50)])
    assert sum(r.allowed for r in results) == limiter.limit   # exactly the limit, never more
```

---

## Related

- [Rate Limiting Geofence & Tile Endpoints](/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/) — algorithm decision matrix, keying strategies, and the full middleware
- [Cost-Based Throttling for Expensive PostGIS Queries](/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/cost-based-throttling-for-expensive-postgis-queries/) — weight the window by query cost, not a flat count
- [Redis Caching for Spatial Queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — reuse the same Redis to cache tile responses so the limiter only guards misses

← Back to [Rate Limiting Geofence & Tile Endpoints](/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/)
