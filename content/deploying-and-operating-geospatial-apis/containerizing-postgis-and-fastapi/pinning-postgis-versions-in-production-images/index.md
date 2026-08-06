---
layout: layouts/page.njk
title: "Pinning PostGIS Versions in Production Images"
description: "Floating tags like postgis/postgis:latest silently change ST_ algorithm output and break reproducibility. Pin by exact tag and sha256 digest, keep client GDAL aligned, and follow the safe ALTER EXTENSION postgis UPDATE upgrade path."
slug: "pinning-postgis-versions-in-production-images"
breadcrumb:
  - label: "Deploying & Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Containerizing PostGIS & FastAPI"
    url: "/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/"
  - label: "Pinning PostGIS Versions in Production Images"
    url: "/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/"
datePublished: "2026-01-19"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Pinning PostGIS Versions in Production Images",
      "description": "Floating tags like postgis/postgis:latest silently change ST_ algorithm output and break reproducibility. Pin by exact tag and sha256 digest, keep client GDAL aligned, and follow the safe ALTER EXTENSION postgis UPDATE upgrade path.",
      "datePublished": "2026-01-19",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "Article",
      "headline": "Pinning PostGIS Versions in Production Images",
      "datePublished": "2026-01-19",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Deploying & Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/"},
        {"@type": "ListItem", "position": 2, "name": "Containerizing PostGIS & FastAPI", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/"},
        {"@type": "ListItem", "position": 3, "name": "Pinning PostGIS Versions in Production Images", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Pin PostGIS versions for reproducible production images",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Replace floating tags with an exact PostGIS version tag."},
        {"@type": "HowToStep", "position": 2, "text": "Resolve the tag to a sha256 digest and pin FROM to the digest."},
        {"@type": "HowToStep", "position": 3, "text": "Align the client-side GDAL and PROJ versions with the pinned database."},
        {"@type": "HowToStep", "position": 4, "text": "Upgrade deliberately with ALTER EXTENSION postgis UPDATE and postgis_extensions_upgrade()."},
        {"@type": "HowToStep", "position": 5, "text": "Verify with SELECT PostGIS_Full_Version()."}
      ]
    }
  ]
}
</script>

← Back to [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/)

# Pinning PostGIS versions in production images

A floating `postgis/postgis:latest` tag turns a routine image pull into a silent geometry-algorithm change — pin by exact tag *and* digest so `ST_` output is reproducible across every environment and rebuild.

## Context & when to use

PostGIS is not a passive store; it is the engine that computes your geometry. Its `ST_` functions call into GEOS and PROJ, and those libraries evolve. Between PostGIS 3.3 and 3.4, or between the GEOS versions two minor image tags bundle, functions like `ST_SimplifyPreserveTopology`, `ST_Buffer`, `ST_MakeValid`, and even `ST_IsValid` can return *different but equally correct* results — a slightly different vertex set, a polygon that was previously flagged invalid now repaired, a simplification that keeps one more point. When your image references `:latest` or a bare major like `:16`, a rebuild months apart pulls a newer build, and suddenly a regression test comparing serialized geometry fails, a cached tile no longer matches a freshly rendered one, or a downstream diff pipeline reports thousands of "changed" features that nobody edited.

Pin whenever an environment must be reproducible: production, staging, and CI all need to run the *same* PostGIS build so that a geometry computed in CI equals the one computed in production. This is the operational complement to the base-image discipline in [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/) — that guide pins the tag; this one pins the immutable digest and covers the upgrade path. The precondition is a private or trusted registry mirror if you need the pinned digest to survive an upstream tag being re-pushed.

---

## Why floating tags drift

