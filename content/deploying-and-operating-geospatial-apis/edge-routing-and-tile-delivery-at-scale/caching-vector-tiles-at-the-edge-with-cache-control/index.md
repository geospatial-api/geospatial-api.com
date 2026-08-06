---
layout: layouts/page.njk
title: "Caching Vector Tiles at the Edge with Cache-Control"
description: "The exact Cache-Control strategy for vector tiles: immutable versioned tiles vs mutable tiles, s-maxage, stale-while-revalidate, ETag, and purge-on-publish via a version segment in the tile path — with runnable FastAPI header code."
slug: "caching-vector-tiles-at-the-edge-with-cache-control"
breadcrumb:
  - label: "Deploying & Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Edge Routing & Tile Delivery at Scale"
    url: "/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/"
  - label: "Caching Vector Tiles at the Edge with Cache-Control"
    url: "/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/"
datePublished: "2026-04-12"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Caching Vector Tiles at the Edge with Cache-Control",
      "description": "The exact Cache-Control strategy for vector tiles: immutable versioned tiles vs mutable tiles, s-maxage, stale-while-revalidate, ETag, and purge-on-publish via a version segment in the tile path — with runnable FastAPI header code.",
      "datePublished": "2026-04-12",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Deploying & Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/"},
        {"@type": "ListItem", "position": 2, "name": "Edge Routing & Tile Delivery at Scale", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/"},
        {"@type": "ListItem", "position": 3, "name": "Caching Vector Tiles at the Edge with Cache-Control", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Set Cache-Control for vector tiles at the edge",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Decide whether the tile URL is immutable (versioned) or mutable."},
        {"@type": "HowToStep", "position": 2, "text": "Set max-age, s-maxage, and immutable for versioned tiles."},
        {"@type": "HowToStep", "position": 3, "text": "Use stale-while-revalidate and a shorter s-maxage for mutable tiles."},
        {"@type": "HowToStep", "position": 4, "text": "Emit an ETag and set Vary on Accept-Encoding."},
        {"@type": "HowToStep", "position": 5, "text": "Purge on publish by bumping the version segment in the tile path."}
      ]
    },
    {
      "@type": "Article",
      "headline": "Caching Vector Tiles at the Edge with Cache-Control",
      "datePublished": "2026-04-12",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [Edge Routing & Tile Delivery at Scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/)

# Caching vector tiles at the edge with Cache-Control

Get the `Cache-Control` header exactly right so immutable versioned tiles cache for a year, mutable tiles revalidate without a latency stall, and a data publish invalidates the edge by changing the URL rather than purging it.

## Context & when to use

The single header that decides your edge hit ratio is `Cache-Control`. Send it wrong and either the edge over-caches stale geometry for a year, or it revalidates on every request and your `ST_AsMVT` origin melts. There are exactly two cases, and they need different headers: a **versioned tile** whose URL contains a data-version segment (`/tiles/v42/...`) is immutable — its bytes can never change under that URL — and a **mutable tile** at a stable URL (`/tiles/roads/...`) that must reflect data updates within some freshness window.

Use immutable caching whenever you can put a version in the path, which the delivery architecture in [Edge Routing & Tile Delivery at Scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/) is built around — it gives the highest hit ratio and the cleanest invalidation. Use mutable caching with `stale-while-revalidate` only when you cannot version the URL (for example, a third-party consumer hardcoded a stable tile template). This page is the header-level companion to the [Cloudflare Workers edge router](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/cloudflare-workers-edge-routing-for-vector-tile-endpoints/), which attaches these exact directives to tiles it stores, and to the origin query in [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/).

---

## Directive timeline: immutable vs mutable

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two Cache-Control timelines: an immutable versioned tile served for a year until the version bumps, versus a mutable tile that serves fresh, then stale-while-revalidate, then must revalidate" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Cache-Control lifecycle for immutable versus mutable tiles</title>
  <desc>The top timeline shows an immutable versioned tile: fresh for one year, no revalidation, then a version bump replaces the URL. The bottom timeline shows a mutable tile: fresh during s-maxage, then a stale-while-revalidate window where the stale tile is served instantly while the edge revalidates in the background, then a hard revalidation.</desc>
  <rect x="0" y="0" width="760" height="300" rx="12" fill="var(--surface, #f5f3ff)"/>
  <!-- Immutable timeline -->
  <text x="20" y="46" font-size="12" font-weight="700" fill="currentColor">Immutable  ·  /tiles/v42/roads/10/512/340.mvt</text>
  <rect x="20" y="60" width="560" height="34" rx="6" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="300" y="81" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">FRESH — served from edge, no revalidation  (max-age = s-maxage = 1 year, immutable)</text>
  <rect x="588" y="60" width="152" height="34" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5,3"/>
  <text x="664" y="76" text-anchor="middle" font-size="10.5" fill="currentColor" font-weight="600">version bump → v43</text>
  <text x="664" y="89" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">new URL, new key</text>
  <line x1="580" y1="77" x2="586" y2="77" stroke="currentColor" stroke-width="1.5" marker-end="url(#a2)"/>
  <!-- Mutable timeline -->
  <text x="20" y="156" font-size="12" font-weight="700" fill="currentColor">Mutable  ·  /tiles/roads/10/512/340.mvt</text>
  <rect x="20" y="170" width="230" height="34" rx="6" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="135" y="191" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">FRESH  (s-maxage 300s)</text>
  <rect x="258" y="170" width="290" height="34" rx="6" fill="var(--surface2, #ede9fe)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="403" y="188" text-anchor="middle" font-size="10.5" fill="currentColor" font-weight="600">STALE-WHILE-REVALIDATE (86400s)</text>
  <text x="403" y="200" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">serve stale instantly · refresh in background</text>
  <rect x="556" y="170" width="184" height="34" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5,3"/>
  <text x="648" y="186" text-anchor="middle" font-size="10.5" fill="currentColor" font-weight="600">must revalidate</text>
  <text x="648" y="199" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">ETag / 304 or refetch</text>
  <!-- axis -->
  <line x1="20" y1="230" x2="740" y2="230" stroke="currentColor" stroke-width="1" opacity="0.5" marker-end="url(#a2)"/>
  <text x="20" y="248" font-size="10" fill="var(--muted, #7c6fb0)">t = 0</text>
  <text x="720" y="248" text-anchor="end" font-size="10" fill="var(--muted, #7c6fb0)">time →</text>
  <text x="380" y="272" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">Immutable maximises hit ratio; mutable trades a freshness window for instant, never-blocking responses.</text>
  <defs>
    <marker id="a2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

---

## Runnable implementation

A FastAPI helper that returns the right headers for each case, plus the purge-on-publish routine. The version comes from the path for immutable tiles; mutable tiles carry an `ETag` so the edge can revalidate cheaply with a conditional request.

```python
# app/tiles/headers.py
import hashlib
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response

router = APIRouter()

def immutable_tile_headers(version: int, layer: str, z: int, x: int, y: int) -> dict:
    """Versioned URL → bytes can never change → cache for a year, never revalidate."""
    return {
        # public:    shared caches (the CDN/edge) may store it
        # max-age:   browser holds it for 1 year
        # s-maxage:  shared cache (edge) holds it for 1 year — REQUIRED, or the
        #            browser's max-age also caps the edge on some CDNs
        # immutable: browser skips revalidation entirely within max-age
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
        "ETag": f'"{version}-{layer}-{z}-{x}-{y}"',
        "Vary": "Accept-Encoding",      # never serve gzip bytes to an identity client
        "Content-Type": "application/vnd.mapbox-vector-tile",
    }

def mutable_tile_headers(tile_bytes: bytes) -> dict:
    """Stable URL → may change → short fresh window, then serve stale while revalidating."""
    etag = hashlib.sha1(tile_bytes).hexdigest()[:16]
    return {
        # s-maxage=300:              edge treats the tile as fresh for 5 minutes
        # stale-while-revalidate:    for the next 24h the edge serves the STALE tile
        #                            instantly and refreshes it in the background —
        #                            no client ever waits on the origin
        # (no 'immutable' here: the URL is stable, so revalidation must be allowed)
        "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
        "ETag": f'"{etag}"',
        "Vary": "Accept-Encoding",
        "Content-Type": "application/vnd.mapbox-vector-tile",
    }

@router.get("/tiles/{version}/{layer}/{z}/{x}/{y}.mvt")
async def versioned_tile(request: Request, version: int, layer: str,
                         z: int, x: int, y: int):
    if not (0 <= z <= 15 and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
        raise HTTPException(status_code=400, detail="Invalid tile coordinates")

    tile_bytes = await generate_mvt(request.app.state.pool, version, layer, z, x, y)

    # Honour conditional requests so a revalidation costs 304, not a full body
    etag = f'"{version}-{layer}-{z}-{x}-{y}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})

    return Response(
        content=tile_bytes,
        headers=immutable_tile_headers(version, layer, z, x, y),
    )
```

Purge-on-publish never enumerates tile paths. It bumps the version and, as a belt-and-braces measure, fires a tag-based purge:

```python
# app/tiles/publish.py
import httpx, os

async def publish_new_tile_version(pool) -> int:
    """Atomically bump the data version. New tile URLs miss the edge and repopulate;
    old versioned URLs age out by TTL. No per-path purge storm."""
    async with pool.acquire() as conn:
        new_version = await conn.fetchval(
            "UPDATE tile_dataset SET version = version + 1 "
            "WHERE name = 'roads' RETURNING version"
        )

    # Optional emergency purge of the LAYER tag (Cloudflare Cache-Tag / Fastly
    # Surrogate-Key) in case a bad tile was cached under the previous version.
    async with httpx.AsyncClient() as client:
        await client.post(
            f"https://api.cloudflare.com/client/v4/zones/{os.environ['CF_ZONE']}/purge_cache",
            headers={"Authorization": f"Bearer {os.environ['CF_TOKEN']}"},
            json={"tags": ["layer:roads"]},
        )
    return new_version   # expose this in the map style JSON so clients request /tiles/{new}/...
```

---

Four directives cover every sensible tile policy, and they act on different caches.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Which directive does what for a tile: Edge, Browser" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Which directive does what for a tile</title>
  <desc>A comparison table. max-age: Edge partly, Browser yes. browser lifetime s-maxage: Edge yes, Browser no. edge lifetime, overrides max-age stale-while-revalidate: Edge yes, Browser partly. serve stale, refresh behind immutable: Edge yes, Browser yes. only for versioned URLs no-store: Edge yes, Browser yes. defeats the entire point The pair that matters is a short s-maxage with a long stale-while-revalidate: fresh enough to be correct, stale enough to absorb a spike.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Which directive does what for a tile</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Edge</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Browser</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">max-age</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">browser lifetime</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">s-maxage</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="460" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">edge lifetime, overrides max-age</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">stale-while-revalidate</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="460" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">serve stale, refresh behind</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">immutable</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">only for versioned URLs</text>
  <line x1="20" y1="194" x2="700" y2="194" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="216" font-size="10.5" fill="currentColor">no-store</text>
  <text x="294" y="216" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="216" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="216" font-size="9.5" fill="var(--muted, #7c6fb0)">defeats the entire point</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">The pair that matters is a short s-maxage with a long stale-while-revalidate: fresh enough to be correct, stale enough to absorb a spike.</text>
</svg>

## Key parameters & options

| Directive | Meaning | Immutable tile | Mutable tile |
|---|---|---|---|
| `public` | Shared caches (edge/CDN) may store the response | Yes | Yes |
| `max-age=N` | Seconds the **browser** treats the tile as fresh | `31536000` (1 yr) | `0` |
| `s-maxage=N` | Seconds the **shared/edge** cache treats it as fresh; overrides `max-age` for the edge | `31536000` | `300` |
| `immutable` | Browser skips revalidation within `max-age` even on reload | Set it | Omit |
| `stale-while-revalidate=N` | Serve stale for N s while refreshing in background | Omit (never stale) | `86400` |
| `ETag` | Validator for cheap `304 Not Modified` revalidation | Optional | Recommended |
| `Vary: Accept-Encoding` | Separate cache entries for gzip vs identity | Always | Always |
| Version path segment | Turns invalidation into a URL change | `/tiles/v42/...` | not available |

`s-maxage` is the directive teams most often forget, and its absence is the classic bug: without it the edge falls back to `max-age`, so if you set `max-age=0` for "always revalidate in the browser" you accidentally also stop the edge from caching. Always set `s-maxage` explicitly for the edge behaviour you want, independent of the browser's `max-age`.

---

Each directive removes a different slice of origin traffic, and the last one removes the spikes.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Origin requests per minute at 12 000 tile requests/min: no caching 12 000, max-age only 2 100, s-maxage 300 340, + stale-while-revalidate 41" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Origin requests per minute at 12 000 tile requests/min</title>
  <desc>A horizontal bar chart. no caching is 12 000. max-age only is 2 100. s-maxage 300 is 340. + stale-while-revalidate is 41. Stale-while-revalidate is what collapses the last order of magnitude: expiry stops causing a stampede.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Origin requests per minute at 12 000 tile requests/min</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">no caching</text>
  <rect x="250" y="48" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="61" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">12 000</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">max-age only</text>
  <rect x="250" y="82" width="59" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="317" y="95" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">2 100</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">s-maxage 300</text>
  <rect x="250" y="116" width="9" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="267" y="129" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">340</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">+ stale-while-revalidate</text>
  <rect x="250" y="150" width="6" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="264" y="163" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">41</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">Stale-while-revalidate is what collapses the last order of magnitude: expiry stops causing a stampede.</text>
</svg>

## Gotchas & failure modes

- **Missing `s-maxage`, so browsers over-cache (or the edge under-caches).** If you send only `max-age=0` intending "browser always revalidates", the edge inherits `max-age=0` and caches nothing — your origin sees every request. Conversely, `max-age=31536000` with no `s-maxage` lets the browser pin a stale mutable tile for a year. Always set both explicitly; they control different caches.

- **Caching error responses.** A `403`, `404`, or `500` served with a long-lived `Cache-Control` freezes the failure into the edge. A transient origin error then becomes a year-long outage for that tile. Only attach caching headers to `200` responses; send `Cache-Control: no-store` on error paths.

- **Missing `Vary: Accept-Encoding` corrupts clients.** If the edge caches a gzip-compressed tile and later serves it to a client that did not send `Accept-Encoding: gzip`, the client receives compressed bytes it cannot parse — the MVT decode fails with a garbled-protobuf error. `Vary: Accept-Encoding` keeps compressed and identity variants in separate cache entries.

- **`immutable` on a mutable URL.** Marking a stable-URL tile `immutable` tells browsers never to revalidate, so a data update is invisible until the `max-age` expires — potentially a year. `immutable` is only correct when the version is in the URL.

- **Version bumped but the style JSON still points at the old version.** Clients keep requesting `/tiles/v42/...` and see stale tiles even though `v43` exists. Serve the tile URL template from the same version source and give the style document a short `s-maxage` so clients pick up the new template quickly.

- **`stale-while-revalidate` on a first-ever request.** SWR only helps once a tile is already cached; the very first request per colo still blocks on the origin. This is expected — SWR removes the stall on *subsequent* refreshes, not the cold miss.

---

## Verification

Confirm the headers and the fresh → stale → revalidate transition with `curl -I` and the `age` header:

```bash
# Immutable versioned tile: year-long, immutable, with an ETag
curl -sI "https://cdn.example.com/tiles/42/roads/10/512/340.mvt" \
  | grep -iE 'cache-control|etag|age|vary'
# cache-control: public, max-age=31536000, s-maxage=31536000, immutable
# etag: "42-roads-10-512-340"
# age: 5123            ← seconds the edge has held it
# vary: accept-encoding

# Conditional revalidation returns 304 with no body
curl -sI "https://cdn.example.com/tiles/42/roads/10/512/340.mvt" \
  -H 'If-None-Match: "42-roads-10-512-340"' | head -1
# HTTP/2 304

# Mutable tile: short s-maxage, long stale-while-revalidate
curl -sI "https://cdn.example.com/tiles/roads/10/512/340.mvt" | grep -i cache-control
# cache-control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400

# After a publish bump, the OLD version keeps serving (immutable), the NEW misses:
curl -sI "https://cdn.example.com/tiles/43/roads/10/512/340.mvt" \
  | grep -iE 'cf-cache-status|age'
# cf-cache-status: MISS
# age: 0
```

A mutable tile whose `age` climbs past `s-maxage` while still returning `200` instantly (not a slow origin fetch) confirms `stale-while-revalidate` is working: the edge is serving stale bytes and refreshing in the background.

---

## Related

- [Edge Routing & Tile Delivery at Scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/) — the versioned tile contract and purge-on-publish strategy these headers implement
- [Cloudflare Workers Edge Routing for Vector Tile Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/cloudflare-workers-edge-routing-for-vector-tile-endpoints/) — a Worker that attaches these directives to tiles it stores in the Cache API
- [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — the `ST_AsMVT` origin and CDN caching layers that consume these headers

← Back to [Edge Routing & Tile Delivery at Scale](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/)
</content>
