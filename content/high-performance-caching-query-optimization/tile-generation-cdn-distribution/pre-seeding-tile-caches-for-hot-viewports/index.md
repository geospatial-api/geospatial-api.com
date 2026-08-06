---
layout: layouts/page.njk
title: "Pre-Seeding Tile Caches for Hot Viewports"
description: "Warm the tiles users actually request instead of the whole pyramid: derive hot areas from access logs, seed by zoom band, and stop after the point where hit rate stops improving."
slug: pre-seeding-tile-caches-for-hot-viewports
type: howto
breadcrumb:
  - label: "Geospatial Caching and Query Optimization"
    url: "/high-performance-caching-query-optimization/"
  - label: "Tile Generation & CDN Distribution"
    url: "/high-performance-caching-query-optimization/tile-generation-cdn-distribution/"
  - label: "Pre-Seeding Tile Caches for Hot Viewports"
    url: "/high-performance-caching-query-optimization/tile-generation-cdn-distribution/pre-seeding-tile-caches-for-hot-viewports/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Pre-Seeding Tile Caches for Hot Viewports",
      "description": "Warm the tiles users actually request instead of the whole pyramid, using access logs to derive hot areas.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/pre-seeding-tile-caches-for-hot-viewports/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Geospatial Caching and Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 2, "name": "Tile Generation & CDN Distribution", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/" },
        { "@type": "ListItem", "position": 3, "name": "Pre-Seeding Tile Caches for Hot Viewports", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/pre-seeding-tile-caches-for-hot-viewports/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Warm a Tile Cache From Real Traffic",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Derive the hot set", "text": "Aggregate tile requests from access logs into a ranked list rather than guessing at bounding boxes." },
        { "@type": "HowToStep", "position": 2, "name": "Seed in zoom order", "text": "Warm low zooms first — they are few, expensive and universally requested." },
        { "@type": "HowToStep", "position": 3, "name": "Stop at diminishing returns", "text": "Track hit rate against tiles seeded and stop when the curve flattens." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why not just seed the whole pyramid?",
          "acceptedAnswer": { "@type": "Answer", "text": "Because the pyramid is enormous and almost entirely unvisited. Zoom 14 alone is 268 million tiles globally, and for a typical regional dataset well over 99 percent of them are never requested. Seeding by traffic reaches the same hit rate for a tiny fraction of the generation cost and storage." }
        },
        {
          "@type": "Question",
          "name": "How often should re-seeding run?",
          "acceptedAnswer": { "@type": "Answer", "text": "Tie it to the data, not the clock. Seed after each import or refresh that invalidates tiles, since that is when the cache is cold and the traffic is about to arrive. A nightly job is a reasonable default when the data changes nightly, and pointless when it changes weekly." }
        },
        {
          "@type": "Question",
          "name": "Should seeding hit the CDN or the origin cache?",
          "acceptedAnswer": { "@type": "Answer", "text": "Both, in that order, and via ordinary HTTP requests through the CDN. Requesting through the edge populates the origin cache and the edge in one pass, and it exercises the same path a real user takes, so a seeding run that succeeds proves the delivery chain works." }
        }
      ]
    }
  ]
}
</script>

← Back to [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/)

# Pre-seeding tile caches for hot viewports

This page covers warming a tile cache from evidence: deriving the hot set from real traffic, seeding in the order that pays first, and knowing when to stop.

## Context & When to Use

After a data refresh every cached tile is stale, and the next few hundred users pay origin latency to regenerate them. On a dataset where tile generation is 23 ms that is tolerable; where it is 200 ms, or where a burst of traffic arrives at 08:00 with a cold cache, it is a visible outage of responsiveness. Pre-seeding moves that work into a window where nobody is watching.

The naive version — walk the whole pyramid — does not survive contact with the numbers. Zoom 14 has 268 million tiles worldwide; even bounded to one country it is millions, and the great majority are ocean, farmland or car parks that nobody has ever requested. Generating them costs hours and storage, and improves the hit rate by almost nothing.

The traffic-derived version inverts it. Most map traffic concentrates hard: a handful of cities, a few zoom levels, and within those the tiles containing whatever the product is about. Seeding the top few thousand tiles typically reaches the same hit rate as seeding millions. The delivery mechanics this builds on are in [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/), and the header policy that keeps seeded tiles alive is in [Caching Vector Tiles at the Edge with Cache-Control](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/).

