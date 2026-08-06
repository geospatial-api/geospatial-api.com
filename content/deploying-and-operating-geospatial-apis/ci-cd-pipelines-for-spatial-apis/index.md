---
layout: layouts/page.njk
title: "CI/CD Pipelines for Spatial APIs"
description: "Build a full CI/CD pipeline for a FastAPI + PostGIS service: lint, type-check, spatial integration tests against a real PostGIS, image build, migrations, and deploy — with the spatial-specific failure modes solved."
slug: "ci-cd-pipelines-for-spatial-apis"
breadcrumb:
  - label: "Deploying & Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "CI/CD Pipelines for Spatial APIs"
    url: "/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/"
datePublished: "2025-09-18"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "CI/CD Pipelines for Spatial APIs",
      "description": "Build a full CI/CD pipeline for a FastAPI + PostGIS service: lint, type-check, spatial integration tests against a real PostGIS, image build, migrations, and deploy — with the spatial-specific failure modes solved.",
      "datePublished": "2025-09-18",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com"},
      "mainEntityOfPage": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/"
    },
    {
      "@type": "Article",
      "headline": "CI/CD Pipelines for Spatial APIs",
      "datePublished": "2025-09-18",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Deploying & Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/"},
        {"@type": "ListItem", "position": 2, "name": "CI/CD Pipelines for Spatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build a CI/CD Pipeline for a FastAPI and PostGIS Service",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Run lint and static type-check gates"},
        {"@type": "HowToStep", "position": 2, "name": "Run unit tests that need no database"},
        {"@type": "HowToStep", "position": 3, "name": "Stand up a real PostGIS and run spatial integration tests"},
        {"@type": "HowToStep", "position": 4, "name": "Build and push the container image"},
        {"@type": "HowToStep", "position": 5, "name": "Run migrations then deploy"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why can't I mock PostGIS in CI instead of running a real instance?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Spatial correctness lives inside PostGIS's C library. ST_Intersects, ST_DWithin, GiST index selection, and SRID transforms have no faithful Python stand-in — a mock returns whatever you told it to, so it can pass while the real query is wrong. SQLite with SpatiaLite differs from PostGIS in function coverage, index behaviour, and SRID handling, so tests that pass there routinely fail in production. Run the same postgis/postgis image tag you deploy."
          }
        },
        {
          "@type": "Question",
          "name": "Service container, Testcontainers, or docker-compose in CI — which should I use?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use a GitHub Actions service container for a single fixed PostGIS version and the simplest, fastest setup. Use Testcontainers when tests need to control the database lifecycle in code, run several isolated databases, or run identically on a laptop and in CI. Use docker-compose when the job needs the API, worker, Redis, and PostGIS wired together as a system for end-to-end tests."
          }
        },
        {
          "@type": "Question",
          "name": "How do I keep spatial CI fast when PostGIS startup is slow?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Cache pip wheels and Docker build layers keyed on the lock file, gate on a real health check rather than a fixed sleep, create the PostGIS extension once into a template or reused container, and split the fast lint and unit jobs from the slower integration job so failures surface in under a minute. A warm pipeline for a mid-size service lands around three to five minutes end to end."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/)

# CI/CD pipelines for spatial APIs

Continuous integration for an ordinary CRUD service is a solved problem: lint, run tests against an in-memory database or a mock, build an image, deploy. A FastAPI service backed by PostGIS breaks that recipe in exactly one place — the tests — and that single difference cascades through the entire pipeline. Spatial correctness does not live in your Python code; it lives inside PostGIS's C library. `ST_Intersects`, `ST_DWithin`, GiST index selection, and SRID transforms cannot be mocked without mocking away the very thing you need to verify. This guide builds a complete pipeline for a spatial API — lint and type-check, unit tests, spatial integration tests against a real PostGIS, image build and push, migrations, and deploy — and treats the "you need a real PostGIS in CI" constraint as the central design problem rather than an afterthought.

The rest of the deployment story — how the image is built and pinned — lives in the [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/) overview and its [containerizing PostGIS and FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/) guide. This page assumes that image exists and focuses on the pipeline that tests and ships it.

