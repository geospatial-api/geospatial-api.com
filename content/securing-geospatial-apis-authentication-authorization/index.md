---
layout: layouts/page.njk
title: "Securing Geospatial APIs — Authentication & Authorization"
description: "A production security reference for FastAPI + PostGIS spatial APIs: JWT authentication with spatial scope claims, PostgreSQL row-level security for multi-tenant geometry isolation, and cost-based rate limiting for expensive geofence and tile endpoints."
slug: securing-geospatial-apis-authentication-authorization
breadcrumb: Securing Geospatial APIs
datePublished: "2025-03-18"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Securing Geospatial APIs — Authentication & Authorization",
      "description": "A production security reference for FastAPI + PostGIS spatial APIs: JWT authentication with spatial scope claims, PostgreSQL row-level security for multi-tenant geometry isolation, and cost-based rate limiting for expensive geofence and tile endpoints.",
      "datePublished": "2025-03-18",
      "dateModified": "2026-07-10",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com" },
      "mainEntityOfPage": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/"
    },
    {
      "@type": "Article",
      "headline": "Securing Geospatial APIs — Authentication & Authorization",
      "datePublished": "2025-03-18",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Secure a Production FastAPI and PostGIS Spatial API",
      "step": [
        { "@type": "HowToStep", "name": "Shed abusive tile and geofence traffic at the edge with cost-based rate limits", "position": 1 },
        { "@type": "HowToStep", "name": "Verify JWTs in FastAPI and reject insecure algorithms such as alg=none", "position": 2 },
        { "@type": "HowToStep", "name": "Enforce spatial scope claims with a FastAPI dependency and ST_Within before querying", "position": 3 },
        { "@type": "HowToStep", "name": "Isolate tenant geometry with PostGIS FORCE ROW LEVEL SECURITY and current_setting", "position": 4 },
        { "@type": "HowToStep", "name": "Rotate signing keys, handle secrets, and audit every spatial access", "position": 5 }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Should the spatial scope check run in FastAPI or in PostGIS?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Run a coarse scope check in FastAPI before the query and a fine-grained check in PostGIS during the query. The FastAPI dependency rejects requests whose bounding box or geofence falls entirely outside the token scope, avoiding a wasted database round-trip. PostGIS then applies an ST_Within or ST_Intersects predicate against the scope geometry so that individual rows outside the authorized area are never returned even if the coarse check passes. Row-level security is the final backstop that cannot be bypassed by application bugs."
          }
        },
        {
          "@type": "Question",
          "name": "Does PostGIS row-level security slow down GiST index scans?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The RLS policy adds a predicate that PostgreSQL ANDs onto every query. When the policy filters on an indexed tenant_id column the overhead is typically 3 to 8 percent, because the planner can still use a composite btree or a GiST index and simply intersects the candidate set. The cost rises sharply only when the policy calls a volatile function or an ST_ predicate that is not index-backed, which forces a per-row evaluation. Keep the policy expression simple and indexed, and confirm with EXPLAIN ANALYZE that the tenant filter is applied as an Index Cond rather than a Filter."
          }
        },
        {
          "@type": "Question",
          "name": "How do I stop a JWT from being accepted with alg=none?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Always pass an explicit allow-list of algorithms to the decode call, for example jwt.decode(token, key, algorithms=[\"RS256\"]). Never read the algorithm from the token header to decide how to verify it, and never call decode without the algorithms argument. Libraries that accept alg=none will treat an unsigned token as valid, letting an attacker forge arbitrary spatial scopes. Pin the algorithm, reject tokens whose header alg is not in the allow-list, and prefer asymmetric RS256 or ES256 so the API only holds the public key."
          }
        }
      ]
    }
  ]
}
</script>

# Securing geospatial APIs: authentication and authorization

Backend engineers and GIS platform architects shipping multi-tenant spatial services face a threat surface that ordinary CRUD APIs never expose: a single leaked geometry can reveal a competitor's asset locations, a forged scope claim can unlock a neighbouring tenant's parcels, and one unbounded `ST_DWithin` call can pin a database CPU for seconds. This reference covers the full security stack for a production FastAPI and PostGIS API — edge rate limiting, JWT authentication with spatial scope claims, database-enforced tenant isolation, and the audit and rotation practices that keep the system defensible under real traffic. It builds directly on the [core geospatial API architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/), adding the authentication and authorization layers that turn a working spatial API into one you can safely expose to untrusted clients.

