---
layout: layouts/page.njk
title: "Edge Routing & Tile Delivery at Scale"
description: "Put a CDN or edge-compute tier in front of a FastAPI ST_AsMVT origin to serve vector tiles at scale: the /tiles/{z}/{x}/{y}.mvt contract, versioned cache keys, invalidation on data change, and signed tile access."
slug: "edge-routing-and-tile-delivery-at-scale"
breadcrumb:
  - label: "Deploying & Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Edge Routing & Tile Delivery at Scale"
    url: "/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/"
datePublished: "2026-01-20"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Edge Routing & Tile Delivery at Scale",
      "description": "Put a CDN or edge-compute tier in front of a FastAPI ST_AsMVT origin to serve vector tiles at scale: the /tiles/{z}/{x}/{y}.mvt contract, versioned cache keys, invalidation on data change, and signed tile access.",
      "datePublished": "2026-01-20",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com"},
      "mainEntityOfPage": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/"
    },
    {
      "@type": "Article",
      "headline": "Edge Routing & Tile Delivery at Scale",
      "datePublished": "2026-01-20",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/"},
        {"@type": "ListItem", "position": 2, "name": "Deploying & Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/"},
        {"@type": "ListItem", "position": 3, "name": "Edge Routing & Tile Delivery at Scale", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Serve Vector Tiles at Scale Through an Edge Tier",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Define the versioned /tiles/{z}/{x}/{y}.mvt contract and cache key"},
        {"@type": "HowToStep", "position": 2, "name": "Implement the FastAPI ST_AsMVT origin route with correct headers"},
        {"@type": "HowToStep", "position": 3, "name": "Choose origin-pull CDN, edge compute, or a pre-rendered tile store"},
        {"@type": "HowToStep", "position": 4, "name": "Invalidate on data change by bumping the version segment"},
        {"@type": "HowToStep", "position": 5, "name": "Authorize tile access with signed URLs and verify edge hit ratio"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Should the CDN cache key include the tile layer and data version?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. The minimal correct cache key is z, x, y, layer, and a data-version token. Omitting the layer causes two layers requesting the same z/x/y to collide and serve each other's bytes. Omitting the version means you can never invalidate atomically — you are stuck purging every path or waiting for TTL expiry. Encode the version in the path (/tiles/v42/roads/10/512/340.mvt) so it becomes part of the key for free."
          }
        },
        {
          "@type": "Question",
          "name": "How do I invalidate CDN tiles the moment underlying data changes?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Do not purge z/x/y paths one by one — a single metro area at zoom 14 is tens of thousands of tiles. Instead put a monotonic version segment in the tile path and bump it on publish. New requests resolve to a fresh key that misses the edge and repopulates from the origin, while old versioned tiles age out by TTL. Pair this with a Cache-Tag or Surrogate-Key purge for emergency invalidation."
          }
        },
        {
          "@type": "Question",
          "name": "How do I stop an attacker from requesting unbounded zoom levels?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Reject out-of-range coordinates before any database work: enforce 0 <= z <= max_zoom and 0 <= x, y < 2**z, returning 400 for anything outside that box. Without the guard, a request for z=30 forces the origin to compute an ST_AsMVT over an absurd envelope and pollutes the edge with millions of unique, never-reused keys — a cache-fill denial-of-service."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/)

# Edge routing and tile delivery at scale

A vector-tile endpoint that works flawlessly for one developer on localhost becomes a database-melting liability the moment a map goes viral: a single MapLibre client panning across a city fires dozens of `/tiles/{z}/{x}/{y}.mvt` requests per second, and every uncached one runs a fresh `ST_AsMVT` aggregation on PostGIS. The fix is not a bigger database — it is an edge tier that answers the overwhelming majority of tile requests before they ever reach your FastAPI origin. This guide covers the tile contract that makes edge caching correct, how to build cache keys that invalidate cleanly, the three architectures for putting a CDN or edge runtime in front of the origin, and how to authorize tile access without destroying the cache hit ratio.

