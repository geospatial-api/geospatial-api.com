---
layout: layouts/page.njk
title: "Implementing Cursor-Based Pagination for Spatial Queries"
description: "Step-by-step guide to replacing OFFSET/LIMIT with keyset cursor pagination in FastAPI and PostGIS: GiST index alignment, Base64 cursor encoding, stable ORDER BY, and edge-case handling."
slug: implementing-cursor-based-pagination-for-spatial-queries
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "Spatial Pagination & Cursor Strategies"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/"
  - label: "Implementing Cursor-Based Pagination for Spatial Queries"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/"
datePublished: "2024-03-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Implementing Cursor-Based Pagination for Spatial Queries",
      "description": "Step-by-step guide to replacing OFFSET/LIMIT with keyset cursor pagination in FastAPI and PostGIS: GiST index alignment, Base64 cursor encoding, stable ORDER BY, and edge-case handling.",
      "datePublished": "2024-03-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "url": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/"
    },
    {
      "@type": "Article",
      "headline": "Implementing Cursor-Based Pagination for Spatial Queries",
      "datePublished": "2024-03-15",
      "dateModified": "2026-06-23",
      "url": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/"},
        {"@type": "ListItem", "position": 2, "name": "Spatial Pagination & Cursor Strategies", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/"},
        {"@type": "ListItem", "position": 3, "name": "Implementing Cursor-Based Pagination for Spatial Queries", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement cursor-based pagination for PostGIS spatial queries in FastAPI",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Add GiST and B-tree indexes", "text": "Create a GiST index on the geometry column and a B-tree index on the UUID primary key for keyset traversal."},
        {"@type": "HowToStep", "position": 2, "name": "Encode and decode the cursor", "text": "Serialize the last row's primary key to a URL-safe Base64 JSON payload; validate strictly on decode."},
        {"@type": "HowToStep", "position": 3, "name": "Build the paginated FastAPI route", "text": "Apply the spatial bounding-box pre-filter, add WHERE id > :cursor_id, and enforce ORDER BY id ASC LIMIT."},
        {"@type": "HowToStep", "position": 4, "name": "Return next_cursor conditionally", "text": "Emit next_cursor only when the page is full (len(rows) == limit); an absent next_cursor signals the last page."},
        {"@type": "HowToStep", "position": 5, "name": "Verify with EXPLAIN ANALYZE", "text": "Confirm index scans on both the GiST and B-tree indexes, with Rows Removed by Filter staying low."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does OFFSET pagination break for spatial queries?",
          "acceptedAnswer": {"@type": "Answer", "text": "OFFSET forces PostgreSQL to materialise, sort, and discard N rows before returning results. With spatial filters, this bypasses GiST index range scanning, causing O(N) latency growth as page depth increases. Concurrent inserts or deletes between requests also shift row positions, producing duplicates or gaps."}
        },
        {
          "@type": "Question",
          "name": "Can I sort by ST_Distance and still use a keyset cursor?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes, but you must append a unique tiebreaker: ORDER BY geom <-> :point, id ASC. The cursor payload must then encode both the distance value and the id so the WHERE clause can reconstruct the exact resume position."}
        },
        {
          "@type": "Question",
          "name": "Is Base64 cursor encoding secure enough for production?",
          "acceptedAnswer": {"@type": "Answer", "text": "Base64 prevents casual ID exposure in browser history and logs, but it is not tamper-proof. For public APIs serving sensitive location data, sign cursors with HMAC-SHA256 and reject any cursor whose signature does not verify before running the query."}
        }
      ]
    }
  ]
}
</script>

← Back to [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/)

# Implementing Cursor-Based Pagination for Spatial Queries

Replace `OFFSET`/`LIMIT` with a deterministic keyset cursor so PostGIS bounding-box queries page in constant time regardless of dataset depth.

## Context & When to Use

`OFFSET`-based pagination asks PostgreSQL to materialize the entire filtered result set, sort it, discard the first N rows, then return the next batch. For spatial workloads this is doubly expensive: the GiST index that accelerates `&&` or `ST_DWithin` cannot skip scanned tuples, so query latency grows linearly as page depth increases. At page 500 of a 20-row page, the database discards 9 980 rows on every request.

Keyset pagination eliminates that waste. Instead of skipping rows, the API decodes a cursor representing the last returned row's primary key, applies a `WHERE id > :cursor_id` clause, and lets the B-tree index jump straight to that boundary. Query cost becomes proportional to the page size — not the page number. This is the technique described in [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) and the right choice whenever your API must serve deep, stable pages of spatial features.

Use this approach when:

