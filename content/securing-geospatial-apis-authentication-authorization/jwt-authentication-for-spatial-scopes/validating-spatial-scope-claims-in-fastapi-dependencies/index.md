---
layout: layouts/page.njk
title: "Validating Spatial Scope Claims in FastAPI Dependencies"
description: "A reusable FastAPI dependency that validates the requested geometry falls within a JWT's spatial scope, returns 403 otherwise, caches decoded claims per request, and composes with the auth dependency."
slug: "validating-spatial-scope-claims-in-fastapi-dependencies"
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "JWT Authentication for Spatial Scopes"
    url: "/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/"
  - label: "Validating Spatial Scope Claims in FastAPI Dependencies"
    url: "/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/validating-spatial-scope-claims-in-fastapi-dependencies/"
datePublished: "2026-05-06"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Validating Spatial Scope Claims in FastAPI Dependencies",
      "description": "A reusable FastAPI dependency that validates the requested geometry falls within a JWT's spatial scope, returns 403 otherwise, caches decoded claims per request, and composes with the auth dependency.",
      "datePublished": "2026-05-06",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/"},
        {"@type": "ListItem", "position": 2, "name": "JWT Authentication for Spatial Scopes", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/"},
        {"@type": "ListItem", "position": 3, "name": "Validating Spatial Scope Claims in FastAPI Dependencies", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/validating-spatial-scope-claims-in-fastapi-dependencies/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Validate a spatial scope claim inside a FastAPI dependency",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Decode and cache the JWT claims once per request on request.state."},
        {"@type": "HowToStep", "position": 2, "text": "Extract the geo_scope claim and normalise it to a comparison geometry."},
        {"@type": "HowToStep", "position": 3, "text": "Test the requested geometry against the scope with ST_Within before the data query."},
        {"@type": "HowToStep", "position": 4, "text": "Raise 403 on any out-of-scope, null, or unsupported claim; fail closed."}
      ]
    },
    {
      "@type": "Article",
      "headline": "Validating Spatial Scope Claims in FastAPI Dependencies",
      "datePublished": "2026-05-06",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/)

# Validating spatial scope claims in FastAPI dependencies

Build one reusable dependency that confirms a requested geometry or bounding box falls inside the token's spatial scope, returns `403` otherwise, and never verifies the same JWT twice in a single request.

## Context & when to use

The scope check belongs in a FastAPI dependency, not in each route handler, for one blunt reason: a check that lives in the handler is a check a future handler will forget. A dependency attaches to every route that declares it, runs *before* the handler body, and short-circuits the request with `403` if the requested area is out of bounds — so the expensive PostGIS read never runs for an unauthorised caller. This is the enforcement half of the pattern whose token design is covered in [JWT authentication for spatial scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/); here we focus purely on the FastAPI wiring: decode once, cache, compare, fail closed.

Use a dedicated scope dependency whenever more than one endpoint reads geometry, when the requested area arrives in different shapes (a bbox query, an uploaded polygon, a single point), or when the scope encoding might change — bbox today, [H3 cell set](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/encoding-geofence-boundaries-in-jwt-scope-claims/) tomorrow — and you want that swap to touch one function. Prefer a plain inline check only for a throwaway single-route service where reuse and composition buy you nothing.

---

## Dependency composition

The chain is four dependencies deep. Each layer does one thing and hands a narrower, validated value to the next; FastAPI resolves the graph and caches each dependency's result within the request.