---

## Why spatial CI is different

The core problem is that a spatial query has two answers: the one your ORM emits and the one PostGIS computes. Only the second one matters, and only PostGIS can produce it.

- **You cannot mock the spatial engine.** A mock repository that returns a hand-picked list of features tests your Python plumbing and nothing else. Whether `WHERE ST_DWithin(geom, :point, 500)` actually returns the right rows depends on the geometry column's SRID, whether the GiST index is used, and the exact semantics of the PostGIS version installed. Substituting SQLite + SpatiaLite is worse than useless: it has different function coverage, no `&&` planner behaviour, different SRID handling, and will pass tests that production fails.
- **Fixtures must be real geometries.** A spatial test fixture is not `{"lat": 1, "lon": 2}` — it is a `MULTIPOLYGON` with a declared SRID, inserted with `ST_GeomFromText(..., 4326)` or `ST_SetSRID`, that exercises the actual predicate under test. The realism of the geometry (winding order, self-intersections, antimeridian crossing) is part of the test.
- **The extension is not the database.** `postgis/postgis:16-3.4` ships the PostGIS binaries, but `CREATE EXTENSION postgis` still has to run against each database before `ST_` functions resolve. Forgetting this is the single most common CI failure, producing `function st_intersects(...) does not exist`.
- **Migrations carry spatial baggage.** Running Alembic in CI with GeoAlchemy2 surfaces problems a plain schema never sees — spurious `DROP COLUMN geom`, and `CREATE INDEX CONCURRENTLY` that cannot run inside a migration's transaction. That whole class of problem has its own guide: [automating spatial database migrations in CI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/automating-spatial-database-migrations-in-ci/).

<svg viewBox="0 33 740 207" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CI/CD pipeline stages for a FastAPI and PostGIS service" style="width:100%;max-width:780px;display:block;margin:1.5rem auto;">
  <title>Spatial API CI/CD pipeline stages</title>
  <desc>Six sequential stages left to right: lint and type-check, unit tests, spatial integration tests, build and push image, migrate database, and deploy. The spatial integration test stage connects down to a highlighted PostGIS service container that provides real ST_ functions, GiST indexes, SRID handling, and real geometries.</desc>
  <rect x="0" y="33" width="740" height="207" rx="10" fill="var(--surface, #f5f3ff)"/>
  <!-- stage boxes -->
  <rect x="16" y="80" width="108" height="64" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="70" y="60" text-anchor="middle" font-size="11" font-weight="700" fill="var(--muted, #7c6fb0)">1</text>
  <text x="70" y="108" text-anchor="middle" font-size="10.5" fill="currentColor">Lint &amp;</text>
  <text x="70" y="123" text-anchor="middle" font-size="10.5" fill="currentColor">type-check</text>
  <rect x="136" y="80" width="108" height="64" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="190" y="60" text-anchor="middle" font-size="11" font-weight="700" fill="var(--muted, #7c6fb0)">2</text>
  <text x="190" y="108" text-anchor="middle" font-size="10.5" fill="currentColor">Unit tests</text>
  <text x="190" y="123" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">(no DB)</text>
  <rect x="256" y="80" width="108" height="64" rx="8" fill="var(--accent, #7c3aed)" opacity="0.14" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="310" y="60" text-anchor="middle" font-size="11" font-weight="700" fill="var(--muted, #7c6fb0)">3</text>
  <text x="310" y="108" text-anchor="middle" font-size="10.5" fill="currentColor" font-weight="700">Spatial integ.</text>
  <text x="310" y="123" text-anchor="middle" font-size="10.5" fill="currentColor" font-weight="700">tests</text>
  <rect x="376" y="80" width="108" height="64" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="430" y="60" text-anchor="middle" font-size="11" font-weight="700" fill="var(--muted, #7c6fb0)">4</text>
  <text x="430" y="108" text-anchor="middle" font-size="10.5" fill="currentColor">Build &amp;</text>
  <text x="430" y="123" text-anchor="middle" font-size="10.5" fill="currentColor">push image</text>
  <rect x="496" y="80" width="108" height="64" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="550" y="60" text-anchor="middle" font-size="11" font-weight="700" fill="var(--muted, #7c6fb0)">5</text>
  <text x="550" y="108" text-anchor="middle" font-size="10.5" fill="currentColor">Migrate DB</text>
  <text x="550" y="123" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">(Alembic)</text>
  <rect x="616" y="80" width="108" height="64" rx="8" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="670" y="60" text-anchor="middle" font-size="11" font-weight="700" fill="var(--muted, #7c6fb0)">6</text>
  <text x="670" y="108" text-anchor="middle" font-size="10.5" fill="#065f46" font-weight="700">Deploy</text>
  <text x="670" y="123" text-anchor="middle" font-size="10.5" fill="#065f46">rollout</text>
  <!-- arrows between stages -->
  <line x1="124" y1="112" x2="136" y2="112" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="244" y1="112" x2="256" y2="112" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="364" y1="112" x2="376" y2="112" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="484" y1="112" x2="496" y2="112" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="604" y1="112" x2="616" y2="112" stroke="#10b981" stroke-width="1.5" marker-end="url(#arr2)"/>
  <!-- callout: PostGIS service container -->
  <rect x="180" y="176" width="260" height="48" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="310" y="196" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">Real PostGIS service container</text>
  <text x="310" y="212" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">ST_ functions · GiST · SRID · real geometries</text>
  <line x1="310" y1="144" x2="310" y2="176" stroke="var(--accent, #7c3aed)" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="var(--accent, #7c3aed)"/>
    </marker>
    <marker id="arr2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#10b981"/>
    </marker>
  </defs>