- The result set has more than ~1 000 features and clients page forward sequentially (maps, exports, feeds).
- Concurrent writes are possible between page requests — offset drift produces duplicate or missing rows, keyset traversal does not.
- You want your [geospatial API architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/) to stay stateless: the cursor encodes all resume state so the server stores nothing between requests.

It is **not** the right tool when clients need random page access (jump to page 47), because keyset traversal is inherently forward-only. For random access, materialize result sets into Redis or accept the offset trade-off on bounded datasets.

## Data Flow Overview

The diagram below shows how a single paginated request moves through the stack, from the decoded cursor through the dual-index query to the encoded next cursor in the response.

<svg viewBox="0 0 680 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cursor pagination data flow: client sends cursor, FastAPI decodes it, PostGIS applies spatial filter then keyset WHERE clause, result set is encoded into next cursor and returned" style="width:100%;max-width:680px;font-family:inherit;">
  <title>Cursor-based pagination data flow in FastAPI + PostGIS</title>
  <desc>Sequence diagram showing: client sends GET /locations?bbox=…&amp;cursor=BASE64, FastAPI decodes cursor to uuid, PostGIS GiST index filters by bounding box, B-tree index applies WHERE id &gt; cursor_id ORDER BY id LIMIT n, rows returned, next cursor encoded and sent in JSON response.</desc>
  <!-- background -->
  <rect width="680" height="320" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.08" stroke-width="1"/>
  <!-- lane headers -->
  <rect x="10" y="10" width="140" height="36" rx="6" fill="currentColor" fill-opacity="0.08"/>
  <text x="80" y="33" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Client</text>
  <rect x="170" y="10" width="160" height="36" rx="6" fill="currentColor" fill-opacity="0.08"/>
  <text x="250" y="33" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">FastAPI Route</text>
  <rect x="350" y="10" width="160" height="36" rx="6" fill="currentColor" fill-opacity="0.08"/>
  <text x="430" y="33" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">PostGIS / GiST</text>
  <rect x="530" y="10" width="140" height="36" rx="6" fill="currentColor" fill-opacity="0.08"/>
  <text x="600" y="33" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">B-tree Index</text>
  <!-- vertical lane dividers -->
  <line x1="160" y1="46" x2="160" y2="310" stroke="currentColor" stroke-opacity="0.15" stroke-dasharray="4 3"/>
  <line x1="340" y1="46" x2="340" y2="310" stroke="currentColor" stroke-opacity="0.15" stroke-dasharray="4 3"/>
  <line x1="520" y1="46" x2="520" y2="310" stroke="currentColor" stroke-opacity="0.15" stroke-dasharray="4 3"/>
  <!-- step 1: GET request -->
  <line x1="80" y1="80" x2="238" y2="80" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="159" y="74" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.8">GET /locations?cursor=BASE64</text>
  <!-- step 2: decode cursor -->
  <rect x="172" y="90" width="156" height="28" rx="5" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
  <text x="250" y="109" text-anchor="middle" font-size="11" fill="currentColor">decode cursor → uuid</text>
  <!-- step 3: spatial pre-filter -->
  <line x1="328" y1="104" x2="418" y2="104" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="373" y="98" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.8">geom &amp;&amp; bbox</text>
  <rect x="352" y="114" width="156" height="28" rx="5" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
  <text x="430" y="133" text-anchor="middle" font-size="11" fill="currentColor">GiST bbox pre-filter</text>
  <!-- step 4: keyset filter -->
  <line x1="508" y1="128" x2="582" y2="128" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="545" y="122" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.8">id &gt; cursor_id</text>
  <rect x="532" y="138" width="136" height="28" rx="5" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
  <text x="600" y="157" text-anchor="middle" font-size="11" fill="currentColor">B-tree range scan</text>
  <!-- step 5: rows returned -->
  <line x1="530" y1="190" x2="342" y2="190" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#arrR)"/>
  <text x="436" y="184" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.7">rows (LIMIT n)</text>
  <!-- step 6: encode next cursor -->
  <rect x="172" y="200" width="156" height="28" rx="5" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
  <text x="250" y="219" text-anchor="middle" font-size="11" fill="currentColor">encode next_cursor</text>
  <!-- step 7: response -->
  <line x1="170" y1="258" x2="92" y2="258" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#arrR)"/>
  <text x="131" y="252" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.7">JSON + next_cursor</text>
  <!-- arrow markers -->
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" fill-opacity="0.7"/>
    </marker>
    <marker id="arrR" markerWidth="8" markerHeight="8" refX="2" refY="3" orient="auto">
      <path d="M8,0 L8,6 L0,3 z" fill="currentColor" fill-opacity="0.5"/>
    </marker>
  </defs>
  <!-- step labels -->
  <text x="16" y="78" font-size="9" fill="currentColor" fill-opacity="0.45">1</text>
  <text x="16" y="108" font-size="9" fill="currentColor" fill-opacity="0.45">2</text>
  <text x="16" y="133" font-size="9" fill="currentColor" fill-opacity="0.45">3</text>
  <text x="16" y="158" font-size="9" fill="currentColor" fill-opacity="0.45">4</text>
  <text x="16" y="193" font-size="9" fill="currentColor" fill-opacity="0.45">5</text>
  <text x="16" y="218" font-size="9" fill="currentColor" fill-opacity="0.45">6</text>
  <text x="16" y="258" font-size="9" fill="currentColor" fill-opacity="0.45">7</text>