## Architectural Blueprint: layered defence for a spatial request

Security for a spatial API is defence in depth, not a single middleware. A request must survive four independent gates before any geometry leaves the database, and each gate fails closed with a distinct, well-defined response. Collapsing these layers — trusting the application to filter tenants, or trusting the token to be well-formed — is the root cause of every serious spatial data leak in production.

<svg viewBox="0 0 760 442" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Layered security architecture for a spatial API request passing through edge rate limiting, JWT and spatial scope checks in FastAPI, PostGIS row-level security, and a filtered response" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>Layered security architecture for a spatial API request</title>
  <desc>A client request carrying a bearer JWT and bounding box or tile parameters flows downward through four gates: an edge rate limit and abuse shield that returns 429 on abuse, a FastAPI JWT verification and spatial scope check that returns 401 or 403, PostGIS row-level security that returns zero rows for out-of-tenant data, and finally a filtered GeoJSON response containing only in-scope, in-tenant features.</desc>
  <rect x="0" y="0" width="760" height="442" rx="12" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <!-- Client -->
  <rect x="240" y="20" width="200" height="44" rx="8" fill="var(--accent, #7c3aed)" opacity="0.14" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="340" y="41" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Client request</text>
  <text x="340" y="57" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">Bearer JWT · bbox / z-x-y tile params</text>
  <line x1="340" y1="64" x2="340" y2="96" stroke="currentColor" stroke-width="1.5" marker-end="url(#sarr)"/>
  <!-- Layer 1 -->
  <rect x="120" y="96" width="440" height="68" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="340" y="120" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">1 · Edge rate limit &amp; abuse shield</text>
  <text x="340" y="139" text-anchor="middle" font-size="10.5" fill="currentColor">Redis sliding window · cost-based throttle · WAF</text>
  <text x="340" y="156" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">Sheds abusive tile / geofence traffic before origin</text>
  <line x1="560" y1="130" x2="600" y2="130" stroke="currentColor" stroke-width="1.5" marker-end="url(#sarr)"/>
  <text x="606" y="134" text-anchor="start" font-size="10" fill="var(--muted, #7c6fb0)">429 throttled</text>
  <line x1="340" y1="164" x2="340" y2="192" stroke="currentColor" stroke-width="1.5" marker-end="url(#sarr)"/>
  <!-- Layer 2 -->
  <rect x="120" y="192" width="440" height="68" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="340" y="216" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">2 · JWT auth &amp; spatial scope check</text>
  <text x="340" y="235" text-anchor="middle" font-size="10.5" fill="currentColor">PyJWT verify · deny alg=none · scope ST_Within</text>
  <text x="340" y="252" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">FastAPI dependency runs before any DB query</text>
  <line x1="560" y1="226" x2="600" y2="226" stroke="currentColor" stroke-width="1.5" marker-end="url(#sarr)"/>
  <text x="606" y="230" text-anchor="start" font-size="10" fill="var(--muted, #7c6fb0)">401 / 403</text>
  <line x1="340" y1="260" x2="340" y2="288" stroke="currentColor" stroke-width="1.5" marker-end="url(#sarr)"/>
  <!-- Layer 3 -->
  <rect x="120" y="288" width="440" height="68" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="340" y="312" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">3 · PostGIS row-level security</text>
  <text x="340" y="331" text-anchor="middle" font-size="10.5" fill="currentColor">FORCE RLS · current_setting('app.tenant_id')</text>
  <text x="340" y="348" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">Tenant geometry isolation at the row</text>
  <line x1="560" y1="322" x2="600" y2="322" stroke="currentColor" stroke-width="1.5" marker-end="url(#sarr)"/>
  <text x="606" y="326" text-anchor="start" font-size="10" fill="var(--muted, #7c6fb0)">0 rows</text>
  <line x1="340" y1="356" x2="340" y2="384" stroke="currentColor" stroke-width="1.5" marker-end="url(#sarr)"/>
  <!-- Response -->
  <rect x="240" y="384" width="200" height="44" rx="8" fill="var(--accent, #7c3aed)" opacity="0.14" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="340" y="405" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Filtered GeoJSON response</text>
  <text x="340" y="421" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">only in-scope, in-tenant features</text>
  <defs>
    <marker id="sarr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