</svg>

---

## Prerequisites & Environment

The pipeline pins every tool. Floating versions are how a green pipeline turns red overnight with no code change.

| Component | Version | Why it matters here |
|---|---|---|
| Python | 3.12 | Match the runtime baked into the deploy image, not just "latest 3.x" |
| FastAPI | 0.111+ | Async lifespan, current Pydantic v2 integration |
| SQLAlchemy | 2.0+ | Native `async_sessionmaker`, `AsyncSession` |
| asyncpg | 0.29+ | Async driver used by the app and the integration tests |
| GeoAlchemy2 | 0.15+ | `Geometry` column type; interacts with Alembic autogenerate |
| Alembic | 1.13+ | Migrations; `autocommit_block()` for concurrent index creation |
| PostGIS image | `postgis/postgis:16-3.4` | The **same** tag CI and production run — never `latest` |
| pytest / pytest-asyncio | 8.x / 0.23+ | Async test execution |
| ruff / mypy | 0.5+ / 1.10+ | Lint and static type gates |

Two rules govern the whole pipeline. First, the PostGIS tag in CI is the tag you deploy — pinning it is covered in [pinning PostGIS versions in production images](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/), and the same discipline applies to CI. A minor PostGIS bump can change `ST_SimplifyPreserveTopology` output or GiST cost estimates; if CI runs 3.4 and prod runs 3.5, your tests are lying. Second, the database that runs your tests must have the PostGIS extension created before any test touches an `ST_` function.

---

## Decision matrix: how to run PostGIS in CI

There are three defensible ways to get a real PostGIS into a CI job. They are not interchangeable; each optimises a different axis.

| Approach | Lifecycle owner | Isolation | Startup cost | Best when |
|---|---|---|---|---|
| **Service container** (`jobs.<id>.services`) | The CI runner | One DB per job | Lowest — pulled and started once per job | A single fixed PostGIS version; fastest, simplest integration job |
| **Testcontainers** (`testcontainers[postgres]`) | Your test code | Per test module or per session, in code | Medium — container per fixture scope | You need programmatic control, several isolated DBs, or laptop/CI parity |
| **docker-compose in CI** | A compose file | Whole system (API + worker + Redis + DB) | Highest — full stack boot | End-to-end tests that need the API and dependencies wired together |