<svg viewBox="0 0 720 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="FastAPI dependency chain for spatial scope validation" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Spatial scope dependency chain</title>
  <desc>Four stacked FastAPI dependencies flowing left to right. First, the OAuth2 bearer dependency extracts the token. Second, current_claims decodes and caches it on request.state. Third, spatial_scope extracts the geo_scope claim. Fourth, require_geometry_in_scope runs ST_Within and either passes the validated geometry to the route handler or raises 403.</desc>
  <rect x="0" y="0" width="720" height="300" rx="10" fill="var(--surface, #f5f3ff)"/>
  <!-- boxes -->
  <rect x="20" y="60" width="150" height="70" rx="8" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="95" y="90" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">oauth2</text>
  <text x="95" y="108" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">Bearer token</text>
  <rect x="200" y="60" width="150" height="70" rx="8" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="275" y="86" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">current_claims</text>
  <text x="275" y="103" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">decode once +</text>
  <text x="275" y="116" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">cache on state</text>
  <rect x="380" y="60" width="150" height="70" rx="8" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="455" y="86" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">spatial_scope</text>
  <text x="455" y="103" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">parse geo_scope</text>
  <text x="455" y="116" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">→ geometry</text>
  <rect x="560" y="60" width="140" height="70" rx="8" fill="var(--accent, #7c3aed)" opacity="0.22" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="630" y="86" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">require_in_scope</text>
  <text x="630" y="103" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">ST_Within gate</text>
  <text x="630" y="116" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">pass / 403</text>
  <!-- flow arrows -->
  <line x1="170" y1="95" x2="200" y2="95" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="350" y1="95" x2="380" y2="95" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="530" y1="95" x2="560" y2="95" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
  <!-- outcomes -->
  <rect x="480" y="200" width="120" height="40" rx="6" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="540" y="224" text-anchor="middle" font-size="11" font-weight="600" fill="#065f46">200 handler</text>
  <rect x="620" y="200" width="80" height="40" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="660" y="224" text-anchor="middle" font-size="11" font-weight="600" fill="#991b1b">403</text>
  <line x1="615" y1="130" x2="555" y2="200" stroke="#10b981" stroke-width="1.5" marker-end="url(#g)"/>
  <line x1="645" y1="130" x2="660" y2="200" stroke="#dc2626" stroke-width="1.5" marker-end="url(#r)"/>
  <defs>
    <marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/></marker>
    <marker id="g" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#10b981"/></marker>
    <marker id="r" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
</svg>

---

## Runnable implementation

One module with the full chain. `current_claims` verifies and memoises; `require_geometry_in_scope` is a dependency *factory* so the same logic guards a bbox route, a point route, or a polygon upload.

```python
# app/security/scope_dep.py
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
import jwt
from jwt import ExpiredSignatureError, InvalidTokenError

from app.dependencies import get_db

oauth2 = OAuth2PasswordBearer(tokenUrl="token")
PUBLIC_KEY = open("jwt-public.pem").read()


async def current_claims(request: Request, token: str = Depends(oauth2)) -> dict:
    """Decode the JWT exactly once; reuse the result for every dependency
    in the same request via request.state (FastAPI also caches the dependency,
    but state makes the intent explicit and survives sub-dependency reuse)."""
    if (cached := getattr(request.state, "claims", None)) is not None:
        return cached
    try:
        claims = jwt.decode(
            token, PUBLIC_KEY,
            algorithms=["RS256"],                     # pinned; never "none"
            audience="geospatial-api",
            issuer="https://auth.geospatial-api.com",
            options={"require": ["exp", "iss", "aud", "sub"]},
            leeway=10,
        )
    except ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired")
    except InvalidTokenError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {exc}")
    request.state.claims = claims
    return claims


def _scope_to_geometry_sql(claim: dict) -> tuple[str, dict]:
    """Return an SQL fragment producing the scope geometry + its bind params.
    Supports bbox and WKT-ref today; extend the dispatch for h3/geohash."""
    if not claim:                                      # null / missing => fail closed
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No spatial scope on token")
    enc, srid = claim.get("encoding"), int(claim.get("srid", 4326))
    if enc == "bbox":
        # union of envelopes -> one MultiPolygon scope geometry
        regions = claim["regions"]
        parts = ",".join(
            f"ST_MakeEnvelope({b[0]},{b[1]},{b[2]},{b[3]},{srid})" for b in regions
        )
        return f"ST_Collect(ARRAY[{parts}])", {}
    if enc == "wkt":
        return "ST_GeomFromText(:scope_wkt, :srid)", {
            "scope_wkt": claim["regions"][0], "srid": srid}
    raise HTTPException(status.HTTP_403_FORBIDDEN, f"Unsupported encoding: {enc}")


def require_geometry_in_scope(request_geom_sql: str):
    """Dependency factory. `request_geom_sql` is an SQL expression (using bind
    params supplied by the route) that yields the requested geometry."""
    async def _dep(
        claims: dict = Depends(current_claims),
        db: AsyncSession = Depends(get_db),
        request: Request = None,
    ):
        scope_sql, scope_params = _scope_to_geometry_sql(claims.get("geo_scope"))
        # bbox binds come from the route via request.query_params
        qp = dict(request.query_params)
        params = {**scope_params,
                  **{k: float(qp[k]) for k in ("minx", "miny", "maxx", "maxy")
                     if k in qp}}
        row = await db.execute(text(f"""
            SELECT ST_Within(({request_geom_sql}), ({scope_sql})) AS ok
        """), params)
        if not row.scalar():
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Requested geometry is outside your authorised spatial scope.",
            )
    return _dep


# --- usage: guard a bbox route ------------------------------------------------
from fastapi import FastAPI, Query
app = FastAPI()

bbox_in_scope = require_geometry_in_scope(
    "ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)"
)

@app.get("/features/bbox", dependencies=[Depends(bbox_in_scope)])
async def features_in_bbox(
    minx: float = Query(...), miny: float = Query(...),
    maxx: float = Query(...), maxy: float = Query(...),
    db: AsyncSession = Depends(get_db),
):
    # Reaches here only if the bbox passed the scope gate.
    result = await db.execute(text("""
        SELECT id, ST_AsGeoJSON(geom)::jsonb AS geometry
        FROM spatial_features
        WHERE geom && ST_MakeEnvelope(:minx,:miny,:maxx,:maxy,4326)
          AND ST_Intersects(geom, ST_MakeEnvelope(:minx,:miny,:maxx,:maxy,4326))
        ORDER BY id LIMIT 200
    """), {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy})
    return {"type": "FeatureCollection",
            "features": [{"type": "Feature", "id": r.id, "geometry": r.geometry}
                         for r in result.mappings().all()]}
```

