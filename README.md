# geospatial-api.com

**In-depth, production-focused guides to building geospatial REST APIs with [FastAPI](https://fastapi.tiangolo.com/) and [PostGIS](https://postgis.net/).**

🌐 **Live site: [www.geospatial-api.com](https://www.geospatial-api.com)**

---

## About

[geospatial-api.com](https://www.geospatial-api.com) is a free, deeply technical reference for the
engineers who build location-aware backends. Most geospatial tutorials stop at "here's a `SELECT
ST_Within(...)`." This site starts where those leave off and follows a spatial API all the way to
production — the architecture decisions, the failure modes, the benchmarks, and the copy-runnable
code that make the difference between a demo and a service that holds up under real traffic.

Every page is written for practitioners: a decision matrix or concept reference up front, then
numbered, runnable Python and SQL, then the gotchas with the exact error messages you'll actually
hit — and a hand-drawn architecture diagram for the hardest idea on the page.

### What it covers

The library spans **50+ guides** across five topic areas:

- **Core Architecture** — layered FastAPI + PostGIS design, geometry vs. geography, GiST indexing,
  spatial resource modelling, cursor-based pagination, GeoJSON vs. GeoParquet serialization, and
  API versioning that doesn't break clients.
- **Advanced Endpoints & Data Contracts** — strict Pydantic v2 geometry validation, bounding-box
  and KNN queries, OpenAPI schema generation for spatial types, async transaction patterns, and
  async bulk ingestion with Celery.
- **Caching & Query Optimization** — reading `EXPLAIN ANALYZE` for spatial plans, Redis caching for
  spatial queries, PgBouncer tuning, materialized views for aggregations, and vector-tile CDN delivery.
- **Security & Authentication** — JWT authentication with spatial scope claims, PostgreSQL
  row-level security for multi-tenant geometry isolation, and rate limiting for expensive
  geofence and tile endpoints.
- **Deployment & Operations** — containerizing PostGIS and FastAPI, CI/CD with real spatial
  integration tests, and edge routing for vector tiles at scale.

### Who it's for

Backend and full-stack engineers, GIS platform engineers, API architects, and SaaS founders who
are shipping spatial features on FastAPI and PostGIS and want depth, not hand-waving.

**👉 Read the guides at [www.geospatial-api.com](https://www.geospatial-api.com) — no signup, no paywall.**

---

## About this repository

This repo is the source of the site itself. It is a static site built with
[Eleventy](https://www.11ty.dev/) and served from a Cloudflare Worker (static assets).

### Structure

```
content/            Markdown guides (one index.md per page, nested by topic)
_includes/          Nunjucks layouts and partials
_data/              Global data (e.g. asset cache-busting)
assets/             CSS, JS, images
index.njk           Home page
eleventy.config.js  Build configuration
wrangler.jsonc      Cloudflare Worker (static-assets) configuration
```

### Develop

```bash
npm install
npm run dev      # local server with live reload at http://localhost:8080
npm run build    # production build to ./_site
```

### Deploy

The site is served by a Cloudflare Worker that serves the `_site` build output as static assets.

```bash
npm run deploy   # build + wrangler deploy
```

Deployment reads Cloudflare credentials from a local `.env` file
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) — do not commit it.

## License

Content and code © the site authors. All rights reserved unless stated otherwise.