For the pipeline in this guide the integration job uses a **service container**: it is the least code, starts once, and maps cleanly onto GitHub Actions' health-check plumbing. The complete `test.yml` for that path — health check, extension creation, seeded geometries, and async pytest — is built end to end in [GitHub Actions integration tests with a PostGIS service container](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/github-actions-integration-tests-with-a-postgis-service-container/). Reach for Testcontainers when a single shared database is not enough — for example, tests that verify tenant isolation need a fresh database per case, and the same container config then runs unchanged on a developer laptop. Reach for docker-compose only when the thing under test is the system, not the query.

---

The choice of how to run the database in CI decides which class of bug the pipeline can see at all.

<svg viewBox="0 0 720 234" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Running PostGIS in CI — three options: Fast, Realistic, Cheap" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Running PostGIS in CI — three options</title>
  <desc>A comparison table. service container: Fast yes, Realistic yes, Cheap yes. the default for GitHub Actions shared staging database: Fast partly, Realistic yes, Cheap no. flaky under parallel jobs SQLite + SpatiaLite: Fast yes, Realistic no, Cheap yes. different SQL, different bugs managed ephemeral branch: Fast yes, Realistic yes, Cheap partly. closest to production data SpatiaLite is the tempting one and the wrong one: the dialect differences hide exactly the bugs CI exists to catch.</desc>
  <rect x="0" y="0" width="720" height="234" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Running PostGIS in CI — three options</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Fast</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Realistic</text>
  <text x="502" y="58" font-size="10" font-weight="700" fill="currentColor">Cheap</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">service container</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="568" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">the default for GitHub Actions</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">shared staging database</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">flaky under parallel jobs</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">SQLite + SpatiaLite</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="510" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="568" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">different SQL, different bugs</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">managed ephemeral branch</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="184" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="568" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">closest to production data</text>
  <text x="20" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">SpatiaLite is the tempting one and the wrong one: the dialect differences hide exactly the bugs CI exists to catch.</text>
</svg>

## Step-by-Step Implementation

The pipeline is five gates. Each either passes cheaply and fast, or fails loudly with an actionable error. The ordering is deliberate: the cheapest gates run first so a formatting slip never waits on a PostGIS boot.

### Step 1 — Lint and type-check (seconds, no database)

Run `ruff` and `mypy` as the first gate. They need no services, finish in seconds, and catch the majority of mechanical mistakes.

```bash
ruff check app tests
ruff format --check app tests
mypy app
```

Type-checking a spatial API earns its keep: GeoAlchemy2's `Geometry` columns and the `WKBElement` values they return are easy to mishandle, and `mypy` flags a raw `WKBElement` leaking into a response model before a human review would.

### Step 2 — Unit tests that need no database

Keep a genuine unit tier that runs without PostGIS: Pydantic geometry validators, coordinate-bounds checks, cursor encoders, and pure serialisation. These verify the logic that surrounds the database. Validation modelling itself follows the [spatial resource modelling patterns](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) used across the API, so the unit tier maps directly onto those model classes.

```python
# tests/unit/test_validators.py
import pytest
from app.schemas import GeometryPayload

def test_rejects_unknown_srid():
    with pytest.raises(ValueError, match="not in allowed set"):
        GeometryPayload(wkt="POINT(0 0)", srid=9999)
```

### Step 3 — Spatial integration tests against a real PostGIS

This is the stage that defines a spatial pipeline. A `postgis/postgis:16-3.4` service starts, the job waits on a real health check, the extension is created, fixtures insert real geometries with explicit SRIDs, and pytest runs the queries that only PostGIS can answer.

```python
# tests/integration/conftest.py
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5432/gis_test"

@pytest_asyncio.fixture(scope="session")
async def engine():
    eng = create_async_engine(DATABASE_URL, poolclass=None)
    async with eng.begin() as conn:
        # The extension must exist before any ST_ function resolves.
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS parcels (
                id     bigserial PRIMARY KEY,
                name   text,
                geom   geometry(MultiPolygon, 4326)
            )
        """))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_parcels_geom ON parcels USING GIST (geom)"))
    yield eng
    await eng.dispose()

@pytest_asyncio.fixture
async def session(engine):
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        # Seed a real geometry with an explicit SRID — this IS the fixture.
        await s.execute(text("""
            INSERT INTO parcels (name, geom) VALUES
            ('block-a', ST_Multi(ST_GeomFromText(
                'POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))', 4326)))
        """))
        await s.commit()
        yield s
        await s.execute(text("TRUNCATE parcels RESTART IDENTITY"))
        await s.commit()
```