## Runnable Implementation

```python
import asyncio
import re
from collections import Counter
from typing import Iterable, Iterator

import httpx

TILE_RE = re.compile(r"/v1/tiles/(\d+)/(\d+)/(\d+)\.mvt")
BASE = "https://api.example.com"
CONCURRENCY = 8            # polite: seeding must not become the load spike


def hot_tiles(log_lines: Iterable[str], top_n: int = 4_000) -> list[tuple[int, int, int]]:
    """Rank tiles by real request count over the observed window."""
    counts: Counter[tuple[int, int, int]] = Counter()
    for line in log_lines:
        m = TILE_RE.search(line)
        if m:
            counts[(int(m[1]), int(m[2]), int(m[3]))] += 1
    # Low zooms first: fewer tiles, more expensive, requested by everyone
    return sorted(counts, key=lambda t: (t[0], -counts[t]))[:top_n]


def with_parents(tiles: Iterable[tuple[int, int, int]]) -> Iterator[tuple[int, int, int]]:
    """Every hot tile implies its ancestors were on screen during the zoom in."""
    seen: set[tuple[int, int, int]] = set()
    for z, x, y in tiles:
        while z >= 0:
            if (z, x, y) not in seen:
                seen.add((z, x, y))
                yield (z, x, y)
            z, x, y = z - 1, x // 2, y // 2


async def seed(tiles: list[tuple[int, int, int]]) -> dict[str, int]:
    """Request each tile through the CDN so edge and origin both warm."""
    stats = {"ok": 0, "empty": 0, "failed": 0}
    limiter = asyncio.Semaphore(CONCURRENCY)

    async with httpx.AsyncClient(timeout=30) as client:
        async def one(z: int, x: int, y: int) -> None:
            async with limiter:
                try:
                    r = await client.get(f"{BASE}/v1/tiles/{z}/{x}/{y}.mvt",
                                         headers={"Cache-Control": "no-cache"})
                except httpx.HTTPError:
                    stats["failed"] += 1
                    return
            if r.status_code == 204:
                stats["empty"] += 1
            elif r.is_success:
                stats["ok"] += 1
            else:
                stats["failed"] += 1

        await asyncio.gather(*(one(*t) for t in tiles))
    return stats
```

`Cache-Control: no-cache` on the seeding request is deliberate: it forces the edge to revalidate against the origin and store the fresh tile, which is exactly what "warming" means after an invalidation.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of cache hit rate against number of tiles seeded, rising steeply and then flattening" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Hit rate against tiles seeded</title>
  <desc>Cache hit rate plotted against the number of tiles pre-seeded, on a logarithmic horizontal axis. Seeding 100 tiles reaches 31 percent, 500 reaches 62 percent, 2000 reaches 84 percent, 4000 reaches 91 percent and 20000 reaches 94 percent. Beyond 4000 the curve is essentially flat, so the last 16000 tiles buy three percentage points at four times the generation cost. A marker at 4000 identifies the practical stopping point.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Hit rate versus seeding effort, one regional dataset</text>
  <line x1="70" y1="186" x2="686" y2="186" stroke="currentColor" stroke-width="1.1"/>
  <line x1="70" y1="44" x2="70" y2="186" stroke="currentColor" stroke-width="1.1"/>
  <text x="62" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">100 %</text>
  <text x="62" y="118" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">50 %</text>
  <text x="62" y="186" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <polyline points="70,186 150,144 260,104 380,74 460,64 560,60 686,58" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="2.6"/>
  <circle cx="380" cy="74" r="6" fill="var(--viz-good, #1f6b3a)"/>
  <text x="392" y="70" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">4 000 tiles → 91 %</text>
  <text x="392" y="86" font-size="9.5" fill="var(--viz-good, #1f6b3a)">stop here</text>
  <line x1="380" y1="44" x2="380" y2="196" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4" stroke-dasharray="5,3"/>
  <text x="500" y="120" font-size="10" fill="var(--muted, #7c6fb0)">+16 000 tiles buys +3 points</text>
  <text x="500" y="136" font-size="10" fill="var(--muted, #7c6fb0)">at 4× the generation cost</text>
  <text x="100" y="206" font-size="9.5" fill="var(--muted, #7c6fb0)">100</text>
  <text x="255" y="206" font-size="9.5" fill="var(--muted, #7c6fb0)">1 000</text>
  <text x="440" y="206" font-size="9.5" fill="var(--muted, #7c6fb0)">10 000</text>
  <text x="640" y="206" font-size="9.5" fill="var(--muted, #7c6fb0)">100 000</text>
  <text x="20" y="234" font-size="10.5" fill="var(--muted, #7c6fb0)">Map traffic is heavily concentrated, so the curve always has this shape — only the position of the knee changes.</text>
