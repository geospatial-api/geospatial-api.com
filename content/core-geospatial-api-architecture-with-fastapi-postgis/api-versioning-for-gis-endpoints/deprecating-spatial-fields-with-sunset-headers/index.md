---
layout: layouts/page.njk
title: "Deprecating Spatial Fields with Sunset Headers"
description: "Retire a geometry field or a default projection without breaking clients: RFC 8594 Sunset and Deprecation headers, per-consumer usage tracking, and a removal date you can actually defend."
slug: deprecating-spatial-fields-with-sunset-headers
type: howto
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "API Versioning for GIS Endpoints"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/"
  - label: "Deprecating Spatial Fields with Sunset Headers"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/deprecating-spatial-fields-with-sunset-headers/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Deprecating Spatial Fields with Sunset Headers",
      "description": "Retire a geometry field or a default projection without breaking clients, using RFC 8594 Sunset and Deprecation headers plus per-consumer usage tracking.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/deprecating-spatial-fields-with-sunset-headers/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 2, "name": "API Versioning for GIS Endpoints", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/" },
        { "@type": "ListItem", "position": 3, "name": "Deprecating Spatial Fields with Sunset Headers", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/deprecating-spatial-fields-with-sunset-headers/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Deprecate a Spatial Response Field Safely",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Announce in the response", "text": "Send Deprecation and Sunset headers plus a Link to the migration note on every response that includes the field." },
        { "@type": "HowToStep", "position": 2, "name": "Count who still reads it", "text": "Track per-consumer usage of the deprecated field so the removal date is based on evidence rather than hope." },
        { "@type": "HowToStep", "position": 3, "name": "Rehearse the removal", "text": "Run scheduled brownouts before the sunset date so a surprised client discovers the change while someone is watching." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the difference between the Deprecation and Sunset headers?",
          "acceptedAnswer": { "@type": "Answer", "text": "Deprecation says the resource or field is discouraged from a given date; Sunset, defined by RFC 8594, says it will stop working at a specific date and time. Both are HTTP-date values. Send them together: Deprecation tells a client to start migrating and Sunset tells it exactly how long it has." }
        },
        {
          "@type": "Question",
          "name": "How can the API tell whether a client actually uses a field?",
          "acceptedAnswer": { "@type": "Answer", "text": "Not from the request, for a plain JSON response — the client receives the whole object either way. Two workable proxies exist: offer a fields or sparse-fieldset parameter and count who omits the deprecated field, or run scheduled brownouts and count who complains. The second is cruder and, in practice, the more reliable signal." }
        },
        {
          "@type": "Question",
          "name": "How long should a spatial deprecation window be?",
          "acceptedAnswer": { "@type": "Answer", "text": "Longer than for an ordinary field, because a coordinate change often means recalibrating something downstream — a map style, a stored geofence, a printed report. Six months is a reasonable floor for a projection or geometry-shape change; ninety days is enough for an added field or a renamed property that maps one to one." }
        }
      ]
    }
  ]
}
</script>

← Back to [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/)

# Deprecating spatial fields with Sunset headers

This page shows how to retire a field, a property name or a default projection from a spatial API using machine-readable deprecation signals, with a removal date supported by evidence rather than optimism.

## Context & When to Use

Spatial deprecations are heavier than ordinary ones. Removing a `bbox` property from a feature breaks any client that drew a rectangle from it. Changing the default output projection from 4326 to 3857 moves every coordinate by thousands of kilometres in a client that did not notice. Renaming `geom` to `geometry` looks trivial until you find a customer's stored procedure parsing the old key. The blast radius is larger than the diff suggests, and the affected code is frequently outside your organisation.

A full version bump is the heavyweight answer and is often disproportionate — see [Versioning Geospatial APIs Without Breaking Clients](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/versioning-geospatial-apis-without-breaking-clients/) for when it is warranted. For a single field, the lighter path is to keep serving it while announcing its end date in the response itself, so any client with logging sees the warning without anybody reading a changelog.

Use this whenever the change is additive-then-subtractive: a new field replaces an old one, both are served for a window, and the old one goes away on a date announced in advance. Do not use it for changes that alter the *meaning* of an existing field — silently changing what `distance` is measured in deserves a version bump, not a header.