The gate uses the same GiST-friendly [bounding-box query mechanics](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) as the data route — `ST_Within` for full containment. Swap it for `ST_Intersects` if a partly-overlapping request should be allowed.

---

A scope dependency is a sequence of increasingly expensive checks, ordered so the cheapest refusal happens first.

<svg viewBox="0 0 720 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Order of checks in the dependency: signature then claims then coarse scope then fine scope" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Order of checks in the dependency</title>
  <desc>A left to right pipeline. Stage 1, signature: algorithms pinned reject alg=none. Stage 2, claims: exp · aud · iss cheap, no I/O. Stage 3, coarse scope: bbox vs scope bbox rejects before the query. Stage 4, fine scope: ST_Within in SQL per row, backstopped by RLS. Each step is cheaper than the one after it, so the order is not stylistic — it is what keeps rejection cost near zero.</desc>
  <rect x="0" y="0" width="720" height="210" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Order of checks in the dependency</text>
  <rect x="18" y="52" width="154" height="86" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="95" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">signature</text>
  <text x="95" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">algorithms pinned</text>
  <text x="95" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">reject alg=none</text>
  <path d="M175 95 L189 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arorderofche)"/>
  <rect x="194" y="52" width="154" height="86" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="271" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">claims</text>
  <text x="271" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">exp · aud · iss</text>
  <text x="271" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">cheap, no I/O</text>
  <path d="M351 95 L365 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arorderofche)"/>
  <rect x="370" y="52" width="154" height="86" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="447" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">coarse scope</text>
  <text x="447" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">bbox vs scope bbox</text>
  <text x="447" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">rejects before the query</text>
  <path d="M527 95 L541 95" stroke="currentColor" stroke-width="1.4" marker-end="url(#arorderofche)"/>
  <rect x="546" y="52" width="154" height="86" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="623" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">fine scope</text>
  <text x="623" y="98" text-anchor="middle" font-size="9.5" fill="currentColor">ST_Within in SQL</text>
  <text x="623" y="116" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">per row, backstopped by RLS</text>
  <text x="20" y="168" font-size="10.5" fill="var(--muted, #7c6fb0)">Each step is cheaper than the one after it, so the order is not stylistic — it is what keeps rejection cost near zero.</text>
  <defs><marker id="arorderofche" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker></defs>
</svg>

## Key parameters & options

| Knob | Effect | Recommended |
|---|---|---|
| `request.state.claims` cache | One signature verification per request | Always; RS256 verify is ~0.3 ms, don't repeat it |
| `ST_Within` vs `ST_Intersects` | Full containment vs any overlap | `ST_Within` for scoping; `ST_Intersects` only if partial access is intended |
| `leeway=10` | Clock-skew tolerance on `exp`/`nbf` | 5–30 s; never large enough to meaningfully extend a token |
| `options={"require": [...]}` | Reject tokens missing critical claims | Require `exp`, `iss`, `aud`, `sub` at minimum |
| Dependency factory arg | Reuse the gate for point/bbox/polygon routes | Pass the request-geometry SQL per route |
| Fail-closed on `null` scope | Missing `geo_scope` → 403 | Mandatory; never default to unbounded access |

