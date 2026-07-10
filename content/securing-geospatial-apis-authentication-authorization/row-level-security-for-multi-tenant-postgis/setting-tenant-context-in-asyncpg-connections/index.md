---
layout: layouts/page.njk
title: "Setting Tenant Context in asyncpg Connections"
description: "Set app.tenant_id correctly per request with asyncpg and SQLAlchemy AsyncSession behind PgBouncer transaction pooling: use SET LOCAL inside the transaction, never session-level SET, and bind the tenant with set_config to avoid injection."
slug: "setting-tenant-context-in-asyncpg-connections"
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "Row-Level Security for Multi-Tenant PostGIS"
    url: "/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/"
  - label: "Setting Tenant Context in asyncpg Connections"
    url: "/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/"
datePublished: "2026-01-19"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Setting Tenant Context in asyncpg Connections",
      "description": "Set app.tenant_id correctly per request with asyncpg and SQLAlchemy AsyncSession behind PgBouncer transaction pooling: use SET LOCAL inside the transaction, never session-level SET, and bind the tenant with set_config to avoid injection.",
      "datePublished": "2026-01-19",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/"},
        {"@type": "ListItem", "position": 2, "name": "Row-Level Security for Multi-Tenant PostGIS", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/"},
        {"@type": "ListItem", "position": 3, "name": "Setting Tenant Context in asyncpg Connections", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Set tenant context per request in asyncpg behind PgBouncer",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Open a transaction for each request so SET LOCAL has a scope to bind to."},
        {"@type": "HowToStep", "position": 2, "text": "Call set_config('app.tenant_id', :tid, true) with the tenant as a bind parameter."},
        {"@type": "HowToStep", "position": 3, "text": "Run the RLS-protected query in the same transaction and commit."},
        {"@type": "HowToStep", "position": 4, "text": "Verify the context does not leak across pooled clients."}
      ]
    },
    {
      "@type": "Article",
      "headline": "Setting Tenant Context in asyncpg Connections",
      "datePublished": "2026-01-19",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/)

# Setting tenant context in asyncpg connections

Set `app.tenant_id` per request so PostGIS row-level security has a tenant to filter on — using `SET LOCAL` inside the transaction so the value can never leak onto the next client that borrows the same pooled connection.

## Context & when to use

This is the operational half of [row-level security for multi-tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/): the policies are inert until each request establishes its tenant on the connection running the query. The subtlety is connection pooling. Under PgBouncer in **transaction** mode, a single PostgreSQL backend is handed to different clients transaction by transaction, so any state you set *outside* a transaction — a session-level `SET app.tenant_id` — persists on that backend and is inherited by the next, unrelated request. In a multi-tenant system that is a direct cross-tenant data breach: tenant B's request runs against a backend still carrying tenant A's context.