## Runnable Implementation

```python
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response

router = APIRouter(prefix="/v1/features", tags=["features"])

# One place to declare every in-flight deprecation
DEPRECATIONS: dict[str, dict[str, Any]] = {
    "feature.bbox": {
        "deprecated_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
        "sunset_at":     datetime(2026, 11, 1, tzinfo=timezone.utc),
        "replacement":   "Compute from geometry, or request ?include=envelope",
        "docs":          "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/",
    },
}


def announce(response: Response, key: str) -> None:
    """Attach RFC 8594 Sunset plus a Deprecation header and a docs link."""
    spec = DEPRECATIONS[key]
    response.headers["Deprecation"] = format_datetime(spec["deprecated_at"], usegmt=True)
    response.headers["Sunset"] = format_datetime(spec["sunset_at"], usegmt=True)
    response.headers["Link"] = f'<{spec["docs"]}>; rel="deprecation"; type="text/html"'
    # A human-readable hint for anyone reading a raw response
    response.headers["Warning"] = (
        f'299 - "field {key} is deprecated; {spec["replacement"]}"'
    )


@router.get("")
async def list_features(
    request: Request,
    response: Response,
    include: Annotated[str | None, None] = None,
) -> dict[str, Any]:
    rows = await fetch_features(request)          # your existing query
    features = [_serialize(r) for r in rows]

    # Still serving the deprecated field — so still announcing it
    if any("bbox" in f for f in features):
        announce(response, "feature.bbox")
        await record_deprecated_use(request, "feature.bbox")

    return {"type": "FeatureCollection", "features": features}
```

The header set is deliberately redundant. `Sunset` is the machine-readable date, `Deprecation` marks when the clock started, `Link` points at the explanation, and `Warning` is the one a developer notices while poking at the API with curl.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline of a deprecation from announcement through brownouts to removal, with the headers sent at each stage" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Deprecation timeline for a spatial field</title>
  <desc>An eight-month timeline. At month zero the field is announced as deprecated and Deprecation, Sunset, Link and Warning headers begin appearing on every response. Months one to five are the migration window, during which per-consumer usage is tracked. At month six a one-hour brownout removes the field to surface any remaining consumers. At month seven a longer four-hour brownout runs. At month eight the field is removed permanently. A note records that the two brownouts are what convert silent dependence into a support ticket while there is still time.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Eight months from announcement to removal</text>
  <line x1="40" y1="118" x2="690" y2="118" stroke="currentColor" stroke-width="1.4"/>
  <circle cx="60" cy="118" r="6" fill="var(--accent, #7c3aed)"/>
  <text x="60" y="94" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">announce</text>
  <text x="60" y="146" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">m0</text>
  <rect x="70" y="106" width="360" height="24" rx="5" fill="var(--accent, #7c3aed)" fill-opacity="0.14" stroke="var(--accent, #7c3aed)" stroke-width="1.2"/>
  <text x="250" y="122" text-anchor="middle" font-size="10" fill="currentColor">headers on every response · usage tracked per consumer</text>
  <circle cx="450" cy="118" r="6" fill="var(--viz-warn, #8a5000)"/>
  <text x="450" y="94" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-warn, #8a5000)">brownout 1 h</text>
  <text x="450" y="146" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">m6</text>
  <circle cx="560" cy="118" r="6" fill="var(--viz-warn, #8a5000)"/>
  <text x="560" y="94" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-warn, #8a5000)">brownout 4 h</text>
  <text x="560" y="146" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">m7</text>
  <circle cx="670" cy="118" r="7" fill="var(--viz-bad, #a32b23)"/>
  <text x="668" y="94" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">removed</text>
  <text x="670" y="146" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">m8 · Sunset</text>
  <line x1="40" y1="170" x2="690" y2="170" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="194" font-size="10.5" fill="currentColor">Consumers still reading the field:</text>
  <rect x="250" y="182" width="180" height="14" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="438" y="194" font-size="9.5" fill="currentColor">14 at m0</text>
  <rect x="250" y="200" width="52" height="14" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="310" y="212" font-size="9.5" fill="currentColor">4 at m6 — brownout finds them</text>
  <rect x="250" y="218" width="10" height="14" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="268" y="230" font-size="9.5" fill="currentColor">0 at m8 — safe to remove</text>