</svg>

## Schema & Index Prerequisites

Your PostGIS table needs two indexes: a GiST index for the spatial pre-filter, and a B-tree index for keyset traversal. Both must exist before the query planner can execute the pattern efficiently.

```sql
CREATE TABLE locations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    geom        GEOMETRY(Point, 4326) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial pre-filter: GiST accelerates the && bounding-box operator
CREATE INDEX idx_locations_geom ON locations USING GIST (geom);

-- Keyset traversal: B-tree enables WHERE id > :cursor_id as a range scan
CREATE INDEX idx_locations_id   ON locations (id);
```

If your workload sorts by distance (`ORDER BY geom <-> :origin`), also create a compound index on `(geom, id)` so the planner can resolve the KNN scan and the tiebreaker without a separate sort step.

## Runnable Implementation

The endpoint below is production-ready with SQLAlchemy 2.0 async, Pydantic v2, and URL-safe Base64 cursor encoding. The spatial pre-filter uses `&&` (bounding-box overlap, GiST-accelerated), and pagination relies on `id > :cursor_id`.

```python
import base64
import json
from typing import Optional, List

from fastapi import FastAPI, Query, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker

DATABASE_URL = "postgresql+asyncpg://user:password@localhost/gisdb"
engine = create_async_engine(DATABASE_URL, pool_size=10, max_overflow=5)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)

app = FastAPI()


# ── Models ────────────────────────────────────────────────────────────────────

class LocationOut(BaseModel):
    id: str
    name: str
    geom_wkt: str   # WKT for API transport; swap ST_AsGeoJSON for GeoJSON output
    created_at: str

class PagedLocations(BaseModel):
    items: List[LocationOut]
    next_cursor: Optional[str] = None  # absent → caller is on the last page


# ── Cursor helpers ────────────────────────────────────────────────────────────

def encode_cursor(row_id: str) -> str:
    """Encode a UUID string to a URL-safe Base64 cursor token."""
    payload = json.dumps({"id": row_id}).encode()
    return base64.urlsafe_b64encode(payload).decode()

def decode_cursor(token: str) -> dict:
    """Decode and validate a cursor token; raises 400 on any tampering."""
    try:
        payload = base64.urlsafe_b64decode(token.encode()).decode()
        data = json.loads(payload)
        if "id" not in data:
            raise ValueError("missing id key")
        return data
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid cursor token")


# ── Dependency ────────────────────────────────────────────────────────────────

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


# ── Route ─────────────────────────────────────────────────────────────────────

@app.get("/locations", response_model=PagedLocations)
async def list_locations(
    bbox: str = Query(
        ...,
        description="Spatial filter: minx,miny,maxx,maxy (EPSG:4326)",
        example="-0.5,51.3,0.2,51.6",
    ),
    cursor: Optional[str] = Query(None, description="Opaque continuation token from previous page"),
    limit: int = Query(20, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    # 1. Parse and validate the bounding box
    try:
        minx, miny, maxx, maxy = map(float, bbox.split(","))
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="bbox must be minx,miny,maxx,maxy")

    # 2. Build the keyset WHERE clause depending on cursor presence
    if cursor:
        cursor_data = decode_cursor(cursor)
        sql = text("""
            SELECT
                id::text        AS id,
                name,
                ST_AsText(geom) AS geom_wkt,
                created_at::text AS created_at
            FROM locations
            WHERE geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)
              AND id > :cursor_id::uuid   -- keyset resume; B-tree range scan
            ORDER BY id ASC
            LIMIT :limit
        """)
        params = {
            "minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy,
            "cursor_id": cursor_data["id"],
            "limit": limit,
        }
    else:
        sql = text("""
            SELECT
                id::text        AS id,
                name,
                ST_AsText(geom) AS geom_wkt,
                created_at::text AS created_at
            FROM locations
            WHERE geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)
            ORDER BY id ASC
            LIMIT :limit
        """)
        params = {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy, "limit": limit}

    # 3. Execute and map rows
    result = await db.execute(sql, params)
    rows = result.mappings().all()
    items = [LocationOut(**row) for row in rows]

    # 4. Emit next_cursor only when the page is full (signals more pages exist)
    next_cursor = encode_cursor(items[-1].id) if len(items) == limit else None

    return PagedLocations(items=items, next_cursor=next_cursor)
```