<svg viewBox="0 0 760 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A floating tag resolves to different image builds over time producing different ST_ output, while a pinned digest always resolves to the same build" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>Floating tag drift versus pinned digest stability</title>
  <desc>The floating tag postgis:16 resolves in January to a GEOS 3.11 build and in June to a GEOS 3.12 build, producing two different ST_SimplifyPreserveTopology outputs. The pinned digest sha256 always resolves to the same GEOS 3.12 build and the same output regardless of when it is pulled.</desc>
  <rect x="0" y="0" width="760" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <!-- Floating row -->
  <text x="20" y="46" font-size="11" font-weight="700" fill="currentColor">FLOATING · postgis:16</text>
  <rect x="200" y="24" width="150" height="48" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="275" y="44" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">Jan pull</text>
  <text x="275" y="60" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">GEOS 3.11 build</text>
  <rect x="410" y="24" width="150" height="48" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="485" y="44" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">Jun pull</text>
  <text x="485" y="60" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">GEOS 3.12 build</text>
  <rect x="600" y="18" width="150" height="60" rx="8" fill="none" stroke="#ef4444" stroke-width="1.5"/>
  <text x="675" y="40" text-anchor="middle" font-size="10.5" fill="#b91c1c" font-weight="700">DIFFERENT</text>
  <text x="675" y="56" text-anchor="middle" font-size="9.5" fill="#b91c1c">ST_Simplify output</text>
  <text x="675" y="69" text-anchor="middle" font-size="9.5" fill="#b91c1c">reproducibility ✕</text>
  <line x1="350" y1="48" x2="410" y2="48" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#a)"/>
  <line x1="560" y1="48" x2="600" y2="48" stroke="#ef4444" stroke-width="1.5" marker-end="url(#b)"/>
  <!-- divider -->
  <line x1="20" y1="120" x2="740" y2="120" stroke="var(--border, #c4b5fd)" stroke-width="1" stroke-dasharray="3 3"/>
  <!-- Pinned row -->
  <text x="20" y="176" font-size="11" font-weight="700" fill="currentColor">PINNED · @sha256:…</text>
  <rect x="200" y="154" width="150" height="48" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="275" y="174" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">Jan pull</text>
  <text x="275" y="190" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">GEOS 3.12 build</text>
  <rect x="410" y="154" width="150" height="48" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="485" y="174" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">Jun pull</text>
  <text x="485" y="190" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">GEOS 3.12 build</text>
  <rect x="600" y="148" width="150" height="60" rx="8" fill="none" stroke="#10b981" stroke-width="1.5"/>
  <text x="675" y="170" text-anchor="middle" font-size="10.5" fill="#047857" font-weight="700">IDENTICAL</text>
  <text x="675" y="186" text-anchor="middle" font-size="9.5" fill="#047857">ST_Simplify output</text>
  <text x="675" y="199" text-anchor="middle" font-size="9.5" fill="#047857">reproducible ✓</text>
  <line x1="350" y1="178" x2="410" y2="178" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="560" y1="178" x2="600" y2="178" stroke="#10b981" stroke-width="1.5" marker-end="url(#c)"/>
  <defs>
    <marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
    <marker id="b" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#b91c1c"/></marker>
    <marker id="c" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#047857"/></marker>
  </defs>
</svg>

A tag is a mutable pointer; a `sha256` digest is the content-addressed identity of one exact image. Pinning the tag documents intent (PostGIS 3.4 on PostgreSQL 16); pinning the digest guarantees byte-for-byte the same GEOS and PROJ every pull.

---

## Runnable implementation

Pin the database image in the `Dockerfile` (or the compose `image:`) to a tag *and* its digest, then align the client stack. Resolve the digest once, commit it, and treat a change to it as a deliberate upgrade.

{% raw %}
```bash
# 1. Resolve the current digest for the exact tag you intend to run.
docker pull postgis/postgis:16-3.4
docker inspect --format '{{index .RepoDigests 0}}' postgis/postgis:16-3.4
# postgis/postgis@sha256:9c1f...e2a7   <-- commit THIS string
```
{% endraw %}

```dockerfile
# Dockerfile (or compose image:) — tag documents intent, digest guarantees identity.
# The tag after the @digest is ignored by the daemon but kept for humans.
FROM postgis/postgis:16-3.4@sha256:9c1f4b2d3a5e6f7089abcdef0123456789abcdef0123456789abcdef0123e2a7
```

```yaml
# docker-compose.yml — same pin, plus a client stack aligned to the DB's PROJ/GEOS.
services:
  db:
    image: postgis/postgis:16-3.4@sha256:9c1f4b2d3a5e6f7089abcdef...e2a7
    environment:
      POSTGRES_DB: gis
      POSTGRES_USER: gis
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gis && psql -U gis -d gis -tAc 'SELECT PostGIS_Version()'"]
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    build: .            # app image pins libgdal32 to the SAME GDAL major as the DB
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
```