</svg>

## Key Parameters & Options

| Header | Value | Purpose |
|---|---|---|
| `Deprecation` | HTTP-date | When the field became discouraged |
| `Sunset` | HTTP-date | When it stops working — the one clients automate against |
| `Link; rel="deprecation"` | docs URL | Where the migration is explained |
| `Warning: 299` | free text | Human-readable; visible in a raw curl |
| `?include=` | opt-in field list | Lets clients prove they no longer need the field |
| Brownout | 1 h, then 4 h | Converts silent dependence into a support ticket |

`Sunset` is the only one of these with a formal specification behind it, and it is the one worth getting exactly right: an HTTP-date in GMT, not an ISO 8601 timestamp, because clients parsing it will use an HTTP-date parser.

## Finding out who still depends on it

The hard part is not announcing the change — it is knowing when it is safe to make. For a plain JSON response you cannot see which keys a client reads, so the usage signal has to be constructed.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of four techniques for discovering which consumers depend on a deprecated field, rated by reliability and cost" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Four ways to find the remaining consumers</title>
  <desc>Four techniques rated on how reliably they find dependent consumers. Reading the changelog and waiting for replies finds almost nobody and costs nothing. An opt-in sparse-fieldset parameter finds those who actively migrate, about half, at low cost. Contacting known integrators directly finds most of the large ones but misses small automated consumers. A scheduled brownout finds essentially everyone still depending on the field, at the cost of a controlled hour of breakage. The chart argues for combining the sparse-fieldset signal with brownouts.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">How much of the dependent population each technique surfaces</text>
  <text x="20" y="62" font-size="10.5" fill="currentColor">changelog + hope</text>
  <rect x="230" y="48" width="34" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="274" y="62" font-size="10" fill="var(--viz-bad, #a32b23)">~7 %</text>
  <text x="20" y="102" font-size="10.5" fill="currentColor">sparse-fieldset opt-in</text>
  <rect x="230" y="88" width="220" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="460" y="102" font-size="10" fill="currentColor">~50 % — those actively migrating</text>
  <text x="20" y="142" font-size="10.5" fill="currentColor">contact known integrators</text>
  <rect x="230" y="128" width="290" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="530" y="142" font-size="10" fill="currentColor">~70 % — misses small clients</text>
  <text x="20" y="182" font-size="10.5" fill="currentColor">scheduled brownout</text>
  <rect x="230" y="168" width="410" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="650" y="182" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">~98 %</text>
  <text x="20" y="212" font-size="10.5" fill="var(--muted, #7c6fb0)">A brownout is a controlled outage of one field, announced in advance, during working hours, with someone</text>
  <text x="20" y="228" font-size="10.5" fill="var(--muted, #7c6fb0)">watching the support queue. That is a very different thing from finding out on the sunset date.</text>
</svg>

The brownout is worth the discomfort. Schedule it, announce it in the same headers, run it during business hours in your customers' time zones, and treat every ticket it generates as a success rather than an incident.

## Which changes a header can carry, and which need a version