The tile-generation mechanics — the `ST_AsMVT` and `ST_AsMVTGeom` query, the Web Mercator envelope math, and the Redis hot-tile layer — are covered in depth in [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/). This page assumes that origin exists and focuses on the operational layer above it: routing, keying, versioning, and offload. For where this fits in the wider operational stack, see the [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/) overview.

---

## The tile contract and why it constrains everything

Everything downstream — the cache key, the invalidation strategy, the signing scheme — is determined by the shape of the URL. A production tile contract carries five pieces of identity in the path, not the query string, because most CDNs key on the path by default and ignore query parameters unless explicitly configured:

```
/tiles/{version}/{layer}/{z}/{x}/{y}.mvt
        │        │       │   │   │
        │        │       │   │   └── tile row  (0 <= y < 2**z)
        │        │       │   └────── tile col  (0 <= x < 2**z)
        │        │       └────────── zoom      (0 <= z <= max_zoom)
        │        └────────────────── layer / source name
        └─────────────────────────── monotonic data version token
```

The `.mvt` extension (equivalently `.pbf` in some stacks) makes the MIME type unambiguous at the edge, which matters because a CDN must be told to cache `application/vnd.mapbox-vector-tile` — several providers do not cache unknown binary types by default. Putting `version` and `layer` in the path rather than the query string is the single most important decision on this page: it makes the CDN cache key correct with zero extra configuration, and it turns invalidation into a path change rather than a purge storm.

---

## Prerequisites & Environment

This layer sits on top of a working async FastAPI + PostGIS tile origin. Confirm these baselines before adding an edge tier:

| Component | Minimum version | Why it matters |
|---|---|---|
| PostgreSQL | 14+ | Parallel aggregation for `ST_AsMVT` under concurrent tile load |
| PostGIS | 3.2+ | Stable `ST_AsMVT` / `ST_AsMVTGeom` memory handling |
| FastAPI | 0.100+ | Lifespan-managed `asyncpg` pool; `Response` with raw bytes |
| asyncpg | 0.29+ | Non-blocking binary protocol for the MVT `bytea` return |
| CDN / edge | Cloudflare, CloudFront, or Fastly | Must cache the vector-tile MIME type and honour `s-maxage` |
| A GiST index | — | The tile bbox filter is a sequential scan without it |

Install the origin dependencies:

```bash
pip install "fastapi>=0.100" "uvicorn>=0.27" "asyncpg>=0.29"
```

Your geometry column needs a GiST spatial index or every cache miss becomes a full table scan. See [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) for confirming the index engages with `EXPLAIN ANALYZE`, and [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) for keeping the origin pool from exhausting under the miss traffic that survives the edge.

---

## Architecture: edge tier in front of the origin

The map client never talks to PostGIS. It talks to the edge, which either answers from cache or forwards a miss to the FastAPI origin, which runs `ST_AsMVT` and returns bytes the edge stores under the versioned key.

