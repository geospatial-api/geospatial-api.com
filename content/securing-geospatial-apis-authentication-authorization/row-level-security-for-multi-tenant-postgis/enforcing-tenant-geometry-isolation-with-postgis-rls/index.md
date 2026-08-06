---
layout: layouts/page.njk
title: "Enforcing Tenant Geometry Isolation with PostGIS RLS"
description: "The concrete row-level-security policy set for a spatial features table that prevents cross-tenant leakage even through spatial joins and ST_DWithin neighbour queries, with WITH CHECK write barriers and verification."
slug: "enforcing-tenant-geometry-isolation-with-postgis-rls"
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "Row-Level Security for Multi-Tenant PostGIS"
    url: "/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/"
  - label: "Enforcing Tenant Geometry Isolation with PostGIS RLS"
    url: "/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/enforcing-tenant-geometry-isolation-with-postgis-rls/"
datePublished: "2025-10-21"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Enforcing Tenant Geometry Isolation with PostGIS RLS",
      "description": "The concrete row-level-security policy set for a spatial features table that prevents cross-tenant leakage even through spatial joins and ST_DWithin neighbour queries, with WITH CHECK write barriers and verification.",
      "datePublished": "2025-10-21",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/"},
        {"@type": "ListItem", "position": 2, "name": "Row-Level Security for Multi-Tenant PostGIS", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/"},
        {"@type": "ListItem", "position": 3, "name": "Enforcing Tenant Geometry Isolation with PostGIS RLS", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/enforcing-tenant-geometry-isolation-with-postgis-rls/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Enforce tenant geometry isolation with PostGIS row-level security",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Enable and force RLS on the features table and any table it is spatially joined to."},
        {"@type": "HowToStep", "position": 2, "text": "Create per-command policies with USING and WITH CHECK bound to app.tenant_id."},
        {"@type": "HowToStep", "position": 3, "text": "Verify that a spatial join and ST_DWithin query cannot cross the tenant boundary."}
      ]
    },
    {
      "@type": "Article",
      "headline": "Enforcing Tenant Geometry Isolation with PostGIS RLS",
      "datePublished": "2025-10-21",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/)

# Enforcing tenant geometry isolation with PostGIS RLS

Write the concrete policy set for a spatial `features` table so that no query — not a bounding-box scan, not a spatial self-join, not an `ST_DWithin` neighbour lookup — can ever return one tenant's geometry to another.

## Context & when to use

Reach for this the moment more than one customer's geometry lives in the same physical table. The danger with spatial data specifically is that leakage often hides inside *relationships*: a nearest-neighbour query, a `ST_Intersects` join between `features` and a `zones` table, or a distance sort can each pull rows the caller was never entitled to, even when the top-level `SELECT` looks tenant-scoped. Row-level security closes this because the policy predicate is attached to **every** reference to the table in a plan — including both sides of a self-join and every subquery — so there is no query shape that escapes it.

Use these policies as the primary boundary rather than an application `WHERE tenant_id = ...` filter, which a single forgotten clause defeats. This page assumes you have already enabled and forced RLS as described in the parent guide, [row-level security for multi-tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/); here the focus is the exact policy SQL and the join/neighbour cases. The companion piece, [setting tenant context in asyncpg connections](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/), covers how `app.tenant_id` gets onto the connection safely under connection pooling.

**Preconditions:** a `tenant_id uuid NOT NULL` column on every isolated table, a GiST index on each `geom` column, an application role that is neither owner (or the table is `FORCE`d), superuser, nor `BYPASSRLS`, and `app.tenant_id` set per transaction before any query runs.

---

## How the policy filters both tenants

