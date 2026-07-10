---
layout: layouts/page.njk
title: "Handling Deadlocks in Concurrent Spatial Updates"
description: "Why concurrent updates to overlapping geometry rows deadlock, and how to fix it: consistent lock ordering with SELECT ... FOR UPDATE ORDER BY id, retrying on PostgreSQL 40P01, and pg_advisory_xact_lock for hotspot geometries."
slug: "handling-deadlocks-in-concurrent-spatial-updates"
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Async PostGIS Transaction Patterns"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/"
  - label: "Handling Deadlocks in Concurrent Spatial Updates"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/handling-deadlocks-in-concurrent-spatial-updates/"
datePublished: "2026-04-06"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Handling Deadlocks in Concurrent Spatial Updates",
      "description": "Why concurrent updates to overlapping geometry rows deadlock, and how to fix it: consistent lock ordering with SELECT ... FOR UPDATE ORDER BY id, retrying on PostgreSQL 40P01, and pg_advisory_xact_lock for hotspot geometries.",
      "datePublished": "2026-04-06",
      "dateModified": "2026-07-10",
      "author": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "Async PostGIS Transaction Patterns", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/" },
        { "@type": "ListItem", "position": 3, "name": "Handling Deadlocks in Concurrent Spatial Updates", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/handling-deadlocks-in-concurrent-spatial-updates/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Prevent and recover from deadlocks in concurrent spatial updates",
      "step": [
        { "@type": "HowToStep", "position": 1, "text": "Lock the rows a transaction will touch in a deterministic order with SELECT ... FOR UPDATE ORDER BY id." },
        { "@type": "HowToStep", "position": 2, "text": "Catch PostgreSQL error code 40P01 (deadlock_detected) and 40001 (serialization_failure)." },
        { "@type": "HowToStep", "position": 3, "text": "Retry the whole transaction with capped exponential backoff and jitter." },
        { "@type": "HowToStep", "position": 4, "text": "For a single hotspot geometry, serialise writers with pg_advisory_xact_lock." }
      ]
    },
    {
      "@type": "Article",
      "headline": "Handling Deadlocks in Concurrent Spatial Updates",
      "datePublished": "2026-04-06",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [Async PostGIS Transaction Patterns](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/)

# Handling deadlocks in concurrent spatial updates

Stop concurrent updates to overlapping geometry rows from deadlocking by imposing a consistent lock order, retrying on PostgreSQL's `40P01`, and serialising hotspot writes with advisory locks.

## Context & when to use

A deadlock happens when two transactions each hold a lock the other needs. In spatial workloads this is common because a single "update" often touches several rows — a parcel edit that also updates its neighbours' shared boundaries, a merge that rewrites two overlapping polygons, or a recomputation that locks every feature inside a bounding box. If transaction A locks rows in the order `(17, 42)` and transaction B locks them as `(42, 17)`, they can each grab one and wait forever for the other. PostgreSQL breaks the cycle by killing one transaction with `ERROR: deadlock detected` (`SQLSTATE 40P01`).

This is the concurrency counterpart to the width-and-boundary rules in the parent [async PostGIS transaction patterns](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/) guide. Reach for these techniques when multiple writers update the same feature set concurrently — collaborative editing, ingestion that overlaps live edits (including the chunked loads in [bulk geometry writes](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/)), or any endpoint where two requests can legitimately target overlapping geometries.

There are three complementary tools. **Consistent lock ordering** prevents most deadlocks outright. **Retry on `40P01`** handles the ones you cannot design away, because deadlocks are always possible in principle. **Advisory locks** serialise writers on a known hotspot so they queue politely instead of colliding.

## How two spatial transactions deadlock

<svg viewBox="0 0 720 300" role="img" aria-label="Two transactions deadlocking by locking two geometry rows in opposite order, and the fix of locking in a consistent id order" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:720px;font-family:inherit;">
  <title>Deadlock from inconsistent lock ordering, and the ordered-lock fix</title>
  <desc>Transaction A locks row 17 then waits for row 42. Transaction B locks row 42 then waits for row 17. Each holds what the other needs, forming a cycle that PostgreSQL aborts with error 40P01. The fix is for both transactions to lock rows in ascending id order so one waits cleanly for the other.</desc>
  <rect x="0" y="0" width="720" height="300" rx="12" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="200" y="28" text-anchor="middle" font-size="12" font-weight="700" fill="#b91c1c">Deadlock: opposite lock order</text>
  <text x="560" y="28" text-anchor="middle" font-size="12" font-weight="700" fill="#065f46">Fix: same order (ORDER BY id)</text>
  <!-- left: deadlock -->
  <rect x="30" y="52" width="150" height="46" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="105" y="72" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Tx A</text>
  <text x="105" y="88" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">locks row 17</text>
  <rect x="220" y="52" width="150" height="46" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="295" y="72" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Tx B</text>
  <text x="295" y="88" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">locks row 42</text>
  <rect x="30" y="128" width="150" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="105" y="148" text-anchor="middle" font-size="11" fill="#92400e">A waits for 42</text>
  <text x="105" y="164" text-anchor="middle" font-size="10" fill="#92400e">held by B</text>
  <rect x="220" y="128" width="150" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="295" y="148" text-anchor="middle" font-size="11" fill="#92400e">B waits for 17</text>
  <text x="295" y="164" text-anchor="middle" font-size="10" fill="#92400e">held by A</text>
  <rect x="90" y="206" width="220" height="42" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="200" y="226" text-anchor="middle" font-size="11" font-weight="600" fill="#b91c1c">ERROR: deadlock detected</text>
  <text x="200" y="241" text-anchor="middle" font-size="10" fill="#b91c1c">SQLSTATE 40P01 — one tx aborted</text>
  <!-- cycle arrows -->
  <line x1="180" y1="151" x2="220" y2="151" stroke="#d97706" stroke-width="1.5" marker-end="url(#d1)"/>
  <line x1="220" y1="165" x2="180" y2="165" stroke="#d97706" stroke-width="1.5" marker-end="url(#d1)"/>
  <line x1="105" y1="98" x2="105" y2="128" stroke="currentColor" stroke-width="1.2" stroke-dasharray="3 2"/>
  <line x1="295" y1="98" x2="295" y2="128" stroke="currentColor" stroke-width="1.2" stroke-dasharray="3 2"/>
  <line x1="200" y1="174" x2="200" y2="206" stroke="#dc2626" stroke-width="1.5" marker-end="url(#d2)"/>
  <!-- divider -->
  <line x1="390" y1="44" x2="390" y2="256" stroke="var(--border, #c4b5fd)" stroke-width="1" stroke-dasharray="4 3"/>
  <!-- right: fix -->
  <rect x="430" y="66" width="120" height="44" rx="8" fill="none" stroke="#10b981" stroke-width="1.5"/>
  <text x="490" y="86" text-anchor="middle" font-size="11" font-weight="600" fill="#065f46">Tx A</text>
  <text x="490" y="101" text-anchor="middle" font-size="10" fill="#065f46">lock 17 → 42</text>
  <rect x="590" y="66" width="120" height="44" rx="8" fill="none" stroke="#10b981" stroke-width="1.5"/>
  <text x="650" y="86" text-anchor="middle" font-size="11" font-weight="600" fill="#065f46">Tx B</text>
  <text x="650" y="101" text-anchor="middle" font-size="10" fill="#065f46">lock 17 → 42</text>
  <rect x="470" y="140" width="200" height="44" rx="8" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="570" y="160" text-anchor="middle" font-size="11" font-weight="600" fill="#065f46">B waits at row 17, then proceeds</text>
  <text x="570" y="175" text-anchor="middle" font-size="10" fill="#065f46">no cycle — no deadlock</text>
  <line x1="490" y1="110" x2="540" y2="140" stroke="#10b981" stroke-width="1.5" marker-end="url(#d3)"/>
  <line x1="650" y1="110" x2="600" y2="140" stroke="#10b981" stroke-width="1.5" marker-end="url(#d3)"/>
  <defs>
    <marker id="d1" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#d97706"/></marker>
    <marker id="d2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#b91c1c"/></marker>
    <marker id="d3" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#10b981"/></marker>
  </defs>
</svg>

## Runnable implementation

Two parts: a decorator that retries a transaction on `40P01`/`40001`, and the SQL that locks rows in a deterministic order so the retries are rarely needed.

```python
# app/concurrency/retry.py
import asyncio
import random
import functools
from asyncpg.exceptions import DeadlockDetectedError, SerializationError
from sqlalchemy.exc import DBAPIError

# PostgreSQL SQLSTATEs worth retrying:
#   40P01 = deadlock_detected, 40001 = serialization_failure
RETRYABLE_SQLSTATES = {"40P01", "40001"}


def _is_retryable(exc: Exception) -> bool:
    orig = getattr(exc, "orig", exc)
    if isinstance(orig, (DeadlockDetectedError, SerializationError)):
        return True
    return getattr(orig, "sqlstate", None) in RETRYABLE_SQLSTATES


def retry_on_deadlock(max_attempts: int = 5, base_delay: float = 0.05, cap: float = 1.0):
    """Retry an async transaction fn on deadlock/serialization failure.
    The wrapped fn MUST be idempotent: it may run several times."""
    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            attempt = 0
            while True:
                try:
                    return await fn(*args, **kwargs)
                except DBAPIError as exc:
                    attempt += 1
                    if attempt >= max_attempts or not _is_retryable(exc):
                        raise
                    # Exponential backoff with full jitter to de-synchronise contenders.
                    delay = min(cap, base_delay * (2 ** (attempt - 1)))
                    await asyncio.sleep(random.uniform(0, delay))
        return wrapper
    return decorator
```

```python
# app/concurrency/spatial_writes.py
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from .retry import retry_on_deadlock


@retry_on_deadlock(max_attempts=5)
async def merge_overlapping_parcels(session: AsyncSession, ids: list[int]) -> None:
    """Rewrite several overlapping parcels atomically.
    Deadlock-safe because every writer locks rows in ascending id order."""
    async with session.begin():                      # one short, atomic transaction
        # 1. Deterministic lock order: ALWAYS ascending id. This is the whole trick.
        locked = await session.execute(
            text("""
                SELECT id, geom
                FROM parcels
                WHERE id = ANY(:ids)
                ORDER BY id            -- consistent order across all writers
                FOR UPDATE
            """),
            {"ids": sorted(ids)},
        )
        rows = locked.mappings().all()
        if len(rows) != len(ids):
            raise ValueError("Some parcels no longer exist")

        # 2. Now that all target rows are locked in order, do the spatial work.
        await session.execute(
            text("""
                UPDATE parcels
                SET geom = ST_MakeValid(ST_Union(geom) OVER ())
                WHERE id = ANY(:ids)
            """),
            {"ids": ids},
        )


@retry_on_deadlock(max_attempts=8)
async def update_hotspot_cell(session: AsyncSession, cell_key: int, delta_geom_wkb: bytes) -> None:
    """A single grid cell that many writers hit at once. Serialise them with an
    advisory lock instead of letting them fight over row locks."""
    async with session.begin():
        # Transaction-scoped advisory lock: auto-released at COMMIT/ROLLBACK.
        # All writers targeting the same cell_key queue on this one lock.
        await session.execute(
            text("SELECT pg_advisory_xact_lock(:k)"),
            {"k": cell_key},
        )
        await session.execute(
            text("""
                UPDATE coverage_cells
                SET geom = ST_Union(geom, ST_SetSRID(ST_GeomFromWKB(:g), 4326))
                WHERE cell_key = :k
            """),
            {"k": cell_key, "g": delta_geom_wkb},
        )
```

Advisory locks and row locks solve different shapes of the problem. `FOR UPDATE ORDER BY id` prevents cycles when a transaction touches a *set* of rows. `pg_advisory_xact_lock` serialises writers on a *single* known hotspot (a grid cell, a shared boundary) so they never contend on the row at all — cheaper than letting them deadlock and retry.

## Key parameters & options

| Parameter | What it controls | Recommended value |
|---|---|---|
| `max_attempts` | Retry ceiling before giving up | 5 for ordinary writes; up to 8 for hot rows |
| `base_delay` / `cap` | Exponential backoff window, in seconds | `base_delay=0.05`, `cap=1.0` |
| Jitter | Randomises retries so contenders do not resynchronise | Full jitter: `sleep(random.uniform(0, delay))` |
| Isolation level | `READ COMMITTED` deadlocks only on `40P01`; `REPEATABLE READ`/`SERIALIZABLE` add `40001` | `READ COMMITTED` unless a stable snapshot is required |
| `deadlock_timeout` (server) | How long PostgreSQL waits before running deadlock detection | Default `1s`; lower only on very hot workloads |
| Lock ordering key | The column that defines a total order for `FOR UPDATE` | Primary key `id` — stable and always indexed |
| `pg_advisory_xact_lock` key | Identifies the hotspot to serialise on | A stable integer (grid cell id / hashed boundary key) |

## Gotchas & failure modes

- **Retrying a non-idempotent write corrupts data.** The retry decorator may run the function several times. If the body does `parcel_count = parcel_count + 1` outside the locked, atomic scope, a retried transaction double-counts. Fix: make the whole operation idempotent — derive the new state from locked inputs inside the transaction, or key inserts with `ON CONFLICT DO NOTHING` — so a replay produces the same result. This is the same idempotency requirement flagged for retried bulk writes in [managing async transactions for bulk geometry writes](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/).

- **Lock ordering must be consistent across tables too.** Ordering rows by `id` within one table is not enough if transaction A locks `parcels` then `boundaries` while B locks `boundaries` then `parcels`. Fix: define a global order over tables (e.g. always lock `parcels` before `boundaries`) and honour it everywhere.

- **`ERROR: deadlock detected` (`40P01`) leaves the transaction aborted.** After a deadlock, PostgreSQL has already rolled the losing transaction back; every subsequent statement on that session fails with `current transaction is aborted, commands ignored until end of transaction block`. Fix: the retry must start a *fresh* transaction, not continue the aborted one — the decorator does this by re-invoking the whole function.

- **Serialization failures (`40001`) are not deadlocks but need the same retry.** Under `REPEATABLE READ` or `SERIALIZABLE`, a concurrent update surfaces as `could not serialize access due to concurrent update` (`40001`). It is expected and retryable — include it in `RETRYABLE_SQLSTATES`, as above.

- **Advisory locks that outlive their transaction.** `pg_advisory_lock` (session-scoped) is *not* released at `COMMIT` and, under PgBouncer transaction pooling, leaks onto a backend another client will borrow. Fix: always use the transaction-scoped `pg_advisory_xact_lock`, which releases automatically — the same `SET LOCAL` discipline described in the [connection pooling guide](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

## Verification

Reproduce a deadlock deliberately, then confirm the retry recovers. In two `psql` sessions, lock in opposite order:

```sql
-- Session 1                              -- Session 2
BEGIN;                                    BEGIN;
UPDATE parcels SET status='x'             UPDATE parcels SET status='x'
  WHERE id = 17;                            WHERE id = 42;
--                                        --
UPDATE parcels SET status='x'             UPDATE parcels SET status='x'
  WHERE id = 42;   -- waits                 WHERE id = 17;   -- deadlock!
-- one session now shows:
-- ERROR:  deadlock detected
-- SQLSTATE: 40P01
```

Then run the decorated path under contention and confirm it succeeds without surfacing a 500. Count deadlocks server-side — a healthy service keeps this number low and flat:

```sql
SELECT datname, deadlocks FROM pg_stat_database WHERE datname = current_database();
-- If deadlocks climbs steadily, lock ordering is inconsistent somewhere.
```

Confirm no advisory locks are leaking between requests:

```sql
SELECT locktype, objid, pid FROM pg_locks WHERE locktype = 'advisory';
-- Should be empty between transactions when using pg_advisory_xact_lock.
```

## Related

- [Async PostGIS Transaction Patterns](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/) — transaction boundaries, isolation levels, and short lock scopes
- [Managing Async Transactions for Bulk Geometry Writes](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/) — idempotent, chunked writes that coexist with live updates
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — why transaction-scoped locks and `SET LOCAL` are mandatory under pooling

← Back to [Async PostGIS Transaction Patterns](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/)
