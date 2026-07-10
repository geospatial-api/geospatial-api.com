---
layout: layouts/page.njk
title: "Async PostGIS Transaction Patterns"
description: "Correct transaction handling for async spatial writes with SQLAlchemy 2.0 AsyncSession and asyncpg: explicit transactions, savepoints, isolation levels, short-held GiST locks, SET LOCAL under PgBouncer, and batched geometry writes."
slug: "async-postgis-transaction-patterns"
type: "cluster"
breadcrumb: "Advanced Spatial Endpoints & Data Contracts > Async PostGIS Transaction Patterns"
datePublished: "2025-09-12"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Async PostGIS Transaction Patterns",
      "description": "Correct transaction handling for async spatial writes with SQLAlchemy 2.0 AsyncSession and asyncpg: explicit transactions, savepoints, isolation levels, short-held GiST locks, SET LOCAL under PgBouncer, and batched geometry writes.",
      "datePublished": "2025-09-12",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "Article",
      "headline": "Async PostGIS Transaction Patterns",
      "datePublished": "2025-09-12",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://geospatial-api.com/"},
        {"@type": "ListItem", "position": 2, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/"},
        {"@type": "ListItem", "position": 3, "name": "Async PostGIS Transaction Patterns", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Handle Async PostGIS Transactions Safely in FastAPI",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Pick a strategy from the autocommit vs explicit vs batched decision matrix"},
        {"@type": "HowToStep", "position": 2, "name": "Open one explicit transaction per request with async with session.begin()"},
        {"@type": "HowToStep", "position": 3, "name": "Wrap the risky geometry step in a savepoint via session.begin_nested()"},
        {"@type": "HowToStep", "position": 4, "name": "Set the isolation level and SET LOCAL parameters inside the transaction"},
        {"@type": "HowToStep", "position": 5, "name": "Verify lock hold time with pg_stat_activity and EXPLAIN"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why do I get 'another operation is in progress' with AsyncSession?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "asyncpg allows only one operation per connection at a time. The InterfaceError 'cannot perform operation: another operation is in progress' means two coroutines are sharing one AsyncSession or one underlying connection concurrently. An AsyncSession is not safe to share across tasks. Give each concurrent task its own session from the async_sessionmaker, and never await two queries on the same session with asyncio.gather."
          }
        },
        {
          "@type": "Question",
          "name": "Should I use REPEATABLE READ or READ COMMITTED for concurrent spatial updates?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "READ COMMITTED is the right default for high-concurrency spatial writes: each statement sees a fresh snapshot, so updates to non-overlapping geometries rarely conflict. Use REPEATABLE READ only when a multi-statement read-modify-write must see a stable snapshot, for example recomputing a coverage polygon from several rows. REPEATABLE READ raises the chance of a serialization failure (SQLSTATE 40001) that you must catch and retry."
          }
        },
        {
          "@type": "Question",
          "name": "Does SET LOCAL work with PgBouncer transaction pooling?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, but only when it is issued inside an explicit transaction. SET LOCAL scopes a parameter to the current transaction, so PgBouncer in transaction mode returns the backend to the pool cleanly at COMMIT with no leaked state. Plain SET (without LOCAL) is unsafe under transaction pooling because the setting persists on a backend that another client will borrow next."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Advanced Spatial Endpoints & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/)

# Async PostGIS transaction patterns

A spatial write is rarely a single statement. Inserting a parcel, updating its centroid, and refreshing an adjacency row belong together — either all of them land or none of them do. When that work runs inside an async FastAPI handler on top of SQLAlchemy 2.0's `AsyncSession` and `asyncpg`, the transaction boundary stops being a background detail and becomes the thing that decides whether your geometry data stays consistent under concurrency. Get it wrong and you leak half-written geometries, pile GiST and heap locks on hot rows, and eventually starve the connection pool with `idle in transaction` backends.

