---
layout: layouts/page.njk
title: "Cloudflare Workers Edge Routing for Vector Tile Endpoints"
description: "A Cloudflare Worker that parses /tiles/{z}/{x}/{y}.mvt, checks the Cache API, fetches from the FastAPI origin on a miss, stores the tile with Cache-Control, and rejects invalid tile coordinates before any origin round-trip."
slug: "cloudflare-workers-edge-routing-for-vector-tile-endpoints"
breadcrumb:
  - label: "Deploying & Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Edge Routing & Tile Delivery at Scale"
    url: "/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/"
  - label: "Cloudflare Workers Edge Routing for Vector Tile Endpoints"
    url: "/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/cloudflare-workers-edge-routing-for-vector-tile-endpoints/"
datePublished: "2026-03-05"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Cloudflare Workers Edge Routing for Vector Tile Endpoints",
      "description": "A Cloudflare Worker that parses /tiles/{z}/{x}/{y}.mvt, checks the Cache API, fetches from the FastAPI origin on a miss, stores the tile with Cache-Control, and rejects invalid tile coordinates before any origin round-trip.",
      "datePublished": "2026-03-05",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Deploying & Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/"},
        {"@type": "ListItem", "position": 2, "name": "Edge Routing & Tile Delivery at Scale", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/"},
        {"@type": "ListItem", "position": 3, "name": "Cloudflare Workers Edge Routing for Vector Tile Endpoints", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/cloudflare-workers-edge-routing-for-vector-tile-endpoints/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Route vector tiles through a Cloudflare Worker",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Parse the /tiles/{z}/{x}/{y}.mvt path and validate coordinate bounds."},
        {"@type": "HowToStep", "position": 2, "text": "Build a normalised cache key and probe the Cache API."},
        {"@type": "HowToStep", "position": 3, "text": "On a miss, fetch the tile from the FastAPI origin."},
        {"@type": "HowToStep", "position": 4, "text": "Attach Cache-Control and store the response with waitUntil."},
        {"@type": "HowToStep", "position": 5, "text": "Add CORS headers so browser map clients can read the tile."}
      ]
    },
    {
      "@type": "Article",
      "headline": "Cloudflare Workers Edge Routing for Vector Tile Endpoints",
      "datePublished": "2026-03-05",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [Edge Routing & Tile Delivery at Scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/)

# Cloudflare Workers edge routing for vector tile endpoints

Put a Cloudflare Worker in front of your FastAPI `ST_AsMVT` origin so tile coordinate validation, cache lookups, and CORS all happen in the edge PoP — and an invalid or already-cached request never costs a database round-trip.

## Context & when to use

A plain origin-pull CDN forwards every cache miss to your origin verbatim: it cannot reject a malformed `z=30` request, cannot normalise a fragmenting query string out of the cache key, and cannot add CORS headers your FastAPI app forgot. A Cloudflare Worker runs your own JavaScript at every PoP before the cache is consulted, which lets you do all three at the edge. This is the edge-compute row of the decision matrix in [Edge Routing & Tile Delivery at Scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/) — reach for it when you need logic in front of the cache, not just caching.

Prefer a Worker over a bare CDN when you want to validate tile coordinates before they reach the origin, strip a signed `token`/`exp` pair out of the cache key so per-user tokens do not shatter the hit ratio, or serve map clients on other origins that need `Access-Control-Allow-Origin`. If none of those apply and your origin already sends correct `Cache-Control`, a plain origin-pull CDN is simpler and you do not need this page.

The Worker below is JavaScript because it runs on Cloudflare's V8 edge runtime, not on your Python origin. Your `ST_AsMVT` tile generation stays in FastAPI exactly as described in [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/); the Worker only routes and caches in front of it.

**Preconditions:** a deployed FastAPI tile origin reachable from Cloudflare, a Worker route bound to your tile hostname (`tiles.example.com/*`), and `wrangler` for local development and deploy.

---

## Request flow

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cloudflare Worker tile routing flow: client to Worker, Worker validates coordinates, checks the Cache API, on a hit returns cached bytes, on a miss fetches the FastAPI origin and stores the tile with waitUntil" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Cloudflare Worker vector tile routing</title>
  <desc>A map client requests a tile from the Worker. The Worker validates z, x and y coordinate bounds, returning 400 if invalid. It builds a normalised cache key and probes the Cache API. On a hit it returns the cached tile. On a miss it fetches from the FastAPI origin, attaches Cache-Control, stores the response asynchronously with waitUntil, and returns it with CORS headers.</desc>
  <rect x="0" y="0" width="760" height="300" rx="12" fill="none"/>
  <!-- Client -->
  <rect x="20" y="120" width="110" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="75" y="146" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Map Client</text>
  <text x="75" y="164" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">MapLibre GL</text>
  <!-- Worker box -->
  <rect x="176" y="40" width="212" height="220" rx="10" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="282" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Cloudflare Worker (per PoP)</text>
  <!-- validate -->
  <rect x="196" y="78" width="172" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="282" y="98" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">1 · validate z/x/y</text>
  <text x="282" y="112" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">out of range → 400</text>
  <!-- cache key -->
  <rect x="196" y="128" width="172" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="282" y="148" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">2 · Cache API probe</text>
  <text x="282" y="162" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">key: normalised URL</text>
  <!-- store -->
  <rect x="196" y="178" width="172" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="282" y="198" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">4 · cache.put()</text>
  <text x="282" y="212" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">via ctx.waitUntil</text>
  <text x="282" y="238" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">Cache API is per-colo</text>
  <!-- Origin -->
  <rect x="600" y="120" width="140" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="670" y="144" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">FastAPI Origin</text>
  <text x="670" y="162" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">ST_AsMVT · PostGIS</text>
  <!-- Arrows -->
  <line x1="130" y1="150" x2="174" y2="150" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="152" y="142" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">GET</text>
  <!-- miss to origin -->
  <line x1="388" y1="148" x2="598" y2="148" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="493" y="140" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">3 · miss → fetch origin</text>
  <!-- origin back -->
  <line x1="598" y1="164" x2="390" y2="164" stroke="var(--accent, #7c3aed)" stroke-width="1.3" stroke-dasharray="5,3" marker-end="url(#b)"/>
  <text x="493" y="180" text-anchor="middle" font-size="9.5" fill="var(--accent, #7c3aed)">tile bytes</text>
  <!-- hit return -->
  <path d="M282 40 Q282 18 178 18 Q75 18 75 118" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#b)"/>
  <text x="200" y="12" text-anchor="middle" font-size="9.5" fill="var(--accent, #7c3aed)">HIT → cached bytes + CORS</text>
  <defs>
    <marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
    <marker id="b" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="var(--accent, #7c3aed)"/></marker>
  </defs>
</svg>

---

## Runnable implementation

The Worker parses the path, validates coordinates, probes the per-colo Cache API, and only on a miss touches the origin. Deploy with `wrangler deploy`.

```javascript
// src/worker.js — Cloudflare Worker: vector tile edge router
// Route binding (wrangler.toml): routes = ["tiles.example.com/tiles/*"]

const MAX_ZOOM = 15;
const ORIGIN = "https://origin.internal.example.com"; // FastAPI ST_AsMVT origin
const ALLOWED_ORIGINS = new Set([
  "https://maps.example.com",
  "https://app.example.com",
]);
// Path shape: /tiles/{version}/{layer}/{z}/{x}/{y}.mvt
const TILE_RE = /^\/tiles\/(\d+)\/([a-z0-9_-]+)\/(\d+)\/(\d+)\/(\d+)\.mvt$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight for browser map clients on another origin
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const match = url.pathname.match(TILE_RE);
    if (!match) {
      return new Response("Not a tile path", { status: 404 });
    }

    const version = Number(match[1]);
    const layer = match[2];
    const z = Number(match[3]);
    const x = Number(match[4]);
    const y = Number(match[5]);

    // 1. Coordinate validation — reject BEFORE any cache or origin work.
    //    An unbounded z or out-of-range x/y is a cache-fill DoS otherwise.
    const dim = 2 ** z;
    if (z < 0 || z > MAX_ZOOM || x < 0 || x >= dim || y < 0 || y >= dim) {
      return new Response("Invalid tile coordinates", { status: 400 });
    }

    // 2. Build a NORMALISED cache key: drop token/exp so per-user signed
    //    URLs do not fragment the cache. The version segment is already in
    //    the path, so it is part of the key for free.
    const token = url.searchParams.get("token") ?? "";
    const exp = url.searchParams.get("exp") ?? "";
    const cacheKeyUrl = new URL(url.origin + url.pathname); // no query string
    const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });
    const cache = caches.default;

    // 3. Probe the per-colo Cache API
    let response = await cache.match(cacheKey);
    if (response) {
      response = new Response(response.body, response);
      response.headers.set("x-edge-cache", "HIT");
      applyCors(response, request);
      return response;
    }

    // 4. MISS — fetch from the FastAPI origin, forwarding auth for verification.
    //    The origin verifies token/exp; the Worker only strips them from the KEY.
    const originUrl = new URL(ORIGIN + url.pathname);
    if (token) originUrl.searchParams.set("token", token);
    if (exp) originUrl.searchParams.set("exp", exp);

    const originResp = await fetch(originUrl.toString(), {
      cf: { cacheTtl: 0 }, // we manage caching explicitly via the Cache API
      headers: { "accept": "application/vnd.mapbox-vector-tile" },
    });

    if (originResp.status === 403) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders(request) });
    }

    // 5. Attach immutable Cache-Control (version is in the path) and store.
    response = new Response(originResp.body, originResp);
    response.headers.set(
      "Cache-Control",
      "public, max-age=31536000, s-maxage=31536000, immutable",
    );
    response.headers.set("Content-Type", "application/vnd.mapbox-vector-tile");
    response.headers.set("x-edge-cache", "MISS");

    // Only cache successful, non-empty-error responses
    if (originResp.status === 200) {
      // waitUntil lets cache.put() finish AFTER the response is sent to the client
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    applyCors(response, request);
    return response;
  },
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function applyCors(response, request) {
  for (const [k, v] of Object.entries(corsHeaders(request))) {
    response.headers.set(k, v);
  }
}
```

---

## Key parameters & options

| Parameter | Purpose | Recommended value |
|---|---|---|
| `MAX_ZOOM` | Upper bound on `z`; anything higher is rejected with `400` | Match the origin's max zoom (12–15 typical) |
| `Cache-Control max-age` / `s-maxage` | TTL for the stored tile in browser and edge | `31536000` for versioned immutable tiles |
| `immutable` directive | Tells the browser never to revalidate within `max-age` | Always, for versioned tile paths |
| `cf: { cacheTtl: 0 }` on origin fetch | Disable Cloudflare's implicit fetch cache so the Cache API is the only cache | `0` — one cache layer, not two |
| `ctx.waitUntil(cache.put(...))` | Store the tile without delaying the client response | Always wrap `cache.put` |
| `caches.default` vs Cache API `caches.open()` | Default cache is shared; named caches isolate namespaces | `caches.default` for tiles |
| Workers KV | Cross-colo shared store for the current data `version` or a signing key | Read version from KV, cache in-Worker per request |
| `ALLOWED_ORIGINS` | Explicit allowlist for `Access-Control-Allow-Origin` | Never reflect arbitrary `Origin` with credentials |

The **Cache API is per-colo**: a tile cached in Frankfurt is not visible in Singapore, so the first request in each region is a miss. This is expected and fine for tiles — each PoP warms independently and the origin sees at most one miss per region per version. If you need cross-colo coordination (for example, a globally consistent data version), read it from Workers KV, which replicates to every PoP within seconds.

---

## Gotchas & failure modes

- **`Cannot perform I/O on behalf of a different request` (`cache.put` after response returned).** Calling `await cache.put(...)` inline can outlive the request scope if you have already returned. Always wrap it in `ctx.waitUntil(cache.put(cacheKey, response.clone()))` so the runtime keeps the store alive after the client response is flushed — and `clone()` the response, because a body stream can only be read once.

- **Cache API is per-colo, so hit ratios look low in tests.** Curling from one machine hits one PoP and looks great; a global audience spreads across ~300 colos, each starting cold. This is not a bug. Do not "fix" it by forcing everything to KV — KV is a key-value store with its own limits, not a tile cache. Let each colo warm from the origin.

- **Signed `token`/`exp` fragments the cache key.** If you build the cache key from the full URL including the query string, every user's unique token creates a unique entry and the hit ratio collapses to zero. Strip `token`/`exp` from the cache key (as above) while still forwarding them to the origin for verification.

- **Invalid coordinates reach the origin.** Forgetting the `z`/`x`/`y` bounds check lets `z=30` through to the origin, which computes a pointless `ST_AsMVT` and caches a never-reused tile. Validate against `2 ** z` first; return `400` before any `fetch` or `cache.match`.

- **Missing CORS makes tiles fail silently in the browser.** A cross-origin MapLibre client that receives a tile without `Access-Control-Allow-Origin` sees an opaque network error with no useful message. Apply CORS on **both** the hit and miss paths, and handle the `OPTIONS` preflight.

- **Caching a `403` or `500`.** Only `cache.put` on `status === 200`. Caching an auth failure or origin error freezes a bad response into the edge for a year under an `immutable` directive.

---

## Verification

Deploy, then confirm the miss-then-hit transition and the coordinate guard:

```bash
# First request in a colo: MISS
curl -sI "https://tiles.example.com/tiles/42/roads/10/512/340.mvt?token=abc&exp=1799999999" \
  | grep -iE 'x-edge-cache|cf-cache-status|cache-control'
# x-edge-cache: MISS

# Second identical request from the same region: HIT
curl -sI "https://tiles.example.com/tiles/42/roads/10/512/340.mvt?token=abc&exp=1799999999" \
  | grep -iE 'x-edge-cache|cf-cache-status'
# x-edge-cache: HIT
# cf-cache-status: HIT

# Out-of-range zoom is rejected at the edge, never reaching the origin:
curl -sI "https://tiles.example.com/tiles/42/roads/30/9/9.mvt" | head -1
# HTTP/2 400

# CORS preflight from an allowed map origin:
curl -sI -X OPTIONS "https://tiles.example.com/tiles/42/roads/10/512/340.mvt" \
  -H "Origin: https://maps.example.com" \
  -H "Access-Control-Request-Method: GET" | grep -i access-control-allow-origin
# access-control-allow-origin: https://maps.example.com
```

A `MISS` that never becomes a `HIT` on repeat means the cache key still contains the query string (fragmenting on `token`), or the origin sent an uncacheable `Cache-Control`.

---

## Related

- [Edge Routing & Tile Delivery at Scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/) — the tile contract, versioned cache keys, and where edge compute fits among the three delivery architectures
- [Caching Vector Tiles at the Edge with Cache-Control](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/) — the exact `Cache-Control` directives the Worker attaches to stored tiles
- [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — the FastAPI `ST_AsMVT` origin this Worker sits in front of

← Back to [Edge Routing & Tile Delivery at Scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/)
</content>