```sql
-- The SAFE upgrade path. Run ONLY after deliberately bumping the pinned
-- digest to a newer minor and letting the new binary start against the
-- existing data volume. This reconciles the SQL-level extension objects
-- with the new .so, without a dump/restore.
ALTER EXTENSION postgis UPDATE;                 -- core geometry types + functions
SELECT postgis_extensions_upgrade();            -- also updates postgis_raster,
                                                -- postgis_topology, tiger geocoder
-- Confirm the reconciliation:
SELECT PostGIS_Full_Version();
```

---

A floating tag is a dependency that updates itself without appearing in any diff.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="What a floating tag actually gives you over six months: deploy then rebuild then rebuild then rebuild then incident" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What a floating tag actually gives you over six months</title>
  <desc>A horizontal timeline. deploy: PostGIS 3.4.0. rebuild: silently 3.4.1. rebuild: silently 3.4.2. rebuild: 3.5.0 — new GEOS. incident: a plan changed; nothing in the diff explains it. Nothing in the repository changed across these five points. That is precisely the problem a digest pin solves.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">What a floating tag actually gives you over six months</text>
  <rect x="20" y="92" width="109" height="34" rx="5" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="74" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">deploy</text>
  <text x="74" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">PostGIS 3.4.0</text>
  <rect x="133" y="92" width="109" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="187" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">rebuild</text>
  <text x="187" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">silently 3.4.1</text>
  <rect x="246" y="92" width="109" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="300" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">rebuild</text>
  <text x="300" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">silently 3.4.2</text>
  <rect x="359" y="92" width="166" height="34" rx="5" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="442" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">rebuild</text>
  <text x="442" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">3.5.0 — new GEOS</text>
  <rect x="529" y="92" width="166" height="34" rx="5" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="612" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">incident</text>
  <text x="612" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">a plan changed; nothing in the diff explains it</text>
  <text x="20" y="184" font-size="10.5" fill="var(--muted, #7c6fb0)">Nothing in the repository changed across these five points. That is precisely the problem a digest pin solves.</text>
</svg>

## Key parameters & options

| Element | Purpose | Recommended value |
|---|---|---|
| Exact tag `16-3.4` | Documents the intended PostgreSQL + PostGIS pair | Never `:latest`, never bare `:16` |
| `@sha256:…` digest | Content-addressed, immutable image identity | Resolve once, commit, review on change |
| Client `libgdal32` major | Keep API-side GDAL aligned with the DB's GEOS/PROJ | Same major as the pinned DB build |
| `ALTER EXTENSION postgis UPDATE` | Reconciles SQL objects with a new PostGIS `.so` | Run after every deliberate minor bump |
| `postgis_extensions_upgrade()` | Upgrades raster/topology/tiger sub-extensions too | Run alongside the `ALTER EXTENSION` |
| `PostGIS_Full_Version()` | Reports PostGIS, GEOS, PROJ, and GDAL versions | The single verification source of truth |
| Digest in a private mirror | Survives upstream tags being re-pushed | Mirror the digest for supply-chain safety |

---

Each step down this list trades reproducibility for automatic patches — and only the last row makes upgrades visible.

<svg viewBox="0 0 720 234" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pinning strength, from weakest to strongest: Reproducible, Gets fixes" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Pinning strength, from weakest to strongest</title>
  <desc>A comparison table. postgis/postgis:latest: Reproducible no, Gets fixes yes. never do this postgis/postgis:16: Reproducible no, Gets fixes yes. major only — still drifts postgis/postgis:16-3.4: Reproducible partly, Gets fixes yes. patch versions still move …@sha256:…: Reproducible yes, Gets fixes no. exact, and updates are a deliberate PR The digest is the only line that makes a rebuild byte-identical, and the only one where an upgrade is reviewable.</desc>
  <rect x="0" y="0" width="720" height="234" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Pinning strength, from weakest to strongest</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Reproducible</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Gets fixes</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">postgis/postgis:latest</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">never do this</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">postgis/postgis:16</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">major only — still drifts</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">postgis/postgis:16-3.4</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">patch versions still move</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">…@sha256:…</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="460" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">exact, and updates are a deliberate PR</text>
  <text x="20" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">The digest is the only line that makes a rebuild byte-identical, and the only one where an upgrade is reviewable.</text>
</svg>

## Gotchas & failure modes

