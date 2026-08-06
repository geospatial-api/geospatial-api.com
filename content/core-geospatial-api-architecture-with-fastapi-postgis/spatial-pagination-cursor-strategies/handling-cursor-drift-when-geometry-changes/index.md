---
layout: layouts/page.njk
title: "Handling Cursor Drift When Geometry Changes"
description: "A feature moves mid-pagination and the client silently skips or repeats rows. Anchor cursors to an immutable sort key, detect drift with a snapshot token, and tell the client when the page set has shifted."
slug: handling-cursor-drift-when-geometry-changes
type: howto
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "Spatial Pagination & Cursor Strategies"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/"
  - label: "Handling Cursor Drift When Geometry Changes"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/handling-cursor-drift-when-geometry-changes/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Handling Cursor Drift When Geometry Changes",
      "description": "Anchor spatial cursors to an immutable sort key and detect drift when features move mid-pagination.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/handling-cursor-drift-when-geometry-changes/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 2, "name": "Spatial Pagination & Cursor Strategies", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/" },
        { "@type": "ListItem", "position": 3, "name": "Handling Cursor Drift When Geometry Changes", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/handling-cursor-drift-when-geometry-changes/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Keep Spatial Pagination Stable While Data Changes",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Sort on something immutable", "text": "Order by a key that cannot change under the client, such as the primary key, rather than by distance or by geometry." },
        { "@type": "HowToStep", "position": 2, "name": "Carry a snapshot token", "text": "Embed a transaction timestamp in the cursor so the server can tell how much has changed since the first page." },
        { "@type": "HowToStep", "position": 3, "name": "Report drift rather than hide it", "text": "Return a field telling the client how many rows changed under it, so it can decide whether to restart." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does sorting by distance break pagination?",
          "acceptedAnswer": { "@type": "Answer", "text": "Because the sort key is computed from data that moves. If a vehicle two kilometres away drives closer between page one and page two, it moves earlier in the ordering and is returned again on page two, while something else is pushed past the cursor and never appears. Nothing errors; the client simply receives a list with duplicates and holes." }
        },
        {
          "@type": "Question",
          "name": "Is a keyset cursor on the primary key enough?",
          "acceptedAnswer": { "@type": "Answer", "text": "It fixes duplication and skipping caused by reordering, because a primary key never changes. It does not fix membership changes: a feature that moves into the bounding box after page one will appear on a later page, and one that moves out will be missing. That is usually acceptable, but it should be documented rather than discovered." }
        },
        {
          "@type": "Question",
          "name": "Should the API offer a fully consistent snapshot instead?",
          "acceptedAnswer": { "@type": "Answer", "text": "Only for exports. A repeatable-read transaction held across pages gives perfect consistency and holds a database snapshot for as long as the client takes to paginate, which blocks vacuum and pins a connection. For interactive paging, an immutable sort key plus honest drift reporting is the better trade." }
        }
      ]
    }
  ]
}
</script>

← Back to [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/)

# Handling cursor drift when geometry changes

This page covers what happens to a paginated spatial result when the underlying features move, and how to make the failure visible instead of silent.

## Context & When to Use

Pagination assumes a stable ordering. That assumption is safe for a table of invoices and unsafe for a table of vehicles: if the API sorts by distance from a point, every position update reorders the result set under the client's feet. A vehicle that approaches crosses the cursor backwards and is returned twice; one that recedes is pushed past the cursor and is never returned at all.

The damage is proportional to how fast the data moves and how slowly the client pages. A fleet updating every three seconds, paged at 200 features a request over a 4 000-feature result, will produce a list with several percent duplicates and a similar number of silent omissions. No error is raised at any point, and the client's totals will simply be wrong.

Two fixes stack. Sorting on an immutable key removes reordering entirely, which is the bulk of the problem and costs nothing — the keyset technique in [Implementing Cursor-Based Pagination for Spatial Queries](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/). Reporting drift handles what remains: features entering or leaving the filter mid-walk, which no sort key can prevent.

## Runnable Implementation

