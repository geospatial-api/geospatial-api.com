---
layout: layouts/page.njk
title: "Multi-Stage Docker Builds for PostGIS & FastAPI"
description: "Compile shapely, pyproj, and the GDAL bindings in a builder stage, then copy only the virtualenv and runtime shared libraries into a slim non-root final image — with the ldd checks that prove no .so is missing."
slug: "multi-stage-docker-builds-for-postgis-fastapi"
breadcrumb:
  - label: "Deploying & Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Containerizing PostGIS & FastAPI"
    url: "/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/"
  - label: "Multi-Stage Docker Builds for PostGIS & FastAPI"
    url: "/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/multi-stage-docker-builds-for-postgis-fastapi/"
datePublished: "2025-10-21"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Multi-Stage Docker Builds for PostGIS & FastAPI",
      "description": "Compile shapely, pyproj, and the GDAL bindings in a builder stage, then copy only the virtualenv and runtime shared libraries into a slim non-root final image — with the ldd checks that prove no .so is missing.",
      "datePublished": "2025-10-21",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "Article",
      "headline": "Multi-Stage Docker Builds for PostGIS & FastAPI",
      "datePublished": "2025-10-21",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Deploying & Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/"},
        {"@type": "ListItem", "position": 2, "name": "Containerizing PostGIS & FastAPI", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/"},
        {"@type": "ListItem", "position": 3, "name": "Multi-Stage Docker Builds for PostGIS & FastAPI", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/multi-stage-docker-builds-for-postgis-fastapi/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build a multi-stage Docker image for a FastAPI PostGIS API",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "In a builder stage, install build tooling and GDAL/GEOS/PROJ dev headers, then build a virtualenv of all Python geospatial wheels."},
        {"@type": "HowToStep", "position": 2, "text": "Start a fresh slim runtime stage and install only the runtime shared libraries."},
        {"@type": "HowToStep", "position": 3, "text": "Copy the built virtualenv from the builder into the runtime stage."},
        {"@type": "HowToStep", "position": 4, "text": "Create a non-root user and run uvicorn as that user."},
        {"@type": "HowToStep", "position": 5, "text": "Verify with docker image size and ldd against the compiled extensions."}
      ]
    }
  ]
}
</script>

← Back to [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/)

# Multi-stage Docker builds for PostGIS & FastAPI

Compile the geospatial Python stack once in a throwaway builder stage, then ship a slim final image that carries only the virtualenv and the runtime `.so` libraries — never the compiler.

## Context & when to use

A single-stage image that can *build* `rasterio` and the GDAL bindings must contain `build-essential`, `libgdal-dev`, `libgeos-dev`, and `libproj-dev` — hundreds of megabytes of compilers and headers that do nothing at runtime and widen your attack surface. A multi-stage build separates the two concerns: a `builder` stage has the full toolchain and produces a self-contained virtualenv, and a `runtime` stage starts fresh from `python:3.12-slim`, installs only the runtime shared libraries, and copies the finished venv across. The final image is smaller, faster to pull, and contains no compiler for an attacker to leverage.

Reach for this pattern once your image is heading to production or to any registry pull path that matters — CI, autoscaling, or edge nodes. For purely local development, the single-stage Dockerfile in the parent guide, [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/), is simpler and rebuilds just as fast thanks to layer caching. The one precondition that makes multi-stage safe for geospatial code is **library-version alignment**: the `libgdal-dev` the bindings compile against in the builder must have the same major version as the `libgdal32` runtime package in the final stage, or the copied extension will fail to load. Because both come from the same Debian bookworm source package here, they align automatically.

---

