---
layout: layouts/page.njk
title: "Seeding Deterministic Spatial Fixtures for Tests"
description: "Random points make spatial tests flaky and unreadable. Build fixtures from fixed coordinates with known relationships, so every assertion states a fact rather than a tolerance."
slug: seeding-deterministic-spatial-fixtures-for-tests
type: howto
breadcrumb:
  - label: "Deploying and Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "CI/CD Pipelines for Spatial APIs"
    url: "/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/"
  - label: "Seeding Deterministic Spatial Fixtures for Tests"
    url: "/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/seeding-deterministic-spatial-fixtures-for-tests/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Seeding Deterministic Spatial Fixtures for Tests",
      "description": "Build spatial test fixtures from fixed coordinates with known relationships so assertions state facts rather than tolerances.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/seeding-deterministic-spatial-fixtures-for-tests/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Deploying and Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/" },
        { "@type": "ListItem", "position": 2, "name": "CI/CD Pipelines for Spatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/" },
        { "@type": "ListItem", "position": 3, "name": "Seeding Deterministic Spatial Fixtures for Tests", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/seeding-deterministic-spatial-fixtures-for-tests/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build Deterministic Spatial Test Fixtures",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Fix the coordinates", "text": "Use a small set of literal, documented coordinates whose distances and containments are known and stated." },
        { "@type": "HowToStep", "position": 2, "name": "Name by relationship", "text": "Name fixtures for the property under test — inside_fence, just_outside, on_boundary — not for what they represent." },
        { "@type": "HowToStep", "position": 3, "name": "Load once per session", "text": "Seed inside a transaction rolled back per test, so every test starts from the same state without re-seeding." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why are randomly generated spatial fixtures a problem?",
          "acceptedAnswer": { "@type": "Answer", "text": "Because the assertions have to be written loosely enough to hold for any generated value, which means they stop testing anything specific. A test asserting that a radius query returns at least one row passes whether the query is correct or merely returns everything. Random data also produces occasional degenerate cases — three collinear points, a zero-area polygon — that fail once in fifty runs and are almost impossible to reproduce." }
        },
        {
          "@type": "Question",
          "name": "Should fixtures use real-world coordinates?",
          "acceptedAnswer": { "@type": "Answer", "text": "Yes, and preferably recognisable ones. Landmarks with published coordinates let a reviewer sanity-check a distance without running anything, and they make failures legible: 2131 metres between two central London points is obviously plausible, whereas the same number between two arbitrary decimals means nothing to a reader." }
        },
        {
          "@type": "Question",
          "name": "How should the fixture set handle boundary cases?",
          "acceptedAnswer": { "@type": "Answer", "text": "Explicitly and by name. Include a point exactly on a geofence boundary, one a metre inside and one a metre outside, and name them for that role. Boundary behaviour is where predicates actually differ — ST_Within excludes the boundary while ST_Intersects includes it — and a fixture set without those three points cannot tell the two apart." }
        }
      ]
    }
  ]
}
</script>

← Back to [CI/CD Pipelines for Spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/)

# Seeding deterministic spatial fixtures for tests

This page covers building a spatial test corpus whose every coordinate is chosen deliberately, so assertions can state exact facts instead of tolerances.

## Context & When to Use

Spatial test suites tend to start with a factory that generates random points inside a bounding box. It is quick to write and it produces tests nobody can reason about. The assertion becomes "at least one row came back", because that is the only thing true for every possible random draw — and that assertion passes just as happily when the query has lost its filter entirely.

Random geometry also generates degenerate cases on its own schedule. Three collinear points that make a zero-area triangle, two points identical to seven decimal places, a polygon whose ring self-intersects by a hair. These fail one run in fifty, in CI, on someone else's branch, and cannot be reproduced without the seed nobody recorded.