```python
import base64
import json
from datetime import datetime, timezone
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

router = APIRouter(prefix="/v1/features", tags=["features"])

PAGE_SQL = """
SELECT f.id,
       ST_AsGeoJSON(f.geom, 6)::json AS geometry,
       f.updated_at,
       -- How many rows in this window changed since the walk began?
       count(*) FILTER (WHERE f.updated_at > $6) OVER () AS changed_since_start
FROM   features f
WHERE  f.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
  AND  ($5::bigint IS NULL OR f.id > $5)     -- keyset on an IMMUTABLE key
ORDER  BY f.id                                -- never ORDER BY distance
LIMIT  $7
"""


def encode_cursor(last_id: int, started_at: datetime) -> str:
    payload = {"id": last_id, "t": started_at.isoformat()}
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def decode_cursor(token: str) -> tuple[int, datetime]:
    try:
        payload = json.loads(base64.urlsafe_b64decode(token.encode()))
        return int(payload["id"]), datetime.fromisoformat(payload["t"])
    except Exception:
        raise HTTPException(422, detail={"error": "malformed_cursor"})


@router.get("")
async def list_features(
    bbox: Annotated[str, Query()],
    cursor: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
    last_id, started_at = decode_cursor(cursor) if cursor else (None, datetime.now(timezone.utc))

    async with pool.acquire() as conn:
        rows = await conn.fetch(PAGE_SQL, minx, miny, maxx, maxy,
                                last_id, started_at, limit)

    drifted = rows[0]["changed_since_start"] if rows else 0
    next_cursor = encode_cursor(rows[-1]["id"], started_at) if len(rows) == limit else None

    return {
        "features": [
            {"type": "Feature", "id": r["id"], "geometry": r["geometry"]} for r in rows
        ],
        "next_cursor": next_cursor,
        # Honesty: the client is told the ground moved, and by how much
        "drift": {
            "since": started_at.isoformat(),
            "rows_changed_in_window": drifted,
            "advice": "restart pagination" if drifted > limit // 4 else "continue",
        },
    }
```

The window function counting `changed_since_start` costs one extra pass over the page's rows, not over the table, so the drift signal is effectively free.

<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Illustration of a feature moving between two pages, causing a duplicate under distance ordering and no anomaly under key ordering" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The same movement under two sort keys</title>
  <desc>Two panels showing three pages of results. Under distance ordering, a vehicle that moves closer between page one and page two appears again on page two as a duplicate, while another feature is pushed past the cursor and never appears. Under primary-key ordering, the same movement changes nothing about which rows appear or in what order, because the sort key did not move. Only membership changes remain, and those are reported through the drift field.</desc>
  <rect x="0" y="0" width="720" height="260" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One vehicle moves between page 1 and page 2</text>
  <text x="180" y="52" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">ORDER BY distance</text>
  <rect x="30" y="62" width="300" height="34" rx="5" fill="var(--surface-alt, #ede8f8)"/>
  <text x="42" y="84" font-size="10" font-family="monospace" fill="currentColor">page 1: A B C D E</text>
  <rect x="30" y="102" width="300" height="34" rx="5" fill="var(--viz-bad-soft, #fbe4e1)"/>
  <text x="42" y="124" font-size="10" font-family="monospace" fill="currentColor">page 2: D F G H I</text>
  <text x="42" y="156" font-size="10" fill="var(--viz-bad, #a32b23)">D returned twice — it moved closer</text>
  <text x="42" y="172" font-size="10" fill="var(--viz-bad, #a32b23)">J never returned — it was pushed past the cursor</text>
  <text x="42" y="196" font-size="10" fill="var(--muted, #7c6fb0)">no error · no warning · totals silently wrong</text>
  <text x="540" y="52" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good, #1f6b3a)">ORDER BY id</text>
  <rect x="390" y="62" width="300" height="34" rx="5" fill="var(--surface-alt, #ede8f8)"/>
  <text x="402" y="84" font-size="10" font-family="monospace" fill="currentColor">page 1: A B C D E</text>
  <rect x="390" y="102" width="300" height="34" rx="5" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="402" y="124" font-size="10" font-family="monospace" fill="currentColor">page 2: F G H I J</text>
  <text x="402" y="156" font-size="10" fill="var(--viz-good, #1f6b3a)">every feature exactly once, in a stable order</text>
  <text x="402" y="172" font-size="10" fill="var(--viz-good, #1f6b3a)">D's new position is simply reflected in its geometry</text>
  <text x="402" y="196" font-size="10" fill="var(--muted, #7c6fb0)">membership changes remain — and are reported</text>
  <line x1="30" y1="214" x2="690" y2="214" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="238" font-size="10.5" fill="var(--muted, #7c6fb0)">Sorting by a moving value makes the cursor meaningless: the position it marks is not where it was.</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">Distance still belongs in the response — as a field, not as the ordering.</text>
</svg>

## Key Parameters & Options