<svg viewBox="0 0 780 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Edge tier routing vector tile requests: map client to edge cache to FastAPI origin to PostGIS, with a versioned cache key and version-bump invalidation" style="width:100%;max-width:780px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Edge routing for vector tiles</title>
  <desc>A map client requests /tiles/v42/roads/10/512/340.mvt. The edge tier checks a cache keyed on version, layer, z, x and y. A hit returns bytes directly. A miss forwards to the FastAPI origin, which runs ST_AsMVT against PostGIS, returns the tile, and the edge stores it. A publish step bumps the version from v42 to v43, changing every key and forcing repopulation.</desc>
  <rect x="0" y="0" width="780" height="340" rx="12" fill="var(--surface, #f5f3ff)"/>
  <!-- Client -->
  <rect x="24" y="120" width="120" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="84" y="148" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Map Client</text>
  <text x="84" y="166" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">MapLibre / Leaflet</text>
  <text x="84" y="180" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">panning = many tiles</text>
  <!-- Edge -->
  <rect x="216" y="96" width="150" height="118" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="291" y="122" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Edge Tier</text>
  <text x="291" y="140" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">CDN PoP / Worker</text>
  <text x="291" y="160" text-anchor="middle" font-size="10" fill="currentColor">key: version · layer</text>
  <text x="291" y="174" text-anchor="middle" font-size="10" fill="currentColor">· z · x · y</text>
  <text x="291" y="194" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">honours s-maxage</text>
  <text x="291" y="206" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">SWR revalidate</text>
  <!-- Origin -->
  <rect x="438" y="96" width="150" height="118" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="513" y="122" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">FastAPI Origin</text>
  <text x="513" y="142" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">asyncpg pool</text>
  <text x="513" y="158" text-anchor="middle" font-size="10" fill="currentColor">coord validation</text>
  <text x="513" y="174" text-anchor="middle" font-size="10" fill="currentColor">signed-URL check</text>
  <text x="513" y="194" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">sets Cache-Control</text>
  <!-- PostGIS -->
  <rect x="644" y="120" width="112" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="700" y="148" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">PostGIS</text>
  <text x="700" y="166" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">ST_AsMVT</text>
  <text x="700" y="180" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">GiST bbox filter</text>
  <!-- Arrows request path -->
  <line x1="144" y1="150" x2="214" y2="150" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="179" y="142" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">request</text>
  <line x1="366" y1="155" x2="436" y2="155" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="401" y="147" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">miss</text>
  <line x1="588" y1="155" x2="642" y2="155" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Cache hit short-circuit -->
  <path d="M291 96 Q291 56 187 56 Q84 56 84 118" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5" stroke-dasharray="5,3"/>
  <text x="200" y="48" text-anchor="middle" font-size="10" fill="var(--accent, #7c3aed)">edge HIT → bytes returned, origin untouched</text>
  <!-- Version bump / invalidation -->
  <rect x="216" y="256" width="372" height="56" rx="8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="6,3" opacity="0.8"/>
  <text x="402" y="278" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">Publish: bump version  v42 → v43</text>
  <text x="402" y="296" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">every key changes → old tiles age out by TTL, new keys miss and repopulate</text>
  <line x1="402" y1="256" x2="330" y2="214" stroke="currentColor" stroke-width="1" stroke-dasharray="4,2" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

---

## Decision matrix: where the tile is served from

Three architectures put a caching tier between the client and PostGIS. They differ in who runs the cache-miss logic and where the bytes are generated. Pick before you write config.

| Approach | Miss logic runs at | Origin load | Invalidation | First-byte on miss | Best for |
|---|---|---|---|---|---|
| **Origin-pull CDN** | Nowhere (CDN just forwards) | Every miss hits FastAPI | Version segment + Cache-Tag purge | 20–200 ms (`ST_AsMVT`) | Simplest; most workloads start here |
| **Edge compute** (Workers / Lambda@Edge) | The edge runtime | Only cold-region misses hit FastAPI | Version segment + KV flag | 20–200 ms cold, ~1 ms warm | Coordinate validation, auth, custom keys at the edge |
| **Pre-rendered tile store** (R2 / S3 + CDN) | A batch job, ahead of time | Zero at request time | Rewrite objects under new version prefix | 5–15 ms (object fetch) | Slowly-changing basemaps, huge read:write ratios |

**Origin-pull CDN** is the default and the right starting point: the CDN forwards misses to FastAPI unchanged and caches whatever the origin's `Cache-Control` header permits. **Edge compute** moves coordinate validation, signed-URL checks, and cache-key normalisation into the PoP so invalid or unauthorised requests never consume an origin round-trip — the [Cloudflare Workers edge routing](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/cloudflare-workers-edge-routing-for-vector-tile-endpoints/) walkthrough builds exactly this. **Pre-rendered tile stores** eliminate the database from the hot path entirely by baking every tile up to some zoom into object storage; they trade freshness and storage cost for the lowest possible miss latency, and are the natural extension of the batch generation described in [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/).

Most production systems combine them: an origin-pull CDN for the broad request volume, a pre-rendered store for the low-zoom basemap tiles that everyone requests, and edge compute for authorization.

---