The test then asserts on the predicate itself — the thing a mock could never verify:

```python
# tests/integration/test_spatial_queries.py
import pytest
from sqlalchemy import text

@pytest.mark.asyncio
async def test_point_inside_parcel_is_found(session):
    row = await session.execute(text("""
        SELECT id FROM parcels
        WHERE ST_Intersects(geom, ST_SetSRID(ST_MakePoint(0.5, 0.5), 4326))
    """))
    assert row.scalar() is not None

@pytest.mark.asyncio
async def test_gist_index_is_used(session):
    plan = await session.execute(text("""
        EXPLAIN (FORMAT TEXT)
        SELECT id FROM parcels
        WHERE geom && ST_MakeEnvelope(0, 0, 1, 1, 4326)
    """))
    assert any("idx_parcels_geom" in r[0] for r in plan)
```

The second test asserts the GiST index is actually chosen — a class of regression that unit tests are structurally incapable of catching, and one that also validates the reasoning in [reading EXPLAIN ANALYZE for spatial query optimization](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/).

### Step 4 — Build and push the image

Only after tests pass do you build the deployable image. Use the registry cache so unchanged layers are not rebuilt, and tag with the immutable commit SHA. The multi-stage build itself is covered in [multi-stage Docker builds for PostGIS FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/multi-stage-docker-builds-for-postgis-fastapi/); the pipeline's job is to build it reproducibly and push it.

### Step 5 — Migrate, then deploy

Migrations run as a discrete step against the target database before the new image serves traffic. Running Alembic with GeoAlchemy2 has spatial-specific hazards — spurious geometry-column drops in autogenerate, and `CREATE INDEX CONCURRENTLY` that cannot execute inside Alembic's transaction — all handled in [automating spatial database migrations in CI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/automating-spatial-database-migrations-in-ci/). Deploy only after `alembic upgrade head` exits zero.

---

## Production Code Example

A complete GitHub Actions workflow that runs the fast gates, then the spatial integration job against a real PostGIS, then builds and pushes on success. This is copy-runnable; adjust the registry and secrets to your environment.

{% raw %}
```yaml
# .github/workflows/ci.yml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
      - run: pip install -r requirements-dev.txt
      - run: ruff check app tests
      - run: ruff format --check app tests
      - run: mypy app

  test:
    runs-on: ubuntu-latest
    needs: lint
    services:
      postgis:
        image: postgis/postgis:16-3.4
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: gis_test
        ports:
          - 5432:5432
        # Gate on a REAL readiness check, not a fixed sleep.
        options: >-
          --health-cmd "pg_isready -U postgres -d gis_test"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql+asyncpg://postgres:postgres@localhost:5432/gis_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
      - run: pip install -r requirements-dev.txt
      # Create the extension once, into the DB the tests use.
      - name: Enable PostGIS
        run: psql "$PSQL_URL" -c "CREATE EXTENSION IF NOT EXISTS postgis"
        env:
          PGPASSWORD: postgres
          PSQL_URL: postgresql://postgres@localhost:5432/gis_test
      - run: alembic upgrade head
      - run: pytest tests/unit tests/integration -q

  build-and-push:
    runs-on: ubuntu-latest
    needs: test
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
          # Reuse layers across runs — keeps warm builds under a minute.
          cache-from: type=gha
          cache-to: type=gha,mode=max
```
{% endraw %}

Note the shape: `lint → test → build-and-push`, with the build gated behind green tests and `if: github.ref == 'refs/heads/main'` so pull requests are validated but never pushed. The `psql` extension step targets the exact database the tests connect to — creating the extension in `postgres` but testing against `gis_test` is a frequent and confusing failure.

---

## Verification & Testing

Confirm each gate does what it claims before trusting the pipeline.

**The extension actually exists in the test DB:**

```bash
psql postgresql://postgres@localhost:5432/gis_test \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'postgis';"
```

