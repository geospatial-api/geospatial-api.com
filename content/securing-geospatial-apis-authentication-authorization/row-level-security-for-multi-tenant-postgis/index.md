---
layout: layouts/page.njk
title: "Row-Level Security for Multi-Tenant PostGIS"
description: "Use PostgreSQL row-level security to guarantee tenant isolation of geometry data so an application bug can never leak one tenant's features to another. Policies, FORCE RLS, GiST interaction, and a FastAPI integration."
slug: "row-level-security-for-multi-tenant-postgis"
type: "cluster"
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "Row-Level Security for Multi-Tenant PostGIS"
    url: "/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/"
datePublished: "2025-09-08"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Row-Level Security for Multi-Tenant PostGIS",
      "description": "Use PostgreSQL row-level security to guarantee tenant isolation of geometry data so an application bug can never leak one tenant's features to another. Policies, FORCE RLS, GiST interaction, and a FastAPI integration.",
      "datePublished": "2025-09-08",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "Article",
      "headline": "Row-Level Security for Multi-Tenant PostGIS",
      "datePublished": "2025-09-08",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://geospatial-api.com/"},
        {"@type": "ListItem", "position": 2, "name": "Securing Geospatial APIs", "item": "https://geospatial-api.com/securing-geospatial-apis-authentication-authorization/"},
        {"@type": "ListItem", "position": 3, "name": "Row-Level Security for Multi-Tenant PostGIS", "item": "https://geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Enforce Tenant Isolation on a PostGIS Features Table with Row-Level Security",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Add a tenant_id column and a GiST spatial index to the features table"},
        {"@type": "HowToStep", "position": 2, "name": "ENABLE and FORCE ROW LEVEL SECURITY on the table"},
        {"@type": "HowToStep", "position": 3, "name": "Create per-command policies with USING and WITH CHECK on current_setting('app.tenant_id')"},
        {"@type": "HowToStep", "position": 4, "name": "Set the tenant context per request from FastAPI using SET LOCAL"},
        {"@type": "HowToStep", "position": 5, "name": "Verify isolation with psql and EXPLAIN ANALYZE"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Does row-level security disable the GiST spatial index?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. The RLS policy predicate is ANDed with your own WHERE clause, so a query that uses ST_DWithin or the && operator still uses the GiST index for the spatial part, and the planner applies the tenant_id equality as an additional filter. For best results add a btree index on tenant_id (or a composite plan) so the tenant predicate is also index-assisted; the spatial GiST scan and the tenant filter then compose rather than forcing a sequential scan."
          }
        },
        {
          "@type": "Question",
          "name": "Why can the table owner still see every tenant's rows?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "ENABLE ROW LEVEL SECURITY does not apply to the table owner or to roles with the BYPASSRLS attribute. If your application connects as the owner, policies are silently ignored and every tenant's geometry is visible. You must additionally run ALTER TABLE features FORCE ROW LEVEL SECURITY, and prefer connecting as a non-owner, non-superuser role that holds neither BYPASSRLS nor superuser."
          }
        },
        {
          "@type": "Question",
          "name": "What happens if app.tenant_id is never set?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "If the parameter is not registered and you call current_setting('app.tenant_id') without the missing_ok argument, PostgreSQL raises 'unrecognized configuration parameter \"app.tenant_id\"' (SQLSTATE 42704) and the query fails. That is the safe default: a request with no tenant context returns an error rather than leaking rows. Use current_setting('app.tenant_id', true) only when you deliberately want an unset context to evaluate to NULL and therefore match no rows."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Securing Geospatial APIs](/securing-geospatial-apis-authentication-authorization/)

# Row-level security for multi-tenant PostGIS

Multi-tenant spatial platforms share one `features` table across many customers, and a single missing `WHERE tenant_id = ...` clause is enough to serve one tenant's parcels, assets, or geofences to another. Application-layer filtering is fragile precisely because it depends on every developer, every ORM query, and every raw SQL string remembering the filter forever. PostgreSQL row-level security (RLS) moves the tenant boundary into the database engine itself: the policy predicate is compiled into every plan for the table, so even a query that forgets the filter — or a raw `psql` session, or a background job — sees only the current tenant's geometry. This is the strongest structural defence against cross-tenant leakage, and it composes cleanly with GiST spatial indexes and predicates like `ST_DWithin` and `ST_Intersects`.

This guide sits under [Securing Geospatial APIs](/securing-geospatial-apis-authentication-authorization/) alongside [JWT authentication for spatial scopes](/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) and [rate limiting for geofence and tile endpoints](/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/). Where JWT scopes answer "which operations may this caller invoke," RLS answers the orthogonal question "which rows may this caller ever touch," and the two are layered, not alternatives.

---

## Architecture overview

The diagram below shows where the tenant boundary lives. FastAPI authenticates the request and sets a per-transaction `app.tenant_id`; PostgreSQL then rewrites every statement against `features` to include the policy predicate before planning, so the GiST index scan and the tenant filter run inside one plan.

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Row-level security enforcing tenant isolation between FastAPI and a shared PostGIS features table" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Row-level security tenant isolation flow</title>
  <desc>A request carrying a JWT reaches FastAPI, which opens a transaction and issues SET LOCAL app.tenant_id. The query planner ANDs the RLS policy predicate (tenant_id equals the session setting) with the caller's spatial predicate, so the shared features table returns only the current tenant's rows even though rows for tenant A and tenant B are physically interleaved.</desc>
  <rect x="0" y="0" width="760" height="340" rx="12" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <!-- FastAPI box -->
  <rect x="24" y="40" width="180" height="150" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="114" y="66" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">FastAPI request</text>
  <text x="114" y="92" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">JWT → tenant_id</text>
  <text x="114" y="116" text-anchor="middle" font-size="11" fill="currentColor">BEGIN;</text>
  <text x="114" y="136" text-anchor="middle" font-size="11" fill="currentColor">SET LOCAL</text>
  <text x="114" y="152" text-anchor="middle" font-size="11" fill="currentColor">app.tenant_id = …</text>
  <text x="114" y="176" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">ST_DWithin(geom, …)</text>
  <!-- Arrow -->
  <line x1="204" y1="115" x2="272" y2="115" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Policy rewrite box -->
  <rect x="272" y="40" width="210" height="150" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="377" y="66" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Planner rewrite</text>
  <text x="377" y="92" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">policy ANDed in:</text>
  <text x="377" y="114" text-anchor="middle" font-size="11" fill="currentColor">tenant_id =</text>
  <text x="377" y="130" text-anchor="middle" font-size="11" fill="currentColor">current_setting(</text>
  <text x="377" y="146" text-anchor="middle" font-size="11" fill="currentColor">'app.tenant_id')::uuid</text>
  <text x="377" y="172" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">AND ST_DWithin(…)</text>
  <!-- Arrow -->
  <line x1="482" y1="115" x2="550" y2="115" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Table box -->
  <rect x="550" y="40" width="186" height="260" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 3"/>
  <text x="643" y="64" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">features (shared)</text>
  <text x="643" y="86" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">GiST index on geom</text>
  <!-- rows -->
  <rect x="568" y="100" width="150" height="26" rx="5" fill="var(--accent, #7c3aed)" opacity="0.18" stroke="var(--accent, #7c3aed)" stroke-width="1.2"/>
  <text x="643" y="117" text-anchor="middle" font-size="10" fill="currentColor">tenant A · returned</text>
  <rect x="568" y="132" width="150" height="26" rx="5" fill="none" stroke="var(--border, #c4b5fd)" stroke-width="1.2" stroke-dasharray="3 2"/>
  <text x="643" y="149" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">tenant B · filtered</text>
  <rect x="568" y="164" width="150" height="26" rx="5" fill="var(--accent, #7c3aed)" opacity="0.18" stroke="var(--accent, #7c3aed)" stroke-width="1.2"/>
  <text x="643" y="181" text-anchor="middle" font-size="10" fill="currentColor">tenant A · returned</text>
  <rect x="568" y="196" width="150" height="26" rx="5" fill="none" stroke="var(--border, #c4b5fd)" stroke-width="1.2" stroke-dasharray="3 2"/>
  <text x="643" y="213" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">tenant B · filtered</text>
  <rect x="568" y="228" width="150" height="26" rx="5" fill="none" stroke="var(--border, #c4b5fd)" stroke-width="1.2" stroke-dasharray="3 2"/>
  <text x="643" y="245" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">tenant C · filtered</text>
  <text x="643" y="278" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">FORCE RLS: owner too</text>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 z" fill="var(--accent, #7c3aed)"/>
    </marker>
  </defs>
</svg>

---

## Prerequisites & Environment

RLS has been stable in PostgreSQL since 9.5, but the spatial and async pieces need modern versions:

| Component | Minimum version | Why it matters |
|---|---|---|
| PostgreSQL | 14+ | Stable `FORCE ROW LEVEL SECURITY`, per-command policies, `SCRAM-SHA-256` |
| PostGIS | 3.3+ | `ST_DWithin`, `ST_Intersects`, GiST/SP-GiST operator classes |
| FastAPI | 0.100+ | Async lifespan, dependency injection for the tenant context |
| SQLAlchemy | 2.0+ | `AsyncSession`, `async_sessionmaker`, event hooks for `SET LOCAL` |
| asyncpg | 0.29+ | Binary protocol; `set_config()` bind parameters avoid SQL injection |
| PgBouncer | 1.21+ | Transaction pooling — mandates `SET LOCAL`, never session-level `SET` |

Two roles are involved. The migration role owns the schema (and, being the owner, bypasses RLS unless you `FORCE` it). The application role — the one your API connects as — must be a plain `LOGIN` role with **neither** `SUPERUSER` nor `BYPASSRLS`. Confirm before you rely on any policy:

```sql
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname = 'api_app';
--  rolname | rolsuper | rolbypassrls
-- ---------+----------+--------------
--  api_app | f        | f            ← both must be false
```

Install the async stack if you have not already:

```bash
pip install "fastapi>=0.100" "asyncpg>=0.29" "sqlalchemy[asyncio]>=2.0"
```

---

## Decision matrix: RLS vs app-layer filter vs schema-per-tenant

Three isolation strategies dominate multi-tenant PostGIS. They are not mutually exclusive, but one should be your primary boundary. Choose before writing a policy.

| Dimension | RLS (shared table) | App-layer `WHERE tenant_id` | Schema-per-tenant |
|---|---|---|---|
| Where isolation lives | Database engine (policy) | Application code | Physical schema separation |
| Leak on forgotten filter | **Impossible** (policy ANDed in) | Leaks silently | Impossible |
| Tenant count ceiling | Millions | Millions | Hundreds (catalog bloat) |
| Cross-tenant analytics | One query, `BYPASSRLS` role | One query | Painful (`UNION` across schemas) |
| Migration cost | One `ALTER TABLE` per table | Zero | N schemas to migrate |
| Spatial index sharing | One GiST index, all tenants | One GiST index | N indexes (per schema) |
| Connection-context need | Must set `app.tenant_id` per txn | None | Per-tenant search_path |
| Blast radius of bug | Contained by engine | Full table | Contained by schema |

For a spatial SaaS with a large, dynamic tenant list, **RLS on a shared table is the default recommendation**: one GiST index serves everyone, the tenant boundary cannot be forgotten, and adding a tenant is an `INSERT`, not a DDL migration. Schema-per-tenant suits a small number of high-value tenants that demand physical separation for compliance. A pure app-layer filter is acceptable only as a secondary optimisation on top of RLS, never as the sole boundary. The one operational cost RLS adds is that every request must establish its tenant context on the connection — the subject of [setting tenant context in asyncpg connections](/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/).

---

## Step-by-Step Implementation

### Step 1: Model the table with a tenant key and spatial index

Every isolated table needs a `tenant_id` and a GiST index on its geometry. The tenant column should be `NOT NULL` so a row can never be orphaned outside every policy.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE features (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   uuid NOT NULL,
    name        text NOT NULL,
    geom        geometry(Geometry, 4326) NOT NULL
);

-- Spatial index for ST_DWithin / ST_Intersects / && predicates
CREATE INDEX idx_features_geom ON features USING GIST (geom);

-- Btree on tenant_id so the RLS predicate is also index-assisted
CREATE INDEX idx_features_tenant ON features (tenant_id);
```

The two indexes matter for the same query. When the RLS predicate (`tenant_id = ...`) is ANDed with a spatial predicate, the planner can start from either index; on a large multi-tenant table it usually leads with the tenant btree, then confirms geometry against the GiST index. Detailed EXPLAIN reading is covered in [reading EXPLAIN ANALYZE for spatial query optimization](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/).

### Step 2: ENABLE and FORCE row-level security

```sql
ALTER TABLE features ENABLE ROW LEVEL SECURITY;
ALTER TABLE features FORCE ROW LEVEL SECURITY;
```

`ENABLE` activates policy enforcement for ordinary roles. `FORCE` extends enforcement to the **table owner** as well — without it, the role that created the table (often the same role your migrations and, dangerously, sometimes your app run as) sees every tenant. `FORCE` is the single most commonly omitted line in RLS setups and the most common cause of "RLS is on but leaking." Superusers and `BYPASSRLS` roles are still exempt even with `FORCE`; that exemption is what your analytics/ETL role uses deliberately.

### Step 3: Register the tenant context parameter

RLS policies read the tenant from a session/transaction setting. Referencing an unregistered custom parameter with plain `current_setting()` raises an error, so decide your contract. The safest is to *require* the context: a request with no tenant must fail, not return everything or nothing silently.

```sql
-- Optional: register a default so the parameter always "exists".
-- Use ONLY if you want an unset context to mean "no tenant" rather than error.
ALTER DATABASE gis_db SET app.tenant_id = '';
```

Whether or not you register a default, the policy in Step 4 uses the strict two-argument form so an empty or missing value matches no rows rather than raising mid-query. The trade-offs of strict vs `missing_ok` are examined in [setting tenant context in asyncpg connections](/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/).

### Step 4: Create per-command policies with USING and WITH CHECK

A single `FOR ALL` policy is tempting but blunt. Per-command policies let you express different rules for reads and writes — critically, `WITH CHECK` on writes prevents a caller from *inserting or moving a row into another tenant*, which `USING` alone does not.

```sql
-- Reads: only rows belonging to the active tenant are visible
CREATE POLICY features_select ON features
    FOR SELECT
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Inserts: the new row MUST carry the active tenant_id
CREATE POLICY features_insert ON features
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Updates: can only see own rows (USING) and cannot reassign tenant (WITH CHECK)
CREATE POLICY features_update ON features
    FOR UPDATE
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Deletes: can only delete own rows
CREATE POLICY features_delete ON features
    FOR DELETE
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`USING` filters which existing rows a command can *see* (SELECT, UPDATE, DELETE). `WITH CHECK` validates the row *after* the write (INSERT, UPDATE) and rejects it if the predicate is false. The `UPDATE` policy needs both: `USING` stops a tenant from touching foreign rows, and `WITH CHECK` stops them from setting `tenant_id` to someone else's value. Omitting the `WITH CHECK` on `UPDATE` is a real leakage path — a tenant could migrate a row out of their own boundary. The full policy set, including how it survives spatial joins, is drilled into in [enforcing tenant geometry isolation with PostGIS RLS](/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/enforcing-tenant-geometry-isolation-with-postgis-rls/).

### Step 5: Establish tenant context on the connection

The policy is inert until `app.tenant_id` is set on the connection running the query. Under PgBouncer transaction pooling you must use `SET LOCAL` (transaction-scoped) — never session `SET`, which would leak the previous client's tenant onto the next borrower of that pooled backend. This is a hard constraint of the pooling mode described in [connection pooling & PgBouncer setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).

```sql
BEGIN;
-- Bind the tenant as a *parameter*, never string-interpolated, to avoid injection.
SELECT set_config('app.tenant_id', $1, true);  -- true = LOCAL to this transaction
-- ... spatial query runs here under the policy ...
COMMIT;
```

`set_config(name, value, is_local => true)` is the function form of `SET LOCAL` and, unlike a literal `SET LOCAL app.tenant_id = '...'`, accepts a bind parameter — so the tenant UUID can come straight from a validated JWT claim without any string concatenation. The asyncpg/SQLAlchemy wiring for this is the subject of [setting tenant context in asyncpg connections](/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/).

---

## Production Code Example

A complete FastAPI route that resolves the tenant from the request, opens a transaction, pins the context with `set_config`, and runs an RLS-protected `ST_DWithin` neighbour query. The tenant filter never appears in the query text — RLS supplies it.

```python
# app/routes/features.py
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from ..dependencies import get_db, get_tenant_id

router = APIRouter(prefix="/features", tags=["features"])

@router.get("/nearby")
async def features_nearby(
    lon: float = Query(..., ge=-180, le=180),
    lat: float = Query(..., ge=-90, le=90),
    radius_m: float = Query(1000, gt=0, le=50_000),
    limit: int = Query(100, le=1000),
    tenant_id: str = Depends(get_tenant_id),   # extracted & validated from the JWT
    db: AsyncSession = Depends(get_db),
):
    """
    Return this tenant's features within radius_m metres of (lon, lat).
    Row-level security guarantees the result can only contain the caller's
    own geometry — even though the query text has no tenant_id filter.
    """
    # Pin the tenant for THIS transaction only (LOCAL). Parameterised — no injection.
    await db.execute(
        text("SELECT set_config('app.tenant_id', :tid, true)"),
        {"tid": tenant_id},
    )

    rows = (await db.execute(
        text("""
            SELECT id, name, ST_AsGeoJSON(geom)::jsonb AS geometry
            FROM features
            WHERE ST_DWithin(
                    geom::geography,
                    ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
                    :radius_m
                  )
            ORDER BY geom <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)
            LIMIT :limit
        """),
        {"lon": lon, "lat": lat, "radius_m": radius_m, "limit": limit},
    )).mappings().all()

    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "id": r["id"],
             "geometry": r["geometry"], "properties": {"name": r["name"]}}
            for r in rows
        ],
    }
```

The RLS policy predicate is ANDed with the `ST_DWithin` filter by the planner. The `geom::geography` cast gives true metre distances; the `<->` KNN operator orders by distance using the GiST index (see [optimizing KNN queries with the PostGIS operator](/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/optimizing-knn-queries-with-postgis-operator/)). Nothing about the tenant boundary is expressed in Python or in the SQL text — that is the entire point.

---

## Verification & Testing

**Prove isolation directly in psql.** Connect as the non-owner `api_app` role and switch tenants inside a transaction:

```sql
-- Seed two tenants
INSERT INTO features (tenant_id, name, geom) VALUES
  ('11111111-1111-1111-1111-111111111111', 'A-north',
   ST_SetSRID(ST_MakePoint(0.10, 0.10), 4326)),
  ('22222222-2222-2222-2222-222222222222', 'B-south',
   ST_SetSRID(ST_MakePoint(0.11, 0.11), 4326));

BEGIN;
SELECT set_config('app.tenant_id',
                  '11111111-1111-1111-1111-111111111111', true);
SELECT name FROM features;      -- returns ONLY 'A-north'
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id',
                  '22222222-2222-2222-2222-222222222222', true);
SELECT name FROM features;      -- returns ONLY 'B-south'
COMMIT;
```

**Confirm the write barrier.** An attempt to insert a row for another tenant must be rejected by `WITH CHECK`:

```sql
BEGIN;
SELECT set_config('app.tenant_id',
                  '11111111-1111-1111-1111-111111111111', true);
INSERT INTO features (tenant_id, name, geom)
VALUES ('22222222-2222-2222-2222-222222222222', 'sneaky',
        ST_SetSRID(ST_MakePoint(0,0), 4326));
-- ERROR:  new row violates row-level security policy for table "features"
ROLLBACK;
```

**Confirm the spatial index still fires under RLS** with `EXPLAIN`:

```sql
BEGIN;
SELECT set_config('app.tenant_id',
                  '11111111-1111-1111-1111-111111111111', true);
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM features
WHERE ST_DWithin(geom::geography,
                 ST_SetSRID(ST_MakePoint(0.1,0.1),4326)::geography, 5000);
--  Index Scan using idx_features_geom on features
--    Filter: (tenant_id = (current_setting('app.tenant_id', true))::uuid)
COMMIT;
```

The plan shows the GiST `Index Scan` for the spatial predicate with the tenant equality applied as a `Filter` — proof the policy composes with, rather than defeats, the index.

**pytest skeleton** asserting a second tenant cannot see the first's rows:

```python
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_tenant_cannot_see_other_tenant_features():
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://test") as c:
        a = await c.get("/features/nearby?lon=0.1&lat=0.1",
                        headers={"Authorization": "Bearer <tenant-A-jwt>"})
        b = await c.get("/features/nearby?lon=0.1&lat=0.1",
                        headers={"Authorization": "Bearer <tenant-B-jwt>"})
    a_ids = {f["id"] for f in a.json()["features"]}
    b_ids = {f["id"] for f in b.json()["features"]}
    assert a_ids.isdisjoint(b_ids)
```

---

## Failure Modes & Edge Cases

1. **Owner bypasses RLS without `FORCE`.** You ran `ENABLE ROW LEVEL SECURITY`, tested as `postgres` or the owning role, saw every tenant, and concluded RLS "doesn't work." The owner is exempt from policies until `ALTER TABLE features FORCE ROW LEVEL SECURITY`. Run `FORCE`, and connect the app as a non-owner role.

2. **`unrecognized configuration parameter "app.tenant_id"` (SQLSTATE 42704).** The parameter was never set on this connection and the policy used the strict one-argument `current_setting('app.tenant_id')`. Either set it every transaction, or use the two-argument `current_setting('app.tenant_id', true)` so an unset context yields `NULL` (which matches no rows) instead of erroring. Choose deliberately — erroring is often the safer default.

3. **`SET` instead of `SET LOCAL` under transaction pooling.** A session-level `SET app.tenant_id` persists on the pooled backend after your transaction returns to PgBouncer, so the *next* client to borrow that backend inherits your tenant and reads your rows. Always use `SET LOCAL` / `set_config(..., true)`. This is the most dangerous failure in the whole design; see [setting tenant context in asyncpg connections](/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/).

4. **`SECURITY DEFINER` function silently bypasses policies.** A helper function marked `SECURITY DEFINER` runs as its owner; if that owner is exempt from RLS, calls through the function see all tenants. Prefer `SECURITY INVOKER` (the default) for anything touching tenant tables, or set `app.tenant_id` inside the definer function explicitly.

5. **Missing `WITH CHECK` on `UPDATE`.** With only a `USING` clause, a tenant can `UPDATE features SET tenant_id = '<other>'` and move a row out of their boundary — or an attacker can smuggle data across tenants. Always pair `UPDATE` policies with a `WITH CHECK` identical to the `USING`.

6. **`new row violates row-level security policy for table "features"`.** Your `INSERT` set `tenant_id` to a value different from the active `app.tenant_id`, or the context was empty. This is the policy working. Ensure the write path derives `tenant_id` from the same validated claim used for the context, or omit the column and let a `DEFAULT current_setting('app.tenant_id')::uuid` fill it.

7. **`NULL` tenant rows become invisible to everyone.** A row inserted with `tenant_id IS NULL` (possible only if the column is nullable and RLS was added later) matches no policy and is unreachable through the API — an orphan. Keep `tenant_id NOT NULL` and backfill before enabling policies.

8. **Analytics role forgets it holds `BYPASSRLS`.** A reporting job connecting as a `BYPASSRLS` role reads every tenant by design — correct for cross-tenant aggregates, catastrophic if that role's DSN is reused for the public API. Keep the bypass role isolated to internal ETL.

---

## Performance Notes

**Policy predicates are essentially free when indexed.** The RLS predicate compiles into the plan as an extra `Filter` or index condition. Against the btree on `tenant_id`, the added cost is a fraction of a millisecond even on tables with tens of millions of rows across thousands of tenants. The GiST spatial index still drives `ST_DWithin`/`ST_Intersects`; RLS does not force a sequential scan.

**Lead with the more selective predicate.** On a table where one tenant owns most rows, the spatial predicate is more selective and the planner leads with the GiST index, applying `tenant_id` as a filter. Where a tenant owns a tiny slice, the tenant btree is more selective and leads. A composite plan works either way; verify with `EXPLAIN (ANALYZE, BUFFERS)` per your data distribution — the technique is covered in [query plan analysis & index tuning](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/).

**Context-setting adds one round-trip.** `SELECT set_config(...)` before the real query is a sub-millisecond statement, but under high throughput it doubles statement count. Batch it into the same transaction as the query (which you must do anyway under transaction pooling) so it shares one backend hand-off rather than opening a second.

**`current_setting()` is evaluated per row unless stable.** For very hot loops, cast once: PostgreSQL treats `current_setting('app.tenant_id', true)::uuid` as stable within a statement, so it is evaluated once per query, not per row. Do not wrap it in a `VOLATILE` function.

**Caching interacts with the tenant key.** If you place a [Redis cache for spatial queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) in front of RLS-protected endpoints, the cache key **must** include `tenant_id`. A cache keyed only on the bounding box will serve one tenant's cached geometry to another, re-introducing the exact leak RLS prevents at the database.

---

## FAQ

### Does row-level security disable the GiST spatial index?

No. The RLS policy predicate is ANDed with your own `WHERE` clause, so a query using `ST_DWithin` or the `&&` operator still uses the GiST index for the spatial part, and the planner applies the `tenant_id` equality as an additional filter. Add a btree index on `tenant_id` so the tenant predicate is also index-assisted; the spatial GiST scan and the tenant filter then compose rather than forcing a sequential scan. Confirm with `EXPLAIN (ANALYZE, BUFFERS)`.

### Why can the table owner still see every tenant's rows?

`ENABLE ROW LEVEL SECURITY` does not apply to the table owner or to roles with the `BYPASSRLS` attribute. If your application connects as the owner, policies are silently ignored and every tenant's geometry is visible. Run `ALTER TABLE features FORCE ROW LEVEL SECURITY`, and connect as a non-owner, non-superuser role that holds neither `BYPASSRLS` nor `SUPERUSER`.

### What happens if `app.tenant_id` is never set?

If the parameter is not registered and you call `current_setting('app.tenant_id')` without the `missing_ok` argument, PostgreSQL raises `unrecognized configuration parameter "app.tenant_id"` (SQLSTATE 42704) and the query fails. That is the safe default: a request with no tenant context returns an error rather than leaking rows. Use `current_setting('app.tenant_id', true)` only when you deliberately want an unset context to evaluate to `NULL` and therefore match no rows.

---

## Related

- [Enforcing Tenant Geometry Isolation with PostGIS RLS](/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/enforcing-tenant-geometry-isolation-with-postgis-rls/) — the full policy set that survives spatial joins and `ST_DWithin` neighbour queries
- [Setting Tenant Context in asyncpg Connections](/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/) — `SET LOCAL` vs session `SET` under PgBouncer, and injection-safe `set_config`
- [JWT Authentication for Spatial Scopes](/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) — where the `tenant_id` claim that feeds the policy originates
- [Connection Pooling & PgBouncer Setup](/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — the transaction-pooling mode that mandates `SET LOCAL` for tenant context
- [Securing Geospatial APIs](/securing-geospatial-apis-authentication-authorization/) — the broader authentication and authorization reference

← Back to [Securing Geospatial APIs](/securing-geospatial-apis-authentication-authorization/)