Tile delivery is a caching problem first and a database problem a distant second.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Where a tile request is answered from, by share of traffic: edge cache HIT 91 % · 12 ms, edge MISS, origin cache HIT 6 % · 38 ms, origin generates the tile 2 % · 210 ms, 204 empty tile 1 % · 9 ms" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where a tile request is answered from, by share of traffic</title>
  <desc>A horizontal bar chart. edge cache HIT is 91 % · 12 ms. edge MISS, origin cache HIT is 6 % · 38 ms. origin generates the tile is 2 % · 210 ms. 204 empty tile is 1 % · 9 ms. The 2 % that reaches PostGIS is what capacity planning is actually about — the other 98 % never touches the database.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Where a tile request is answered from, by share of traffic</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">edge cache HIT</text>
  <rect x="250" y="48" width="340" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="598" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">91 % · 12 ms</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">edge MISS, origin cache HIT</text>
  <rect x="250" y="82" width="22" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="280" y="95" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">6 % · 38 ms</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">origin generates the tile</text>
  <rect x="250" y="116" width="7" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="265" y="129" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">2 % · 210 ms</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">204 empty tile</text>
  <rect x="250" y="150" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="163" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">1 % · 9 ms</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">The 2 % that reaches PostGIS is what capacity planning is actually about — the other 98 % never touches the database.</text>
</svg>

## Step-by-Step Implementation

### Step 1: Nail down the cache key

The cache key is the contract. For an origin-pull CDN the key is the path, so `version` and `layer` must live in the path. If you must accept a query parameter (for example `?fields=id,name`), configure the CDN to include it in the key or strip it — never leave it default, or two different field selections will serve each other's bytes. The minimal correct key is:

```
key = (version, layer, z, x, y)
```

Anything the response body depends on must appear in the key. If tiles differ by tenant, the tenant identity must be in the key too — usually derived from the signed token, not a raw header, to prevent [cross-tenant cache bleed](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/).

### Step 2: Set `Cache-Control` correctly at the origin

Because the version is in the path, a versioned tile is immutable — its bytes can never change under that URL. That unlocks the strongest possible caching directive. The exact directive strategy, including `s-maxage`, `stale-while-revalidate`, and `immutable`, is the entire subject of [Caching Vector Tiles at the Edge with Cache-Control](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/). In short:

```python
# Immutable versioned tile: browser and edge may hold it effectively forever
headers = {
    "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
    "Content-Type": "application/vnd.mapbox-vector-tile",
}
```

### Step 3: Reject invalid coordinates before the database

This is a security control, not an optimisation. An unbounded `z` or an out-of-range `x`/`y` produces a unique key that will never be requested again, filling the edge cache with garbage and forcing an origin computation each time. Guard first, always.

### Step 4: Choose origin generation vs pre-generation

For dynamic layers, generate on the origin at miss time (Step 5 below). For a basemap that changes weekly, pre-render every tile up to zoom 12 into an object store under a version prefix and point the CDN at it; a miss becomes an object fetch, not an `ST_AsMVT`. The break-even is roughly: pre-render when the same tile is read more than a few hundred times between data updates.

### Step 5: Invalidate by bumping the version

When data changes, increment the version token (a table row, a Redis counter, or the max `updated_at` epoch) and expose the new value to the map client's style JSON. New requests resolve to `/tiles/v43/...`, which misses everywhere and repopulates from the origin, while `v42` tiles quietly expire. No purge storm, no partial-update flicker. Keep an emergency Cache-Tag / Surrogate-Key purge available for the rare case where you must evict a bad `v42` immediately.

---

## Production Code Example

A complete FastAPI origin route for the versioned MVT contract. It validates coordinates, verifies a signed token, runs `ST_AsMVT`, and sets immutable cache headers. This is the origin that both the [Workers edge router](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/cloudflare-workers-edge-routing-for-vector-tile-endpoints/) and a plain origin-pull CDN sit in front of.