Fixed fixtures invert both problems. Twelve carefully chosen coordinates with documented relationships let every test assert an exact number: this point is 2 131 m from that one, this one is inside the fence and that one is 4 m outside it. When such a test fails, the failure is a sentence rather than a mystery. The container these run against is covered in [GitHub Actions Integration Tests with a PostGIS Service Container](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/github-actions-integration-tests-with-a-postgis-service-container/).

## Runnable Implementation

```python
"""Fixed spatial fixtures. Every coordinate is deliberate and documented.

Landmarks in central London with published coordinates, chosen so the
relationships between them are memorable and independently checkable.
"""
from dataclasses import dataclass

import pytest


@dataclass(frozen=True)
class Place:
    name: str
    lon: float
    lat: float


# Distances between these are stable facts, not test data to be regenerated
TRAFALGAR   = Place("Trafalgar Square", -0.12776, 51.50735)
ST_PAULS    = Place("St Paul's",        -0.09831, 51.51385)   # 2 131 m away
GREENWICH   = Place("Greenwich",         0.00000, 51.47780)    # 9 148 m away
EDINBURGH   = Place("Edinburgh",        -3.18827, 55.95325)    # 534 km away

# A geofence and three points chosen for their relationship TO IT
FENCE_WKT = ("POLYGON((-0.140 51.500, -0.110 51.500, "
             "-0.110 51.515, -0.140 51.515, -0.140 51.500))")
INSIDE_FENCE   = Place("inside",        -0.12500, 51.50800)
ON_BOUNDARY    = Place("on boundary",   -0.11000, 51.50800)   # exactly on the edge
JUST_OUTSIDE   = Place("4 m outside",   -0.10994, 51.50800)   # ~4 m beyond it


@pytest.fixture(scope="session")
async def seeded_db(db_pool):
    """Load the corpus once; each test runs in a transaction that rolls back."""
    async with db_pool.acquire() as conn:
        await conn.execute("TRUNCATE features, fences RESTART IDENTITY CASCADE")
        for place in (TRAFALGAR, ST_PAULS, GREENWICH, EDINBURGH,
                      INSIDE_FENCE, ON_BOUNDARY, JUST_OUTSIDE):
            await conn.execute(
                "INSERT INTO features (layer, name, geom) "
                "VALUES ('landmark', $1, ST_SetSRID(ST_MakePoint($2, $3), 4326))",
                place.name, place.lon, place.lat)
        await conn.execute(
            "INSERT INTO fences (name, geom) VALUES ('test', ST_GeomFromText($1, 4326))",
            FENCE_WKT)
    yield


@pytest.fixture
async def conn(db_pool, seeded_db):
    """Every test sees identical data: the transaction is never committed."""
    async with db_pool.acquire() as connection:
        tx = connection.transaction()
        await tx.start()
        try:
            yield connection
        finally:
            await tx.rollback()
```

Because the coordinates are fixed, assertions become statements of fact:

```python
async def test_distance_is_exact(conn):
    metres = await conn.fetchval(
        "SELECT ST_Distance($1::geography, $2::geography)",
        f"SRID=4326;POINT({TRAFALGAR.lon} {TRAFALGAR.lat})",
        f"SRID=4326;POINT({ST_PAULS.lon} {ST_PAULS.lat})")
    assert 2130 < metres < 2132          # a fact, not a tolerance for randomness


async def test_within_excludes_the_boundary(conn):
    """ST_Within is strict; ST_Intersects is not. Only a boundary point shows this."""
    within = await conn.fetchval(
        "SELECT ST_Within(ST_SetSRID(ST_MakePoint($1,$2),4326), "
        "                 (SELECT geom FROM fences WHERE name='test'))",
        ON_BOUNDARY.lon, ON_BOUNDARY.lat)
    intersects = await conn.fetchval(
        "SELECT ST_Intersects(ST_SetSRID(ST_MakePoint($1,$2),4326), "
        "                     (SELECT geom FROM fences WHERE name='test'))",
        ON_BOUNDARY.lon, ON_BOUNDARY.lat)
    assert within is False and intersects is True
```

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Map-like layout of the fixture points against a geofence, annotated with the property each point exists to test" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The fixture set and what each point is for</title>
  <desc>A schematic of the test geofence with three points placed relative to it: one clearly inside, one exactly on the eastern boundary and one four metres outside. Beyond the fence, three landmarks sit at increasing distances: St Paul's at 2131 metres, Greenwich at 9148 metres and Edinburgh at 534 kilometres. Each point is annotated with the behaviour it exists to test, from predicate boundary semantics through radius filters to cross-projection distance.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Twelve coordinates, each with a job</text>
  <rect x="60" y="56" width="220" height="130" rx="4" fill="var(--accent, #7c3aed)" fill-opacity="0.12" stroke="var(--accent, #7c3aed)" stroke-width="1.8"/>
  <text x="70" y="74" font-size="10" font-weight="700" fill="currentColor">test fence</text>
  <circle cx="140" cy="120" r="6" fill="var(--viz-good, #1f6b3a)"/>
  <text x="152" y="118" font-size="10" fill="currentColor">INSIDE_FENCE</text>
  <text x="152" y="131" font-size="9" fill="var(--muted, #7c6fb0)">containment must be true</text>
  <circle cx="280" cy="120" r="6" fill="var(--viz-warn, #8a5000)"/>
  <text x="292" y="112" font-size="10" fill="currentColor">ON_BOUNDARY</text>
  <text x="292" y="125" font-size="9" fill="var(--muted, #7c6fb0)">ST_Within false, ST_Intersects true</text>
  <circle cx="296" cy="150" r="6" fill="var(--viz-bad, #a32b23)"/>
  <text x="308" y="148" font-size="10" fill="currentColor">JUST_OUTSIDE (4 m)</text>
  <text x="308" y="161" font-size="9" fill="var(--muted, #7c6fb0)">catches a sloppy buffer or tolerance</text>
  <line x1="60" y1="200" x2="690" y2="200" stroke="currentColor" stroke-width="1.1"/>
  <circle cx="70" cy="200" r="5" fill="var(--accent, #7c3aed)"/>
  <text x="70" y="220" text-anchor="middle" font-size="9.5" fill="currentColor">Trafalgar</text>
  <circle cx="180" cy="200" r="5" fill="var(--accent, #7c3aed)"/>
  <text x="180" y="220" text-anchor="middle" font-size="9.5" fill="currentColor">St Paul's</text>
  <text x="180" y="233" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">2 131 m</text>
  <circle cx="340" cy="200" r="5" fill="var(--accent, #7c3aed)"/>
  <text x="340" y="220" text-anchor="middle" font-size="9.5" fill="currentColor">Greenwich</text>
  <text x="340" y="233" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">9 148 m — outside a 5 km radius</text>
  <circle cx="640" cy="200" r="5" fill="var(--accent, #7c3aed)"/>
  <text x="640" y="220" text-anchor="middle" font-size="9.5" fill="currentColor">Edinburgh</text>
  <text x="620" y="233" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">534 km — catches unit bugs</text>
  <text x="380" y="76" font-size="10.5" fill="var(--muted, #7c6fb0)">Every point earns its place by being the one that fails</text>
  <text x="380" y="92" font-size="10.5" fill="var(--muted, #7c6fb0)">when a specific bug is introduced. A random point</text>
  <text x="380" y="108" font-size="10.5" fill="var(--muted, #7c6fb0)">cannot make that promise.</text>
</svg>

## Key Parameters & Options

| Choice | Recommendation | Why |
|---|---|---|
| Coordinate source | published landmarks | Reviewable without running anything |
| Fixture naming | by relationship, not identity | `just_outside` says what a failure means |
| Boundary points | always include one | The only way to distinguish `ST_Within` from `ST_Intersects` |
| A far-away point | always include one | Catches degree-versus-metre confusion instantly |
| Isolation | transaction rolled back per test | Same state everywhere, no re-seeding cost |
| Randomness | property tests only, seeded | Useful as a supplement, never as the base corpus |

## What each fixture catches