The diagram shows two tenants' points physically interleaved in one table and one GiST index. With `app.tenant_id` pinned to tenant A, an `ST_DWithin` query returns only A's points inside the radius; B's points are filtered by the policy even though they fall geometrically inside the same circle.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two tenants' points share one table; an ST_DWithin radius query under tenant A's context returns only tenant A points" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Tenant-filtered ST_DWithin query</title>
  <desc>A shared coordinate space contains tenant A points (filled) and tenant B points (outlined). A dashed query radius circle encloses points from both tenants, but with app.tenant_id set to tenant A the policy returns only the filled tenant A points; the tenant B points inside the same circle are excluded.</desc>
  <rect x="0" y="0" width="720" height="320" rx="12" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="24" y="34" font-size="13" font-weight="700" fill="currentColor">Shared features table · one GiST index</text>
  <text x="24" y="52" font-size="11" fill="var(--muted, #7c6fb0)">app.tenant_id = tenant A</text>
  <!-- query radius -->
  <circle cx="330" cy="185" r="120" fill="var(--accent, #7c3aed)" opacity="0.07" stroke="var(--accent, #7c3aed)" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text x="330" y="80" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">ST_DWithin radius</text>
  <!-- tenant A points (filled, returned) -->
  <circle cx="300" cy="160" r="9" fill="var(--accent, #7c3aed)" opacity="0.85"/>
  <circle cx="360" cy="210" r="9" fill="var(--accent, #7c3aed)" opacity="0.85"/>
  <circle cx="290" cy="230" r="9" fill="var(--accent, #7c3aed)" opacity="0.85"/>
  <circle cx="600" cy="120" r="9" fill="var(--accent, #7c3aed)" opacity="0.4"/>
  <!-- tenant B points (outlined, filtered) -->
  <circle cx="340" cy="150" r="9" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="2" stroke-dasharray="3 2"/>
  <circle cx="320" cy="220" r="9" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="2" stroke-dasharray="3 2"/>
  <circle cx="380" cy="170" r="9" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="2" stroke-dasharray="3 2"/>
  <circle cx="620" cy="230" r="9" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="2" stroke-dasharray="3 2"/>
  <!-- legend -->
  <circle cx="500" cy="270" r="8" fill="var(--accent, #7c3aed)" opacity="0.85"/>
  <text x="514" y="274" font-size="11" fill="currentColor">tenant A — returned</text>
  <circle cx="500" cy="294" r="8" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="2" stroke-dasharray="3 2"/>
  <text x="514" y="298" font-size="11" fill="var(--muted, #7c6fb0)">tenant B — filtered by policy</text>
  <text x="330" y="185" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">query point</text>
  <path d="M326,181 l8,8" stroke="var(--muted, #7c6fb0)" stroke-width="1"/>
</svg>

---

## Runnable implementation

The complete policy set for `features`, plus a second isolated table `zones` to demonstrate that a **spatial join** stays inside the tenant boundary. Both tables are enabled and `FORCE`d so even the owner is bound.

```sql
-- ── Both tables carry a tenant key + spatial index ───────────────────────
CREATE TABLE features (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id uuid NOT NULL,
    name      text NOT NULL,
    geom      geometry(Point, 4326) NOT NULL
);
CREATE INDEX idx_features_geom   ON features USING GIST (geom);
CREATE INDEX idx_features_tenant ON features (tenant_id);

CREATE TABLE zones (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id uuid NOT NULL,
    label     text NOT NULL,
    geom      geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX idx_zones_geom   ON zones USING GIST (geom);
CREATE INDEX idx_zones_tenant ON zones (tenant_id);

-- ── Enable AND force on every isolated table ─────────────────────────────
ALTER TABLE features ENABLE ROW LEVEL SECURITY;
ALTER TABLE features FORCE  ROW LEVEL SECURITY;
ALTER TABLE zones    ENABLE ROW LEVEL SECURITY;
ALTER TABLE zones    FORCE  ROW LEVEL SECURITY;

-- ── Per-command policies: features ───────────────────────────────────────
-- Strict two-arg current_setting: an unset context yields NULL -> no rows,
-- instead of raising 'unrecognized configuration parameter'.
CREATE POLICY features_select ON features FOR SELECT
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY features_insert ON features FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY features_update ON features FOR UPDATE
    USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY features_delete ON features FOR DELETE
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ── Per-command policies: zones (same shape) ─────────────────────────────
CREATE POLICY zones_select ON zones FOR SELECT
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY zones_insert ON zones FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY zones_update ON zones FOR UPDATE
    USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY zones_delete ON zones FOR DELETE
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Optional convenience: default the tenant on insert so writers can omit it
ALTER TABLE features ALTER COLUMN tenant_id
    SET DEFAULT current_setting('app.tenant_id', true)::uuid;
ALTER TABLE zones ALTER COLUMN tenant_id
    SET DEFAULT current_setting('app.tenant_id', true)::uuid;
```

Now the critical case — a spatial join of points to the polygons that contain them. The policy is applied **independently to each table reference**, so `features` is filtered to the tenant *and* `zones` is filtered to the tenant. There is no context in which a point matches a foreign tenant's polygon:

```sql
BEGIN;
SELECT set_config('app.tenant_id',
                  '11111111-1111-1111-1111-111111111111', true);

-- Which of my features fall inside which of my zones?
SELECT f.name, z.label
FROM   features f
JOIN   zones    z
  ON   ST_Intersects(f.geom, z.geom)   -- GiST-indexed spatial predicate
ORDER  BY f.name;
-- Both f and z are transparently constrained to tenant 1111...
-- A tenant-2222 polygon can never appear on the right-hand side.
COMMIT;
```

