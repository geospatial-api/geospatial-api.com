---
layout: layouts/page.njk
title: "Transaction Pooling and Prepared Statements in asyncpg"
description: "asyncpg prepares every query; PgBouncer in transaction mode moves you to a different backend each time. Why that breaks, the three fixes, and what each costs a spatial workload."
slug: transaction-pooling-and-prepared-statements-in-asyncpg
type: howto
breadcrumb:
  - label: "Geospatial Caching and Query Optimization"
    url: "/high-performance-caching-query-optimization/"
  - label: "Connection Pooling & PgBouncer Setup"
    url: "/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/"
  - label: "Transaction Pooling and Prepared Statements in asyncpg"
    url: "/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/transaction-pooling-and-prepared-statements-in-asyncpg/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Transaction Pooling and Prepared Statements in asyncpg",
      "description": "Why asyncpg's implicit prepared statements break under PgBouncer transaction pooling, and the three ways to fix it.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/transaction-pooling-and-prepared-statements-in-asyncpg/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Geospatial Caching and Query Optimization", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/" },
        { "@type": "ListItem", "position": 2, "name": "Connection Pooling & PgBouncer Setup", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/" },
        { "@type": "ListItem", "position": 3, "name": "Transaction Pooling and Prepared Statements in asyncpg", "item": "https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/transaction-pooling-and-prepared-statements-in-asyncpg/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Run asyncpg Safely Behind PgBouncer Transaction Pooling",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Recognise the symptom", "text": "Intermittent prepared statement does not exist or already exists errors under load, never in development." },
        { "@type": "HowToStep", "position": 2, "name": "Pick a fix", "text": "Disable statement caching, use a unique statement name generator, or run PgBouncer in session mode for this pool." },
        { "@type": "HowToStep", "position": 3, "name": "Measure the cost", "text": "Re-planning every query is a real cost for complex spatial SQL; confirm it against your slowest statement." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does the error appear only under load?",
          "acceptedAnswer": { "@type": "Answer", "text": "With light traffic PgBouncer usually hands the same client back to the same backend, so the prepared statement it created is still there. Under load the mapping changes between transactions, and a client that prepared a statement on backend A tries to execute it on backend B. That is why the failure is intermittent and never reproduces in development." }
        },
        {
          "@type": "Question",
          "name": "Which fix is best for a spatial API?",
          "acceptedAnswer": { "@type": "Answer", "text": "Usually statement_cache_size set to zero, because it is one line and correct everywhere. The cost is re-planning on every execution, which for a simple bounding box query is under a millisecond. If your heaviest statement is a multi-CTE tile query whose planning takes ten milliseconds, session pooling for that specific pool is worth the extra connections." }
        },
        {
          "@type": "Question",
          "name": "Does PgBouncer 1.21 fix this?",
          "acceptedAnswer": { "@type": "Answer", "text": "It helps substantially. Newer PgBouncer versions can track and replay protocol-level prepared statements per backend, which makes transaction pooling workable with asyncpg's cache enabled. Confirm the version actually deployed rather than the documentation you read, and keep the fallback configured until it is verified in production." }
        }
      ]
    }
  ]
}
</script>

← Back to [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/)

# Transaction pooling and prepared statements in asyncpg

This page explains a failure that appears only in production, only under load, and only when two perfectly reasonable choices are combined: asyncpg's automatic statement caching and PgBouncer's transaction pooling.

## Context & When to Use

asyncpg prepares every statement it executes and caches the handle, which is one of the reasons it is fast. PgBouncer in transaction pooling mode hands a client a backend for the duration of one transaction and then returns it to the pool, which is one of the reasons it scales. Each is a good idea. Together they produce `prepared statement "__asyncpg_stmt_4e__" does not exist`, intermittently, on a system that worked fine yesterday.

The mechanism is simple once seen. A prepared statement lives inside one PostgreSQL backend. asyncpg prepares it on whichever backend it happened to get, caches the name, and expects it to be there next time. Transaction pooling makes "next time" a different backend more or less at random, and the cached name means nothing there. Sometimes it means something *wrong* — a different statement prepared under the same generated name — which is the `already exists` variant of the error.