- **A minor bump silently changes `ST_` output.** Upgrading the pinned digest from a GEOS 3.11 build to a 3.12 build can shift `ST_SimplifyPreserveTopology`, `ST_Buffer`, and `ST_MakeValid` results by a vertex or a coordinate. A geometry-diff regression suite then reports mass "changes." This is expected, not a bug — treat every digest bump as a change that requires re-baselining golden geometry fixtures, and gate it behind the same review as a schema migration handled in CI.

- **Mismatched PROJ data between client and server.** If the API container's `pyproj`/`libproj25` bundles a different PROJ datum grid than the database, an `ST_Transform` computed server-side and a `pyproj` transform computed client-side can disagree by centimetres to metres for datum-shifting SRIDs. Pin the client PROJ to the same major as the database, and prefer doing all reprojection in one place — see the serialization trade-offs in [GeoJSON vs GeoParquet serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/).

- **Downgrade is effectively impossible.** `ALTER EXTENSION postgis UPDATE` moves forward only; there is no `DOWNGRADE`. If a bumped digest breaks you, the pinned *old* digest still exists in the registry, but a data directory already touched by the newer binary will refuse to start under the older one (`database files are incompatible with server`). Always snapshot the volume (or take a `pg_dump`) before bumping, so rollback is a restore, not a prayer.

- **`could not access file "$libdir/postgis-3"` after the binary changed but the SQL did not.** The container started on a new PostGIS `.so` but you never ran `ALTER EXTENSION postgis UPDATE`, so the catalog still points at the old library name. Fix: run the upgrade SQL immediately after the first start on a new minor.

- **The digest points at a multi-arch manifest list.** On Apple Silicon vs x86 CI, the same tag resolves to different per-architecture digests. Pin the *manifest list* digest (what `docker inspect` returns for the tag) so Docker selects the right arch, or pin per-arch digests explicitly in a build matrix — mismatches otherwise surface as `exec format error`.

---

Pinning is only half the discipline; the other half is a scheduled review. A digest that is never updated becomes an image that never receives a security patch, which is a different kind of risk from the one pinning was adopted to solve. Put the upgrade on a calendar, treat it as an ordinary pull request with the version diff visible, and run the same startup assertions against the new image before it reaches production.

Pinning is only half the discipline; the other half is a scheduled review. A digest that is never updated becomes an image that never receives a security patch, which is a different kind of risk from the one pinning was adopted to solve. Put the upgrade on a calendar, treat it as an ordinary pull request with the version diff visible, and run the same startup assertions against the new image before it reaches production.

## Verification

`PostGIS_Full_Version()` is the one call that reports every library the geometry engine depends on. Assert it in a smoke test so a drifted image fails the pipeline before it serves traffic:

{% raw %}
```bash
# Confirm the running database reports the exact expected stack.
docker compose exec -T db psql -U gis -d gis -tAc "SELECT PostGIS_Full_Version();"
# POSTGIS="3.4.2 ..." [EXTENSION] PGSQL="160" GEOS="3.12.1-CAPI-1.18.1"
#   PROJ="9.3.1" LIBXML="2.9.14" LIBJSON="0.17" ...

# Assert the digest actually deployed matches what you pinned.
docker inspect --format '{{index .RepoDigests 0}}' \
  "$(docker compose images -q db)"
# postgis/postgis@sha256:9c1f...e2a7   <-- must equal the committed digest

# Pin-drift guard for CI: fail if GEOS is not the expected version.
docker compose exec -T db psql -U gis -d gis -tAc "SELECT PostGIS_Full_Version();" \
  | grep -q 'GEOS="3.12' || { echo "PostGIS/GEOS drift detected"; exit 1; }
```
{% endraw %}

If `PostGIS_Full_Version()` reports a GEOS or PROJ version you did not expect, the pinned digest changed underneath you — reconcile the committed digest before allowing the deploy to proceed.

---

## Related

- [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/) — base image selection, the compose stack, and PostGIS-aware healthchecks this pinning strategy locks down
- [Multi-Stage Docker Builds for PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/multi-stage-docker-builds-for-postgis-fastapi/) — align the builder and runtime GDAL versions so a pinned image stays reproducible
- [GeoJSON vs GeoParquet serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — where reprojection and serialization belong when client and server PROJ versions must agree

← Back to [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/)