Because the same policy guards both sides, even a self-join for neighbour clustering (`features a JOIN features b ON ST_DWithin(a.geom, b.geom, 500)`) cannot pair a tenant's point with a foreign point: both `a` and `b` are filtered before the join executes.

---

Five clauses have to be present for a policy to be both effective and affordable.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Getting the policy definition right: Required" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Getting the policy definition right</title>
  <desc>A comparison table. ENABLE ROW LEVEL SECURITY: Required yes. without it the policy is inert FORCE ROW LEVEL SECURITY: Required yes. applies to the table owner too a policy for each command: Required yes. SELECT does not imply INSERT WITH CHECK on writes: Required yes. stops writing into another tenant an index on the policy column: Required yes. or every query pays per row The second row is the one most often missed: without FORCE, the owner role — frequently the migration role — sees everything.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Getting the policy definition right</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Required</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">ENABLE ROW LEVEL SECURITY</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="352" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">without it the policy is inert</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">FORCE ROW LEVEL SECURITY</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="352" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">applies to the table owner too</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">a policy for each command</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="352" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">SELECT does not imply INSERT</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">WITH CHECK on writes</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="352" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">stops writing into another tenant</text>
  <line x1="20" y1="194" x2="700" y2="194" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="216" font-size="10.5" fill="currentColor">an index on the policy column</text>
  <text x="294" y="216" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="352" y="216" font-size="9.5" fill="var(--muted, #7c6fb0)">or every query pays per row</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">The second row is the one most often missed: without FORCE, the owner role — frequently the migration role — sees everything.</text>
</svg>

## Key parameters & options

| Element | Role | Notes |
|---|---|---|
| `ENABLE ROW LEVEL SECURITY` | Turns on policy enforcement | Ignored for the owner until `FORCE` |
| `FORCE ROW LEVEL SECURITY` | Binds the table owner too | Omitting it is the #1 leak cause |
| `USING (…)` | Filters *visible* rows for SELECT/UPDATE/DELETE | Applied to every table reference in the plan |
| `WITH CHECK (…)` | Validates *written* rows for INSERT/UPDATE | Blocks moving a row to another tenant |
| `current_setting('app.tenant_id', true)` | Reads the active tenant | `true` = `missing_ok`; unset → NULL → no rows |
| `::uuid` cast | Type-matches `tenant_id` | Cast once; treated as stable per statement |
| `SET DEFAULT current_setting(...)` | Auto-fills `tenant_id` on insert | Lets writers omit the column safely |
| Per-command policies | SELECT/INSERT/UPDATE/DELETE split | More precise than a single `FOR ALL` |

---

Both of these look like configuration details and only one of them is survivable.

<svg viewBox="0 0 720 198" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two ways the isolation quietly disappears: the setting is missing versus the role bypasses RLS" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Two ways the isolation quietly disappears</title>
  <desc>Two panels. the setting is missing: current_setting returns NULL policy compares against NULL every comparison is unknown result: zero rows — loud and safe the role bypasses RLS: superuser or table owner FORCE not enabled policy is simply not applied result: every tenant — silent One failure mode returns nothing and the other returns everything. Test for the second explicitly, with the role the application actually uses.</desc>
  <rect x="0" y="0" width="720" height="198" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Two ways the isolation quietly disappears</text>
  <rect x="16" y="40" width="336" height="122" rx="9" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="34" y="62" font-size="11" font-weight="700" fill="var(--viz-good, #1f6b3a)">the setting is missing</text>
  <text x="34" y="84" font-size="10" fill="currentColor">current_setting returns NULL</text>
  <text x="34" y="106" font-size="10" fill="currentColor">policy compares against NULL</text>
  <text x="34" y="128" font-size="10" fill="currentColor">every comparison is unknown</text>
  <text x="34" y="150" font-size="10" fill="currentColor">result: zero rows — loud and safe</text>
  <rect x="368" y="40" width="336" height="122" rx="9" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.5"/>
  <text x="386" y="62" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">the role bypasses RLS</text>
  <text x="386" y="84" font-size="10" fill="currentColor">superuser or table owner</text>
  <text x="386" y="106" font-size="10" fill="currentColor">FORCE not enabled</text>
  <text x="386" y="128" font-size="10" fill="currentColor">policy is simply not applied</text>
  <text x="386" y="150" font-size="10" fill="currentColor">result: every tenant — silent</text>
  <text x="20" y="194" font-size="10.5" fill="var(--muted, #7c6fb0)">One failure mode returns nothing and the other returns everything. Test for the second explicitly, with the role the application actually uses.</text>