Use `SET LOCAL` (or its function form `set_config(name, value, true)`) which binds the value to the *current transaction only* and is discarded automatically on `COMMIT`/`ROLLBACK`. The pooling-mode caveat is exactly the one described in [connection pooling & PgBouncer setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — transaction pooling does not preserve session state, which is what makes `SET LOCAL` both necessary and safe. Apply this whenever RLS is enabled and you sit behind PgBouncer transaction pooling, `pgcat`, RDS Proxy, or Supavisor in transaction mode.

**Preconditions:** RLS policies already reference `app.tenant_id`; the app connects as a non-owner, non-`BYPASSRLS` role; `asyncpg` runs with `statement_cache_size=0` behind the pooler; and every request has a validated `tenant_id` (typically a JWT claim resolved by a FastAPI dependency).

---

## SET vs SET LOCAL under transaction pooling

The diagram contrasts the two: session `SET` bleeds tenant A's context onto tenant B's borrowed backend, while `SET LOCAL` is scoped to the transaction and released before the backend is reused.

<svg viewBox="0 0 740 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Session SET leaks tenant context across pooled clients while SET LOCAL is confined to the transaction" style="width:100%;max-width:740px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>SET versus SET LOCAL under PgBouncer transaction pooling</title>
  <desc>Top row: a session-level SET app.tenant_id by tenant A persists on the pooled backend, so tenant B's next transaction inherits tenant A's context and leaks data. Bottom row: SET LOCAL inside tenant A's transaction is discarded at COMMIT, so tenant B starts with no context and its own SET LOCAL applies.</desc>
  <rect x="0" y="0" width="740" height="320" rx="12" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <!-- Top: session SET (danger) -->
  <text x="20" y="34" font-size="12" font-weight="700" fill="currentColor">Session SET — leaks</text>
  <rect x="20" y="46" width="150" height="60" rx="7" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="95" y="70" text-anchor="middle" font-size="11" fill="currentColor">Tenant A txn</text>
  <text x="95" y="88" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">SET app.tenant_id=A</text>
  <rect x="300" y="46" width="150" height="60" rx="7" fill="none" stroke="var(--border, #c4b5fd)" stroke-width="1.5" stroke-dasharray="5 3"/>
  <text x="375" y="70" text-anchor="middle" font-size="11" fill="currentColor">pooled backend</text>
  <text x="375" y="88" text-anchor="middle" font-size="10" fill="#b91c1c">still = A</text>
  <rect x="560" y="46" width="160" height="60" rx="7" fill="none" stroke="#b91c1c" stroke-width="1.6"/>
  <text x="640" y="70" text-anchor="middle" font-size="11" fill="currentColor">Tenant B txn</text>
  <text x="640" y="88" text-anchor="middle" font-size="10" fill="#b91c1c">reads A's rows!</text>
  <line x1="170" y1="76" x2="300" y2="76" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#arrb)"/>
  <line x1="450" y1="76" x2="560" y2="76" stroke="#b91c1c" stroke-width="1.5" marker-end="url(#arrr)"/>
  <!-- divider -->
  <line x1="20" y1="140" x2="720" y2="140" stroke="var(--border, #c4b5fd)" stroke-width="1" stroke-dasharray="4 3"/>
  <!-- Bottom: SET LOCAL (safe) -->
  <text x="20" y="176" font-size="12" font-weight="700" fill="currentColor">SET LOCAL — safe</text>
  <rect x="20" y="188" width="150" height="60" rx="7" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="95" y="212" text-anchor="middle" font-size="11" fill="currentColor">Tenant A txn</text>
  <text x="95" y="230" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">SET LOCAL = A → COMMIT</text>
  <rect x="300" y="188" width="150" height="60" rx="7" fill="none" stroke="var(--border, #c4b5fd)" stroke-width="1.5" stroke-dasharray="5 3"/>
  <text x="375" y="212" text-anchor="middle" font-size="11" fill="currentColor">pooled backend</text>
  <text x="375" y="230" text-anchor="middle" font-size="10" fill="#047857">reset — no context</text>
  <rect x="560" y="188" width="160" height="60" rx="7" fill="none" stroke="#047857" stroke-width="1.6"/>
  <text x="640" y="212" text-anchor="middle" font-size="11" fill="currentColor">Tenant B txn</text>
  <text x="640" y="230" text-anchor="middle" font-size="10" fill="#047857">SET LOCAL = B</text>
  <line x1="170" y1="218" x2="300" y2="218" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#arrb)"/>
  <line x1="450" y1="218" x2="560" y2="218" stroke="#047857" stroke-width="1.5" marker-end="url(#arrg)"/>
  <text x="370" y="290" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">SET LOCAL is discarded at COMMIT/ROLLBACK — nothing survives the hand-off</text>
  <defs>
    <marker id="arrb" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="var(--accent, #7c3aed)"/></marker>
    <marker id="arrr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#b91c1c"/></marker>
    <marker id="arrg" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#047857"/></marker>
  </defs>
</svg>

---

## Runnable implementation

The robust pattern binds the tenant per transaction with `set_config(..., true)` — the function form of `SET LOCAL` that accepts a **bind parameter**, so the tenant UUID never touches an interpolated SQL string. Here it is wired as a FastAPI dependency over a SQLAlchemy `AsyncSession`.

```python
# app/dependencies.py
from typing import AsyncGenerator
from fastapi import Depends, Request, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from .database import AsyncSessionLocal
from .auth import decode_jwt   # your verified-claims helper


def get_tenant_id(request: Request) -> str:
    """Resolve and validate the tenant from the request's JWT."""
    claims = decode_jwt(request.headers.get("authorization", ""))
    tid = claims.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="No tenant in token.")
    return tid  # a UUID string; cast to ::uuid happens in the policy


async def get_db(
    tenant_id: str = Depends(get_tenant_id),
) -> AsyncGenerator[AsyncSession, None]:
    """
    Yield a session whose transaction is pinned to the caller's tenant.
    set_config(..., is_local => true) == SET LOCAL: transaction-scoped, so
    the value cannot survive onto the next client of a pooled backend.
    """
    async with AsyncSessionLocal() as session:
        # begin() opens ONE transaction; the whole request runs inside it.
        async with session.begin():
            # Parameterised — the tenant is a bind value, never string-formatted.
            await session.execute(
                text("SELECT set_config('app.tenant_id', :tid, true)"),
                {"tid": tenant_id},
            )
            yield session
        # Exiting session.begin() commits (or rolls back) → SET LOCAL cleared.
```

If you prefer to guarantee the context is applied on *every* checkout regardless of route code, hook it at the transaction-begin event so it is impossible to forget:

```python
# app/database.py  (event-driven variant)
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from contextvars import ContextVar

current_tenant: ContextVar[str | None] = ContextVar("current_tenant", default=None)

engine = create_async_engine(
    "postgresql+asyncpg://api_app:***@pgbouncer:6432/gis_db",
    pool_size=5, max_overflow=0,
    connect_args={"statement_cache_size": 0},  # required under txn pooling
)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession,
                                       expire_on_commit=False)

@event.listens_for(engine.sync_engine, "begin")
def _pin_tenant(conn):
    tid = current_tenant.get()
    if tid is None:
        # Fail closed: no tenant context => refuse to run the transaction.
        raise RuntimeError("No tenant bound for this transaction.")
    # Executed at BEGIN, inside the transaction → behaves as SET LOCAL.
    conn.exec_driver_sql(
        "SELECT set_config('app.tenant_id', %(tid)s, true)", {"tid": tid}
    )
```

With the `ContextVar` set from a middleware that decodes the JWT, every transaction the engine opens is tenant-pinned before any query runs, and the value is released at commit.

---

## Key parameters & options

| Choice | Correct value | Why |
|---|---|---|
| Scope keyword | `SET LOCAL` / `set_config(..., true)` | Transaction-scoped; released at COMMIT — safe under pooling |
| Session `SET` / `set_config(..., false)` | **Never** behind transaction pooling | Persists on the backend and leaks to the next client |
| Value binding | `set_config('app.tenant_id', :tid, true)` | Accepts a bind param → no SQL injection |
| String interpolation | Forbidden | `SET LOCAL app.tenant_id = '{tid}'` is injectable |
| `statement_cache_size` | `0` | asyncpg prepared-statement cache breaks under txn pooling |
| Missing context policy | strict `current_setting(name)` or `current_setting(name, true)` | Error vs NULL-and-no-rows; pick a fail-closed default |
| Transaction boundary | one per request | `SET LOCAL` needs a live transaction to bind to |

---

## Gotchas & failure modes

- **Session `SET` leaks across tenants.** A bare `SET app.tenant_id = ...` (or `set_config(..., false)`) runs outside transaction scope and stays on the pooled backend. The next client inherits it and reads foreign rows. Symptom: intermittent, load-dependent cross-tenant results that vanish when you switch PgBouncer to session mode. Fix: always `SET LOCAL`.

- **`SET LOCAL` outside a transaction is a silent no-op.** Issued in autocommit mode, `SET LOCAL` emits `WARNING: SET LOCAL can only be used in transaction blocks` and the value is discarded immediately — so RLS then sees an unset context and your query errors or returns nothing. Ensure `session.begin()` (or an explicit `BEGIN`) wraps it.

- **SQL injection via interpolated tenant id.** Building `f"SET LOCAL app.tenant_id = '{tid}'"` lets a crafted claim like `x'; SET app.tenant_id='victim` alter context. `SET LOCAL` cannot take a bind parameter, but `set_config('app.tenant_id', $1, true)` can — always use the function form with a parameter.

- **`unrecognized configuration parameter "app.tenant_id"` (SQLSTATE 42704).** The query ran on a connection where the context was never set and the policy used strict `current_setting('app.tenant_id')`. Either guarantee the context via the begin-event hook above, or use `current_setting('app.tenant_id', true)` in the policy for NULL-and-no-rows behaviour. Decide which is your fail-closed default.

- **asyncpg `prepared statement "__asyncpg_..." does not exist` behind PgBouncer.** Unrelated to tenancy but co-occurs: transaction pooling breaks asyncpg's statement cache. Set `statement_cache_size=0` in `connect_args`, as detailed in [connection pooling & PgBouncer setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

---

## Verification

Prove the context is transaction-local and does not survive a hand-off. Connect *through PgBouncer* (port 6432) as the app role and run two transactions on what the pool may reuse as one backend:

```sql
-- Transaction 1 sets LOCAL context, reads it, commits.
BEGIN;
SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
SELECT current_setting('app.tenant_id', true);  -- 1111...
COMMIT;

-- Transaction 2: the LOCAL value must be gone (NULL/empty), NOT 1111...
BEGIN;
SELECT current_setting('app.tenant_id', true);  -- '' or NULL  ✓ no leak
COMMIT;
```

If transaction 2 still reports `1111...`, you used session `SET` somewhere — hunt it down before shipping. Then confirm the end-to-end path through the API returns only the caller's rows:

```bash
# Two tenants, same coordinates — each must see only its own features
curl -s localhost:8000/features/nearby?lon=0.1\&lat=0.1 \
  -H "Authorization: Bearer $TENANT_A_JWT" | jq '.features | length'
curl -s localhost:8000/features/nearby?lon=0.1\&lat=0.1 \
  -H "Authorization: Bearer $TENANT_B_JWT" | jq '.features | length'
# The two result sets must share no feature ids.
```

A final assertion in PostgreSQL log review: enable `log_statement = 'all'` briefly and grep for any `SET app.tenant_id` (without `LOCAL`) — there should be zero matches from the application role.

---

## Related

- [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) — the policies this context activates, with the RLS-vs-alternatives decision matrix
- [Enforcing Tenant Geometry Isolation with PostGIS RLS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/enforcing-tenant-geometry-isolation-with-postgis-rls/) — the concrete policy set that reads `app.tenant_id`
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — why transaction pooling mandates `SET LOCAL` and `statement_cache_size=0`

← Back to [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/)