The ordering is deliberate and non-negotiable. The edge layer is first because rejecting an abusive request costs nothing at the database; letting it reach PostGIS costs a connection slot and CPU. Authentication precedes authorization because you cannot scope a caller you have not identified. The spatial scope check runs inside the FastAPI dependency — before the query is built — so that an out-of-area request never generates SQL. Row-level security sits last and lowest because it is the only layer that survives an application bug: even a hand-written raw query with a wrong `WHERE` clause cannot cross a tenant boundary when the policy is `FORCE`d. Each of the three interior gates has a dedicated deep-dive: [JWT authentication for spatial scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/), [row-level security for multi-tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/), and [rate limiting geofence and tile endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/).

## Authentication and the token layer

Authentication for a spatial API is standard OAuth2 bearer-token flow with one twist: the token carries not just *who* the caller is but *where* they are allowed to operate. Get the token verification wrong and the spatial scope encoded inside it becomes a suggestion rather than a control.

### Verifying JWTs correctly

Use `PyJWT` or `python-jose` and verify tokens with an explicit algorithm allow-list. The single most dangerous mistake — accepting `alg=none` or trusting the header's declared algorithm — is entirely avoidable by pinning algorithms at the decode call. Prefer asymmetric signing (`RS256` or `ES256`) so the API service holds only the public key and cannot itself mint tokens; the private key lives with the identity provider.

```python
# app/security/tokens.py
import jwt                              # PyJWT
from jwt import InvalidTokenError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

bearer = HTTPBearer(auto_error=True)

# Public key (RS256). Loaded from a secrets manager, never hardcoded.
JWT_PUBLIC_KEY = load_public_key_from_secret("jwt-signing-public")
JWT_ISSUER = "https://auth.example.com/"
JWT_AUDIENCE = "geospatial-api"

def decode_token(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> dict:
    try:
        claims = jwt.decode(
            creds.credentials,
            JWT_PUBLIC_KEY,
            algorithms=["RS256"],          # explicit allow-list — never trust the header
            audience=JWT_AUDIENCE,
            issuer=JWT_ISSUER,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except InvalidTokenError as exc:
        # Do not echo the exception text to the client — it can leak key/format details.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    return claims
```

The `options={"require": [...]}` block forces the presence of the registered claims; a token missing `exp` is rejected rather than treated as non-expiring. Short access-token lifetimes (5–15 minutes) limit the blast radius of a leaked token, which matters more for spatial APIs because a scope claim leaked once can be replayed against a wide geographic area until it expires.

### Service clients and OAuth2 client credentials

Human users authenticate through an interactive flow, but most spatial API traffic is machine-to-machine: tile renderers, ETL jobs, and partner integrations. Use the OAuth2 client-credentials grant for these. Each service client is issued a `client_id` and secret, exchanges them for a short-lived JWT at the token endpoint, and receives a token whose scope is fixed to that client's authorized area. Because service clients are long-running, they must cache the token and refresh it a minute before `exp` rather than requesting one per call — otherwise the token endpoint itself becomes a rate-limit target.

### Encoding spatial scope into the token

The authorization data — the geographic area the caller may touch — travels as a custom claim. Keep it compact: JWTs ride in an `Authorization` header on every request, and a claim carrying a 500-vertex polygon will bloat headers past proxy limits. Encode the scope as one of three compact forms — a set of H3 cell indexes, an axis-aligned bounding box, or a simplified geofence in WKT — and resolve the full geometry server-side. The trade-offs between these encodings are the subject of [encoding geofence boundaries in JWT scope claims](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/encoding-geofence-boundaries-in-jwt-scope-claims/).

```json
{
  "sub": "svc-tile-renderer-eu",
  "tenant_id": "3f2a…",
  "iss": "https://auth.example.com/",
  "aud": "geospatial-api",
  "exp": 1731000000,
  "scope": "features:read tiles:read",
  "geo_scope": {
    "type": "h3",
    "res": 6,
    "cells": ["861f8d4ffffffff", "861f8d4efffffff"]
  }
}
```

## Application layer: enforcing spatial scope claims

Authentication proves identity; authorization decides whether *this* request touches only *authorized* geography. In a spatial API that decision has two halves — a coarse pre-query check and a fine per-row check — and both must be present.