Not every change is a candidate. The test is whether a client that ignores the announcement gets a *smaller* response or a *wrong* one. Smaller is survivable and belongs in a deprecation window; wrong is not, and belongs behind a version.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Classification of six API changes into those safe for a deprecation header and those requiring a version bump" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Deprecation header or version bump?</title>
  <desc>Six changes classified. Removing a redundant bbox property, renaming a property with both served during the window, and dropping an unused legacy format are all safe for a deprecation header because a client that ignores the warning loses data it can recompute. Changing the default output projection, changing the unit of a distance field, and changing coordinate axis order all require a version bump, because a client that ignores the warning receives plausible numbers that are wrong.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">The test: does ignoring the warning give less data, or wrong data?</text>
  <rect x="16" y="42" width="336" height="188" rx="9" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="34" y="66" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓ deprecation header is enough</text>
  <text x="34" y="90" font-size="10.5" fill="currentColor">remove a redundant <tspan font-family="monospace" font-size="10">bbox</tspan> property</text>
  <text x="46" y="106" font-size="9.5" fill="var(--muted, #7c6fb0)">client can recompute it from the geometry</text>
  <text x="34" y="132" font-size="10.5" fill="currentColor">rename a property, serve both meanwhile</text>
  <text x="46" y="148" font-size="9.5" fill="var(--muted, #7c6fb0)">old key present until the sunset date</text>
  <text x="34" y="174" font-size="10.5" fill="currentColor">drop an unused legacy output format</text>
  <text x="46" y="190" font-size="9.5" fill="var(--muted, #7c6fb0)">406 is a clear, debuggable failure</text>
  <text x="34" y="216" font-size="9.5" font-style="italic" fill="var(--viz-good, #1f6b3a)">worst case: a client gets less and notices</text>
  <rect x="368" y="42" width="336" height="188" rx="9" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.5"/>
  <text x="386" y="66" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕ needs a version bump</text>
  <text x="386" y="90" font-size="10.5" fill="currentColor">change the default output projection</text>
  <text x="398" y="106" font-size="9.5" fill="var(--muted, #7c6fb0)">coordinates move thousands of km, silently</text>
  <text x="386" y="132" font-size="10.5" fill="currentColor">change a distance field from m to km</text>
  <text x="398" y="148" font-size="9.5" fill="var(--muted, #7c6fb0)">every threshold downstream is now wrong</text>
  <text x="386" y="174" font-size="10.5" fill="currentColor">change coordinate axis order</text>
  <text x="398" y="190" font-size="9.5" fill="var(--muted, #7c6fb0)">valid-looking points in the wrong hemisphere</text>
  <text x="386" y="216" font-size="9.5" font-style="italic" fill="var(--viz-bad, #a32b23)">worst case: a client gets wrong data and does not notice</text>
</svg>

## Gotchas & Failure Modes

- **`Sunset` in ISO 8601 format.** RFC 8594 specifies an HTTP-date; a client using a strict parser silently ignores an ISO value and gets no warning at all.
- **Announcing on responses that do not contain the field.** Deprecation headers on every response, including ones where the field is absent, train clients to ignore them. Announce only when actually serving the deprecated thing.
- **A sunset date in the removal PR.** By then it is too late to be a warning. The date must be published at announcement time and must not move earlier.
- **Removing on the sunset date without a final check.** Run the usage report the morning of the removal. If a large consumer appeared last week, a two-week extension is cheaper than an incident.
- **Caches masking the headers.** A CDN that strips or does not vary on these headers hides the warning from everyone behind it. Verify the headers survive the edge — the caching behaviour in [Caching Vector Tiles at the Edge with Cache-Control](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/edge-routing-and-tile-delivery-at-scale/caching-vector-tiles-at-the-edge-with-cache-control/) applies to headers as well as bodies.
- **Deprecating a geometry field without a replacement path.** "Compute it yourself" is not a migration if the computation needs data the client does not have. Ship the replacement before starting the clock.

## Verification Snippet

```bash
# The headers must be present, correctly formatted, and consistent
curl -sD - -o /dev/null "https://api.example.com/v1/features?bbox=-0.2,51.4,0,51.6" \
  | grep -iE 'deprecation|sunset|link|warning'
# Deprecation: Sun, 01 Mar 2026 00:00:00 GMT
# Sunset: Sun, 01 Nov 2026 00:00:00 GMT
# Link: <https://www.geospatial-api.com/…/api-versioning-for-gis-endpoints/>; rel="deprecation"
# Warning: 299 - "field feature.bbox is deprecated; Compute from geometry, or request ?include=envelope"
```

```python
from email.utils import parsedate_to_datetime


def test_sunset_is_http_date_and_after_deprecation(client):
    r = client.get("/v1/features", params={"bbox": "-0.2,51.4,0,51.6"})
    dep = parsedate_to_datetime(r.headers["Deprecation"])
    sunset = parsedate_to_datetime(r.headers["Sunset"])
    assert sunset > dep
    # A meaningful window, not a formality
    assert (sunset - dep).days >= 90
```

---

## Related

- [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — when a header is not enough and a version bump is
- [Versioning Geospatial APIs Without Breaking Clients](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/versioning-geospatial-apis-without-breaking-clients/) — the heavyweight path
- [Coordinate Reference Systems & SRID Handling](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/) — why changing a default projection is a breaking change

← Back to [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/)
