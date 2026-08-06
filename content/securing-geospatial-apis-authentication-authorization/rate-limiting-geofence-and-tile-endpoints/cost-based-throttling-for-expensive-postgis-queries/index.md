---
layout: layouts/page.njk
title: "Cost-Based Throttling for Expensive PostGIS Queries"
description: "Price each spatial request by its bounding-box area, radius, or expected vertex count, deduct that cost from a per-client token budget in Redis, and reject with 429 plus Retry-After when the budget is exhausted."
slug: "cost-based-throttling-for-expensive-postgis-queries"
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "Rate Limiting Geofence & Tile Endpoints"
    url: "/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/"
  - label: "Cost-Based Throttling for Expensive PostGIS Queries"
    url: "/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/cost-based-throttling-for-expensive-postgis-queries/"
datePublished: "2026-03-08"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Cost-Based Throttling for Expensive PostGIS Queries",
      "description": "Price each spatial request by its bounding-box area, radius, or expected vertex count, deduct that cost from a per-client token budget in Redis, and reject with 429 plus Retry-After when the budget is exhausted.",
      "datePublished": "2026-03-08",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/"},
        {"@type": "ListItem", "position": 2, "name": "Rate Limiting Geofence & Tile Endpoints", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/"},
        {"@type": "ListItem", "position": 3, "name": "Cost-Based Throttling for Expensive PostGIS Queries", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/cost-based-throttling-for-expensive-postgis-queries/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Throttle expensive PostGIS queries by cost with a Redis token bucket",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Estimate a request's cost from its bounding-box area, radius, or requested feature count."},
        {"@type": "HowToStep", "position": 2, "text": "Maintain a per-client token bucket in Redis that refills at a fixed rate."},
        {"@type": "HowToStep", "position": 3, "text": "Atomically refill the bucket and deduct the request's cost in one Lua script."},
        {"@type": "HowToStep", "position": 4, "text": "Admit when tokens cover the cost; otherwise reject with 429 and a Retry-After derived from the refill rate."},
        {"@type": "HowToStep", "position": 5, "text": "Cap per-request cost so an unbounded radius cannot exhaust the budget in one call."}
      ]
    },
    {
      "@type": "Article",
      "headline": "Cost-Based Throttling for Expensive PostGIS Queries",
      "datePublished": "2026-03-08",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [Rate Limiting Geofence & Tile Endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/)

# Cost-based throttling for expensive PostGIS queries

Count tokens, not requests: price each spatial call by its bounding-box area or radius, deduct that from a per-client budget, and reject when the budget runs dry.

## Context & when to use

A flat request-per-second limit assumes every request costs the same. Spatial requests violate that assumption by orders of magnitude. On one geofence route, an `ST_DWithin` with a 10 m radius touches a handful of index entries and returns in a millisecond; the same route with a 300 km radius scans a huge candidate set and holds a [pooled connection](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) for seconds. A limit set for the cheap case waves the expensive case straight through to your database; a limit set for the expensive case needlessly throttles honest cheap traffic.

Cost-based throttling resolves the tension by charging a request in proportion to how much work it will demand. Each client gets a token budget that refills at a steady rate. A cheap point lookup withdraws one token; a large-radius or low-zoom-tile request withdraws many. A client can fire hundreds of cheap requests a second or a few heavy ones — either way it consumes its fair share of a finite database, and no single request class can monopolise the pool. Use this when your routes have a wide cost spread and a flat [sliding-window limit](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/redis-sliding-window-rate-limits-for-spatial-endpoints/) either over-throttles or under-protects. For routes where every request is roughly equal, the simpler sliding window is enough; the two compose well, and the parent [rate limiting geofence and tile endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/) guide covers when to reach for each.

The cost estimate must be cheap and derived from the request itself — the bounding box, the radius, the requested feature limit — computed *before* the query runs. Deriving the cost from a `bbox` is the same geometry you already parse for [bounding-box spatial index queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/), so it adds no meaningful overhead.

---

## Cost model and token flow

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cost-based token bucket: request cost estimated from bbox area and radius, deducted from a refilling Redis bucket" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Cost-based token bucket for spatial requests</title>
  <desc>A request's bounding box and radius feed a cost estimator that outputs a token cost. A per-client bucket in Redis refills at a steady rate up to a capacity. The Lua script refills the bucket by elapsed time, then compares tokens to the request cost. If tokens cover the cost they are deducted and the request is admitted; otherwise it is rejected with 429 and a Retry-After equal to the time needed to refill the shortfall.</desc>
  <rect x="0" y="0" width="760" height="320" rx="12" fill="var(--surface, #f5f3ff)"/>
  <!-- request inputs -->
  <rect x="30" y="40" width="160" height="90" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="110" y="64" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Request</text>
  <text x="110" y="86" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.8">bbox area</text>
  <text x="110" y="102" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.8">radius</text>
  <text x="110" y="118" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.8">feature limit</text>
  <!-- estimator -->
  <line x1="190" y1="85" x2="232" y2="85" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#c)"/>
  <rect x="234" y="46" width="160" height="78" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="314" y="72" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Cost estimator</text>
  <text x="314" y="94" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.8">cost = base + area·k</text>
  <text x="314" y="110" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.8">clamped to cost_max</text>
  <!-- cost arrow -->
  <line x1="394" y1="85" x2="440" y2="85" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#c)"/>
  <text x="417" y="76" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">N tokens</text>
  <!-- bucket -->
  <rect x="442" y="30" width="150" height="150" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="517" y="24" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">Redis bucket</text>
  <rect x="458" y="96" width="118" height="70" rx="4" fill="var(--accent, #7c3aed)" opacity="0.18"/>
  <text x="517" y="128" text-anchor="middle" font-size="10.5" fill="currentColor">tokens</text>
  <text x="517" y="150" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">cap = 100</text>
  <!-- refill -->
  <line x1="517" y1="30" x2="517" y2="94" stroke="#10b981" stroke-width="1.5" marker-end="url(#g)"/>
  <text x="600" y="60" font-size="10.5" fill="#065f46">refill 20/s</text>
  <!-- decision -->
  <line x1="592" y1="110" x2="636" y2="110" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#c)"/>
  <rect x="638" y="70" width="96" height="46" rx="6" fill="#d1fae5" stroke="#10b981" stroke-width="1.3"/>
  <text x="686" y="90" text-anchor="middle" font-size="10.5" fill="#065f46" font-weight="600">tokens ≥ N</text>
  <text x="686" y="105" text-anchor="middle" font-size="9.5" fill="#065f46">admit · deduct</text>
  <rect x="638" y="130" width="96" height="46" rx="6" fill="#fee2e2" stroke="#ef4444" stroke-width="1.3"/>
  <text x="686" y="150" text-anchor="middle" font-size="10.5" fill="#991b1b" font-weight="600">tokens &lt; N</text>
  <text x="686" y="165" text-anchor="middle" font-size="9.5" fill="#991b1b">429 · Retry-After</text>
  <!-- annotation -->
  <text x="380" y="240" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85">A 300 km radius withdraws many tokens and drains the budget fast; a point lookup barely moves it.</text>
  <text x="380" y="262" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">Retry-After = ceil((N − tokens) / refill_rate)</text>
  <defs>
    <marker id="c" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="var(--accent, #7c3aed)"/></marker>
    <marker id="g" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#10b981"/></marker>
  </defs>
</svg>

---

## Runnable implementation

Two pieces: a pure-Python cost estimator that turns request parameters into a token count, and an atomic Redis token bucket that refills and deducts in one Lua script.

```python
# app/cost_throttle.py
import math
import time
from dataclasses import dataclass
from redis.asyncio import Redis

# ---- 1. Cost estimation -------------------------------------------------
# Turn request geometry into a token cost. Keep it cheap and monotonic:
# bigger area / radius / feature count => strictly more tokens.

BASE_COST = 1.0          # every request costs at least this
AREA_WEIGHT = 40.0       # tokens per square degree of bbox
RADIUS_WEIGHT = 0.05     # tokens per km of ST_DWithin radius
FEATURE_WEIGHT = 0.002   # tokens per requested feature
COST_MAX = 60.0          # hard ceiling: one request can never cost more than this


def estimate_bbox_cost(minx: float, miny: float, maxx: float, maxy: float) -> float:
    # Area in square degrees is a coarse but effective proxy for how many
    # candidate rows a GiST index scan must consider. See the bounding-box
    # queries guide for how this same envelope drives the actual query.
    area = abs((maxx - minx) * (maxy - miny))
    return min(COST_MAX, BASE_COST + area * AREA_WEIGHT)


def estimate_radius_cost(radius_m: float) -> float:
    # ST_DWithin cost grows with the searched area (~ radius squared), but a
    # linear-in-km charge is a defensible, cheap approximation that still
    # punishes large radii hard once clamped.
    radius_km = radius_m / 1000.0
    return min(COST_MAX, BASE_COST + radius_km * RADIUS_WEIGHT)


# ---- 2. Atomic token bucket --------------------------------------------
# KEYS[1] = bucket key
# ARGV: now_ms, refill_per_sec, capacity, cost
# Returns {allowed(1|0), tokens_left_or_retry_ms}
TOKEN_BUCKET_LUA = """
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local rate   = tonumber(ARGV[2])          -- tokens per second
local cap    = tonumber(ARGV[3])
local cost   = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil then tokens = cap; ts = now end

-- Refill by elapsed time, capped at capacity.
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(cap, tokens + elapsed * rate)

if tokens >= cost then
    tokens = tokens - cost
    redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
    redis.call('PEXPIRE', key, math.ceil(cap / rate * 1000))
    return {1, tokens}
end

-- Not enough: how long until the shortfall refills?
local deficit = cost - tokens
local retry_ms = math.ceil(deficit / rate * 1000)
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(cap / rate * 1000))
return {0, retry_ms}
"""


@dataclass
class Verdict:
    allowed: bool
    tokens_left: float
    retry_after: int


class CostThrottle:
    def __init__(self, redis: Redis, refill_per_sec: float, capacity: float, prefix: str = "cb"):
        self.redis = redis
        self.rate = refill_per_sec
        self.capacity = capacity
        self.prefix = prefix
        self._sha: str | None = None

    async def _load(self) -> str:
        if self._sha is None:
            self._sha = await self.redis.script_load(TOKEN_BUCKET_LUA)
        return self._sha

    async def spend(self, identity: str, cost: float) -> Verdict:
        key = f"{self.prefix}:{identity}"
        now_ms = int(time.time() * 1000)
        sha = await self._load()
        allowed, meta = await self.redis.evalsha(
            sha, 1, key, now_ms, self.rate, self.capacity, cost,
        )
        if allowed == 1:
            return Verdict(True, float(meta), 0)
        return Verdict(False, 0.0, max(1, math.ceil(int(meta) / 1000)))
```

Enforce it in a FastAPI dependency that estimates cost from the actual query parameters before the database is touched:

```python
# app/routes/geofence.py
from fastapi import APIRouter, Depends, Request, HTTPException, Query
from app.cost_throttle import CostThrottle, estimate_radius_cost

router = APIRouter()

def get_throttle(request: Request) -> CostThrottle:
    # 100-token bucket refilling at 20 tokens/s per client.
    return CostThrottle(request.app.state.redis, refill_per_sec=20, capacity=100)

@router.get("/within")
async def within(
    request: Request,
    lng: float, lat: float,
    radius: float = Query(..., gt=0, le=50000, description="metres, capped at 50 km"),
    throttle: CostThrottle = Depends(get_throttle),
):
    cost = estimate_radius_cost(radius)
    identity = request.headers.get("x-api-key") or request.client.host
    verdict = await throttle.spend(f"within:{identity}", cost)
    if not verdict.allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Query too expensive for remaining budget (cost={cost:.1f}).",
            headers={"Retry-After": str(verdict.retry_after)},
        )
    # ... run the ST_DWithin query here, now safely bounded ...
    return {"tokens_left": round(verdict.tokens_left, 1)}
```

---

The price list is the policy — everything else in a cost-based limiter is bookkeeping.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tokens charged by request shape: tile at z14 1 token, bbox under 1 deg² 2, bbox 1–25 deg² 12, bbox over 25 deg² 60, export, unbounded 400 — a minute of budget" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Tokens charged by request shape</title>
  <desc>A horizontal bar chart. tile at z14 is 1 token. bbox under 1 deg² is 2. bbox 1–25 deg² is 12. bbox over 25 deg² is 60. export, unbounded is 400 — a minute of budget. Prices should be derived from measured database time, then rounded generously; a wrong price is worse than a coarse one.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Tokens charged by request shape</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">tile at z14</text>
  <rect x="250" y="48" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">1 token</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">bbox under 1 deg²</text>
  <rect x="250" y="82" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="95" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">2</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">bbox 1–25 deg²</text>
  <rect x="250" y="116" width="10" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="268" y="129" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">12</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">bbox over 25 deg²</text>
  <rect x="250" y="150" width="51" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="309" y="163" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">60</text>
  <text x="20" y="197" font-size="10.5" fill="currentColor">export, unbounded</text>
  <rect x="250" y="184" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="197" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">400 — a minute of</text>
  <text x="20" y="234" font-size="10.5" fill="var(--muted, #7c6fb0)">Prices should be derived from measured database time, then rounded generously; a wrong price is worse than a coarse one.</text>
</svg>

## Key parameters & options

| Parameter | Meaning | Typical value | Notes |
|---|---|---|---|
| `capacity` | Bucket size — the burst a client may spend at once | `100` | Larger allows bigger bursts of cheap requests |
| `refill_per_sec` | Steady-state token grant | `20` | Sets the sustained cost-per-second ceiling |
| `BASE_COST` | Floor cost of any request | `1.0` | Stops zero-cost requests from being free-for-all |
| `AREA_WEIGHT` | Tokens per square degree of bbox | `40` | Tune so a full-continent bbox clamps at `COST_MAX` |
| `RADIUS_WEIGHT` | Tokens per km of radius | `0.05` | Calibrate against measured `ST_DWithin` timings |
| `COST_MAX` | Per-request cost ceiling | `60` | Below `capacity`, so one request can never lock the client out permanently |
| `PEXPIRE` | Bucket TTL | `ceil(cap/rate)` s | Idle buckets evict; refill math reconstructs state on return |

---

A bucket has two parameters and they do different jobs, which is where most misconfigurations come from.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A burst against a token bucket: idle then burst then throttled then refill then normal" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>A burst against a token bucket</title>
  <desc>A horizontal timeline. idle: bucket full. burst: drains fast. throttled: 429 with Retry-After. refill: steady rate resumes. normal: headroom restored. The refill rate sets the sustained allowance and the bucket size sets the burst; tuning one without the other never behaves as intended.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">A burst against a token bucket</text>
  <rect x="20" y="92" width="109" height="34" rx="5" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="74" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">idle</text>
  <text x="74" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">bucket full</text>
  <rect x="133" y="92" width="109" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="187" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">burst</text>
  <text x="187" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">drains fast</text>
  <rect x="246" y="92" width="166" height="34" rx="5" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="329" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">throttled</text>
  <text x="329" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">429 with Retry-After</text>
  <rect x="416" y="92" width="166" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.4"/>
  <text x="499" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">refill</text>
  <text x="499" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">steady rate resumes</text>
  <rect x="586" y="92" width="109" height="34" rx="5" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="640" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">normal</text>
  <text x="640" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">headroom restored</text>
  <text x="20" y="184" font-size="10.5" fill="var(--muted, #7c6fb0)">The refill rate sets the sustained allowance and the bucket size sets the burst; tuning one without the other never behaves as intended.</text>
</svg>

## Gotchas & failure modes

- **Underestimating cost lets the expensive case through.** If `RADIUS_WEIGHT` is too low, a large-radius query costs almost the same as a small one and the throttle does nothing. Calibrate weights against real `EXPLAIN ANALYZE` timings — pull the actual plans with [query plan analysis and index tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) and set weights so a query that runs 10× longer costs roughly 10× the tokens.

- **Unbounded radius or bbox exhausts the budget in one call.** Without `COST_MAX` and a route-level `le=` cap on `radius`, a single request for a 5,000 km radius withdraws thousands of tokens (or worse, more than `capacity`, which can never be satisfied). Clamp cost to `COST_MAX < capacity` *and* reject absurd inputs with a `422` at the parameter level, as the `Query(..., le=50000)` above does.

- **The cost of the cost estimate itself.** If estimating cost requires its own database round trip (for example querying how many features fall in the bbox), you have added a query to save a query. Keep the estimate a pure function of request parameters — area, radius, requested limit — never a database call.

- **Refill clock skew.** Elapsed time is computed from the caller-supplied `now_ms`. As with any distributed limiter, drift between API replicas smears the refill rate; keep NTP tight or read `TIME` from Redis inside the script.

- **Silent negative balances.** If you deduct before checking (`tokens = tokens - cost` unconditionally), a bucket can go negative and a later cheap request is wrongly rejected for a long time. Always check `tokens >= cost` before deducting, as the script does.

---

## Verification

Confirm that cost scales with radius — a cheap request passes many times, an expensive one drains the bucket fast:

```bash
# Cheap: 10 m radius, cost ~1 token — should pass repeatedly against a 100-token bucket
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code} " \
    -H "x-api-key: demo" "http://localhost:8000/within?lng=13.4&lat=52.5&radius=10"
done; echo   # expect all 200s (20 tokens spent of 100)

# Expensive: 50 km radius clamps near COST_MAX (~60) — the 2nd request should 429
curl -s -o /dev/null -w "%{http_code}\n" -H "x-api-key: heavy" \
  "http://localhost:8000/within?lng=13.4&lat=52.5&radius=50000"   # 200
curl -s -o /dev/null -w "%{http_code}\n" -H "x-api-key: heavy" \
  "http://localhost:8000/within?lng=13.4&lat=52.5&radius=50000"   # 429 (budget < cost)
```

Assert the estimator is monotonic — larger radius must never cost less:

```python
from app.cost_throttle import estimate_radius_cost
costs = [estimate_radius_cost(r) for r in (100, 1000, 20000, 500000)]
assert costs == sorted(costs)          # strictly non-decreasing
assert costs[-1] <= 60.0               # clamped at COST_MAX
```

---

## Related

- [Rate Limiting Geofence & Tile Endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/) — where cost-based throttling fits among fixed-window, sliding-window, and token-bucket approaches
- [Redis Sliding-Window Rate Limits for Spatial Endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/redis-sliding-window-rate-limits-for-spatial-endpoints/) — the flat-count limiter to layer beneath cost throttling
- [Bounding-Box Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — the same envelope geometry that feeds the cost estimate
- [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — measure real query cost to calibrate the token weights

← Back to [Rate Limiting Geofence & Tile Endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/)