---

Four enforcement points, and only the last one survives an application bug.

<svg viewBox="0 0 720 234" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Where the scope check can be enforced: Bypassable, Cheap" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where the scope check can be enforced</title>
  <desc>A comparison table. client-side only: Bypassable yes, Cheap yes. not a control at all FastAPI dependency: Bypassable partly, Cheap yes. an application bug bypasses it SQL predicate per query: Bypassable partly, Cheap yes. a forgotten WHERE bypasses it row-level security: Bypassable no, Cheap partly. cannot be bypassed from the app The dependency is for fast, clear rejection; RLS is for the guarantee. Neither replaces the other.</desc>
  <rect x="0" y="0" width="720" height="234" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Where the scope check can be enforced</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Bypassable</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Cheap</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">client-side only</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">not a control at all</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">FastAPI dependency</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">an application bug bypasses it</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">SQL predicate per query</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">a forgotten WHERE bypasses it</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">row-level security</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="460" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">cannot be bypassed from the app</text>
  <text x="20" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">The dependency is for fast, clear rejection; RLS is for the guarantee. Neither replaces the other.</text>
</svg>

## Gotchas & failure modes

- **Checking scope *after* the DB query.** The single worst mistake: fetching features and filtering by scope in Python. An out-of-scope request still runs the full query, holds a connection, and may leak result size via timing. The gate must be a dependency that runs before the handler body — as above — so an unauthorised bbox never reaches `spatial_features`.
- **`geo_scope` of `null` silently allowing everything.** If `_scope_to_geometry_sql` returned an unbounded geometry for a missing claim, every token would read the whole planet. Fail closed: `null` or missing → `403`. Add a test that a stripped-scope token is rejected.
- **`ExpiredSignatureError` from a naive `exp`.** `exp` is a UTC epoch. An issuer that builds it from `datetime.now()` (local, naive) produces tokens that expire hours early or late depending on the server's timezone. Mint from `datetime.now(UTC)` and keep `leeway` small; a large leeway is not a fix for a timezone bug.
- **`ERROR: Operation on mixed SRID geometries`.** The scope claim's `srid` differs from the requested geometry's SRID. Normalise both to one SRID inside `_scope_to_geometry_sql` (reproject the scope with `ST_Transform`) rather than letting the mismatch reach `ST_Within`.
- **Dependency cache assumptions across background tasks.** `request.state` lives for the request only. If you enqueue a background task that re-checks scope, re-decode there — the cached claims object is not available once the response is sent.

---

One further habit is worth adopting: log the reason a scope check refused, not merely that it did. "Outside scope" and "scope claim missing" are different bugs on the client side, and distinguishing them in the response turns an integration problem into a five-minute fix.

One further habit is worth adopting: log the reason a scope check refused, not merely that it did. "Outside scope" and "scope claim missing" are different bugs on the client side, and distinguishing them in the response turns an integration problem into a five-minute fix.

## Verification

```bash
# In-scope bbox → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/features/bbox?minx=-2.6&miny=51.35&maxx=-2.4&maxy=51.45"
# → 200

# Out-of-scope bbox → 403
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/features/bbox?minx=-0.2&miny=51.45&maxx=0.0&maxy=51.55"
# → 403
```

```python
# assert the scope gate runs before the handler and fails closed on null scope
import pytest
from httpx import AsyncClient, ASGITransport
from app.security.scope_dep import app

@pytest.mark.asyncio
async def test_null_scope_is_forbidden(token_without_geo_scope):
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://t") as c:
        r = await c.get("/features/bbox",
                        params={"minx": 0, "miny": 0, "maxx": 1, "maxy": 1},
                        headers={"Authorization": f"Bearer {token_without_geo_scope}"})
    assert r.status_code == 403
```

---

## Related

- [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) — the parent guide covering token signing, RS256 verification, and the scope-encoding decision matrix
- [Encoding Geofence Boundaries in JWT Scope Claims](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/encoding-geofence-boundaries-in-jwt-scope-claims/) — how the `geo_scope` regions this dependency parses are built compactly
- [Bounding-Box Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — the `ST_Within` / `ST_Intersects` index pattern the scope gate reuses

← Back to [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/)