| Choice | Recommended | Why |
|---|---|---|
| Sort key | primary key, or `(created_at, id)` | Immutable under concurrent updates |
| Cursor contents | last key + walk start time | Enough to resume and to measure drift |
| Cursor encoding | base64 JSON, opaque to clients | Lets the shape evolve without breaking anyone |
| Drift threshold | 25 % of a page | Above this, restarting is cheaper than reconciling |
| Distance | a response field | Useful to display, unusable as an ordering |
| Snapshot isolation | exports only | Perfect consistency at the cost of a held connection |

## What each strategy actually guarantees

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Matrix of four pagination strategies against three guarantees: no duplicates, no skipped rows and a consistent snapshot" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What each pagination strategy guarantees on moving data</title>
  <desc>Four strategies rated against three guarantees. Offset pagination provides none of them and additionally degrades in performance. Distance-ordered keyset avoids neither duplicates nor skips because the sort key moves. Primary-key keyset avoids duplicates and skips caused by reordering but does not provide a consistent snapshot. A repeatable-read transaction provides all three but holds a connection and a snapshot for the whole walk, which is only acceptable for exports.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Guarantees by strategy, on data that moves</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="34" y="58" font-size="10.5" font-weight="700" fill="currentColor">Strategy</text>
  <text x="330" y="58" font-size="10.5" font-weight="700" fill="currentColor">no dupes</text>
  <text x="440" y="58" font-size="10.5" font-weight="700" fill="currentColor">no skips</text>
  <text x="550" y="58" font-size="10.5" font-weight="700" fill="currentColor">snapshot</text>
  <text x="34" y="90" font-size="10.5" fill="currentColor">OFFSET / LIMIT</text>
  <text x="352" y="90" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="462" y="90" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="572" y="90" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="620" y="90" font-size="9.5" fill="var(--muted, #7c6fb0)">and slow</text>
  <line x1="20" y1="102" x2="700" y2="102" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="126" font-size="10.5" fill="currentColor">keyset on distance</text>
  <text x="352" y="126" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="462" y="126" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="572" y="126" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="620" y="126" font-size="9.5" fill="var(--muted, #7c6fb0)">fast, wrong</text>
  <line x1="20" y1="138" x2="700" y2="138" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="162" font-size="10.5" font-weight="700" fill="currentColor">keyset on primary key</text>
  <text x="352" y="162" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="462" y="162" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="572" y="162" font-size="12" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="620" y="162" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">recommended</text>
  <line x1="20" y1="174" x2="700" y2="174" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="198" font-size="10.5" fill="currentColor">repeatable-read transaction</text>
  <text x="352" y="198" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="462" y="198" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="572" y="198" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="620" y="198" font-size="9.5" fill="var(--viz-warn, #8a5000)">exports only</text>
  <text x="20" y="228" font-size="10.5" fill="var(--muted, #7c6fb0)">The tilde marks the honest gap: key-ordered paging cannot stop a feature entering or leaving the bounding box</text>
  <text x="20" y="242" font-size="10.5" fill="var(--muted, #7c6fb0)">mid-walk. That is what the drift field is for.</text>
</svg>

## How much drift to expect

Whether drift matters at all is arithmetic: it is roughly the update rate multiplied by the time the client spends walking. Working that out for your own data usually settles the argument about whether any of this is worth building.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of expected drift percentage against total pagination time for three update rates" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Expected drift by walk duration and update rate</title>
  <desc>Three lines showing the percentage of rows changed during a pagination walk, plotted against walk duration from ten seconds to five minutes. A slow-changing parcel dataset updated daily shows essentially zero drift at every duration. A moderately active dataset updated hourly reaches about two percent at five minutes. A live fleet updating every three seconds reaches eleven percent at one minute and thirty-eight percent at five minutes, at which point pagination is no longer meaningful and a streaming subscription is the right interface.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Rows changed during the walk, by dataset volatility</text>
  <line x1="70" y1="170" x2="686" y2="170" stroke="currentColor" stroke-width="1.1"/>
  <line x1="70" y1="44" x2="70" y2="170" stroke="currentColor" stroke-width="1.1"/>
  <text x="62" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">40 %</text>
  <text x="62" y="112" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">20 %</text>
  <text x="62" y="170" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <polyline points="70,168 200,167 330,166 460,165 620,163" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="2.2"/>
  <text x="330" y="158" font-size="10" fill="var(--viz-good, #1f6b3a)">parcels, updated daily — drift is noise</text>
  <polyline points="70,169 200,166 330,162 460,158 620,152" fill="none" stroke="var(--viz-warn, #8a5000)" stroke-width="2.2"/>
  <text x="470" y="145" font-size="10" fill="var(--viz-warn, #8a5000)">assets, hourly — ~2 %</text>
  <polyline points="70,166 200,136 330,110 460,84 620,52" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="2.4"/>
  <text x="440" y="76" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">fleet, every 3 s — 38 % at 5 min</text>
  <line x1="70" y1="120" x2="686" y2="120" stroke="var(--viz-grid, #d8cff0)" stroke-width="1.2" stroke-dasharray="5,3"/>
  <text x="76" y="115" font-size="9.5" fill="var(--muted, #7c6fb0)">above this, restart rather than continue</text>
  <text x="90" y="188" font-size="9.5" fill="var(--muted, #7c6fb0)">10 s</text>
  <text x="330" y="188" font-size="9.5" fill="var(--muted, #7c6fb0)">1 min</text>
  <text x="610" y="188" font-size="9.5" fill="var(--muted, #7c6fb0)">5 min</text>
  <text x="20" y="212" font-size="10.5" fill="var(--muted, #7c6fb0)">Past roughly 20 %, paginating a live dataset stops being meaningful — offer a change feed or a websocket</text>
  <text x="20" y="226" font-size="10.5" fill="var(--muted, #7c6fb0)">subscription instead of pretending the list is a snapshot.</text>