</svg>

## Key Parameters & Options

| Parameter | Suggested | Notes |
|---|---|---|
| `top_n` | derived from the hit-rate curve | Measure once, then keep the number |
| Seeding order | ascending zoom | Low zooms are few, costly and always requested |
| `CONCURRENCY` | 4–8 | Seeding must not itself become the load spike |
| `Cache-Control: no-cache` | on the seeding request | Forces revalidation so the edge stores the new tile |
| Ancestor expansion | on | A hot tile implies its parents were on screen |
| Trigger | after data refresh | Not on a clock unrelated to invalidation |

The ancestor expansion is a small trick with a real payoff. Users arrive at zoom 14 by zooming in from zoom 8, so every hot deep tile implies a chain of shallower ones was fetched on the way. Seeding those costs almost nothing — there are very few of them — and they are the slowest to generate.

## Where seeding fits in the refresh cycle

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline of a data refresh showing invalidation, seeding and the traffic peak, with and without pre-seeding" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Refresh, seed, peak — and what happens without the middle step</title>
  <desc>A timeline from 02:00 to 09:00. The data import finishes at 02:30 and tiles are invalidated. With seeding, a job runs from 02:40 to 03:20 warming 4000 tiles, and the 08:00 traffic peak is served at 91 percent hit rate with origin latency around 12 milliseconds. Without seeding, the same peak arrives at a cold cache, hit rate starts near zero and origin latency reaches 340 milliseconds for the first twenty minutes while the cache fills from live traffic.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">The window between invalidation and the morning peak</text>
  <line x1="40" y1="76" x2="690" y2="76" stroke="currentColor" stroke-width="1.2"/>
  <circle cx="120" cy="76" r="6" fill="var(--accent, #7c3aed)"/>
  <text x="120" y="60" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">02:30 import done</text>
  <text x="120" y="96" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">tiles invalidated</text>
  <rect x="150" y="66" width="140" height="20" rx="4" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.25" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.3"/>
  <text x="220" y="80" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor">seed 4 000 tiles · 40 min</text>
  <circle cx="560" cy="76" r="6" fill="var(--viz-warn, #8a5000)"/>
  <text x="560" y="60" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">08:00 peak</text>
  <text x="40" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">02:00</text>
  <text x="330" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">05:00</text>
  <text x="660" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">09:00</text>
  <line x1="40" y1="136" x2="690" y2="136" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="160" font-size="10.5" fill="currentColor">with seeding</text>
  <rect x="180" y="148" width="180" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="370" y="161" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">91 % hit · origin p95 12 ms at peak</text>
  <text x="20" y="192" font-size="10.5" fill="currentColor">without seeding</text>
  <rect x="180" y="180" width="450" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="180" y="212" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">cold start · origin p95 340 ms for the first 20 minutes</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">The peak is unavoidable; paying for it at 03:00 with eight concurrent requests instead of at 08:00 with</text>
  <text x="20" y="236" font-size="10.5" fill="var(--muted, #7c6fb0)">two thousand is the entire idea.</text>
</svg>

## How concentrated tile traffic really is