This guide is about drawing that boundary deliberately: when to let a statement autocommit, when to wrap several writes in one explicit transaction, when to nest a savepoint so a single failing geometry does not abort the whole request, and how to keep transactions short enough that PostGIS's per-row locks never become a queue. It assumes you have already put a pooler in front of PostgreSQL — the [connection pooling and PgBouncer setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) guide covers that layer — because transaction pooling changes what `SET` and prepared statements are allowed to do.

---

## The transaction lifecycle for one spatial write

The diagram below traces a single request that writes a geometry, derives a value from it, and updates a summary row — all inside one transaction, with a savepoint protecting the step most likely to fail.

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Async PostGIS transaction lifecycle with a savepoint around a geometry validation step" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Async transaction lifecycle with a savepoint</title>
  <desc>A FastAPI request opens BEGIN, inserts a geometry, opens a SAVEPOINT before validating and repairing the geometry, releases the savepoint on success or rolls back to it on failure, updates a summary row, then commits. On any unhandled error the whole transaction rolls back and the backend returns to the pool.</desc>
  <rect x="0" y="0" width="760" height="340" rx="12" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="380" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">One request = one transaction</text>
  <!-- BEGIN -->
  <rect x="30" y="54" width="150" height="46" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="105" y="80" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">BEGIN</text>
  <text x="105" y="94" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">session.begin()</text>
  <!-- INSERT geom -->
  <rect x="210" y="54" width="150" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="285" y="76" text-anchor="middle" font-size="11" fill="currentColor">INSERT geom</text>
  <text x="285" y="92" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">heap + GiST lock</text>
  <!-- Savepoint block -->
  <rect x="390" y="46" width="340" height="118" rx="10" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5" stroke-dasharray="6 3"/>
  <text x="560" y="40" text-anchor="middle" font-size="10" font-weight="600" fill="var(--muted, #7c6fb0)">SAVEPOINT (begin_nested)</text>
  <rect x="410" y="62" width="140" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="480" y="82" text-anchor="middle" font-size="11" fill="currentColor">ST_MakeValid</text>
  <text x="480" y="97" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">may raise</text>
  <rect x="570" y="62" width="140" height="44" rx="8" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="640" y="82" text-anchor="middle" font-size="11" fill="#065f46" font-weight="600">RELEASE</text>
  <text x="640" y="97" text-anchor="middle" font-size="10" fill="#065f46">on success</text>
  <rect x="410" y="118" width="300" height="38" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="560" y="142" text-anchor="middle" font-size="11" fill="#92400e">ROLLBACK TO SAVEPOINT on error — outer tx survives</text>
  <!-- UPDATE summary -->
  <rect x="210" y="200" width="150" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="285" y="222" text-anchor="middle" font-size="11" fill="currentColor">UPDATE summary</text>
  <text x="285" y="238" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">short-held row lock</text>
  <!-- COMMIT -->
  <rect x="390" y="200" width="150" height="46" rx="8" fill="#d1fae5" stroke="#10b981" stroke-width="2"/>
  <text x="465" y="222" text-anchor="middle" font-size="12" font-weight="600" fill="#065f46">COMMIT</text>
  <text x="465" y="238" text-anchor="middle" font-size="10" fill="#065f46">locks released</text>
  <!-- return to pool -->
  <rect x="570" y="200" width="160" height="46" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="650" y="222" text-anchor="middle" font-size="11" fill="currentColor">return to pool</text>
  <text x="650" y="238" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">PgBouncer tx mode</text>
  <!-- rollback lane -->
  <rect x="30" y="278" width="700" height="40" rx="8" fill="none" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5 3"/>
  <text x="380" y="303" text-anchor="middle" font-size="11" fill="#b91c1c">Unhandled exception → session.rollback() → nothing persisted, backend cleaned before reuse</text>
  <!-- arrows -->
  <line x1="180" y1="77" x2="210" y2="77" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="360" y1="77" x2="390" y2="90" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="480" y1="106" x2="480" y2="118" stroke="#d97706" stroke-width="1.5" marker-end="url(#arrw)"/>
  <line x1="550" y1="84" x2="570" y2="84" stroke="#10b981" stroke-width="1.5" marker-end="url(#arrg)"/>
  <line x1="465" y1="164" x2="465" y2="200" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="285" y1="200" x2="285" y2="100" stroke="currentColor" stroke-width="1" stroke-dasharray="3 2"/>
  <line x1="360" y1="223" x2="390" y2="223" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="540" y1="223" x2="570" y2="223" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/></marker>
    <marker id="arrg" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#10b981"/></marker>
    <marker id="arrw" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