```python
# app/routes/tiles.py
import hmac, hashlib, time
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

router = APIRouter()

MAX_ZOOM = 15
TILE_SIGNING_KEY = b"rotate-me-from-secrets-manager"

TILE_CIRCUMFERENCE_M = 40075016.68557849       # EPSG:3857 circumference
ORIGIN_SHIFT = TILE_CIRCUMFERENCE_M / 2

def tile_to_bounds_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    n = 2.0 ** z
    return (
        (x / n) * TILE_CIRCUMFERENCE_M - ORIGIN_SHIFT,
        ORIGIN_SHIFT - ((y + 1) / n) * TILE_CIRCUMFERENCE_M,
        ((x + 1) / n) * TILE_CIRCUMFERENCE_M - ORIGIN_SHIFT,
        ORIGIN_SHIFT - (y / n) * TILE_CIRCUMFERENCE_M,
    )

def verify_tile_token(layer: str, token: str, exp: int) -> bool:
    # Signed access: token authorises (layer, expiry). Constant-time compare.
    if exp < int(time.time()):
        return False
    msg = f"{layer}:{exp}".encode()
    expected = hmac.new(TILE_SIGNING_KEY, msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, token)

TILE_SQL = """
    SELECT ST_AsMVT(q, $6, 4096, 'geom') AS tile
    FROM (
        SELECT
            ST_AsMVTGeom(
                ST_Transform(geom, 3857),
                ST_MakeEnvelope($1, $2, $3, $4, 3857),
                4096, 256, true
            ) AS geom,
            id, name, category
        FROM spatial_features
        WHERE layer_name = $6
          AND geom && ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 3857), 4326)
          AND data_version <= $5           -- serve the snapshot pinned by the URL
    ) AS q
    WHERE q.geom IS NOT NULL
"""

@router.get("/tiles/{version}/{layer}/{z}/{x}/{y}.mvt")
async def get_tile(
    request: Request,
    version: int, layer: str, z: int, x: int, y: int,
    token: str = "", exp: int = 0,
):
    # 1. Reject out-of-range coordinates BEFORE any database work (see Failure Modes)
    if not (0 <= z <= MAX_ZOOM and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
        raise HTTPException(status_code=400, detail="Invalid tile coordinates")

    # 2. Authorize: signed token scoped to the layer, short expiry
    if not verify_tile_token(layer, token, exp):
        raise HTTPException(status_code=403, detail="Invalid or expired tile token")

    minx, miny, maxx, maxy = tile_to_bounds_3857(z, x, y)

    async with request.app.state.pool.acquire() as conn:
        row = await conn.fetchrow(TILE_SQL, minx, miny, maxx, maxy, version, layer)

    tile_bytes = row["tile"] if row and row["tile"] else b""

    # 3. Immutable because the version is in the path — bytes can never change here
    return Response(
        content=tile_bytes,
        media_type="application/vnd.mapbox-vector-tile",
        headers={
            "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
            "ETag": f'"{version}-{layer}-{z}-{x}-{y}"',
            "Vary": "Accept-Encoding",
        },
    )
```

Returning an empty `200` (not `404`) for a sparsely populated tile is deliberate: map clients treat `404` as an error and retry aggressively, and a `404` is far harder to cache than an empty `200`.

---

## Verification & Testing

**Fetch a tile and inspect the caching headers:**

```bash
curl -sI "https://cdn.example.com/tiles/42/roads/10/512/340.mvt?token=abc&exp=1799999999"
```

```
HTTP/2 200
content-type: application/vnd.mapbox-vector-tile
cache-control: public, max-age=31536000, s-maxage=31536000, immutable
cf-cache-status: HIT          # or MISS on first fetch, then HIT
age: 214
etag: "42-roads-10-512-340"
vary: accept-encoding
```

The second identical request must show `cf-cache-status: HIT` (Cloudflare), `x-cache: Hit from cloudfront` (CloudFront), or `x-cache: HIT` (Fastly), and a non-zero `age`. If it stays `MISS`, the origin is not sending a cacheable `Cache-Control`, or a query parameter is fragmenting the key.

**Confirm the coordinate guard rejects abuse:**

```bash
curl -sI "https://cdn.example.com/tiles/42/roads/30/9/9.mvt?token=abc&exp=1799999999" | head -1
# HTTP/2 400   ← z=30 is above MAX_ZOOM; never reaches the database
```

**Confirm the MVT decodes** with a quick assertion against the origin directly (bypassing the edge):