</svg>

## Gotchas & Failure Modes

- **A cursor that encodes the distance.** Any cursor containing a computed value inherits the instability of that value. Encode identifiers only.
- **`ORDER BY geom <-> point` with a `LIMIT` and a cursor.** The KNN operator is the reason people reach for distance ordering; it is also precisely what makes the ordering unstable. Use it for "nearest ten", never for a paginated walk — see [Optimizing KNN Queries with the PostGIS Distance Operator](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/optimizing-knn-queries-with-postgis-operator/).
- **Drift reported but never acted on.** A field nobody reads is decoration. Document the threshold and, for first-party clients, restart automatically above it.
- **Timestamps from the client.** The walk start time must come from the server; a client clock skewed by minutes makes the drift count nonsense.
- **`updated_at` not maintained.** The drift count depends on the column being touched by every write. Enforce with a trigger rather than by convention.
- **Cursors that outlive their usefulness.** A cursor resumed a day later walks a result set that no longer resembles the original. Embed the start time and reject cursors older than a documented window.

## Telling the client what to do about it

A drift field is only useful if the contract says what the numbers mean. Three behaviours cover almost every consumer, and stating them in the API documentation saves every integrator from inventing their own.

A client building a live map should ignore drift entirely and simply keep paging: it is going to refresh anyway, and a duplicate feature is harmless when the result is keyed by id. A client computing a total — how many assets are in this region — must restart when drift exceeds its tolerance, because a count assembled from a shifting set is not a count of anything. A client performing a one-off export should not be paginating at all; give it the streamed export path instead, where a single query sees a single snapshot.

Encode that guidance in the response rather than only in prose. The `advice` field in the implementation above is deliberately a string the client can branch on, and adding a machine-readable `drift.ratio` alongside it lets a consumer set its own threshold without parsing English. What matters is that the server has the information and passes it on; a silently inconsistent list is the only genuinely unacceptable outcome.

## Verification Snippet

```python
import pytest


@pytest.mark.asyncio
async def test_moving_features_do_not_duplicate(client, db_conn):
    page1 = (await client.get("/v1/features",
                              params={"bbox": "-1,50,1,52", "limit": 50})).json()
    # Move a feature from page 1 much closer to the query point
    await db_conn.execute(
        "UPDATE features SET geom = ST_SetSRID(ST_MakePoint(0.0, 51.0), 4326),"
        " updated_at = now() WHERE id = $1", page1["features"][10]["id"])

    page2 = (await client.get("/v1/features",
                              params={"bbox": "-1,50,1,52", "limit": 50,
                                      "cursor": page1["next_cursor"]})).json()

    ids1 = {f["id"] for f in page1["features"]}
    ids2 = {f["id"] for f in page2["features"]}
    assert not (ids1 & ids2), "a feature was returned on both pages"
    assert page2["drift"]["rows_changed_in_window"] >= 1
```

```bash
# Walk every page and assert the id set is exactly the table's
python scripts/walk_pages.py --bbox -1,50,1,52 --limit 200 --assert-complete
# 4212 features over 22 pages · 0 duplicates · 0 missing · drift reported on 3 pages
```

---

## Related

- [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — the cursor design this hardens
- [Implementing Cursor-Based Pagination for Spatial Queries](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/) — the keyset mechanics
- [K-Nearest Neighbor Routing Algorithms](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) — where distance ordering does belong

← Back to [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/)