## Two-stage build diagram

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two-stage Docker build: a builder stage with compiler and dev headers produces a virtualenv, which is copied into a slim runtime stage that holds only runtime shared libraries" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>Multi-stage build: builder to slim runtime</title>
  <desc>The builder stage contains build-essential, libgdal-dev, libgeos-dev, and libproj-dev, and produces a virtualenv at /opt/venv holding shapely, pyproj, rasterio, and the GDAL bindings. Only /opt/venv is copied into the runtime stage, which starts from python:3.12-slim and installs only libgdal32, libgeos-c1v5, and libproj25. The compiler and dev headers are discarded.</desc>
  <rect x="0" y="0" width="760" height="300" rx="10" fill="var(--surface, #f5f3ff)"/>
  <!-- Builder stage -->
  <rect x="24" y="34" width="320" height="232" rx="12" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="184" y="24" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">STAGE 1 — builder</text>
  <rect x="44" y="52" width="280" height="52" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="184" y="74" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">build-essential · libgdal-dev</text>
  <text x="184" y="91" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">libgeos-dev · libproj-dev</text>
  <rect x="44" y="120" width="280" height="60" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="184" y="143" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">pip install → /opt/venv</text>
  <text x="184" y="161" text-anchor="middle" font-size="10.5" fill="var(--muted, #7c6fb0)">shapely · pyproj · rasterio · GDAL</text>
  <text x="184" y="174" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">compiled against dev headers</text>
  <text x="184" y="212" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">compiler + headers discarded ✕</text>
  <text x="184" y="230" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">stage never shipped</text>
  <!-- Copy arrow -->
  <line x1="344" y1="150" x2="416" y2="150" stroke="currentColor" stroke-width="2" marker-end="url(#arr)"/>
  <text x="380" y="140" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">COPY</text>
  <text x="380" y="164" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">/opt/venv</text>
  <!-- Runtime stage -->
  <rect x="416" y="34" width="320" height="232" rx="12" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="576" y="24" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">STAGE 2 — runtime (shipped)</text>
  <rect x="436" y="52" width="280" height="34" rx="8" fill="none" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="576" y="74" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">python:3.12-slim</text>
  <rect x="436" y="98" width="280" height="52" rx="8" fill="none" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="576" y="120" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">libgdal32 · libgeos-c1v5</text>
  <text x="576" y="137" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">libproj25 (runtime only)</text>
  <rect x="436" y="162" width="280" height="46" rx="8" fill="none" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="576" y="184" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">/opt/venv (copied in)</text>
  <text x="576" y="200" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">USER app · non-root</text>
  <text x="576" y="234" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">no compiler · ~420 MB</text>
  <text x="576" y="252" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">uvicorn app.main:app</text>
  <defs>
    <marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

---

## Runnable implementation

One `Dockerfile` with two `FROM` statements. Every non-obvious line is annotated inline.