```python
import httpx, mapbox_vector_tile
r = httpx.get("http://origin:8000/tiles/42/roads/10/512/340.mvt",
              params={"token": tok, "exp": exp})
assert r.status_code == 200
assert r.headers["content-type"] == "application/vnd.mapbox-vector-tile"
decoded = mapbox_vector_tile.decode(r.content)
assert "roads" in decoded            # layer present in the tile
```

---

Invalidating tiles is where edge delivery gets genuinely hard, and there are only two workable answers.

<svg viewBox="0 0 720 198" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two invalidation strategies for a tile set: purge by URL versus version the path" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Two invalidation strategies for a tile set</title>
  <desc>Two panels. purge by URL: precise: only changed tiles go needs a list of affected z/x/y expensive at high tile counts races with in-flight requests version the path: /v43/tiles/… — old URLs simply age out no purge API call at all clients pick up the new path on reload costs one cache generation of storage Versioning trades storage for simplicity, and storage at the edge is cheap. Purging is for the rare targeted correction.</desc>
  <rect x="0" y="0" width="720" height="198" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Two invalidation strategies for a tile set</text>
  <rect x="16" y="40" width="336" height="122" rx="9" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.5"/>
  <text x="34" y="62" font-size="11" font-weight="700" fill="var(--viz-warn, #8a5000)">purge by URL</text>
  <text x="34" y="84" font-size="10" fill="currentColor">precise: only changed tiles go</text>
  <text x="34" y="106" font-size="10" fill="currentColor">needs a list of affected z/x/y</text>
  <text x="34" y="128" font-size="10" fill="currentColor">expensive at high tile counts</text>
  <text x="34" y="150" font-size="10" fill="currentColor">races with in-flight requests</text>
  <rect x="368" y="40" width="336" height="122" rx="9" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="386" y="62" font-size="11" font-weight="700" fill="var(--viz-good, #1f6b3a)">version the path</text>
  <text x="386" y="84" font-size="10" fill="currentColor">/v43/tiles/… — old URLs simply age out</text>
  <text x="386" y="106" font-size="10" fill="currentColor">no purge API call at all</text>
  <text x="386" y="128" font-size="10" fill="currentColor">clients pick up the new path on reload</text>
  <text x="386" y="150" font-size="10" fill="currentColor">costs one cache generation of storage</text>
  <text x="20" y="194" font-size="10.5" fill="var(--muted, #7c6fb0)">Versioning trades storage for simplicity, and storage at the edge is cheap. Purging is for the rare targeted correction.</text>
</svg>

## Failure Modes & Edge Cases

1. **Cache poisoning via unkeyed inputs.** If the response varies on something not in the cache key — an unnormalised `Accept-Encoding`, a `?fields=` param the CDN ignores, or a header the origin reads — an attacker can seed the edge with a response that other users then receive. Fix: everything the body depends on must be in the key, and set `Vary: Accept-Encoding` so compressed and uncompressed variants never collide. Never let the origin vary on an uncontrolled request header.

2. **Stale tiles after a data update.** Bytes were cached under `v42` with a one-year TTL, data changed, and clients still see old geometry. Fix: never mutate a tile in place — bump the version segment on publish (Step 5) so the URL itself changes. If you cached mutable tiles without a version, you are forced into a full-path purge, which is slow and eventually consistent.

3. **Unbounded zoom / coordinate flood.** A request for `z=30` or `x=2**z` forces an `ST_AsMVT` over a nonsensical envelope and creates a never-reused key, a cache-fill denial-of-service. Fix: the `0 <= z <= MAX_ZOOM and 0 <= x,y < 2**z` guard in Step 3, returning `400` before the pool is touched.

4. **Query-string key fragmentation.** A signed `?token=` and `?exp=` in the URL become part of the key on some CDNs, so every user's unique token creates a unique cache entry and the hit ratio collapses to zero. Fix: verify the token at an edge worker and strip it before the cache lookup, or configure the CDN to ignore `token`/`exp` in the cache key while still forwarding them to the origin.