## Key Parameters & Options

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `bbox` | `str` | required | `minx,miny,maxx,maxy` in EPSG:4326. Drives `ST_MakeEnvelope`; the wider the box, the more rows the GiST scan touches. |
| `cursor` | `str` | `None` | URL-safe Base64 token. Absent on first page; clients pass back whatever `next_cursor` the API returns. |
| `limit` | `int` | 20 | Capped at 200. Larger values increase individual query cost but reduce round-trip count for bulk consumers. |
| `ORDER BY` | SQL | `id ASC` | Must be deterministic. Replace `id` with a composite key if you sort by distance — always append `id` as a tiebreaker. |
| `ST_MakeEnvelope` | SQL | — | Fourth argument must match the geometry column's SRID (4326 here). Mismatches produce silent wrong results, not errors. |
| `pool_size` | engine | 10 | Size the connection pool relative to your concurrent request volume; spatial queries hold connections longer than simple CRUD. |

## Gotchas & Failure Modes

- **Floating-point sort instability.** Sorting purely by `ST_Distance` or the `<->` operator produces ties for co-located points. The planner may resolve ties differently on each call, causing rows to appear on two consecutive pages or be skipped entirely. Always append `, id ASC` as the final sort key and encode both the distance and `id` in the cursor.

- **SRID mismatch in `ST_MakeEnvelope`.** If the geometry column stores data in EPSG:3857 (Web Mercator) but the envelope is built in 4326, the bounding box silently misses or over-selects features. Check with `SELECT Find_SRID('public', 'locations', 'geom')` before going live.

- **Cursor decoded but index not used.** If `EXPLAIN ANALYZE` shows a sequential scan after adding the cursor, the planner may have decided the filtered row count makes an index scan more expensive. Run `ANALYZE locations` to refresh table statistics and set `random_page_cost = 1.1` on SSD-backed instances to steer the planner back to the index.

- **Limit exactly equals result count on the last page.** If the last page happens to contain exactly `limit` rows, the API emits a `next_cursor` that resolves to an empty page. Clients must handle an empty `items` list as the true end-of-stream signal, or you can reduce the internal query limit to `limit + 1` and use the extra row only as a lookahead sentinel without including it in the response.

- **URL encoding of the Base64 token.** Standard Base64 uses `+` and `/`, which must be percent-encoded in query strings. The implementation above uses `urlsafe_b64encode`, which substitutes `-` and `_` instead — safe to pass in a URL without additional encoding. Mixing the two variants corrupts the cursor silently.

## Verification

Run this against a local PostGIS instance to confirm both indexes are used:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id::text, name, ST_AsText(geom) AS geom_wkt, created_at::text
FROM locations
WHERE geom && ST_MakeEnvelope(-0.5, 51.3, 0.2, 51.6, 4326)
  AND id > 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
ORDER BY id ASC
LIMIT 20;
```

Look for these indicators in the output:

- `Index Scan using idx_locations_geom` — GiST spatial pre-filter active
- `Index Cond: (geom && '...'::geometry)` — bounding box pushed into the index scan
- `Filter: (id > '...'::uuid)` — keyset predicate applied after GiST, before row projection
- `Rows Removed by Filter` should be small relative to `rows=` in the index scan node

End-to-end smoke test with `curl`:

```bash
# First page (no cursor)
curl -s "http://localhost:8000/locations?bbox=-0.5,51.3,0.2,51.6&limit=5" | python3 -m json.tool

# Second page — paste next_cursor from the response above
curl -s "http://localhost:8000/locations?bbox=-0.5,51.3,0.2,51.6&limit=5&cursor=<next_cursor>" | python3 -m json.tool
```

A valid response on the second call must not repeat any `id` from the first page, and `next_cursor` must be absent when the final page contains fewer than `limit` items.

---

## Related

- [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — decision matrix comparing keyset, offset, and seek-method patterns for spatial APIs
- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — choosing the right response format once your pagination is stable
- [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — evolving cursor schemas across API versions without breaking clients

← Back to [Spatial Pagination & Cursor Strategies](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/)