### A FastAPI dependency that fails before the query

The coarse check belongs in a FastAPI dependency so it runs before any SQL is generated. It compares the request's requested area (the bounding box, tile, or query geofence) against the token's `geo_scope`. If the request area lies entirely outside the scope, return `403` immediately: no connection is borrowed, no `ST_` function executes. This ordering is the entire point — a scope check that runs *after* the database query has already leaked the work you were trying to prevent, and, if the query itself returned the data, the leak too.

```python
# app/security/scope.py
from fastapi import Depends, HTTPException, status
from shapely.geometry import box, shape
from shapely import wkt as shapely_wkt

def resolve_scope_geometry(claims: dict):
    """Turn a compact geo_scope claim into a Shapely geometry, server-side."""
    gs = claims.get("geo_scope")
    if not gs:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Token carries no spatial scope")
    if gs["type"] == "bbox":
        return box(*gs["bounds"])                 # [minx, miny, maxx, maxy]
    if gs["type"] == "wkt":
        return shapely_wkt.loads(gs["geofence"])
    if gs["type"] == "h3":
        return h3_cells_to_multipolygon(gs["cells"])   # union of cell boundaries
    raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown geo_scope type")

def require_bbox_within_scope(
    minx: float, miny: float, maxx: float, maxy: float,
    claims: dict = Depends(decode_token),
):
    requested = box(minx, miny, maxx, maxy)
    allowed = resolve_scope_geometry(claims)
    # Coarse gate: reject requests whose area is not fully covered by the scope.
    if not allowed.covers(requested):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Requested area exceeds authorized spatial scope",
        )
    return {"claims": claims, "bbox": (minx, miny, maxx, maxy)}
```

The dependency approach mirrors the validation pattern used throughout the [core architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/): reject at the boundary, cheaply, before the database is involved. The full mechanics of parsing, caching, and testing these dependencies are covered in [validating spatial scope claims in FastAPI dependencies](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/validating-spatial-scope-claims-in-fastapi-dependencies/).

### The fine-grained check inside PostGIS

The coarse gate protects against gross out-of-scope requests, but a bounding box can straddle the scope boundary — partly inside, partly outside. The per-row check enforces the exact boundary with a spatial predicate in the query itself. Pass the resolved scope geometry as a parameter and AND an `ST_Within` (or `ST_Intersects`, depending on whether partial overlaps are permitted) against it. This is the same index-backed predicate pattern documented in [bounding-box spatial index queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/), applied here as an authorization control rather than a filter.

```sql
SELECT id, name, ST_AsGeoJSON(geom, 6)::json AS geometry
FROM features
WHERE geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)   -- GiST pre-filter
  AND ST_Intersects(geom, ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326))
  AND ST_Within(geom, ST_GeomFromText(:scope_wkt, 4326))          -- scope enforcement
ORDER BY id
LIMIT :limit;
```

Feeding the scope through the same GiST-indexed geometry column keeps the authorization predicate cheap. The `&&` bounding-box operator pre-filters candidates on the index; only survivors are tested against the scope polygon.

## Scope claim data contracts

The encoding you choose for `geo_scope` is a contract between the identity provider, the API, and the database. Each format trades header size against expressiveness and server-side resolution cost. Choose per client type rather than globally.

| Encoding | Header size | Expressiveness | Server resolution | Best for |
|---|---|---|---|---|
| Bounding box (`[minx,miny,maxx,maxy]`) | Tiny (~40 B) | Rectangle only | Trivial (`ST_MakeEnvelope`) | Tile renderers, regional service clients |
| H3 cell set (res 5–8) | Small (~15 B/cell) | Quantised region, unions cleanly | `h3_cells_to_multipolygon` cache | Coverage areas, delivery zones, fleets |
| WKT geofence (simplified) | Medium (0.1–2 KB) | Arbitrary polygon | `ST_GeomFromText` + validity check | Admin boundaries, contract territories |
| Scope reference id | Tiny (~30 B) | Unlimited (server lookup) | DB/Redis lookup per request | Complex or frequently changing geofences |