```dockerfile
# syntax=docker/dockerfile:1.7
# ============================================================
#  STAGE 1 — builder: has the compiler + dev headers.
#  Its only job is to produce a fully populated /opt/venv.
# ============================================================
FROM python:3.12-slim AS builder

# Dev headers + toolchain. Needed to compile any dependency that
# does NOT ship a manylinux wheel (or when you build wheels yourself).
# --no-install-recommends stops apt pulling in docs/suggested extras.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libgdal-dev \
        libgeos-dev \
        libproj-dev \
    && rm -rf /var/lib/apt/lists/*

# A venv is the cleanest unit to hand across stages: one directory,
# no reliance on the runtime image's site-packages layout.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# GDAL bindings must match the system libgdal version exactly. Pin the
# Python package to the libgdal-dev version apt just installed so the
# ABI matches on both sides of the stage boundary.
ARG GDAL_VERSION=3.6.2

WORKDIR /build
COPY requirements.txt .

# BuildKit cache mount: pip's wheel cache survives across builds even
# when this layer is invalidated, so one changed dep is not a full
# re-download of the geospatial stack.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir \
        "GDAL[numpy]==${GDAL_VERSION}" \
    && pip install --no-cache-dir -r requirements.txt

# ============================================================
#  STAGE 2 — runtime: fresh slim base, NO compiler, NO headers.
#  Ships only runtime .so libraries + the copied venv.
# ============================================================
FROM python:3.12-slim AS runtime

# Runtime shared objects only — the "-dev" packages are deliberately
# absent. These are what rasterio and osgeo.gdal dlopen at import time.
# curl is here for the HEALTHCHECK; drop it if you probe differently.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgdal32 \
        libgeos-c1v5 \
        libproj25 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. Created before the COPY so ownership is set once.
RUN groupadd --system app && useradd --system --gid app --home /app app

# The whole point of the split: bring the built venv across, leaving
# build-essential / *-dev behind in the discarded builder layer.
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY --chown=app:app . .

# Fail the BUILD (not a request) if any compiled extension can't load
# because a runtime .so is missing from this stage.
RUN python -c "import shapely, pyproj, rasterio; from osgeo import gdal; \
print('ok', gdal.__version__)"

USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

A multi-stage build is really a decision about what to throw away, and the builder stage is designed to be discarded.

<svg viewBox="0 0 720 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="What each stage contributes: base then builder then runtime then final" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What each stage contributes</title>
  <desc>A left to right pipeline. Stage 1, base: python:3.12-slim shared by both stages. Stage 2, builder: gcc + headers + wheels discarded entirely. Stage 3, runtime: copy site-packages only no compiler present. Stage 4, final: non-root user, healthcheck 193 MB. The builder stage can be as heavy as it likes — nothing in it reaches the published image.</desc>
  <rect x="0" y="0" width="720" height="210" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">What each stage contributes</text>
  <rect x="18" y="52" width="154" height="86" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="95" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">base</text>
  <text x="95" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">python:3.12-slim</text>
  <text x="95" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">shared by both stages</text>
  <path d="M175 95 L189 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arwhateachst)"/>
  <rect x="194" y="52" width="154" height="86" rx="8" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.5"/>
  <text x="271" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">builder</text>
  <text x="271" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">gcc + headers + wheels</text>
  <text x="271" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">discarded entirely</text>
  <path d="M351 95 L365 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arwhateachst)"/>
  <rect x="370" y="52" width="154" height="86" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="447" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">runtime</text>
  <text x="447" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">copy site-packages only</text>
  <text x="447" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">no compiler present</text>
  <path d="M527 95 L541 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arwhateachst)"/>
  <rect x="546" y="52" width="154" height="86" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="623" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">final</text>
  <text x="623" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">non-root user, healthcheck</text>
  <text x="623" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">193 MB</text>
  <text x="20" y="168" font-size="10.5" fill="var(--muted, #7c6fb0)">The builder stage can be as heavy as it likes — nothing in it reaches the published image.</text>
  <defs><marker id="arwhateachst" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker></defs>
</svg>

## Key parameters & options

| Parameter / flag | Purpose | Recommended value |
|---|---|---|
| `AS builder` / `AS runtime` | Names the stages so `COPY --from=builder` can reference the first | Always name stages explicitly |
| `python -m venv /opt/venv` | Isolates all deps in one copyable directory | `/opt/venv`, then prepend to `PATH` |
| `--mount=type=cache,target=/root/.cache/pip` | Persists pip's wheel cache across builds | Always, on the builder pip step |
| `--no-install-recommends` | Stops apt pulling in suggested extras | Always, both stages |
| `ARG GDAL_VERSION` | Pins the Python GDAL binding to the system `libgdal` | Match `libgdal-dev` version exactly |
| `libgdal-dev` (builder) vs `libgdal32` (runtime) | Compile-time headers vs runtime `.so` | Same major version from the same distro |
| `COPY --from=builder /opt/venv /opt/venv` | Moves the built stack into the slim image | The only artifact crossing the boundary |
| `COPY --chown=app:app` | Sets file ownership at copy time | Avoids a separate `chown` layer |

---

Layer ordering decides whether a one-line change rebuilds in seconds or minutes.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Rebuild time when one thing changes: a source file 9 s, a requirements pin 1 m 14 s, the base image digest 3 m 06 s, COPY . . placed too early 3 m 06 s — on every source edit" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Rebuild time when one thing changes</title>
  <desc>A horizontal bar chart. a source file is 9 s. a requirements pin is 1 m 14 s. the base image digest is 3 m 06 s. COPY . . placed too early is 3 m 06 s — on every source edit. The last row is a layer-ordering mistake, not a build-speed problem: copying source before installing dependencies busts the cache every time.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Rebuild time when one thing changes</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">a source file</text>
  <rect x="250" y="48" width="16" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="274" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">9 s</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">a requirements pin</text>
  <rect x="250" y="82" width="135" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="393" y="95" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">1 m 14 s</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">the base image digest</text>
  <rect x="250" y="116" width="340" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="598" y="129" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">3 m 06 s</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">COPY . . placed too early</text>
  <rect x="250" y="150" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="163" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">3 m 06 s — on every</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">The last row is a layer-ordering mistake, not a build-speed problem: copying source before installing dependencies busts the cache every</text>
</svg>

## Gotchas & failure modes

- **Missing runtime `.so` in the final stage.** The build succeeds, the image is small, and then `import rasterio` raises `ImportError: libgdal.so.32: cannot open shared object file`. The builder had `libgdal-dev` but the runtime stage forgot `libgdal32`. The `RUN python -c "import ..."` smoke test in the runtime stage turns this into a build failure instead of a 2am incident — never omit it.

- **GDAL version mismatch between build and runtime.** If the builder compiles the bindings against `libgdal-dev` 3.6 but the runtime stage installs a `libgdal32` from a different distro release (say 3.8), the import fails with `symbol lookup error` or a segfault on the first GDAL call. Keep both stages on the same base distribution (`python:3.12-slim`, both bookworm) so `apt` resolves the same GDAL major.

- **Layer cache invalidation from copying source too early.** Placing `COPY . .` before the `pip install` step means any code edit busts the dependency layer and recompiles the entire geospatial stack — minutes per build. Copy `requirements.txt` first, install, *then* copy the source. The parent guide, [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/), applies the same ordering to the single-stage image.

- **Copying `site-packages` instead of the venv.** Copying `/usr/local/lib/python3.12/site-packages` across stages misses console-script shims and `pyvenv.cfg`, so entry points like `uvicorn` are absent. Copy the whole `/opt/venv` and put it on `PATH`.

- **Root-owned venv breaking a non-root user.** If you `COPY --from=builder /opt/venv` and then switch to `USER app`, the app can still read the venv (world-readable by default), but a build step that writes into it as root followed by an app-time write will fail with `PermissionError`. Keep the venv read-only at runtime; never write into `/opt/venv` after the build.

---

## Verification

Prove the image is both smaller and complete. Size first, then `ldd` to confirm every compiled extension resolves its shared libraries inside the final image:

{% raw %}
```bash
# Build both variants and compare on-disk size.
docker build -t geo-api:multistage .
docker images geo-api --format '{{.Tag}}\t{{.Size}}'
# multistage   ~420MB     (vs ~640MB single-stage with build tooling)