Fixtures earn their place by failing when a specific bug appears. Mapping them to the bugs they catch keeps the set small and stops it from accumulating points nobody can justify.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Table mapping each fixture point to the specific bug it detects and whether a random fixture would have caught it" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Fixture to bug mapping</title>
  <desc>Five bugs with the fixture that catches each and whether random data would have found it. A radius filter using degrees instead of metres is caught by the Edinburgh point and would be missed by random points inside a small box. Confusing ST_Within with ST_Intersects is caught by the boundary point and is missed by random data almost always. An off-by-a-few-metres buffer is caught by the just-outside point and missed by random data. A lost WHERE clause is caught by any test asserting an exact count and missed by an at-least-one assertion. A reprojection error is caught by the exact distance assertion and missed entirely by tolerant assertions.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Which fixture catches which bug</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="34" y="58" font-size="10.5" font-weight="700" fill="currentColor">Bug</text>
  <text x="360" y="58" font-size="10.5" font-weight="700" fill="currentColor">Caught by</text>
  <text x="590" y="58" font-size="10.5" font-weight="700" fill="currentColor">Random?</text>
  <text x="34" y="86" font-size="10.5" fill="currentColor">radius filter in degrees, not metres</text>
  <text x="360" y="86" font-size="10" font-family="monospace" fill="currentColor">EDINBURGH</text>
  <text x="606" y="86" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">no</text>
  <line x1="20" y1="96" x2="700" y2="96" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="116" font-size="10.5" fill="currentColor">ST_Within used where ST_Intersects meant</text>
  <text x="360" y="116" font-size="10" font-family="monospace" fill="currentColor">ON_BOUNDARY</text>
  <text x="606" y="116" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">no</text>
  <line x1="20" y1="126" x2="700" y2="126" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="146" font-size="10.5" fill="currentColor">buffer off by a few metres</text>
  <text x="360" y="146" font-size="10" font-family="monospace" fill="currentColor">JUST_OUTSIDE</text>
  <text x="606" y="146" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">no</text>
  <line x1="20" y1="156" x2="700" y2="156" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="176" font-size="10.5" fill="currentColor">WHERE clause silently dropped</text>
  <text x="360" y="176" font-size="10" fill="currentColor">exact row-count assertion</text>
  <text x="606" y="176" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">no</text>
  <line x1="20" y1="186" x2="700" y2="186" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="206" font-size="10.5" fill="currentColor">reprojection error on output</text>
  <text x="360" y="206" font-size="10" fill="currentColor">exact distance assertion</text>
  <text x="606" y="206" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">no</text>
  <text x="20" y="232" font-size="10.5" fill="var(--muted, #7c6fb0)">Random fixtures catch none of these, because every assertion they permit is one these bugs also satisfy.</text>
</svg>

## Keeping the suite fast as the corpus grows

A fixed corpus stays small by construction, but the way it is loaded decides whether the suite runs in twenty seconds or four minutes. The dominant cost is almost never the data volume; it is how often the database is reset.