The reason a few thousand tiles suffice is worth seeing rather than asserting. Map traffic follows a steep power law: a small number of tiles absorb most requests, and the tail is not merely long but almost entirely unvisited.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cumulative share of tile requests against the ranked tile count, showing extreme concentration" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Cumulative request share by tile rank</title>
  <desc>Cumulative share of all tile requests plotted against tiles ranked by popularity. The top 100 tiles absorb 31 percent of requests, the top 1000 absorb 74 percent, the top 4000 absorb 91 percent and the top 20000 absorb 94 percent. Beyond that the curve is flat: the remaining 2.4 million candidate tiles in the region account for the final 6 percent, and roughly 2.1 million of them were never requested at all during the observed month.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One month of tile requests, ranked</text>
  <line x1="70" y1="176" x2="686" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <line x1="70" y1="44" x2="70" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <text x="62" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">100 %</text>
  <text x="62" y="176" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <path d="M70,176 L140,135 L250,94 L370,64 L470,56 L580,54 L686,53 L686,176 Z" fill="var(--accent, #7c3aed)" fill-opacity="0.16" stroke="var(--accent, #7c3aed)" stroke-width="2.4"/>
  <line x1="370" y1="44" x2="370" y2="188" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6" stroke-dasharray="5,3"/>
  <text x="378" y="80" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">top 4 000 tiles = 91 %</text>
  <text x="378" y="96" font-size="9.5" fill="var(--viz-good, #1f6b3a)">this is the whole seeding set</text>
  <text x="440" y="140" font-size="10" fill="var(--muted, #7c6fb0)">2.1 M tiles in this region were</text>
  <text x="440" y="155" font-size="10" fill="var(--muted, #7c6fb0)">never requested even once</text>
  <text x="100" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">100</text>
  <text x="245" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">1 000</text>
  <text x="450" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">20 000</text>
  <text x="640" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">2.4 M</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">Seeding by traffic is not an approximation of seeding everything — it is the same result for a thousandth</text>
  <text x="20" y="236" font-size="10.5" fill="var(--muted, #7c6fb0)">of the work, because almost nothing else is ever asked for.</text>
</svg>

## Gotchas & Failure Modes

- **Seeding harder than production traffic.** A seeder with 200 concurrent workers is a load test against your own origin. Keep concurrency low; the job has all night.
- **Seeding tiles that are empty.** A 204 response costs a database round trip and caches nothing useful. Count them, and prune persistently-empty tiles from the hot list.
- **Hot list derived from the wrong window.** A weekend's logs seed the wrong cities for a Monday morning. Use a window that matches the traffic you are warming for.
- **Seeding before the invalidation completes.** Warming while the purge is still propagating fills the cache with tiles that are about to be evicted. Wait for the purge to confirm.
- **No cap on the job's duration.** A hot list that has grown unnoticed can leave seeding still running at 08:00, competing with the traffic it was meant to help. Set a wall-clock budget and log what was skipped.
- **Assuming the hit rate is uniform.** The aggregate can look excellent while one important city is cold. Report hit rate per zoom band and per region, in line with [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/).

Finally, keep the seeding job's own metrics separate from production traffic metrics. A seeding run that requests four thousand tiles will otherwise appear in the dashboards as a traffic spike with a suspiciously perfect cache-miss rate, and someone will eventually spend an afternoon investigating it.

Finally, keep the seeding job's own metrics separate from production traffic metrics. A seeding run that requests four thousand tiles will otherwise appear in the dashboards as a traffic spike with a suspiciously perfect cache-miss rate, and someone will eventually spend an afternoon investigating it.

And record which tiles were seeded, not merely how many. When the hit rate disappoints, the useful question is whether the hot list was wrong or the seeding failed, and only a per-tile record distinguishes the two.

## Verification Snippet

```bash
# Did the seeding run actually populate the edge?
for t in 8/127/84 10/511/340 14/8188/5448; do
  curl -s -o /dev/null -D - "https://api.example.com/v1/tiles/$t.mvt" \
    | grep -iE '^(cf-cache-status|age|x-cache):'
done
# cf-cache-status: HIT
# age: 3122
```

```sql
-- Hit rate by zoom, from the edge logs loaded into a table
SELECT z,
       count(*)                                                    AS requests,
       round(100.0 * count(*) FILTER (WHERE cache_status = 'HIT')
             / count(*), 1)                                        AS hit_pct
FROM   tile_access_log
WHERE  requested_at >= now() - interval '1 day'
GROUP  BY z ORDER BY z;
--  z  | requests | hit_pct
-- ----+----------+---------
--  14 |   482013 |    93.1
```

---

## Related

- [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/) — the distribution layer being warmed
- [Vector Tile Endpoints with ST_AsMVT](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/) — what each seeded request costs the origin
- [Caching Vector Tiles at the Edge with Cache-Control](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/) — the header policy that decides how long a seeded tile survives

← Back to [Tile Generation & CDN Distribution](https://www.geospatial-api.com/high-performance-caching-query-optimization/tile-generation-cdn-distribution/)