</svg>

The whole point is the width of that transaction. Every lock the `INSERT` and `UPDATE` acquire is held until `COMMIT`. If the request does anything slow between `BEGIN` and `COMMIT` — an HTTP call, a large `ST_Union`, an `await` on an unrelated coroutine — every other writer touching those rows waits. Short transactions are not a style preference for spatial workloads; they are the difference between a pool that recycles connections in single-digit milliseconds and one that fills with `idle in transaction` backends.

---

## Prerequisites & Environment

| Component | Minimum version | Why it matters here |
|---|---|---|
| PostgreSQL | 14+ | Stable `SET LOCAL` under transaction pooling; predictable `40P01`/`40001` SQLSTATE reporting |
| PostGIS | 3.3+ | `ST_MakeValid`, `ST_GeomFromWKB`, and `geography` casts used in the examples |
| SQLAlchemy | 2.0+ | Native `AsyncSession`, `async_sessionmaker`, `session.begin()` / `begin_nested()` |
| asyncpg | 0.29+ | One-operation-per-connection semantics; binary geometry transfer |
| FastAPI | 0.100+ | Async lifespan and dependency injection |
| PgBouncer | 1.21+ | `pool_mode = transaction` with correct `SET LOCAL` handling |

Install the stack:

```bash
pip install "fastapi>=0.100" "asyncpg>=0.29" "sqlalchemy[asyncio]>=2.0" "geoalchemy2>=0.14"
```

Two facts drive every pattern below. First, an `AsyncSession` wraps exactly one `asyncpg` connection, and `asyncpg` permits **one operation at a time** on that connection — sharing a session between coroutines is the direct cause of the `another operation is in progress` error. Second, when you route through PgBouncer in transaction mode, the backend connection is only yours for the length of a transaction, so any parameter you set must be transaction-scoped with `SET LOCAL`.

---

## Decision matrix: how wide should the transaction be?

Before writing a handler, decide which of three shapes the write takes. This is the analytical anchor for everything that follows.

| Strategy | How it commits | Use when | Cost / risk |
|---|---|---|---|
| **Autocommit** (implicit) | Each statement commits on its own | A single, self-contained write — one `INSERT`, one `UPDATE` with no dependent read | No atomicity across statements; a second statement can see a half-applied world |
| **Explicit transaction** (`async with session.begin()`) | One `COMMIT` at the end of the block | Multi-step writes that must be atomic — insert geometry + update summary + write audit row | Holds all locks until commit; must stay short |
| **Explicit + savepoint** (`begin_nested()`) | Inner `RELEASE`/`ROLLBACK TO`, outer `COMMIT` | One step inside the transaction may fail recoverably (geometry repair, optional enrichment) | Extra round-trips per savepoint; still one outer lock scope |
| **Batched writes** | Chunked `COMMIT` every N rows | Writing thousands of geometries where one atomic transaction would bloat WAL and hold locks too long | Partial visibility between chunks; needs idempotent retry |

The default for a normal API write is the explicit transaction. Reach for a savepoint only when a specific step is expected to fail in a way you want to recover from without discarding the rest of the request. Reach for batching only for bulk loads — that path has its own gotchas, covered in [managing async transactions for bulk geometry writes](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/).

---

## Step-by-Step Implementation

### Step 1: One session per task, never shared

The `async_sessionmaker` is your factory. FastAPI's dependency injection hands each request its own session; concurrent background tasks must each request their own. Never pass one `AsyncSession` into `asyncio.gather`.