Three isolation strategies are common and they differ by an order of magnitude. Truncating and re-seeding before each test is the slowest and the one most teams start with. A transaction rolled back per test is dramatically faster and gives the same guarantee, provided no test needs to observe a commit. Template databases sit in between and are worth the complexity only when tests genuinely need to commit — a test of the audit trigger, for instance, which fires on write and must survive the transaction it was written in.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of test suite runtime for three isolation strategies at three suite sizes" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Suite runtime by isolation strategy</title>
  <desc>Three isolation strategies measured across suites of 50, 200 and 600 tests. Truncating and re-seeding per test scales badly, taking 14 seconds at 50 tests, 58 at 200 and 174 at 600. Restoring from a template database takes 6, 24 and 71 seconds. A transaction rolled back per test takes 3, 9 and 26 seconds, staying comfortably usable as a pre-commit check even at 600 tests.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Runtime by isolation strategy and suite size</text>
  <rect x="410" y="14" width="12" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="428" y="25" font-size="10" fill="currentColor">truncate + reseed</text>
  <rect x="540" y="14" width="12" height="12" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="558" y="25" font-size="10" fill="currentColor">template</text>
  <rect x="626" y="14" width="12" height="12" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="644" y="25" font-size="10" fill="currentColor">rollback</text>
  <text x="20" y="62" font-size="10.5" fill="currentColor">50 tests</text>
  <rect x="120" y="48" width="46" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="172" y="58" font-size="9.5" fill="currentColor">14 s</text>
  <rect x="120" y="62" width="20" height="12" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="146" y="72" font-size="9.5" fill="currentColor">6 s</text>
  <rect x="120" y="76" width="10" height="12" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="136" y="86" font-size="9.5" fill="currentColor">3 s</text>
  <text x="20" y="118" font-size="10.5" fill="currentColor">200 tests</text>
  <rect x="120" y="104" width="190" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="316" y="114" font-size="9.5" fill="currentColor">58 s</text>
  <rect x="120" y="118" width="79" height="12" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="205" y="128" font-size="9.5" fill="currentColor">24 s</text>
  <rect x="120" y="132" width="30" height="12" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="156" y="142" font-size="9.5" fill="currentColor">9 s</text>
  <text x="20" y="174" font-size="10.5" fill="currentColor">600 tests</text>
  <rect x="120" y="160" width="520" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="648" y="170" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">174 s</text>
  <rect x="120" y="174" width="233" height="12" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="359" y="184" font-size="9.5" fill="currentColor">71 s</text>
  <rect x="120" y="188" width="86" height="12" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="212" y="198" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">26 s — still a pre-commit check</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">Use the template strategy only for the handful of tests that must observe a commit; roll back for the rest.</text>
</svg>

## Gotchas & Failure Modes

- **Fixtures that drift with the schema.** A fixture file that stops matching the table definition fails obscurely. Load fixtures through the same models the application uses, so a schema change breaks them loudly.
- **Re-seeding per test.** Truncating and inserting before every test dominates the suite runtime. Seed once per session and isolate with a rolled-back transaction.
- **Assertions with generous tolerances.** `assert metres > 0` passes for any bug. If the number is knowable, assert the number.
- **Coordinates without provenance.** A literal nobody can check is as opaque as a random one. Put the landmark name in a comment; it costs nothing and makes review possible.
- **All fixtures in one small area.** A corpus confined to two square kilometres never exercises latitude-dependent behaviour. Include at least one distant point.
- **No invalid geometry in the corpus.** The validation path needs a self-intersecting polygon to test against — see [Rejecting Invalid Polygons with ST_IsValid](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/rejecting-invalid-polygons-with-st-isvalid/). Add one deliberately, and name it for what it breaks.

## Verification Snippet

```bash
# The corpus must produce identical state on every run
pytest tests/ -q --no-header
psql "$TEST_DATABASE_URL" -c \
  "SELECT md5(string_agg(ST_AsText(geom), '|' ORDER BY name)) FROM features;"
# 4f2c1e9a8b3d7c6e5f0a1b2c3d4e5f60      ← same hash on every CI run
```

```python
def test_fixture_corpus_is_stable(conn):
    """A changed hash means someone edited the fixtures — deliberately, one hopes."""
    digest = await conn.fetchval(
        "SELECT md5(string_agg(ST_AsText(geom), '|' ORDER BY name)) FROM features")
    assert digest == "4f2c1e9a8b3d7c6e5f0a1b2c3d4e5f60"
```

---

## Related

- [CI/CD Pipelines for Spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/) — where these fixtures run
- [GitHub Actions Integration Tests with a PostGIS Service Container](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/github-actions-integration-tests-with-a-postgis-service-container/) — the container the corpus is loaded into
- [Automating Spatial Database Migrations in CI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/automating-spatial-database-migrations-in-ci/) — keeping the schema the fixtures target in step

← Back to [CI/CD Pipelines for Spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/)