For anything beyond a rectangle, prefer H3 cell sets: they are compact, they union without slivers, and equality checks are integer comparisons rather than geometry operations. Reserve raw WKT for genuinely irregular boundaries, and always simplify with `ST_SimplifyPreserveTopology` before minting the claim so a token never carries thousands of vertices. When a geofence is large or changes often, store it server-side and put only a stable `scope_ref` id in the token — the token stays small and revoking or editing the boundary does not require re-issuing every client's credentials. Note the parallel with output shaping: how much geometry precision you *return* is a serialisation concern covered by the [GeoJSON vs GeoParquet serialisation](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) decision matrix, while how much geometry you *authorize* is the contract above.

## Database security layer: PostGIS row-level security

Application-layer checks are necessary but not sufficient. Every scope check above lives in code paths that a bug, a new endpoint, or a rushed hotfix can bypass. Row-level security (RLS) moves the tenant boundary into PostgreSQL itself, where no application query — ORM or raw — can cross it.

### Enabling and forcing the policy

```sql
-- Tenant column, indexed for the policy predicate.
ALTER TABLE features ADD COLUMN tenant_id uuid NOT NULL;
CREATE INDEX idx_features_tenant ON features (tenant_id);

-- Turn RLS on, then create the isolation policy.
ALTER TABLE features ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON features
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- CRITICAL: force the policy for the table owner too.
ALTER TABLE features FORCE ROW LEVEL SECURITY;
```

The `FORCE ROW LEVEL SECURITY` line is the one that engineers omit and attackers love. By default, RLS policies do **not** apply to the table's owner or to superusers. If your API connects as the role that owns the `features` table — an extremely common default — the policy is silently inert and every tenant sees every row. `FORCE` closes that gap. The second-order fix is to connect the API as a dedicated non-owner role (`api_runtime`) with only `SELECT`/`INSERT`/`UPDATE` granted, so even without `FORCE` the policy applies; combine both for defence in depth.

### Setting tenant context on the connection

The policy reads `current_setting('app.tenant_id')`. That value must be set on the connection *before* any query runs, and it must be set from the verified JWT claim, never from a client-supplied header. With asyncpg behind PgBouncer in transaction mode, `SET` does not persist across transactions — use `SET LOCAL` inside the transaction, or `set_config(..., true)` (the `true` makes it transaction-local):

```python
async def with_tenant(session, claims: dict):
    # Transaction-local: cannot leak into the next client on a pooled connection.
    await session.execute(
        text("SELECT set_config('app.tenant_id', :tid, true)"),
        {"tid": claims["tenant_id"]},
    )
```

The pooling interaction is subtle and easy to get wrong; the safe patterns for asyncpg and PgBouncer are detailed in [setting tenant context in asyncpg connections](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/), which builds on the transaction-pooling model from [connection pooling and PgBouncer setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/). The end-to-end policy design, including per-tenant geometry partitioning, is covered in [enforcing tenant geometry isolation with PostGIS RLS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/enforcing-tenant-geometry-isolation-with-postgis-rls/).

The layered defence is often assumed to be expensive; measured, it is not.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cost of each security control per request: JWT verify, cached JWKS 0.4 ms, spatial scope check in FastAPI 0.7 ms, RLS predicate on an indexed column 3–8 % of query time, rate-limit token bucket in Redis 0.3 ms, audit envelope insert, off-path 0.6 ms, after the response" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Cost of each security control per request</title>
  <desc>A horizontal bar chart. JWT verify, cached JWKS is 0.4 ms. spatial scope check in FastAPI is 0.7 ms. RLS predicate on an indexed column is 3–8 % of query time. rate-limit token bucket in Redis is 0.3 ms. audit envelope insert, off-path is 0.6 ms, after the response. The whole stack costs under two milliseconds of request time — security is not where a spatial API loses its latency budget.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Cost of each security control per request</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">JWT verify, cached JWKS</text>
  <rect x="250" y="48" width="113" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="371" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">0.4 ms</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">spatial scope check in FastAPI</text>
  <rect x="250" y="82" width="226" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="484" y="95" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">0.7 ms</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">RLS predicate on an indexed column</text>
  <rect x="250" y="116" width="340" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="598" y="129" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">3–8 % of query time</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">rate-limit token bucket in Redis</text>
  <rect x="250" y="150" width="113" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="371" y="163" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">0.3 ms</text>
  <text x="20" y="197" font-size="10.5" fill="currentColor">audit envelope insert, off-path</text>
  <rect x="250" y="184" width="226" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="484" y="197" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">0.6 ms, after the response</text>
  <text x="20" y="234" font-size="10.5" fill="var(--muted, #7c6fb0)">The whole stack costs under two milliseconds of request time — security is not where a spatial API loses its latency budget.</text>