# Resolve the .so dependencies of the compiled rasterio extension.
# Every line must show a real path — no "not found".
docker run --rm geo-api:multistage sh -c '
  SO=$(python -c "import rasterio._base, os; print(rasterio._base.__file__)")
  ldd "$SO"'
# ... libgdal.so.32 => /usr/lib/x86_64-linux-gnu/libgdal.so.32 (0x...)
# ... libproj.so.25 => /usr/lib/x86_64-linux-gnu/libproj.so.25 (0x...)

# Assert no unresolved symbols across the whole venv (exits non-zero on any).
docker run --rm geo-api:multistage sh -c '
  find /opt/venv -name "*.so" -exec ldd {} \; 2>/dev/null | grep "not found"' \
  && echo "MISSING LIBS" || echo "all shared libs resolved"
```
{% endraw %}

A `not found` in any `ldd` line is the multi-stage failure signature: a runtime `.so` the builder had but the runtime stage lacks. Add the missing `libXXX` package to the runtime stage and rebuild. Once this is clean, pin the image so the resolved versions never drift — see [Pinning PostGIS Versions in Production Images](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/).

---

## Related

- [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/) — base image choices, the compose stack, and PostGIS-aware healthchecks this build slots into
- [Pinning PostGIS Versions in Production Images](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/pinning-postgis-versions-in-production-images/) — lock the resolved library versions by tag and digest so builds stay reproducible
- [Deploying & Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/) — the delivery guide covering CI, migrations, and edge tile distribution

← Back to [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/)