```python
# app/database.py
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
import os

engine = create_async_engine(
    f"postgresql+asyncpg://{os.environ['DB_USER']}:{os.environ['DB_PASSWORD']}@pgbouncer:6432/gis_db",
    pool_size=5,
    max_overflow=0,
    pool_recycle=1800,
    connect_args={"statement_cache_size": 0},  # required behind PgBouncer transaction pooling
)

AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
```

`expire_on_commit=False` matters for spatial APIs: it stops SQLAlchemy from issuing a fresh `SELECT` to reload attributes after commit, which under transaction pooling would open a *second* transaction just to refresh a geometry you already have.

### Step 2: Draw the transaction boundary explicitly

`async with session.begin()` opens a transaction, commits on clean exit, and rolls back if the block raises. This is the single most reliable pattern — there is no path where you forget to commit or leak an open transaction.

```python
async def write_parcel(session: AsyncSession, wkb: bytes, srid: int) -> int:
    async with session.begin():                       # BEGIN ... COMMIT/ROLLBACK
        row = await session.execute(
            text("""
                INSERT INTO parcels (geom)
                VALUES (ST_SetSRID(ST_GeomFromWKB(:wkb), :srid))
                RETURNING id
            """),
            {"wkb": wkb, "srid": srid},
        )
        parcel_id = row.scalar_one()
        await session.execute(
            text("UPDATE tile_summary SET parcel_count = parcel_count + 1 WHERE tile_id = tile_for(:pid)"),
            {"pid": parcel_id},
        )
        return parcel_id
    # transaction already committed here; locks released
```

Do not also call `session.commit()` inside the block — `session.begin()` owns the commit. Mixing the two raises `InvalidRequestError: a transaction is already begun on this Session`.

### Step 3: Protect the fragile step with a savepoint

Real-world geometry is dirty: self-intersections, wrong ring orientation, near-duplicate vertices. If `ST_MakeValid` or a topology constraint raises, you often want to fall back (store the raw geometry flagged for review) rather than abort the whole request. `session.begin_nested()` issues a `SAVEPOINT`; a failure inside rolls back only to that savepoint and leaves the outer transaction usable.

```python
async def write_with_repair(session: AsyncSession, wkb: bytes, srid: int) -> int:
    async with session.begin():
        parcel = await session.execute(
            text("INSERT INTO parcels (geom, status) "
                 "VALUES (ST_SetSRID(ST_GeomFromWKB(:wkb), :srid), 'pending') RETURNING id"),
            {"wkb": wkb, "srid": srid},
        )
        parcel_id = parcel.scalar_one()
        try:
            async with session.begin_nested():        # SAVEPOINT
                await session.execute(
                    text("UPDATE parcels SET geom = ST_MakeValid(geom), status = 'valid' "
                         "WHERE id = :id AND NOT ST_IsValid(geom)"),
                    {"id": parcel_id},
                )
            # RELEASE SAVEPOINT on clean exit
        except DBAPIError:
            # ROLLBACK TO SAVEPOINT already happened; flag for manual review
            await session.execute(
                text("UPDATE parcels SET status = 'needs_review' WHERE id = :id"),
                {"id": parcel_id},
            )
        return parcel_id
```

Because a savepoint is a `SAVEPOINT`/`RELEASE` round-trip, do not wrap every statement in one — reserve it for the step that genuinely might fail.

### Step 4: Set isolation and session parameters *inside* the transaction

For a multi-statement read-modify-write that must see a consistent snapshot — say, recomputing a service-area polygon from several rows — raise the isolation level for that transaction only. Do it with `SET LOCAL` so the setting dies at `COMMIT` and never leaks onto a pooled backend.

```python
async def recompute_coverage(session: AsyncSession, region_id: int) -> None:
    async with session.begin():
        # SET LOCAL is transaction-scoped: safe under PgBouncer transaction pooling
        await session.execute(text("SET LOCAL statement_timeout = '5s'"))
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        await session.execute(
            text("""
                UPDATE regions
                SET coverage = sub.geom
                FROM (
                    SELECT ST_Union(geom) AS geom FROM parcels WHERE region_id = :rid
                ) sub
                WHERE regions.id = :rid
            """),
            {"rid": region_id},
        )
```