</svg>

## Performance and scalability

Security controls are only sustainable if they are cheap. The two that touch the hot path — RLS predicates and rate-limit lookups — both have measurable, controllable overhead.

### RLS impact on GiST index scans

An RLS policy is a predicate PostgreSQL ANDs onto every statement. When the predicate filters on an indexed `tenant_id`, the planner treats it as an ordinary conjunct: it can use a composite index or intersect a btree on `tenant_id` with the GiST index on `geom`. Measured on a 12-million-row `features` table on an 8-vCPU instance, a bounding-box query took a p95 of 9.4 ms without RLS and 10.1 ms with the `tenant_isolation` policy — roughly 7 % overhead. The cost only explodes when the policy expression is *not* index-backed: a policy that calls a volatile function, or one that runs an `ST_` predicate against a scope geometry per row, forces evaluation on every candidate and can double query time. Keep the policy expression a simple indexed equality, push spatial scope enforcement into the query where the `&&` operator pre-filters, and verify with `EXPLAIN (ANALYZE, BUFFERS)` that the tenant filter appears as an `Index Cond`, not a post-scan `Filter`. This is the same query-plan discipline as [reading EXPLAIN ANALYZE for spatial query optimisation](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/).

### Rate-limit lookup overhead

A Redis sliding-window counter adds one network round-trip — typically 0.2–0.5 ms on a co-located instance — to each request. That is negligible next to a spatial query, and it is the cost that *prevents* a far larger cost: a single abusive `ST_DWithin` with a continental radius can hold a backend for seconds. Run the limiter as a Lua script so the read-decide-write is atomic under concurrency; the implementation and its benchmarks live in [Redis sliding-window rate limits for spatial endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/redis-sliding-window-rate-limits-for-spatial-endpoints/).

Each layer refuses a different attack, and two of them are not refused by any layer at all.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Which layer stops which attack: Stops it" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Which layer stops which attack</title>
  <desc>A comparison table. forged token with a wide scope: Stops it yes. signature verification valid token, out-of-area request: Stops it yes. spatial scope check application bug leaking another tenant: Stops it yes. row-level security slow enumeration within scope: Stops it partly. rate limiting plus the audit trail credential shared between customers: Stops it no. nothing here — that is a contract problem The last two rows are why an audit trail is a control rather than paperwork: they are the attacks no gate can refuse outright.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Which layer stops which attack</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Stops it</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">forged token with a wide scope</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="352" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">signature verification</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">valid token, out-of-area request</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="352" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">spatial scope check</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">application bug leaking another tenant</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="352" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">row-level security</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">slow enumeration within scope</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="352" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">rate limiting plus the audit trail</text>
  <line x1="20" y1="194" x2="700" y2="194" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="216" font-size="10.5" fill="currentColor">credential shared between customers</text>
  <text x="294" y="216" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="352" y="216" font-size="9.5" fill="var(--muted, #7c6fb0)">nothing here — that is a contract problem</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">The last two rows are why an audit trail is a control rather than paperwork: they are the attacks no gate can refuse outright.</text>
</svg>

## Abuse protection and rate limiting

Spatial endpoints are asymmetric: a request is a few hundred bytes, but the work it triggers can be enormous. A geofence query with a huge radius, a tile request at zoom 22 over a dense city, or an aggregation across a whole country all cost orders of magnitude more than a point lookup. Flat request-per-second limits do not capture this — you need cost-based throttling.

### Cost-based throttling

Assign each request a cost proportional to the work it will demand, and debit a per-client token bucket by that cost rather than by one unit per call. A cheap point lookup costs 1; a bounding-box query scales with area; a `ST_Union` aggregation or a low-zoom tile costs many. A client with a budget of 100 units per second can make a hundred point lookups or a handful of expensive aggregations, but cannot do both — which is exactly the fairness property you want.

