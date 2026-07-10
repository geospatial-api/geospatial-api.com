---
layout: layouts/page.njk
title: "Automating Spatial Database Migrations in CI"
description: "Run Alembic migrations with GeoAlchemy2 safely in CI: create the PostGIS extension, stop autogenerate from dropping spatial_ref_sys and geometry columns, build GiST indexes with CREATE INDEX CONCURRENTLY outside the transaction, and verify reversibility."
slug: "automating-spatial-database-migrations-in-ci"
type: "long_tail"
breadcrumb:
  - label: "Deploying & Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "CI/CD Pipelines for Spatial APIs"
    url: "/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/"
  - label: "Automating Spatial Database Migrations in CI"
    url: "/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/automating-spatial-database-migrations-in-ci/"
datePublished: "2026-01-30"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Automating Spatial Database Migrations in CI",
      "description": "Run Alembic migrations with GeoAlchemy2 safely in CI: create the PostGIS extension, stop autogenerate from dropping spatial_ref_sys and geometry columns, build GiST indexes with CREATE INDEX CONCURRENTLY outside the transaction, and verify reversibility.",
      "datePublished": "2026-01-30",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Deploying & Operating Geospatial APIs", "item": "https://geospatial-api.com/deploying-and-operating-geospatial-apis/"},
        {"@type": "ListItem", "position": 2, "name": "CI/CD Pipelines for Spatial APIs", "item": "https://geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/"},
        {"@type": "ListItem", "position": 3, "name": "Automating Spatial Database Migrations in CI", "item": "https://geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/automating-spatial-database-migrations-in-ci/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Automate Alembic spatial migrations in CI with GeoAlchemy2",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Create the PostGIS extension before running any migration."},
        {"@type": "HowToStep", "position": 2, "text": "Exclude PostGIS-managed objects from Alembic autogenerate."},
        {"@type": "HowToStep", "position": 3, "text": "Build GiST indexes with CREATE INDEX CONCURRENTLY inside an autocommit block."},
        {"@type": "HowToStep", "position": 4, "text": "Verify the migration upgrades and downgrades cleanly."}
      ]
    },
    {
      "@type": "Article",
      "headline": "Automating Spatial Database Migrations in CI",
      "datePublished": "2026-01-30",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [CI/CD Pipelines for Spatial APIs](/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/)

# Automating spatial database migrations in CI

Run Alembic migrations against PostGIS in CI without the three failures GeoAlchemy2 introduces: a missing extension, autogenerate trying to drop `spatial_ref_sys` and geometry columns, and `CREATE INDEX CONCURRENTLY` blowing up inside Alembic's transaction.

## Context & when to use

Every CI pipeline for a FastAPI + PostGIS service runs `alembic upgrade head` as a gate before the image is deployed — it is [step five of the pipeline](/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/). For a plain relational schema this step is uneventful. With GeoAlchemy2 in the mix it is not, because spatial schemas carry objects PostGIS manages on your behalf and index-creation patterns that clash with how Alembic wraps each migration in a transaction.

Use this guidance whenever your models declare `geoalchemy2.Geometry` columns, whenever you rely on `--autogenerate` to draft migrations, or whenever a migration creates a spatial index on a table large enough that you cannot afford an `ACCESS EXCLUSIVE` lock. The techniques matter most in CI precisely because CI is where a broken migration should be caught — reproducibly, against the same `postgis/postgis:16-3.4` you deploy — rather than during a production rollout.

The three hazards are independent and each has a clean fix: create the extension first, filter PostGIS-managed objects out of autogenerate, and run concurrent index builds in an autocommit block. The rest of this page is those three fixes plus a reversibility check.

---

## Hazard map

<svg viewBox="0 0 760 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three spatial migration hazards and their fixes" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>Spatial migration hazards and fixes</title>
  <desc>Three hazards each mapped to a fix: missing extension mapped to create extension if not exists postgis; autogenerate dropping PostGIS-managed objects mapped to an include_object filter; create index concurrently failing inside a transaction mapped to an autocommit block.</desc>
  <!-- column headers -->
  <text x="210" y="34" text-anchor="middle" font-size="12" font-weight="700" fill="var(--muted, #7c6fb0)">Hazard</text>
  <text x="560" y="34" text-anchor="middle" font-size="12" font-weight="700" fill="#065f46">Fix</text>
  <!-- row 1 -->
  <rect x="30" y="48" width="360" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="210" y="70" text-anchor="middle" font-size="11" fill="currentColor">function st_intersects does not exist</text>
  <text x="210" y="88" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">extension not created</text>
  <rect x="440" y="48" width="290" height="52" rx="8" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="585" y="79" text-anchor="middle" font-size="11" fill="#065f46" font-weight="600">CREATE EXTENSION IF NOT EXISTS postgis</text>
  <line x1="390" y1="74" x2="440" y2="74" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- row 2 -->
  <rect x="30" y="112" width="360" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="210" y="134" text-anchor="middle" font-size="11" fill="currentColor">spurious DROP geom / DROP TABLE spatial_ref_sys</text>
  <text x="210" y="152" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">autogenerate sees managed objects</text>
  <rect x="440" y="112" width="290" height="52" rx="8" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="585" y="143" text-anchor="middle" font-size="11" fill="#065f46" font-weight="600">include_object filter</text>
  <line x1="390" y1="138" x2="440" y2="138" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- row 3 -->
  <rect x="30" y="176" width="360" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="210" y="198" text-anchor="middle" font-size="10.5" fill="currentColor">CREATE INDEX CONCURRENTLY cannot run</text>
  <text x="210" y="216" text-anchor="middle" font-size="10.5" fill="currentColor">inside a transaction block</text>
  <rect x="440" y="176" width="290" height="52" rx="8" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="585" y="207" text-anchor="middle" font-size="11" fill="#065f46" font-weight="600">autocommit_block()</text>
  <line x1="390" y1="202" x2="440" y2="202" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

---

## Runnable implementation

### 1. Create the extension, then filter autogenerate

Both fixes live in `alembic/env.py`. The extension is created on the connection before Alembic configures the migration context, and an `include_object` callback removes PostGIS-managed objects and GeoAlchemy2's internally-managed spatial indexes from autogenerate.

```python
# alembic/env.py
from alembic import context
from sqlalchemy import engine_from_config, pool, text
from app.models import Base  # your GeoAlchemy2 models
import geoalchemy2  # noqa: F401 — registers Geometry reflection so it isn't dropped

target_metadata = Base.metadata

# Objects PostGIS creates and manages itself. Autogenerate must never touch them.
POSTGIS_MANAGED_TABLES = {"spatial_ref_sys", "geometry_columns", "geography_columns",
                          "raster_columns", "raster_overviews", "topology", "layer"}


def include_object(obj, name, type_, reflected, compare_to):
    # Never emit DROP/CREATE for PostGIS system tables.
    if type_ == "table" and name in POSTGIS_MANAGED_TABLES:
        return False
    # GeoAlchemy2 creates the GiST spatial index automatically for a Geometry
    # column; a reflected spatial index with no model counterpart is NOT a drop.
    if type_ == "index" and reflected and compare_to is None and name.startswith("idx_") \
            and name.endswith("_geom"):
        return False
    return True


def run_migrations_online():
    connectable = engine_from_config(
        context.config.get_section(context.config.config_ini_section),
        prefix="sqlalchemy.", poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        # The extension must exist before autogenerate reflects, and before any
        # migration references an ST_ function or a geometry column type.
        connection.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        connection.commit()

        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=include_object,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
```

Without the `import geoalchemy2` line, Alembic reflects a `geometry` column it does not recognise and autogenerate proposes `op.drop_column('parcels', 'geom')` followed by a re-add — a destructive no-op that will wipe geometries if it ever runs. The import registers the type so reflection round-trips cleanly. These `geom` columns model the domain entities described in [spatial resource modelling patterns](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/); keeping their type stable across migrations is what makes autogenerate trustworthy.

### 2. Build the GiST index concurrently, outside the transaction

Alembic wraps each migration's `upgrade()` in a single transaction. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block — Postgres rejects it outright. On a large table you still want the concurrent build to avoid an `ACCESS EXCLUSIVE` lock that blocks writes for the duration. The fix is `op.get_context().autocommit_block()`, which suspends the migration transaction so the statement runs in its own autocommit connection.

```python
# alembic/versions/8f2a_add_parcels_geom_index.py
from alembic import op

revision = "8f2a_add_parcels_geom_index"
down_revision = "7c11_create_parcels"


def upgrade():
    # autocommit_block() leaves Alembic's transaction so CONCURRENTLY is legal.
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parcels_geom "
            "ON parcels USING GIST (geom)"
        )


def downgrade():
    # DROP INDEX CONCURRENTLY also cannot run in a transaction.
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS idx_parcels_geom")
```

The `IF NOT EXISTS` / `IF EXISTS` guards make the migration re-runnable, which matters because `CREATE INDEX CONCURRENTLY` is not transactional: if it fails partway it can leave an `INVALID` index behind. Guarding lets a retried CI run — or a re-applied migration after a failed deploy — succeed instead of erroring on a half-built index. The concurrency and locking trade-offs here connect directly to [async PostGIS transaction patterns](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/), which covers how these DDL locks interact with in-flight spatial writes.

### 3. Run it in the pipeline

The CI step is a single command, gated after the extension exists (the migration also creates it defensively):

```yaml
- name: Migrate
  run: alembic upgrade head
  env:
    # Alembic reads sqlalchemy.url from here; use the sync psycopg URL for DDL.
    ALEMBIC_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/gis_test
```

Use a synchronous driver URL (psycopg) for Alembic even if the app runs asyncpg — migrations are plain DDL and do not need the async event loop, and `autocommit_block()` behaves most predictably on the sync driver.

---

## Key parameters & options

| Parameter / call | Purpose |
|---|---|
| `CREATE EXTENSION IF NOT EXISTS postgis` | Registers `ST_` functions and geometry types before any migration runs |
| `import geoalchemy2` in `env.py` | Registers the `Geometry` type so reflection does not propose dropping geom columns |
| `include_object` callback | Filters PostGIS-managed tables and auto-created spatial indexes out of autogenerate |
| `compare_type=True` | Detects real column-type changes while the filter suppresses false spatial drops |
| `op.get_context().autocommit_block()` | Suspends the migration transaction so `CREATE INDEX CONCURRENTLY` is legal |
| `CREATE INDEX CONCURRENTLY IF NOT EXISTS` | Builds the GiST index without an `ACCESS EXCLUSIVE` lock; re-runnable |
| `pool.NullPool` | One connection per migration run; avoids stale pooled connections in CI |
| Sync (psycopg) `sqlalchemy.url` | DDL does not need async; sync driver makes autocommit behaviour predictable |

---

## Gotchas & failure modes

- **`CREATE INDEX CONCURRENTLY cannot run inside a transaction block`** — the index statement ran inside Alembic's wrapping transaction. Wrap it in `with op.get_context().autocommit_block():`. This is the most common spatial migration failure in CI, and it only appears when the table is large enough that someone reached for `CONCURRENTLY`.

- **Autogenerate proposes `op.drop_table('spatial_ref_sys')` or `op.drop_column(..., 'geom')`** — PostGIS-managed objects and GeoAlchemy2 geometry columns leaked into the diff. Add the `include_object` filter and the `import geoalchemy2` line. Always read an autogenerated migration before committing it; a stray `drop_table('spatial_ref_sys')` will strip every SRID definition from the database.

- **`type "geometry" does not exist`** — the extension was not created before the migration referenced a geometry column. Create it on the connection in `env.py` (and defensively as the first migration), not as a manual one-off — CI starts from an empty database every run.

- **Left-behind `INVALID` index after a failed concurrent build** — `CREATE INDEX CONCURRENTLY` is non-transactional, so a mid-build failure leaves an unusable index. The `IF NOT EXISTS` guard is not enough on its own; if you see an invalid index, `DROP INDEX CONCURRENTLY IF EXISTS idx_parcels_geom` and re-run. Check with the verification query below.

- **`downgrade()` is untested and irreversible** — a migration that adds a geometry column but whose `downgrade()` forgets to drop it will fail the reversibility check. Every `upgrade()` needs a matching `downgrade()`, and CI should exercise both (below).

---

## Verification

Assert the migration reaches head, is reversible, and left a valid index:

```bash
# 1. Upgrade to head, then step down and back up — proves reversibility.
alembic upgrade head
alembic downgrade -1
alembic upgrade head
```

```sql
-- 2. The spatial index exists AND is valid (not a failed concurrent build).
SELECT c.relname, i.indisvalid
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = 'idx_parcels_geom';
```

```
     relname      | indisvalid
------------------+------------
 idx_parcels_geom | t
```

```sql
-- 3. PostGIS system tables were NOT touched by the migration.
SELECT count(*) FROM spatial_ref_sys WHERE srid = 4326;  -- expect 1
```

An `indisvalid` of `f` means a concurrent build failed and left an invalid index; a `spatial_ref_sys` count of `0` for SRID 4326 means autogenerate wiped the SRID catalogue and the filter is missing.

---

## Related

- [CI/CD Pipelines for Spatial APIs](/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/) — the pipeline whose migrate step this page implements
- [GitHub Actions Integration Tests with a PostGIS Service Container](/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/github-actions-integration-tests-with-a-postgis-service-container/) — the job that runs `alembic upgrade head` against a real PostGIS
- [Async PostGIS Transaction Patterns](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/) — how DDL locks and concurrent builds interact with in-flight spatial writes

← Back to [CI/CD Pipelines for Spatial APIs](/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/)