</svg>

## Gotchas & failure modes

- **`SECURITY DEFINER` functions bypass the policy.** A distance helper defined `SECURITY DEFINER` runs as its owner; if that owner is RLS-exempt, the function reads every tenant and returns cross-tenant geometry to whoever calls it. Keep tenant-touching functions `SECURITY INVOKER` (the default), or re-assert `app.tenant_id` inside the definer body. Audit with `SELECT proname, prosecdef FROM pg_proc WHERE prosecdef;`.

- **A joined table without its own policies leaks through the join.** RLS is per-table. If `zones` has RLS but a third table `zone_metadata` does not, a join that pulls attributes through `zone_metadata` exposes every tenant's rows on that side. Every table reachable by a spatial or attribute join must carry the same policy set.

- **`new row violates row-level security policy for table "features"`.** An `INSERT`/`UPDATE` produced a `tenant_id` that differs from the active context (or the context was unset, making the predicate `NULL`). This is the `WITH CHECK` barrier working. Derive `tenant_id` from the same claim used for the context, or rely on the `SET DEFAULT` above and omit the column.

- **Index not used under RLS.** If `EXPLAIN` shows a `Seq Scan`, the tenant predicate is likely unindexed or statistics are stale. Add the btree on `tenant_id`, run `ANALYZE features;`, and re-check. The spatial GiST index is unaffected by the policy — the tenant filter composes with it. Reading these plans is covered in [reading EXPLAIN ANALYZE for spatial query optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/).

- **`ST_Intersects` returning empty because of an SRID mismatch, mistaken for RLS.** If `features.geom` is SRID 4326 and `zones.geom` is SRID 3857, the join returns nothing and it looks like RLS over-filtered. Confirm SRIDs match before blaming the policy — RLS never changes geometry results, only which rows are eligible. See [implementing ST_Within and ST_Intersects in FastAPI](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/implementing-st_within-and-st_intersects-in-fastapi/).

---

## Verification

Prove that a spatial join cannot cross the boundary. Seed two tenants whose geometries overlap, then run the join under each context:

```sql
-- Seed: tenant A point inside tenant B polygon and vice versa
INSERT INTO features (tenant_id, name, geom) VALUES
 ('11111111-1111-1111-1111-111111111111','A-pt', ST_SetSRID(ST_MakePoint(0.5,0.5),4326)),
 ('22222222-2222-2222-2222-222222222222','B-pt', ST_SetSRID(ST_MakePoint(0.5,0.5),4326));
INSERT INTO zones (tenant_id, label, geom) VALUES
 ('11111111-1111-1111-1111-111111111111','A-zone',
   ST_SetSRID('POLYGON((0 0,1 0,1 1,0 1,0 0))'::geometry,4326)),
 ('22222222-2222-2222-2222-222222222222','B-zone',
   ST_SetSRID('POLYGON((0 0,1 0,1 1,0 1,0 0))'::geometry,4326));

BEGIN;
SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
SELECT f.name, z.label FROM features f
JOIN zones z ON ST_Intersects(f.geom, z.geom);
--  name  | label
-- -------+--------
--  A-pt  | A-zone      ← only tenant A on BOTH sides; B-pt/B-zone never appear
COMMIT;
```

Then assert the write barrier and, with `EXPLAIN`, that the spatial index still fires:

```sql
BEGIN;
SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM features
WHERE ST_DWithin(geom::geography,
                 ST_SetSRID(ST_MakePoint(0.5,0.5),4326)::geography, 2000);
--  Index Scan using idx_features_geom on features
--    Filter: (tenant_id = (current_setting('app.tenant_id', true))::uuid)
COMMIT;
```

Seeing `A-pt | A-zone` alone from the join, and the GiST `Index Scan` with the tenant `Filter`, confirms isolation holds through spatial relationships without defeating the index.

---

## Related

- [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) — the full setup, decision matrix, and FastAPI integration this page's policies plug into
- [Setting Tenant Context in asyncpg Connections](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/) — how `app.tenant_id` reaches the connection safely under transaction pooling
- [Implementing ST_Within and ST_Intersects in FastAPI](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/implementing-st_within-and-st_intersects-in-fastapi/) — the spatial predicates these policies wrap, and their SRID pitfalls

← Back to [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/)