`REPEATABLE READ` gives the `ST_Union` a stable snapshot, so a parcel inserted mid-transaction cannot make the aggregate inconsistent. The trade-off is that a concurrent writer to `regions` can trigger a serialization failure (`40001`) that the caller must retry — the same retry discipline used for [handling deadlocks in concurrent spatial updates](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/handling-deadlocks-in-concurrent-spatial-updates/).

### Step 5: Keep it short — offload slow work out of the lock scope

The cardinal rule: nothing slow happens between `BEGIN` and `COMMIT`. Compute the geometry, call external services, and validate payloads *before* you open the transaction. If a write is genuinely large, batch it — never hold one transaction open across thousands of rows or a long-running client stream, which is exactly the failure the [bulk geometry write patterns](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/) exist to avoid. Heavy ingestion belongs off the request path entirely, in a worker — see [async bulk uploads with Celery](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/).

---

## Production Code Example

A complete FastAPI route that performs a multi-step geometry write in one transaction, with a savepoint around geometry repair and a short lock scope. Validation happens on the Pydantic model before the transaction opens.

```python
# app/routes/parcels.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import DBAPIError
from sqlalchemy import text
from pydantic import BaseModel, field_validator
from shapely import wkb as shp_wkb
from ..dependencies import get_db

router = APIRouter(prefix="/parcels", tags=["parcels"])

class ParcelIn(BaseModel):
    wkb_hex: str          # geometry as hex-encoded WKB
    srid: int = 4326

    @field_validator("srid")
    @classmethod
    def known_srid(cls, v: int) -> int:
        if v not in {4326, 3857, 27700}:
            raise ValueError(f"Unsupported SRID {v}")
        return v

    @field_validator("wkb_hex")
    @classmethod
    def parseable(cls, v: str) -> str:
        try:
            shp_wkb.loads(bytes.fromhex(v))    # fail fast, before any DB round-trip
        except Exception:
            raise ValueError("Unparseable WKB geometry")
        return v

@router.post("", status_code=201)
async def create_parcel(payload: ParcelIn, db: AsyncSession = Depends(get_db)):
    wkb_bytes = bytes.fromhex(payload.wkb_hex)
    try:
        async with db.begin():                                  # one short transaction
            await db.execute(text("SET LOCAL statement_timeout = '4s'"))

            inserted = await db.execute(
                text("""
                    INSERT INTO parcels (geom, status)
                    VALUES (ST_SetSRID(ST_GeomFromWKB(:wkb), :srid), 'pending')
                    RETURNING id
                """),
                {"wkb": wkb_bytes, "srid": payload.srid},
            )
            parcel_id = inserted.scalar_one()

            # Repair step is isolated: a failure here must not lose the insert.
            try:
                async with db.begin_nested():                   # SAVEPOINT
                    await db.execute(
                        text("""
                            UPDATE parcels
                            SET geom = ST_MakeValid(geom), status = 'valid'
                            WHERE id = :id AND NOT ST_IsValid(geom)
                        """),
                        {"id": parcel_id},
                    )
            except DBAPIError:
                await db.execute(
                    text("UPDATE parcels SET status = 'needs_review' WHERE id = :id"),
                    {"id": parcel_id},
                )

            # Cheap dependent update, still inside the same atomic scope.
            await db.execute(
                text("""
                    INSERT INTO region_counts (region_id, n)
                    SELECT region_id, 1 FROM parcels WHERE id = :id
                    ON CONFLICT (region_id) DO UPDATE SET n = region_counts.n + 1
                """),
                {"id": parcel_id},
            )
        return {"id": parcel_id}
    except DBAPIError as exc:
        # e.g. statement_timeout fired, or a constraint rejected the geometry
        raise HTTPException(status_code=409, detail=f"Write failed: {exc.orig}") from exc
```