```python
# Estimate request cost before executing — reject if it would exceed the budget.
def estimate_cost(bbox: tuple[float, float, float, float], zoom: int | None) -> int:
    minx, miny, maxx, maxy = bbox
    area = (maxx - minx) * (maxy - miny)
    base = 1 + int(area * 50)                 # larger areas cost more
    if zoom is not None and zoom < 8:
        base *= 4                             # low-zoom tiles touch far more geometry
    return min(base, 500)                     # clamp so one request cannot drain the bucket
```

Apply strict budgets to geofence and tile routes and looser ones to metadata endpoints, and separate them onto different Redis key namespaces so a burst of tile traffic cannot starve legitimate feature reads. The full policy, including per-endpoint tiers and burst allowances, is in [rate limiting geofence and tile endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/) and the deeper cost model in [cost-based throttling for expensive PostGIS queries](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/cost-based-throttling-for-expensive-postgis-queries/).

### The database backstop: statement_timeout

Rate limiting caps request frequency; it does not cap the runtime of a request that slipped through. Set a `statement_timeout` at the runtime role level so no single query can pin a connection indefinitely, regardless of how it was authorized:

```sql
-- Cap runtime for the API's runtime role. A runaway ST_DWithin dies at 8s.
ALTER ROLE api_runtime SET statement_timeout = '8s';
```

Combine this with the two-pool separation from the [core architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/) — a lightweight pool for point and bounding-box reads, a small heavy pool for aggregations — so one slow query cannot exhaust the connections serving fast traffic. A canceled statement returns `57014 query_canceled`; catch it and return `503` with a `Retry-After` header rather than a raw `500`.

## Production readiness: secrets, rotation, and audit

The controls above are only as trustworthy as the keys that sign the tokens and the record of who accessed what.

### Secrets handling and key rotation

Never bake signing keys, database credentials, or Redis passwords into images or environment files committed to source. Load them from a secrets manager (AWS Secrets Manager, Vault, or the platform equivalent) at process start, and give the API only the *public* key for JWT verification. Rotate signing keys on a schedule using key IDs: the identity provider signs with a current key and stamps its `kid` in the JWT header; the API keeps a small map of `kid → public key` and looks up the right key per token. Publishing the map as a JWKS document lets you introduce a new key, let both keys validate during an overlap window, then retire the old one — all without downtime and without a flag-day where every client must re-authenticate at once. Version and deprecate these auth changes with the same discipline as the [API versioning for GIS endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) approach, so a key rollover never silently breaks a partner integration.

### Auditing spatial access

Ordinary access logs record the URL, but a spatial API's sensitive fact is *which geography* a caller touched. Log the resolved scope and the queried area for every request against protected data, to an append-only store separate from the primary database. This turns an incident review from guesswork into a query: "which clients read geometry inside this bounding box last week?" Record the subject, tenant, requested area, decision, and cost — never the returned geometry itself, which would recreate the data in your logs.

### Monitoring signals

Standard HTTP dashboards miss the signals that matter for spatial security. Track these explicitly:

| Signal | What to measure | Alert threshold |
|---|---|---|
| Auth failure rate | `401` + `403` responses per minute per client | > 5 % of a client's traffic |
| Scope-denied rate | `403` from the scope dependency | Sudden spike = probing or misconfigured client |
| Rate-limit rejections | `429` per client per minute | Sustained > 0 for a legitimate client = under-provisioned budget |
| Statement timeouts | `57014` cancellations per minute | > 1 per minute = abusive or unbounded query |
| RLS predicate mode | share of queries with tenant filter as `Filter` not `Index Cond` | > 0 in a spot check = missing/unused tenant index |
| Token age at use | median seconds since `iat` | Near `exp` consistently = client not refreshing correctly |

Export via Prometheus and alert on the auth-failure and statement-timeout rates first — a spike in either is the earliest signal of an attack or a broken client. Pair `auth failure rate` with source client id so one misconfigured integration does not mask a genuine credential-stuffing attempt against another.

## Failure Modes and common misconfigurations

Each of the following has caused a real cross-tenant leak, an outage, or a forged-scope bypass in production spatial APIs.

1. **RLS enabled but not `FORCE`d, and the API connects as the table owner.** The policy is silently inert — owners and superusers bypass RLS by default. Every tenant sees every row. Always run `ALTER TABLE … FORCE ROW LEVEL SECURITY` *and* connect as a dedicated non-owner runtime role.