```
 extname | extversion
---------+------------
 postgis | 3.4.2
```

**PostGIS is answering, and it is the pinned version:**

```bash
psql postgresql://postgres@localhost:5432/gis_test \
  -c "SELECT PostGIS_Version();"
```

**The GiST index is chosen (not a seq scan):** run the `test_gist_index_is_used` assertion above, or manually:

```sql
EXPLAIN ANALYZE
SELECT id FROM parcels
WHERE geom && ST_MakeEnvelope(0, 0, 1, 1, 4326);
-- Look for "Index Scan using idx_parcels_geom" — a "Seq Scan" here is a failed gate.
```

**The whole job is reproducible locally.** Because the service container is just an image, you can reproduce the CI database exactly:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgis/postgis:16-3.4
```

---

A healthy pipeline spends most of its wall clock on tests; the shape below is what to compare against.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A spatial CI run, end to end: checkout then boot PostGIS then migrate then seed fixtures then tests then teardown" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>A spatial CI run, end to end</title>
  <desc>A horizontal timeline. checkout: 4 s. boot PostGIS: 18 s until healthy. migrate: schema + extensions. seed fixtures: once per job. tests: the only part that should dominate. teardown: container discarded. If anything other than the test band dominates, the pipeline is measuring its own setup rather than the code.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">A spatial CI run, end to end</text>
  <rect x="20" y="92" width="48" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.4"/>
  <text x="44" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">checkout</text>
  <text x="44" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">4 s</text>
  <rect x="72" y="92" width="100" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="122" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">boot PostGIS</text>
  <text x="122" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">18 s until healthy</text>
  <rect x="176" y="92" width="100" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.4"/>
  <text x="226" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">migrate</text>
  <text x="226" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">schema + extensions</text>
  <rect x="280" y="92" width="48" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.4"/>
  <text x="304" y="114" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor">seed</text>
  <text x="304" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">once per job</text>
  <rect x="332" y="92" width="309" height="34" rx="5" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="486" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">tests</text>
  <text x="486" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">the only part that should dominate</text>
  <rect x="645" y="92" width="48" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.4"/>
  <text x="669" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">teardown</text>
  <text x="669" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">container discarded</text>
  <text x="20" y="184" font-size="10.5" fill="var(--muted, #7c6fb0)">If anything other than the test band dominates, the pipeline is measuring its own setup rather than the code.</text>
</svg>

## Failure Modes & Edge Cases

1. **`function st_intersects(geometry, geometry) does not exist`** — the PostGIS extension was never created in the database the tests connect to. Add `CREATE EXTENSION IF NOT EXISTS postgis` as an explicit step, and verify it targets the *test* database, not `postgres`. This is the number-one spatial CI failure.

2. **`could not connect to server: Connection refused` at the first query** — the job started querying before PostGIS finished booting. A fixed `sleep 10` is unreliable; the container reports "started" before the server accepts connections. Gate on `--health-cmd "pg_isready"` with `--health-retries`, so the job waits on genuine readiness. Details in the [service-container guide](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/github-actions-integration-tests-with-a-postgis-service-container/).

3. **`getaddrinfo failed: Name or service not known` for host `postgis`** — you used the service *name* as the host. When steps run directly on the runner (not inside a container job), the service is reached at `localhost` with the mapped port, not the service name. The service name only resolves for container-based jobs on the same network.

4. **`relation "spatial_ref_sys" already exists` during migration** — an Alembic migration tried to create objects PostGIS already provides, usually because autogenerate captured `spatial_ref_sys` or `geometry_columns`. Exclude PostGIS-managed objects from autogenerate; see [automating spatial database migrations in CI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/automating-spatial-database-migrations-in-ci/).

5. **`CREATE INDEX CONCURRENTLY cannot run inside a transaction block`** — a migration built a GiST index concurrently while Alembic held its wrapping transaction open. Use `op.get_context().autocommit_block()` (or `op.execute` outside the transaction). Fully worked through in the migrations guide.

6. **Migration ordering: deploy before migrate** — deploying the new image before `alembic upgrade head` means the code references columns that do not exist yet, producing `column parcels.centroid does not exist` at request time. Always run migrations as a gate *before* the rollout, and design each migration to be backward-compatible with the previous image for zero-downtime deploys.

7. **Tests pass in CI, fail in prod because SRIDs differ** — a fixture inserted geometry with `SRID=0` (no `ST_SetSRID`) while production data is `4326`. `ST_Intersects` between mismatched SRIDs raises `Operation on mixed SRID geometries`, or silently returns nothing when the index is skipped. Always set SRID explicitly in fixtures.

---

## Performance Notes

**End-to-end runtime.** A mid-size spatial API with a few hundred tests lands at roughly three to five minutes for a warm pipeline: about 20–30 s for lint and type-check, 10–20 s for unit tests, 60–120 s for the integration job (most of it PostGIS pull and boot on a cold cache), and 40–90 s for the build-and-push with layer cache. The PostGIS image is ~150 MB compressed; on GitHub-hosted runners it is often already in the layer cache, so the pull is frequently free.

**Cache the two slow things.** Pip wheels and Docker layers dominate cold-run time. `actions/setup-python` with `cache: pip` keyed on the lock file eliminates repeated wheel downloads; `cache-from/cache-to: type=gha` reuses image layers across runs. Together they typically halve wall-clock on the common path where dependencies are unchanged.

**Health checks beat sleeps — on both speed and reliability.** A fixed `sleep 15` is simultaneously too slow (PostGIS is usually ready in 3–5 s) and too flaky (a busy runner can take longer). `pg_isready` polling returns the instant the server accepts connections, shaving seconds off every run while removing the race entirely.

**Split fast from slow.** Keeping lint and unit tests in a separate job from the integration job means a formatting error or a broken validator fails in under a minute without ever waiting on PostGIS. On pull requests this is the difference between a 40-second and a four-minute feedback loop.

**Reuse the database within a job.** Creating the extension and schema once per session (not per test) and truncating between tests — as the `conftest.py` above does — avoids paying `CREATE EXTENSION` and `CREATE TABLE` costs hundreds of times. For suites that genuinely need per-test isolation, a PostgreSQL template database cloned with `CREATE DATABASE ... TEMPLATE` is far cheaper than re-running the extension.

---

## FAQ

### Why can't I mock PostGIS in CI instead of running a real instance?

Spatial correctness lives inside PostGIS's C library. `ST_Intersects`, `ST_DWithin`, GiST index selection, and SRID transforms have no faithful Python stand-in — a mock returns whatever you told it to, so it can pass while the real query is wrong. SQLite with SpatiaLite differs from PostGIS in function coverage, index behaviour, and SRID handling, so tests that pass there routinely fail in production. Run the same `postgis/postgis` image tag you deploy.

### Service container, Testcontainers, or docker-compose in CI — which should I use?

Use a GitHub Actions service container for a single fixed PostGIS version and the simplest, fastest setup. Use Testcontainers when tests need to control the database lifecycle in code, run several isolated databases, or run identically on a laptop and in CI. Use docker-compose when the job needs the API, worker, Redis, and PostGIS wired together as a system for end-to-end tests.

### How do I keep spatial CI fast when PostGIS startup is slow?

Cache pip wheels and Docker build layers keyed on the lock file, gate on a real health check rather than a fixed sleep, create the PostGIS extension once into a template or reused container, and split the fast lint and unit jobs from the slower integration job so failures surface in under a minute. A warm pipeline for a mid-size service lands around three to five minutes end to end.

---

## Related

- [GitHub Actions Integration Tests with a PostGIS Service Container](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/github-actions-integration-tests-with-a-postgis-service-container/) — the complete `test.yml` with health check, extension creation, and async pytest
- [Automating Spatial Database Migrations in CI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/automating-spatial-database-migrations-in-ci/) — Alembic with GeoAlchemy2, autogenerate hazards, and concurrent index creation
- [Containerizing PostGIS and FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/) — the multi-stage image the pipeline builds and ships
- [Async PostGIS Transaction Patterns](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/) — the transaction semantics your integration tests exercise
- [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/) — the operational context around building, shipping, and running spatial services

← Back to [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/)