Note the `get_db` dependency yields a session but does **not** wrap it in a transaction — the route owns its transaction boundary explicitly. This keeps the `SET LOCAL` and savepoint logic in one visible place instead of split across a dependency and a handler.

---

## Verification & Testing

**Confirm no backend is stuck in a transaction.** Idle-in-transaction backends are the single clearest sign a transaction is held too long:

```sql
SELECT pid, state, wait_event_type, now() - xact_start AS tx_age, query
FROM pg_stat_activity
WHERE datname = current_database()
  AND state = 'idle in transaction'
ORDER BY tx_age DESC;
```

A healthy async write service shows zero rows here under steady load. Any row with a `tx_age` above a second means a transaction opened and then awaited something slow before committing.

**Confirm the write path uses the index, not a seq scan,** so the lock scope stays small:

```sql
EXPLAIN (ANALYZE, BUFFERS)
UPDATE parcels SET status = 'valid'
WHERE id = 42 AND NOT ST_IsValid(geom);
```

Look for an `Index Scan using parcels_pkey` — an update filtered by `id` should never scan the heap. For the deeper reading of spatial plans, see [reading EXPLAIN ANALYZE for spatial query optimization](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/).

**Unit test the atomicity guarantee** — a failure after the insert must leave no parcel behind:

```python
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_rollback_leaves_no_partial_write(monkeypatch, count_parcels):
    before = await count_parcels()
    # Force the dependent update to fail; the whole tx must roll back.
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        resp = await c.post("/parcels", json={"wkb_hex": "00"*8, "srid": 4326})
    assert resp.status_code in (409, 422)
    assert await count_parcels() == before      # nothing persisted
```

---

## Failure Modes & Edge Cases

1. **`InterfaceError: cannot perform operation: another operation is in progress`** — two coroutines are using one session/connection at once. This appears the moment you write `await asyncio.gather(session.execute(a), session.execute(b))`. Fix: one session per concurrent task. Open a second session from `AsyncSessionLocal` for the parallel branch, or run the statements sequentially on the one session.

2. **`InvalidRequestError: a transaction is already begun on this Session`** — you called `session.begin()` while a transaction was already open (often because the `get_db` dependency already began one, or you called `commit()` inside a `begin()` block). Fix: pick one owner of the transaction boundary; if the dependency begins the transaction, the route must not.

3. **Idle-in-transaction pool exhaustion** — a transaction opened, then the code `await`ed a slow HTTP call or a large aggregation before committing. Backends accumulate in `idle in transaction`, PgBouncer's pool drains, and new requests time out. Fix: do slow work before `BEGIN`; set `idle_in_transaction_session_timeout = '10s'` at the database as a backstop so a leaked transaction is force-closed rather than pinning a backend forever.

4. **`SET` leaking across pooled clients** — using plain `SET search_path = tenant_x` (without `LOCAL`) under PgBouncer transaction pooling. The setting persists on the backend and the next borrowing client inherits it, silently reading another tenant's schema. Fix: always `SET LOCAL` inside a transaction, or use fully schema-qualified table names.

5. **`prepared statement "__asyncpg_stmt_..." does not exist`** — asyncpg's client-side statement cache collides with transaction pooling. Fix: `statement_cache_size=0` in `connect_args`, as in the [PgBouncer setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) guide.

6. **Silent `NULL` from `ST_MakeValid` inside a savepoint you never check** — the savepoint swallows the error, but the row is left with a null geometry. Fix: assert the post-condition (`status = 'valid'` or a non-null `geom`) rather than assuming the `RELEASE` succeeded.

7. **Serialization failure (`SQLSTATE 40001`) surfacing as a 500** under `REPEATABLE READ`. It is not a bug — it means PostgreSQL correctly refused to lose an update. Fix: catch it and retry the whole transaction with fresh input, using the retry pattern from [handling deadlocks in concurrent spatial updates](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/handling-deadlocks-in-concurrent-spatial-updates/).