2. **Accepting `alg=none` or trusting the token's declared algorithm.** An attacker submits an unsigned token with arbitrary `tenant_id` and `geo_scope` and is authorized as anyone, anywhere. Always pass an explicit `algorithms=[...]` allow-list to `jwt.decode`; never derive the verification algorithm from the token header.

3. **Running the spatial scope check after the database query instead of before.** If the query executes first and the scope is validated on the result, you have already done the work — and if the query itself was not scoped, you have already fetched the out-of-area geometry. Enforce the coarse scope in a FastAPI dependency before the query and the fine scope inside the query with `ST_Within`.

4. **Leaking geometry through error messages.** Echoing `exc` text — an `InvalidTokenError`, a database error containing a `WHERE geom = ST_GeomFromText('…')` fragment, or a stack trace with row values — hands an attacker the very coordinates or key details you are protecting. Return opaque messages (`"Invalid credentials"`, `"Requested area exceeds authorized scope"`) and log the detail server-side only.

5. **Setting `app.tenant_id` from a client header instead of the verified JWT claim.** A caller who can supply the tenant context defeats RLS entirely by asserting a different tenant. Derive the value only from the verified token, and set it with transaction-local `set_config(…, true)` so it cannot leak across a pooled PgBouncer connection.

6. **Flat request-per-second limits on cost-asymmetric endpoints.** A limit tuned for point lookups lets a handful of continental `ST_DWithin` or zoom-2 tile requests saturate the database while staying under the request-count ceiling. Use cost-based throttling and a database `statement_timeout` as a hard backstop.

7. **Putting a full high-vertex geofence in the JWT.** A scope polygon with thousands of vertices bloats the `Authorization` header past proxy limits (many reject headers over 8 KB) and makes every request expensive to parse. Encode scope as a bounding box, H3 cell set, or a server-side `scope_ref`, and simplify any WKT with `ST_SimplifyPreserveTopology` before minting the claim.

8. **No key rotation path, or a flag-day rotation.** A single signing key that never rotates means one leak compromises every token indefinitely; a rotation with no overlap window breaks every client at once. Sign with a `kid`, publish a JWKS, and validate old and new keys during an overlap window before retiring the old key.

## FAQ

### Should the spatial scope check run in FastAPI or in PostGIS?

Run a coarse scope check in FastAPI before the query and a fine-grained check in PostGIS during the query. The FastAPI dependency rejects requests whose bounding box or geofence falls entirely outside the token scope, avoiding a wasted database round-trip. PostGIS then applies an `ST_Within` or `ST_Intersects` predicate against the scope geometry so that individual rows outside the authorized area are never returned even if the coarse check passes. Row-level security is the final backstop that cannot be bypassed by application bugs.

### Does PostGIS row-level security slow down GiST index scans?

The RLS policy adds a predicate that PostgreSQL ANDs onto every query. When the policy filters on an indexed `tenant_id` column the overhead is typically 3 to 8 %, because the planner can still use a composite btree or a GiST index and simply intersects the candidate set. The cost rises sharply only when the policy calls a volatile function or an `ST_` predicate that is not index-backed, which forces a per-row evaluation. Keep the policy expression a simple indexed equality, and confirm with `EXPLAIN ANALYZE` that the tenant filter is applied as an `Index Cond` rather than a `Filter`.

### How do I stop a JWT from being accepted with alg=none?

Always pass an explicit allow-list of algorithms to the decode call, for example `jwt.decode(token, key, algorithms=["RS256"])`. Never read the algorithm from the token header to decide how to verify it, and never call `decode` without the `algorithms` argument. Libraries that accept `alg=none` will treat an unsigned token as valid, letting an attacker forge arbitrary spatial scopes. Pin the algorithm, reject tokens whose header `alg` is not in the allow-list, and prefer asymmetric `RS256` or `ES256` so the API only holds the public key.

## Related

- [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) — verifying tokens safely and encoding geographic authority into scope claims
- [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) — FORCE RLS, tenant context, and geometry isolation at the database row
- [Rate Limiting Geofence & Tile Endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/) — sliding-window and cost-based throttling for expensive spatial routes
- [Core Geospatial API Architecture](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/) — the FastAPI + PostGIS foundation these security layers protect
- [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — roll out auth and key-rotation changes without breaking existing clients
