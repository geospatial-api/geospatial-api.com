# geospatial-api.com

Source for [geospatial-api.com](https://www.geospatial-api.com) — a technical reference and
how-to site for building production geospatial APIs with **FastAPI** and **PostGIS**: spatial
data modelling, serialization, caching and query optimization, security and authentication,
and deployment.

It is a static site built with [Eleventy](https://www.11ty.dev/) and served from a
Cloudflare Worker (static assets).

## Structure

```
content/          Markdown guides (one index.md per page, nested by topic)
_includes/        Nunjucks layouts and partials
_data/            Global data (e.g. asset cache-busting)
assets/           CSS, JS, images
index.njk         Home page
eleventy.config.js  Build configuration
wrangler.jsonc    Cloudflare Worker (static-assets) configuration
```

## Develop

```bash
npm install
npm run dev      # local server with live reload at http://localhost:8080
npm run build    # production build to ./_site
```

## Deploy

The site is served by a Cloudflare Worker that serves the `_site` build output as static assets.

```bash
npm run deploy   # build + wrangler deploy
```

Deployment reads Cloudflare credentials from a local `.env` file
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) — do not commit it.

## License

Content and code © the site authors. All rights reserved unless stated otherwise.