---

## Performance Notes

**Transaction width dominates everything.** A single-row parcel insert plus one summary update commits in roughly 1–3 ms on a warm connection when nothing slow sits inside the boundary. Insert one `await` on a 40 ms external call between `BEGIN` and `COMMIT` and you have not made that request 40 ms slower — you have held its row and GiST locks for 40 ms, throttling every concurrent writer of the same rows to ~25 per second per row. Measure the gap with `now() - xact_start`, not with request latency.

**Savepoints are not free.** Each `begin_nested()` is a `SAVEPOINT`/`RELEASE` round-trip — around 0.2–0.4 ms each on a local pooler. That is negligible for one savepoint guarding a repair step and ruinous if you wrap all thousand rows of a batch in individual savepoints. For bulk work, prefer chunked commits over per-row savepoints.

**Isolation level cost.** `READ COMMITTED` (the default) re-snapshots per statement and rarely conflicts for writes to distinct geometries — keep it for ordinary CRUD. `REPEATABLE READ` holds one snapshot for the whole transaction, adds no lock overhead itself, but shifts cost to the application in the form of `40001` retries under contention. Only pay it where a multi-statement computation needs a stable view.

**Batching WAL.** Committing every row generates one WAL flush per commit; committing 500 rows per transaction cuts flushes by ~500×, but a single giant transaction over 100k rows bloats WAL, delays vacuum, and holds locks. The sweet spot for geometry loads is a few thousand rows per commit — quantified in the [bulk geometry write guide](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/).

**Pooling interaction.** Because transaction pooling returns the backend at `COMMIT`, short transactions directly raise the multiplexing ratio of the pool. Every millisecond shaved off a transaction is a millisecond that backend is available to another client — the connection-count budget from the [PgBouncer setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) guide only works if transactions stay short.

---

## FAQ

### Why do I get "another operation is in progress" with AsyncSession?

`asyncpg` allows only one operation per connection at a time, and an `AsyncSession` wraps one connection. The `InterfaceError: cannot perform operation: another operation is in progress` means two coroutines are driving the same session or connection concurrently — almost always an `asyncio.gather` over statements that share one session. An `AsyncSession` is not safe to share across tasks. Give each concurrent task its own session from the `async_sessionmaker`, and run statements on a single session sequentially.

### Should I use REPEATABLE READ or READ COMMITTED for concurrent spatial updates?

`READ COMMITTED` is the right default. Each statement sees a fresh snapshot, so updates to non-overlapping geometries almost never conflict, and there is nothing for the application to retry. Use `REPEATABLE READ` only when a multi-statement read-modify-write must observe a stable snapshot — for example recomputing a coverage polygon from several rows with `ST_Union`. The cost is that a concurrent writer can cause a serialization failure (`SQLSTATE 40001`) that you must catch and retry.

### Does SET LOCAL work with PgBouncer transaction pooling?

Yes — as long as it runs inside an explicit transaction. `SET LOCAL` scopes the parameter to the current transaction, so when PgBouncer in transaction mode returns the backend to the pool at `COMMIT`, no state leaks to the next client. Plain `SET` (without `LOCAL`) is unsafe under transaction pooling because the value persists on a backend that another client will borrow next, which is how tenants end up reading each other's `search_path`.

---

## Related

- [Managing Async Transactions for Bulk Geometry Writes](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/) — chunked commits, `copy_records_to_table`, and deferring the GiST index for large loads
- [Handling Deadlocks in Concurrent Spatial Updates](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/handling-deadlocks-in-concurrent-spatial-updates/) — lock ordering, `40P01` retries, and advisory locks for hotspot geometries
- [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — transaction pooling, `statement_cache_size=0`, and why `SET LOCAL` is mandatory
- [Async Bulk Uploads with Celery](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) — move heavy ingestion off the request path entirely
- [Advanced Spatial Endpoints & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/) — the wider set of endpoint and contract patterns this fits into

← Back to [Advanced Spatial Endpoints & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/)
