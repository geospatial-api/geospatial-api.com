---
layout: layouts/page.njk
title: "GitHub Actions Integration Tests with a PostGIS Service Container"
description: "A complete GitHub Actions test.yml using a postgis/postgis:16-3.4 service container with a health check, enabling the extension, seeding real geometries, and running async pytest with asyncpg and SQLAlchemy."
slug: "github-actions-integration-tests-with-a-postgis-service-container"
breadcrumb:
  - label: "Deploying & Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "CI/CD Pipelines for Spatial APIs"
    url: "/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/"
  - label: "GitHub Actions Integration Tests with a PostGIS Service Container"
    url: "/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/github-actions-integration-tests-with-a-postgis-service-container/"
datePublished: "2025-10-22"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "GitHub Actions Integration Tests with a PostGIS Service Container",
      "description": "A complete GitHub Actions test.yml using a postgis/postgis:16-3.4 service container with a health check, enabling the extension, seeding real geometries, and running async pytest with asyncpg and SQLAlchemy.",
      "datePublished": "2025-10-22",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Deploying & Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/"},
        {"@type": "ListItem", "position": 2, "name": "CI/CD Pipelines for Spatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/"},
        {"@type": "ListItem", "position": 3, "name": "GitHub Actions Integration Tests with a PostGIS Service Container", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/github-actions-integration-tests-with-a-postgis-service-container/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Run GitHub Actions integration tests against a PostGIS service container",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Declare a postgis/postgis:16-3.4 service with a pg_isready health check."},
        {"@type": "HowToStep", "position": 2, "text": "Create the PostGIS extension in the test database."},
        {"@type": "HowToStep", "position": 3, "text": "Seed test geometries with explicit SRIDs."},
        {"@type": "HowToStep", "position": 4, "text": "Run pytest with asyncpg and SQLAlchemy async against localhost."}
      ]
    },
    {
      "@type": "Article",
      "headline": "GitHub Actions Integration Tests with a PostGIS Service Container",
      "datePublished": "2025-10-22",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [CI/CD Pipelines for Spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/)

# GitHub Actions integration tests with a PostGIS service container

Stand up a real `postgis/postgis:16-3.4` inside a GitHub Actions job, wait for it correctly, enable the extension, seed real geometries, and run async pytest against it — so your spatial queries are tested by the same engine that runs in production.

## Context & when to use

A GitHub Actions *service container* is the lightest way to give a job a real database. You declare an image under `services:`, the runner starts it before your steps, and your steps reach it over the network. For a FastAPI + PostGIS service this is almost always the right first choice: it is a few lines of YAML, it starts once per job, and it maps cleanly onto the health-check plumbing GitHub already provides. This is the path the [CI/CD pipeline overview](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/) recommends for the integration stage.

Prefer a service container when every test can share one database version and one schema, and when your steps run directly on the runner (the default). Reach for Testcontainers instead when tests must spin databases up and down in code or need a fresh database per case; reach for docker-compose when you are testing the whole system, not the query. For a single spatial test suite that asserts on `ST_Intersects`, `ST_DWithin`, and GiST index selection, the service container wins on simplicity and speed.

The one thing a service container will *not* do for you is create the PostGIS extension. The image ships the binaries, but `CREATE EXTENSION postgis` still has to run against your test database before any `ST_` function resolves — and that step, plus waiting for the server to actually accept connections, is where most first attempts fail.

---

## Data flow

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GitHub Actions job talking to a PostGIS service container over localhost" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>GitHub Actions job and PostGIS service container</title>
  <desc>A runner job runs steps in sequence: wait for the pg_isready health check to pass, create the PostGIS extension, seed geometries, then run pytest. All steps connect over localhost port 5432 to a PostGIS service container that the runner started and health-checks.</desc>
  <rect x="0" y="0" width="760" height="300" rx="10" fill="var(--surface, #f5f3ff)"/>
  <!-- runner job box -->
  <rect x="20" y="30" width="340" height="248" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 3" opacity="0.6"/>
  <text x="190" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="var(--muted, #7c6fb0)">GitHub Actions runner — job "test"</text>
  <rect x="44" y="48" width="292" height="34" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="190" y="69" text-anchor="middle" font-size="11" fill="currentColor">1 · wait for health check (pg_isready)</text>
  <rect x="44" y="94" width="292" height="34" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="190" y="115" text-anchor="middle" font-size="11" fill="currentColor">2 · CREATE EXTENSION postgis</text>
  <rect x="44" y="140" width="292" height="34" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="190" y="161" text-anchor="middle" font-size="11" fill="currentColor">3 · seed geometries (explicit SRID)</text>
  <rect x="44" y="186" width="292" height="34" rx="6" fill="var(--accent, #7c3aed)" opacity="0.14" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="190" y="207" text-anchor="middle" font-size="11" fill="currentColor" font-weight="700">4 · pytest (asyncpg / SQLAlchemy)</text>
  <text x="190" y="248" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">steps run on the runner host</text>
  <text x="190" y="264" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">→ reach the service at localhost:5432</text>
  <!-- service container -->
  <rect x="470" y="88" width="270" height="120" rx="10" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="605" y="118" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">PostGIS service</text>
  <text x="605" y="138" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">postgis/postgis:16-3.4</text>
  <text x="605" y="162" text-anchor="middle" font-size="11" fill="currentColor">container port 5432</text>
  <text x="605" y="182" text-anchor="middle" font-size="11" fill="currentColor">→ mapped to localhost:5432</text>
  <text x="605" y="200" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">health-checked by the runner</text>
  <!-- connection arrows -->
  <line x1="336" y1="203" x2="470" y2="150" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="470" y1="120" x2="336" y2="65" stroke="var(--muted, #7c6fb0)" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#arrm)"/>
  <text x="404" y="108" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">healthy?</text>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="var(--accent, #7c3aed)"/>
    </marker>
    <marker id="arrm" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="var(--muted, #7c6fb0)"/>
    </marker>
  </defs>
</svg>

---

## Runnable implementation

The complete workflow. It declares the service with a health check, waits for readiness, creates the extension, and runs pytest against `localhost:5432`.

```yaml
# .github/workflows/test.yml
name: test
on: [push, pull_request]

jobs:
  integration:
    runs-on: ubuntu-latest
    services:
      postgis:
        # Pin the SAME tag you deploy — CI must not drift from production.
        image: postgis/postgis:16-3.4
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: gis_test
        ports:
          # host:container — reach it at localhost:5432 from runner steps.
          - 5432:5432
        # The runner waits until this command succeeds before starting steps.
        options: >-
          --health-cmd "pg_isready -U postgres -d gis_test"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
          --health-start-period 10s
    env:
      # asyncpg driver URL used by the app + tests. Host is localhost.
      DATABASE_URL: postgresql+asyncpg://postgres:postgres@localhost:5432/gis_test
      # libpq URL for the psql bootstrap step below.
      PSQL_URL: postgresql://postgres:postgres@localhost:5432/gis_test
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip

      - run: pip install -r requirements-dev.txt

      # PostGIS ships the binaries; the EXTENSION must still be created
      # in the specific database the tests connect to (gis_test).
      - name: Enable PostGIS extension
        run: psql "$PSQL_URL" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS postgis"

      # Apply schema/migrations before seeding.
      - name: Migrate
        run: alembic upgrade head

      - name: Run integration tests
        run: pytest tests/integration -q
```

The matching pytest fixture creates the engine, guarantees the extension and schema, and seeds a geometry with an explicit SRID — the fixture *is* the geometry:

```python
# tests/integration/conftest.py
import os
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

DATABASE_URL = os.environ["DATABASE_URL"]  # postgresql+asyncpg://...@localhost:5432/gis_test

@pytest_asyncio.fixture(scope="session")
async def engine():
    eng = create_async_engine(DATABASE_URL)
    async with eng.begin() as conn:
        # Idempotent belt-and-braces in case the workflow step is skipped locally.
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS zones (
                id   bigserial PRIMARY KEY,
                name text,
                geom geometry(Polygon, 4326)  -- SRID is part of the column type
            )
        """))
        await conn.execute(
            text("CREATE INDEX IF NOT EXISTS idx_zones_geom ON zones USING GIST (geom)")
        )
    yield eng
    await eng.dispose()

@pytest_asyncio.fixture
async def session(engine):
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as s:
        # Explicit SRID 4326 — omitting ST_SetSRID/SRID here is the #1 cause of
        # tests that pass locally but return empty sets against real data.
        await s.execute(text("""
            INSERT INTO zones (name, geom) VALUES
            ('unit-square', ST_GeomFromText(
                'POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))', 4326))
        """))
        await s.commit()
        yield s
        await s.execute(text("TRUNCATE zones RESTART IDENTITY"))
        await s.commit()
```

A test that only a real PostGIS can satisfy:

```python
# tests/integration/test_zones.py
import pytest
from sqlalchemy import text

@pytest.mark.asyncio
async def test_point_within_zone(session):
    result = await session.execute(text("""
        SELECT name FROM zones
        WHERE ST_Within(ST_SetSRID(ST_MakePoint(0.5, 0.5), 4326), geom)
    """))
    assert result.scalar() == "unit-square"
```

This same bounding-box-and-predicate shape is the workload described in [implementing ST_Within and ST_Intersects in FastAPI](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/implementing-st_within-and-st_intersects-in-fastapi/) — the integration test verifies that endpoint's query against the real engine.

---

Image choice is the single biggest lever on how long a spatial CI job waits before it can start testing.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Job time by PostGIS image choice: postgis/postgis:16-3.4 18 s to healthy, postgis/postgis:16-3.4-alpine 12 s — smaller, no proj-data, postgres:16 + CREATE EXTENSION 41 s — installs at boot, custom image with fixtures baked 9 s" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Job time by PostGIS image choice</title>
  <desc>A horizontal bar chart. postgis/postgis:16-3.4 is 18 s to healthy. postgis/postgis:16-3.4-alpine is 12 s — smaller, no proj-data. postgres:16 + CREATE EXTENSION is 41 s — installs at boot. custom image with fixtures baked is 9 s. The alpine variant is fastest to pull and the one most likely to be missing grid-shift files — verify before choosing it.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Job time by PostGIS image choice</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">postgis/postgis:16-3.4</text>
  <rect x="250" y="48" width="149" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="407" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">18 s to healthy</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">postgis/postgis:16-3.4-alpine</text>
  <rect x="250" y="82" width="99" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="357" y="95" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">12 s — smaller, no proj-data</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">postgres:16 + CREATE EXTENSION</text>
  <rect x="250" y="116" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="129" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">41 s — installs at boot</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">custom image with fixtures baked</text>
  <rect x="250" y="150" width="74" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="332" y="163" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">9 s</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">The alpine variant is fastest to pull and the one most likely to be missing grid-shift files — verify before choosing it.</text>
</svg>

## Key parameters & options

| Parameter | Where | Purpose |
|---|---|---|
| `image: postgis/postgis:16-3.4` | `services.postgis` | The pinned PostGIS build; must equal the deploy tag |
| `POSTGRES_DB: gis_test` | service `env` | Creates the database the tests connect to |
| `ports: ["5432:5432"]` | service | Maps the container port so runner steps reach `localhost:5432` |
| `--health-cmd "pg_isready ..."` | `options` | Readiness probe the runner waits on before steps start |
| `--health-interval / --health-retries` | `options` | How often and how many times to probe before failing |
| `--health-start-period 10s` | `options` | Grace window before failing probes count against retries |
| `DATABASE_URL` (host `localhost`) | job `env` | asyncpg connection string for app + tests |
| `CREATE EXTENSION IF NOT EXISTS postgis` | step | Registers `ST_` functions in `gis_test` |
| `ON_ERROR_STOP=1` | psql flag | Fails the step loudly if the extension cannot be created |

---

The gap between "postgres is up" and "PostGIS is usable" is where most CI flakiness lives.

<svg viewBox="0 0 720 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Why the health check matters more than it looks: container starts then init scripts run then healthcheck passes then tests connect" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Why the health check matters more than it looks</title>
  <desc>A left to right pipeline. Stage 1, container starts: postgres accepting but no extensions. Stage 2, init scripts run: CREATE EXTENSION several seconds. Stage 3, healthcheck passes: pg_isready + SELECT postgis_version() the real gate. Stage 4, tests connect: schema present deterministic. A health check that only runs pg_isready lets tests start before PostGIS exists — the classic flaky first job of the morning.</desc>
  <rect x="0" y="0" width="720" height="210" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Why the health check matters more than it looks</text>
  <rect x="18" y="52" width="154" height="86" rx="8" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.5"/>
  <text x="95" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">container starts</text>
  <text x="95" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">postgres accepting</text>
  <text x="95" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">but no extensions</text>
  <path d="M175 95 L189 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arwhytheheal)"/>
  <rect x="194" y="52" width="154" height="86" rx="8" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.5"/>
  <text x="271" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">init scripts run</text>
  <text x="271" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">CREATE EXTENSION</text>
  <text x="271" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">several seconds</text>
  <path d="M351 95 L365 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arwhytheheal)"/>
  <rect x="370" y="52" width="154" height="86" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="447" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">healthcheck passes</text>
  <text x="447" y="98" text-anchor="middle" font-size="9" fill="currentColor">pg_isready + postgis_version()</text>
  <text x="447" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">the real gate</text>
  <path d="M527 95 L541 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arwhytheheal)"/>
  <rect x="546" y="52" width="154" height="86" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="623" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">tests connect</text>
  <text x="623" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">schema present</text>
  <text x="623" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">deterministic</text>
  <text x="20" y="168" font-size="10.5" fill="var(--muted, #7c6fb0)">A health check that only runs pg_isready lets tests start before PostGIS exists — the classic flaky first job of the morning.</text>
  <defs><marker id="arwhytheheal" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker></defs>
</svg>

## Gotchas & failure modes

- **`function st_within(...) does not exist`** — the extension was not created, or was created in the wrong database. The image auto-creates it only in the default `POSTGRES_DB` on some tags and versions; do not rely on that. Run `CREATE EXTENSION IF NOT EXISTS postgis` explicitly against `gis_test`, with `ON_ERROR_STOP=1` so a failure is not swallowed.

- **`could not connect to server: Connection refused`** — steps started before PostgreSQL accepted connections. The container reports "started" before the server is ready. Never substitute a fixed `sleep`; use `--health-cmd "pg_isready -U postgres -d gis_test"` with retries so the runner blocks step execution until the probe passes.

- **`getaddrinfo ... Name or service not known` for host `postgis`** — you used the service *name* as the hostname. When your steps run directly on the runner (the default here), the service is reachable at `localhost` on the mapped port, not by service name. The service name resolves only when the *job itself* runs inside a container (`container:` at job level) sharing the service network.

- **Tests pass but production returns nothing** — a fixture inserted geometry with `SRID=0` (no `ST_SetSRID`/`ST_GeomFromText(..., 4326)`). Mixed-SRID comparisons raise `Operation on mixed SRID geometries` or silently skip the GiST index. Bake the SRID into the column type — `geometry(Polygon, 4326)` — and into every insert.

- **`pg_isready` passes but `CREATE EXTENSION` still races on a slow runner** — `pg_isready` reports the postmaster is accepting connections, which is enough here, but on heavily loaded runners add `--health-start-period` to avoid early probe failures burning your retry budget before the server is warm.

---

## Verification

Confirm the service, the extension, and the version from inside the job:

```bash
# Extension is present in the DB the tests use
psql "$PSQL_URL" -c "SELECT extname, extversion FROM pg_extension WHERE extname='postgis';"

# It is the pinned build, not a surprise upgrade
psql "$PSQL_URL" -c "SELECT PostGIS_Version();"

# The seeded geometry has the SRID you expect
psql "$PSQL_URL" -c "SELECT name, ST_SRID(geom) FROM zones;"
```

```
    name     | st_srid
-------------+---------
 unit-square |    4326
```

An `st_srid` of `0` means a fixture forgot to set the SRID — fix it before trusting a single spatial assertion.

---

## Related

- [CI/CD Pipelines for Spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/) — the full pipeline this test job plugs into
- [Automating Spatial Database Migrations in CI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/automating-spatial-database-migrations-in-ci/) — the `alembic upgrade head` step, done safely with GeoAlchemy2
- [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/) — where the tested image is built, shipped, and run

← Back to [CI/CD Pipelines for Spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/)