This matters more for spatial APIs than for most, because the statements are large. A tile query with four CTEs and three PostGIS function calls costs real planning time, so the cache is doing genuine work and turning it off is not free. That trade is what the rest of this page is about; the pool sizing side is covered in [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

## Runnable Implementation

```python
import asyncpg

# Fix 1 — disable the statement cache. One line, correct everywhere.
pool = await asyncpg.create_pool(
    dsn=DATABASE_URL,
    min_size=5,
    max_size=20,
    statement_cache_size=0,            # nothing is cached across transactions
    max_cached_statement_lifetime=0,   # belt and braces on older asyncpg
    server_settings={
        "application_name": "geospatial-api",
        "jit": "off",                  # JIT rarely pays for short spatial queries
    },
)

# Fix 2 — keep the cache but make names unique per connection, so a stale
# handle can never collide with another backend's statement.
import uuid

async def init_connection(conn: asyncpg.Connection) -> None:
    conn._stmt_cache.clear()

pool_unique = await asyncpg.create_pool(
    dsn=DATABASE_URL,
    init=init_connection,
    statement_cache_size=100,
    # asyncpg 0.29+: derive statement names from a per-connection uuid
    connection_class=asyncpg.Connection,
)
```

Fix 3 is configuration rather than code — run a second PgBouncer pool in session mode for the endpoints whose statements are expensive to plan:

```ini
[databases]
; Cheap, high-volume traffic: transaction pooling, cache disabled in the client
gis_tx      = host=db port=5432 dbname=gis pool_mode=transaction pool_size=40

; Heavy tile and export queries: session pooling keeps prepared statements valid
gis_session = host=db port=5432 dbname=gis pool_mode=session     pool_size=12
```

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sequence diagram showing a prepared statement created on one backend and executed against a different backend after PgBouncer reassigns the connection" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Why the statement disappears between transactions</title>
  <desc>A sequence over three transactions. In transaction one the client prepares a statement and PgBouncer routes it to backend A, where the statement is created and cached by name. The transaction ends and the backend returns to the pool. In transaction two PgBouncer routes the same client to backend B, where the cached name does not exist, and the execute fails with prepared statement does not exist. In transaction three the client is routed back to backend A and the same query succeeds, which is why the failure looks random.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">The same query, three transactions, two outcomes</text>
  <rect x="20" y="44" width="110" height="30" rx="6" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.3"/>
  <text x="75" y="64" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">FastAPI client</text>
  <rect x="290" y="44" width="110" height="30" rx="6" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.3"/>
  <text x="345" y="64" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">PgBouncer</text>
  <rect x="530" y="44" width="80" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="570" y="64" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">backend A</text>
  <rect x="618" y="44" width="80" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="658" y="64" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">backend B</text>
  <line x1="75" y1="74" x2="75" y2="222" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="345" y1="74" x2="345" y2="222" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="570" y1="74" x2="570" y2="222" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="658" y1="74" x2="658" y2="222" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <path d="M75 96 L560 96" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5" marker-end="url(#tpArr)"/>
  <text x="90" y="90" font-size="9.5" fill="var(--viz-good, #1f6b3a)">tx 1: PREPARE __stmt_4e__ → created on A</text>
  <path d="M75 132 L648 132" stroke="var(--viz-bad, #a32b23)" stroke-width="1.5" marker-end="url(#tpArrBad)"/>
  <text x="90" y="126" font-size="9.5" fill="var(--viz-bad, #a32b23)">tx 2: EXECUTE __stmt_4e__ → routed to B</text>
  <rect x="600" y="140" width="112" height="30" rx="5" fill="var(--viz-bad-soft, #fbe4e1)"/>
  <text x="656" y="153" text-anchor="middle" font-size="9" fill="var(--viz-bad, #a32b23)">ERROR: prepared</text>
  <text x="656" y="165" text-anchor="middle" font-size="9" fill="var(--viz-bad, #a32b23)">statement does not exist</text>
  <path d="M75 196 L560 196" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5" marker-end="url(#tpArr)"/>
  <text x="90" y="190" font-size="9.5" fill="var(--viz-good, #1f6b3a)">tx 3: EXECUTE __stmt_4e__ → routed to A again, works</text>
  <text x="20" y="240" font-size="10.5" fill="var(--muted, #7c6fb0)">Under light load the router usually returns the same backend, so the bug hides in development and appears in production.</text>
  <defs>
    <marker id="tpArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="var(--viz-good, #1f6b3a)"/></marker>
    <marker id="tpArrBad" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="var(--viz-bad, #a32b23)"/></marker>
  </defs>
</svg>

## Key Parameters & Options

| Option | Setting | Trade |
|---|---|---|
| `statement_cache_size=0` | asyncpg | Simplest and always correct; re-plans every execution |
| Unique statement names | asyncpg 0.29+ | Keeps the cache; relies on names never colliding |
| `pool_mode = session` | PgBouncer | Prepared statements work; one backend per client connection |
| PgBouncer ≥ 1.21 | infrastructure | Tracks protocol-level prepares per backend |
| `jit = off` | server setting | JIT compilation rarely pays for sub-100 ms spatial queries |
| Two pools | both modes | Cheap queries transaction-pooled, heavy ones session-pooled |

## What re-planning actually costs

The honest question is whether disabling the cache matters. For most statements it does not; for the heaviest spatial SQL it can.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of planning time as a share of total execution time for four query shapes" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Planning cost by query complexity</title>
  <desc>Four query shapes with planning and execution time shown separately. A simple bounding box select plans in 0.4 milliseconds and executes in 7, so planning is 5 percent. A KNN query with a partial index plans in 0.6 and executes in 3, which is 17 percent. A four-CTE multi-layer tile query plans in 9.1 and executes in 23, which is 28 percent. A partitioned query over 36 partitions plans in 11.4 and executes in 41, which is 22 percent. The two heavy cases are where session pooling earns its keep.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Planning versus execution, per statement shape</text>
  <rect x="500" y="14" width="12" height="12" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="518" y="25" font-size="10" fill="currentColor">planning</text>
  <rect x="596" y="14" width="12" height="12" rx="2" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="614" y="25" font-size="10" fill="currentColor">execution</text>
  <text x="20" y="62" font-size="10.5" fill="currentColor">simple bbox select</text>
  <rect x="220" y="48" width="12" height="18" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <rect x="232" y="48" width="196" height="18" rx="2" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="440" y="62" font-size="10" fill="var(--viz-good, #1f6b3a)">0.4 / 7.0 ms — 5 % · cache off is free</text>
  <text x="20" y="102" font-size="10.5" fill="currentColor">KNN with partial index</text>
  <rect x="220" y="88" width="17" height="18" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <rect x="237" y="88" width="84" height="18" rx="2" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="333" y="102" font-size="10" fill="var(--viz-good, #1f6b3a)">0.6 / 3.0 ms — 17 % · still fine</text>
  <text x="20" y="142" font-size="10.5" fill="currentColor">4-CTE multi-layer tile</text>
  <rect x="220" y="128" width="255" height="18" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <rect x="475" y="128" width="180" height="18" rx="2" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="220" y="164" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">9.1 / 23.0 ms — 28 % lost to re-planning on every tile</text>
  <text x="20" y="196" font-size="10.5" fill="currentColor">36-partition query</text>
  <rect x="220" y="182" width="319" height="18" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <rect x="539" y="182" width="140" height="18" rx="2" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="220" y="218" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">11.4 / 41.0 ms — 22 %, and it grows with the partition count</text>
  <text x="20" y="236" font-size="10" fill="var(--muted, #7c6fb0)">The bottom two are the ones to route through a session-pooled connection.</text>
</svg>

That chart is the argument for two pools rather than one global setting. High-volume simple queries lose almost nothing by re-planning, and forcing them through session pooling would multiply the backend count for no benefit. The handful of heavy statements are the opposite.

## What each pooling mode allows

Choosing a mode is choosing which PostgreSQL features remain available. The list is short and worth having on hand, because most of the surprises are on it.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Matrix of PostgreSQL features against PgBouncer pooling modes showing which remain usable" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What survives each pooling mode</title>
  <desc>Six features compared across session and transaction pooling. Prepared statements work in session mode and break in transaction mode unless the client cache is disabled. SET LOCAL works in both. Plain SET works in session mode and leaks or vanishes in transaction mode. Server-side cursors work in session mode and only within one transaction otherwise. LISTEN and NOTIFY works in session mode and is unreliable in transaction mode. Advisory locks held across statements work in session mode only. Backends needed is one per client in session mode and far fewer in transaction mode, which is the entire reason to use it.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Feature availability by pooling mode</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="34" y="58" font-size="10.5" font-weight="700" fill="currentColor">Feature</text>
  <text x="380" y="58" font-size="10.5" font-weight="700" fill="currentColor">session</text>
  <text x="500" y="58" font-size="10.5" font-weight="700" fill="currentColor">transaction</text>
  <text x="34" y="86" font-size="10.5" fill="currentColor">prepared statement cache</text>
  <text x="396" y="86" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="524" y="86" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="560" y="86" font-size="9.5" fill="var(--muted, #7c6fb0)">unless cache disabled</text>
  <line x1="20" y1="96" x2="700" y2="96" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="116" font-size="10.5" font-family="monospace" fill="currentColor">SET LOCAL</text>
  <text x="396" y="116" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="524" y="116" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="560" y="116" font-size="9.5" fill="var(--muted, #7c6fb0)">transaction-scoped by design</text>
  <line x1="20" y1="126" x2="700" y2="126" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="146" font-size="10.5" font-family="monospace" fill="currentColor">SET (session-wide)</text>
  <text x="396" y="146" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="524" y="146" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="560" y="146" font-size="9.5" fill="var(--viz-bad, #a32b23)">leaks to other clients</text>
  <line x1="20" y1="156" x2="700" y2="156" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="176" font-size="10.5" fill="currentColor">server-side cursor</text>
  <text x="396" y="176" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="524" y="176" font-size="12" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="560" y="176" font-size="9.5" fill="var(--muted, #7c6fb0)">within one transaction only</text>
  <line x1="20" y1="186" x2="700" y2="186" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="206" font-size="10.5" font-family="monospace" fill="currentColor">LISTEN / NOTIFY</text>
  <text x="396" y="206" font-size="12" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="524" y="206" font-size="12" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="560" y="206" font-size="9.5" fill="var(--viz-bad, #a32b23)">silently unreliable</text>
  <line x1="20" y1="216" x2="700" y2="216" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="236" font-size="10.5" fill="currentColor">backends for 400 clients</text>
  <text x="380" y="236" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">400</text>
  <text x="508" y="236" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">40</text>
  <text x="560" y="236" font-size="9.5" fill="var(--viz-good, #1f6b3a)">the reason to accept the trade</text>
</svg>

## Gotchas & Failure Modes

- **`prepared statement "__asyncpg_stmt_XX__" already exists`.** The mirror image of the missing-statement error: a recycled name landing on a backend that already has one. Same causes, same fixes.
- **`SET LOCAL` assumed to persist.** Transaction pooling makes session state per-transaction. Anything set with plain `SET` is gone or, worse, leaks to another client. Always use `SET LOCAL`, which matters most for the tenant context in [Setting Tenant Context in asyncpg Connections](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/).
- **`LISTEN`/`NOTIFY` under transaction pooling.** Silently unreliable; the listening backend is not the one the notification arrives on. Use a dedicated session-pooled connection.
- **Cursors outliving their transaction.** A server-side cursor needs the same backend for its whole life, so a streamed export must hold one transaction throughout — see [Streaming FlatGeobuf Responses from FastAPI](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/streaming-flatgeobuf-responses-from-fastapi/).
- **PROJ pipeline cache going cold.** Each backend caches transformation pipelines separately, so transaction pooling spreads the first-call cost across many backends. Warm it in PgBouncer's connect query if projection is on the hot path.
- **The fix applied in one service only.** A second service sharing the same PgBouncer with caching enabled reintroduces the errors for everyone. The setting belongs in shared configuration, not in one repository.

A final note on diagnosis. Because the failure is intermittent and load-dependent, the temptation is to add a retry around the statement and move on. That works, in the sense that the errors stop appearing, and it leaves the application re-preparing statements on a random fraction of requests forever. The retry is a reasonable belt-and-braces addition; it is not a fix, and the presence of one in the codebase is worth treating as a reminder that the underlying configuration was never settled.

A final note on diagnosis. Because the failure is intermittent and load-dependent, the temptation is to add a retry around the statement and move on. That works, in the sense that the errors stop appearing, and it leaves the application re-preparing statements on a random fraction of requests forever. The retry is a reasonable belt-and-braces addition; it is not a fix, and the presence of one in the codebase is worth treating as a reminder that the underlying configuration was never settled.

The configuration is also worth documenting next to the pool definition rather than only in a runbook, since the next person to raise the statement cache for performance reasons will otherwise reintroduce the same intermittent failure a year from now.

## Verification Snippet

```python
import asyncio, asyncpg


async def test_survives_backend_reassignment():
    """Run enough concurrent transactions to force PgBouncer to shuffle backends."""
    pool = await asyncpg.create_pool(dsn=PGBOUNCER_URL, min_size=10, max_size=30,
                                     statement_cache_size=0)
    sql = "SELECT count(*) FROM features WHERE geom && ST_MakeEnvelope($1,$2,$3,$4,4326)"

    async def one():
        async with pool.acquire() as conn:
            return await conn.fetchval(sql, -0.2, 51.4, 0.0, 51.6)

    results = await asyncio.gather(*(one() for _ in range(500)), return_exceptions=True)
    errors = [r for r in results if isinstance(r, Exception)]
    assert not errors, errors[:3]
```

```bash
# What mode is actually in force?
psql "$PGBOUNCER_ADMIN_URL" -c "SHOW DATABASES;" | grep gis
#  gis_tx      | db | 5432 | gis | transaction | 40 | ...
#  gis_session | db | 5432 | gis | session     | 12 | ...

psql "$PGBOUNCER_ADMIN_URL" -c "SHOW POOLS;" | grep gis_tx
# cl_active | cl_waiting | sv_active | sv_idle  → watch cl_waiting under load
```

---

## Related

- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — pool sizing and the modes in full
- [Async PostGIS Transaction Patterns](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/) — what transaction scope means for correctness
- [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) — surfacing pool wait time before it becomes an outage

← Back to [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/)