5. **`404` storms on empty tiles.** Returning `404` for tiles with no features makes clients retry and defeats caching. Fix: return an empty `200` with the same immutable headers; the edge caches "this tile is empty" and stops the retries.

6. **Origin serves `no-cache` by accident.** A global middleware or reverse proxy injects `Cache-Control: no-cache` and the edge dutifully forwards every request to the origin. Fix: assert on the header in an integration test (`curl -I`), and make the tile route set its own `Cache-Control` last so it wins.

7. **Version bump without client awareness.** You bump to `v43` but the map style still requests `v42`, so clients see stale tiles until they reload the style. Fix: derive the tile URL template in the style JSON from the same version source, and set a short TTL on the style document itself.

---

## Performance Notes

**Edge hit ratio is the metric that matters.** At a 95% edge hit ratio, only 1 in 20 tile requests reaches the origin; at 99% it is 1 in 100. The difference is enormous: a map with 10,000 tile req/s at 95% still sends 500 req/s of `ST_AsMVT` to PostGIS, but at 99% it sends 100 req/s. Immutable versioned tiles trend toward 99%+ because a given `(version, z, x, y)` is requested identically by every user in a region and never invalidated mid-life.

**Origin offload compounds with pre-rendering.** Baking low-zoom tiles (z 0–8, only ~87,000 tiles worldwide) into an object store removes the most-requested, most-expensive-to-aggregate tiles from the database entirely. The origin then only computes high-zoom, low-traffic tiles on demand.

**Miss latency is dominated by `ST_AsMVT`.** A cold tile is 20–200 ms depending on feature density; an edge hit is 5–15 ms including network. This is why keeping the origin pool healthy still matters — the surviving miss traffic must be served fast so the edge repopulates quickly after a version bump. Route the origin through PgBouncer as described in [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/), and put a [Redis hot-tile cache](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) between FastAPI and PostGIS to absorb the thundering-herd of misses that follows every publish.

**Compression happens once.** MVTs are already compact protobuf, but gzip still shaves 20–40%. Let the edge compress and cache the compressed variant — do not compress on the origin per request, or you burn CPU on every miss for no additional cache benefit.

---

## FAQ

### Should the CDN cache key include the tile layer and data version?

Yes. The minimal correct cache key is `z`, `x`, `y`, `layer`, and a data-version token. Omitting the layer causes two layers requesting the same `z/x/y` to collide and serve each other's bytes. Omitting the version means you can never invalidate atomically — you are stuck purging every path or waiting for TTL expiry. Encode the version in the path (`/tiles/v42/roads/10/512/340.mvt`) so it becomes part of the key for free.

### How do I invalidate CDN tiles the moment underlying data changes?

Do not purge `z/x/y` paths one by one — a single metro area at zoom 14 is tens of thousands of tiles. Instead put a monotonic version segment in the tile path and bump it on publish. New requests resolve to a fresh key that misses the edge and repopulates from the origin, while old versioned tiles age out by TTL. Pair this with a Cache-Tag or Surrogate-Key purge for emergency invalidation.

### How do I stop an attacker from requesting unbounded zoom levels?

Reject out-of-range coordinates before any database work: enforce `0 <= z <= max_zoom` and `0 <= x, y < 2**z`, returning `400` for anything outside that box. Without the guard, a request for `z=30` forces the origin to compute an `ST_AsMVT` over an absurd envelope and pollutes the edge with millions of unique, never-reused keys — a cache-fill denial-of-service.

---

## Related

- [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — the `ST_AsMVT` origin query, Web Mercator math, and Redis hot-tile layer this page sits on top of
- [Cloudflare Workers Edge Routing for Vector Tile Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/cloudflare-workers-edge-routing-for-vector-tile-endpoints/) — a Worker that validates coordinates, checks the Cache API, and fetches from the origin on a miss
- [Caching Vector Tiles at the Edge with Cache-Control](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/) — the exact directive strategy for immutable versioned vs mutable tiles
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — keep the origin pool healthy under the miss traffic that survives the edge
- [Redis Caching for Spatial Queries](https://www.geospatial-api.com/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) — absorb the thundering-herd of misses that follows every version bump

← Back to [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/)
</content>
</invoke>
