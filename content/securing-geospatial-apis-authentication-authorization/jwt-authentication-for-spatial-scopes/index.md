---
layout: layouts/page.njk
title: "JWT Authentication for Spatial Scopes"
description: "Design JWTs whose scope claims encode spatial permissions — regions, geofences, bounding boxes, tenants — and enforce them in FastAPI with PyJWT and RS256 before any PostGIS query runs."
slug: "jwt-authentication-for-spatial-scopes"
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "JWT Authentication for Spatial Scopes"
    url: "/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/"
datePublished: "2026-03-12"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "JWT Authentication for Spatial Scopes",
      "description": "Design JWTs whose scope claims encode spatial permissions — regions, geofences, bounding boxes, tenants — and enforce them in FastAPI with PyJWT and RS256 before any PostGIS query runs.",
      "datePublished": "2026-03-12",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com"},
      "mainEntityOfPage": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/"
    },
    {
      "@type": "Article",
      "headline": "JWT Authentication for Spatial Scopes",
      "datePublished": "2026-03-12",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/"},
        {"@type": "ListItem", "position": 2, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/"},
        {"@type": "ListItem", "position": 3, "name": "JWT Authentication for Spatial Scopes", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Enforce spatial permissions with JWT scope claims in FastAPI",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Mint an RS256-signed JWT carrying a custom geo_scope claim"},
        {"@type": "HowToStep", "position": 2, "name": "Verify the signature with PyJWT and an allow-list of algorithms"},
        {"@type": "HowToStep", "position": 3, "name": "Extract and normalise the spatial scope into a PostGIS-ready envelope"},
        {"@type": "HowToStep", "position": 4, "name": "Reject out-of-scope requests with ST_Within before running the real query"},
        {"@type": "HowToStep", "position": 5, "name": "Cache the decoded claim per request to avoid repeated signature checks"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why must I pin algorithms to RS256 and never accept alg=none?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "PyJWT decodes whatever algorithm the token header declares unless you constrain it. If you omit the algorithms argument or allow 'none', an attacker can strip the signature or downgrade an RS256 token to HS256 and sign it with your public key as the HMAC secret. Always pass algorithms=['RS256'] to jwt.decode and load only the public key on the API; the signing key stays with the issuer."
          }
        },
        {
          "@type": "Question",
          "name": "Should I put the geofence polygon directly in the JWT?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Rarely. A raw WKT polygon inflates the token past the ~8 KB header limit most proxies enforce, and it is re-verified on every request. Prefer a compact encoding — a bbox array, a short geohash prefix list, or a set of H3 cell IDs — or store the polygon server-side and reference it by a stable hash in the claim. The decision matrix on this page weighs each option by size and precision."
          }
        },
        {
          "@type": "Question",
          "name": "Do I still need row-level security if the JWT already scopes the region?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. The JWT check is a fast application-layer gate that rejects obviously out-of-scope requests with 403 before touching the database, but it is not a substitute for defence in depth. PostGIS row-level security enforces tenant isolation even when a query bypasses the ORM or a bug skips the dependency. Treat the scope check and RLS as two independent layers."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/)

# JWT authentication for spatial scopes

A geospatial API rarely wants to grant a client access to *all* geometry. A field-survey token should only read the county it was issued for; a partner integration should only query its own franchise territories; a tenant in a multi-tenant platform must never see another tenant's assets. The cleanest way to carry that constraint is inside the access token itself, as a spatial scope claim that travels with every request and is verified cryptographically before a single row is read. This guide shows how to design a `geo_scope` claim, sign and verify it with PyJWT using RS256, wire it into a FastAPI dependency, and translate the scope into `ST_Within` / `ST_Intersects` predicates that reject out-of-bounds requests with a `403` — long before an expensive PostGIS query has a chance to run.

Spatial scoping sits at the front of the request path, so it belongs with the rest of your [security and authorization architecture](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/). It composes with, but does not replace, database-level [row-level security for multi-tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/): the token gate is fast and coarse, RLS is the backstop.

## Where the scope check runs

Every request passes the same five stages before any geometry is read. The first four are cheap, in-process checks on the token; only a request that survives all of them reaches PostGIS, where an `ST_Within` predicate applies the final row-level gate.

<svg viewBox="2 102 756 194" role="img" aria-label="Request path for a spatially-scoped JWT: client sends a Bearer token, FastAPI verifies the RS256 signature, extracts the geo_scope claim, runs a coarse containment check, and only then applies an ST_Within gate in PostGIS; failures at verification or the coarse check short-circuit to 401 or 403." xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;font-family:inherit;">
  <title>Spatially-scoped JWT request path</title>
  <desc>A horizontal pipeline of five stages — Client with Bearer token, Verify RS256 signature, Extract geo_scope claim, Coarse containment check, and ST_Within gate in PostGIS — with a downward reject branch from the signature and coarse-check stages to a single 401/403 outcome box.</desc>
  <rect x="2" y="102" width="756" height="194" rx="10" fill="var(--surface, #f5f3ff)"/>
  <defs>
    <marker id="jwtarr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/></marker>
    <marker id="jwtrej" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#a82e1e"/></marker>
  </defs>
  <!-- Stage boxes -->
  <rect x="18" y="118" width="120" height="62" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="78" y="144" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Client</text>
  <text x="78" y="162" text-anchor="middle" font-size="10" fill="currentColor">Bearer &lt;JWT&gt;</text>
  <rect x="170" y="118" width="130" height="62" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="235" y="144" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Verify RS256</text>
  <text x="235" y="162" text-anchor="middle" font-size="10" fill="currentColor">signature · exp · aud</text>
  <rect x="332" y="118" width="120" height="62" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="392" y="144" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Extract scope</text>
  <text x="392" y="162" text-anchor="middle" font-size="10" fill="currentColor">geo_scope claim</text>
  <rect x="484" y="118" width="122" height="62" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="545" y="144" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Coarse check</text>
  <text x="545" y="162" text-anchor="middle" font-size="10" fill="currentColor">request ⊆ scope?</text>
  <rect x="638" y="118" width="104" height="62" rx="8" fill="var(--accent, #7c3aed)" opacity="0.12" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <rect x="638" y="118" width="104" height="62" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="690" y="144" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">ST_Within</text>
  <text x="690" y="162" text-anchor="middle" font-size="10" fill="currentColor">PostGIS gate</text>
  <!-- Forward arrows -->
  <line x1="138" y1="149" x2="168" y2="149" stroke="currentColor" stroke-width="1.5" marker-end="url(#jwtarr)"/>
  <line x1="300" y1="149" x2="330" y2="149" stroke="currentColor" stroke-width="1.5" marker-end="url(#jwtarr)"/>
  <line x1="452" y1="149" x2="482" y2="149" stroke="currentColor" stroke-width="1.5" marker-end="url(#jwtarr)"/>
  <line x1="606" y1="149" x2="636" y2="149" stroke="currentColor" stroke-width="1.5" marker-end="url(#jwtarr)"/>
  <!-- Reject branch -->
  <rect x="300" y="238" width="160" height="42" rx="8" fill="none" stroke="#a82e1e" stroke-width="1.5"/>
  <text x="380" y="258" text-anchor="middle" font-size="12" font-weight="700" fill="#a82e1e">401 / 403 rejected</text>
  <text x="380" y="273" text-anchor="middle" font-size="10" fill="#a82e1e">before any DB round-trip</text>
  <line x1="235" y1="180" x2="235" y2="259" stroke="#a82e1e" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#jwtrej)"/>
  <text x="235" y="210" text-anchor="middle" font-size="10" fill="#a82e1e">401 invalid</text>
  <line x1="545" y1="180" x2="545" y2="259" stroke="#a82e1e" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#jwtrej)"/>
  <text x="545" y="210" text-anchor="middle" font-size="10" fill="#a82e1e">403 out of scope</text>
</svg>

---

## Prerequisites & Environment

The scope-enforcement layer is pure Python plus a signature check; it does not need a spatial extension of its own until the moment it hands an envelope to PostGIS. Pin these baselines:

| Component | Minimum version | Why it matters |
|---|---|---|
| Python | 3.11+ | `datetime.UTC`, faster `json` and `hmac` paths |
| FastAPI | 0.110+ | `Security()` + `OAuth2` scopes, async lifespan |
| PyJWT | 2.8+ | `algorithms` enforcement, `options={"require": [...]}`, leeway on `exp` |
| cryptography | 42+ | RS256 key loading for PyJWT's `RSAAlgorithm` |
| PostGIS | 3.3+ | Stable `ST_Within`, `ST_Intersects`, `ST_MakeEnvelope`, `ST_GeomFromText` |
| asyncpg | 0.29+ | Async execution of the scope-boundary check |
| h3 | 4.1+ | Only if you choose the H3 cell-set encoding (see the matrix) |

Install the auth stack:

```bash
pip install "fastapi>=0.110" "pyjwt[crypto]>=2.8" "asyncpg>=0.29" "sqlalchemy[asyncio]>=2.0"
```

Generate an RSA key pair for the issuer. The private key signs tokens in your identity provider; **only the public key is ever deployed to the API**:

```bash
openssl genpkey -algorithm RSA -out jwt-private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
```

---

## Anatomy of a spatial scope token

A JWT is three base64url segments — header, payload, signature. The header declares the algorithm; the payload holds the claims; the signature binds them. For spatial scoping you add one custom claim, `geo_scope`, alongside the registered claims (`iss`, `aud`, `exp`, `sub`) and a conventional OAuth2 `scope` string for coarse permissions:

```json
{
  "iss": "https://auth.geospatial-api.com",
  "aud": "geospatial-api",
  "sub": "svc-field-survey-42",
  "exp": 1773187200,
  "scope": "features:read tiles:read",
  "geo_scope": {
    "srid": 4326,
    "encoding": "bbox",
    "regions": [[-2.71, 51.32, -2.28, 51.53]]
  }
}
```

The `geo_scope` object is deliberately self-describing: `encoding` tells the verifier how to interpret `regions`, and `srid` fixes the coordinate reference so the check never guesses. Because everything inside the payload is signed, a client cannot widen its own bounding box without invalidating the signature.

---

## Decision matrix: how to encode the spatial scope

The single most consequential design choice is *how* you represent the permitted area inside the claim. Four encodings dominate, and they trade token size against precision and query cost. This matrix is the analytical anchor — pick before you write a validator.

| Encoding | Claim payload | Bytes (typical) | Precision | Query mapping | Best for |
|---|---|---|---|---|---|
| **bbox array** | `[[xmin,ymin,xmax,ymax], ...]` | 40–80 per box | Rectangle only | `ST_MakeEnvelope` → `ST_Within` | Axis-aligned regions, tiles, admin extents |
| **geohash list** | `["gcpvj", "gcpvn"]` | 6–12 per prefix | Cell = prefix length | Prefix `LIKE` or `ST_GeomFromGeoHash` → `ST_Intersects` | Coarse zones, cheap containment, string indexes |
| **H3 cell set** | `["8a2a1072b59ffff", ...]` | 16 per cell | Uniform hexagon at a resolution | Cell-of-point membership, or `ST_Intersects` on cell boundary | Even-area coverage, dedupe, set algebra |
| **WKT polygon** | `"POLYGON((...))"` | 60–4000+ | Exact | `ST_GeomFromText` → `ST_Within` | Small, irregular, high-value fences only |
| **server-side ref** | `{"ref":"fence:8f3a...","hash":"..."}` | ~50 fixed | Exact (lookup) | Join to `geofences` table → `ST_Within` | Large or many polygons; keeps token tiny |

Two rules fall straight out of the table. First, never embed a large `WKT polygon` directly — it re-transmits and re-verifies on every request and quickly blows past the header limit. Second, if the fence is irregular *and* large, use the `server-side ref` pattern: store the polygon once, reference it by a stable content hash in the claim, and resolve it during validation. The full trade-off — including how many H3 cells a country needs at each resolution — is worked through in [encoding geofence boundaries in JWT scope claims](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/encoding-geofence-boundaries-in-jwt-scope-claims/).

---

Every scope encoding trades token size against how exactly it describes the permitted area.

<svg viewBox="0 0 720 234" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="How to encode a spatial scope in a token: Compact, Precise" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>How to encode a spatial scope in a token</title>
  <desc>A comparison table. bounding box, four floats: Compact yes, Precise no. ~40 bytes, over-grants geohash prefix list: Compact yes, Precise partly. grid-aligned, cheap to test simplified polygon WKT: Compact no, Precise yes. grows the token quickly scope id resolved server-side: Compact yes, Precise yes. one lookup, no size limit The last row is the only one that stays small and exact — at the cost of a lookup the other three avoid.</desc>
  <rect x="0" y="0" width="720" height="234" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">How to encode a spatial scope in a token</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Compact</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Precise</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">bounding box, four floats</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="460" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">~40 bytes, over-grants</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">geohash prefix list</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="460" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">grid-aligned, cheap to test</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">simplified polygon WKT</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">grows the token quickly</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">scope id resolved server-side</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">one lookup, no size limit</text>
  <text x="20" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">The last row is the only one that stays small and exact — at the cost of a lookup the other three avoid.</text>
</svg>

## Step-by-Step Implementation

### Step 1 — Mint a signed token (issuer side)

The issuer holds the private key and stamps the `geo_scope` claim based on the subject's entitlements. This runs in your identity provider, not the API:

```python
# issuer/mint.py — runs where the PRIVATE key lives, never on the API
import jwt                     # PyJWT
from datetime import datetime, timedelta, UTC

PRIVATE_KEY = open("jwt-private.pem").read()

def mint_token(subject: str, bbox: list[float]) -> str:
    now = datetime.now(UTC)
    payload = {
        "iss": "https://auth.geospatial-api.com",
        "aud": "geospatial-api",
        "sub": subject,
        "iat": now,
        "exp": now + timedelta(minutes=30),
        "scope": "features:read tiles:read",
        "geo_scope": {"srid": 4326, "encoding": "bbox", "regions": [bbox]},
    }
    # algorithm is fixed here; the header will say "RS256"
    return jwt.encode(payload, PRIVATE_KEY, algorithm="RS256")
```

Keep token lifetimes short (15–30 minutes). A spatial scope is an entitlement snapshot; if a client's territory changes, a short-lived token means the change propagates on the next refresh rather than lingering for hours.

### Step 2 — Verify the signature with a pinned algorithm

On the API, decode with the **public** key and an explicit `algorithms` allow-list. This is the security-critical line: passing `algorithms=["RS256"]` prevents an attacker from downgrading the token to `HS256` (signing with your public key as the HMAC secret) or stripping the signature with `alg=none`.

```python
# app/security/jwt.py
import jwt
from jwt import InvalidTokenError

PUBLIC_KEY = open("jwt-public.pem").read()

def decode_token(token: str) -> dict:
    return jwt.decode(
        token,
        PUBLIC_KEY,
        algorithms=["RS256"],            # NEVER omit; NEVER include "none"
        audience="geospatial-api",
        issuer="https://auth.geospatial-api.com",
        options={"require": ["exp", "iss", "aud", "sub"]},
        leeway=10,                        # tolerate 10 s of clock skew on exp/nbf
    )
```

### Step 3 — Extract and normalise the scope

Turn the `geo_scope` claim into a single PostGIS-ready envelope (or geometry). Normalising here means the rest of the request never re-parses the claim. The per-encoding parsing detail lives in [validating spatial scope claims in FastAPI dependencies](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/validating-spatial-scope-claims-in-fastapi-dependencies/); the essence is a small dispatch on `encoding`.

```python
# app/security/scope.py
from dataclasses import dataclass

@dataclass(frozen=True)
class SpatialScope:
    srid: int
    encoding: str
    regions: list        # list of bbox arrays, geohash prefixes, or H3 cells

def parse_scope(claim: dict) -> SpatialScope:
    if not claim or "encoding" not in claim:
        raise ValueError("geo_scope claim missing or malformed")
    return SpatialScope(
        srid=int(claim.get("srid", 4326)),
        encoding=claim["encoding"],
        regions=claim["regions"],
    )
```

### Step 4 — Map the scope to a spatial predicate

The requested geometry (a point, a bbox the client asked for, an uploaded polygon) must fall *inside* the scope. For a bbox-encoded scope that is a `ST_Within` test of the request envelope against the union of scope envelopes. The same GiST-backed [bounding-box spatial index query](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) pattern applies — `&&` first for the index, then the exact predicate:

```sql
-- Returns TRUE when the requested envelope lies within any scoped region.
SELECT bool_or(
         ST_Within(
           ST_MakeEnvelope(:rq_xmin, :rq_ymin, :rq_xmax, :rq_ymax, :srid),
           ST_MakeEnvelope(s.xmin, s.ymin, s.xmax, s.ymax, :srid)
         )
       ) AS in_scope
FROM   unnest(:xmins, :ymins, :xmaxs, :ymaxs)
         AS s(xmin, ymin, xmax, ymax);
```

If `in_scope` is false, the request never reaches the data query — the dependency raises `403`. For containment of an arbitrary polygon rather than a rectangle, swap `ST_Within` for `ST_Intersects` when *any overlap* is acceptable, or keep `ST_Within` when the request must be *fully* enclosed. That distinction is the whole ballgame: `ST_Intersects` grants access to a partly-overlapping request, `ST_Within` demands total containment.

---

## Production Code Example

A complete, copy-runnable FastAPI wiring: an OAuth2 bearer dependency decodes the token, a scope dependency extracts `geo_scope`, and the route rejects out-of-scope bounding boxes with `403` before the feature query runs. The decoded claim is cached on `request.state` so a single request never verifies the signature twice.

```python
# app/main.py
from fastapi import FastAPI, Depends, HTTPException, Request, Query, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
import jwt
from jwt import ExpiredSignatureError, InvalidAudienceError, InvalidTokenError

from app.security.scope import parse_scope, SpatialScope
from app.dependencies import get_db          # yields an AsyncSession

app = FastAPI()
oauth2 = OAuth2PasswordBearer(tokenUrl="token")   # extracts "Authorization: Bearer <jwt>"
PUBLIC_KEY = open("jwt-public.pem").read()


async def current_claims(request: Request, token: str = Depends(oauth2)) -> dict:
    """Verify the JWT once and memoise the claims for the rest of the request."""
    cached = getattr(request.state, "claims", None)
    if cached is not None:
        return cached
    try:
        claims = jwt.decode(
            token, PUBLIC_KEY,
            algorithms=["RS256"],
            audience="geospatial-api",
            issuer="https://auth.geospatial-api.com",
            options={"require": ["exp", "iss", "aud", "sub"]},
            leeway=10,
        )
    except ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired")
    except (InvalidAudienceError, InvalidTokenError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {exc}")
    request.state.claims = claims
    return claims


async def spatial_scope(claims: dict = Depends(current_claims)) -> SpatialScope:
    try:
        return parse_scope(claims.get("geo_scope"))
    except ValueError as exc:
        # A token with no usable spatial scope is a hard failure, not open access.
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc))


async def require_bbox_in_scope(
    minx: float, miny: float, maxx: float, maxy: float,
    scope: SpatialScope = Depends(spatial_scope),
    db: AsyncSession = Depends(get_db),
) -> tuple[float, float, float, float]:
    """403 unless the requested bbox is fully contained by the scoped regions."""
    if scope.encoding != "bbox":
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            f"Unsupported scope encoding: {scope.encoding}")
    xmins = [r[0] for r in scope.regions]
    ymins = [r[1] for r in scope.regions]
    xmaxs = [r[2] for r in scope.regions]
    ymaxs = [r[3] for r in scope.regions]
    row = await db.execute(text("""
        SELECT bool_or(ST_Within(
                 ST_MakeEnvelope(:rq_xmin, :rq_ymin, :rq_xmax, :rq_ymax, :srid),
                 ST_MakeEnvelope(s.xmin, s.ymin, s.xmax, s.ymax, :srid)))
        FROM unnest(cast(:xmins AS float8[]), cast(:ymins AS float8[]),
                    cast(:xmaxs AS float8[]), cast(:ymaxs AS float8[]))
             AS s(xmin, ymin, xmax, ymax)
    """), {
        "rq_xmin": minx, "rq_ymin": miny, "rq_xmax": maxx, "rq_ymax": maxy,
        "srid": scope.srid,
        "xmins": xmins, "ymins": ymins, "xmaxs": xmaxs, "ymaxs": ymaxs,
    })
    if not row.scalar():
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Requested area is outside your authorised spatial scope.",
        )
    return (minx, miny, maxx, maxy)


@app.get("/features/bbox")
async def features_in_bbox(
    bbox: tuple = Depends(require_bbox_in_scope),
    limit: int = Query(100, le=1000),
    db: AsyncSession = Depends(get_db),
):
    minx, miny, maxx, maxy = bbox
    result = await db.execute(text("""
        SELECT id, name, ST_AsGeoJSON(geom)::jsonb AS geometry
        FROM   spatial_features
        WHERE  geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)
          AND  ST_Intersects(geom, ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326))
        ORDER BY id
        LIMIT  :limit
    """), {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy, "limit": limit})
    return {"type": "FeatureCollection",
            "features": [{"type": "Feature", "id": r.id,
                          "geometry": r.geometry, "properties": {"name": r.name}}
                         for r in result.mappings().all()]}
```

The dependency chain reads top-down: `oauth2` pulls the bearer token, `current_claims` verifies it once, `spatial_scope` extracts the claim, and `require_bbox_in_scope` runs the containment gate. Only if all four pass does the feature query execute. Because `require_bbox_in_scope` returns the validated bbox, the handler cannot accidentally use unvalidated coordinates.

---

## Verification & Testing

Mint a scoped test token and probe both an in-scope and an out-of-scope request. Bath, UK (`-2.5, 51.4`) is inside the example scope; central London (`-0.1, 51.5`) is not.

```bash
# 1. Mint a token scoped to a bath-area bbox (issuer side)
TOKEN=$(python -c "from issuer.mint import mint_token; \
  print(mint_token('svc-test', [-2.71, 51.32, -2.28, 51.53]))")

# 2. In-scope request → 200 FeatureCollection
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/features/bbox?minx=-2.6&miny=51.35&maxx=-2.4&maxy=51.45" \
  | jq '.type'
# → "FeatureCollection"

# 3. Out-of-scope request → 403
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/features/bbox?minx=-0.2&miny=51.45&maxx=0.0&maxy=51.55"
# → 403
```

Confirm the algorithm pin actually rejects a downgraded token — decode should raise before any scope logic runs:

```python
import jwt, pytest
def test_hs256_downgrade_rejected():
    pub = open("jwt-public.pem").read()
    forged = jwt.encode({"aud": "geospatial-api"}, pub, algorithm="HS256")
    with pytest.raises(jwt.InvalidAlgorithmError):
        jwt.decode(forged, pub, algorithms=["RS256"], audience="geospatial-api")
```

---

Scope encoding has a hard ceiling that is set by HTTP, not by cryptography.

<svg viewBox="0 0 720 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Token size by scope encoding: bbox only 310 bytes, 9 geohash prefixes 420 bytes, simplified polygon, 40 vertices 1 180 bytes, full polygon, 400 vertices 9 400 bytes — header limits bite" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Token size by scope encoding</title>
  <desc>A horizontal bar chart. bbox only is 310 bytes. 9 geohash prefixes is 420 bytes. simplified polygon, 40 vertices is 1 180 bytes. full polygon, 400 vertices is 9 400 bytes — header limits bite. Most proxies cap request headers around 8 KB, so the last row fails as a transport problem long before it fails as a design one.</desc>
  <rect x="0" y="0" width="720" height="232" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Token size by scope encoding</text>
  <text x="20" y="61" font-size="10.5" fill="currentColor">bbox only</text>
  <rect x="250" y="48" width="11" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="269" y="61" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">310 bytes</text>
  <text x="20" y="95" font-size="10.5" fill="currentColor">9 geohash prefixes</text>
  <rect x="250" y="82" width="15" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="273" y="95" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">420 bytes</text>
  <text x="20" y="129" font-size="10.5" fill="currentColor">simplified polygon, 40 vertices</text>
  <rect x="250" y="116" width="42" height="18" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="300" y="129" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">1 180 bytes</text>
  <text x="20" y="163" font-size="10.5" fill="currentColor">full polygon, 400 vertices</text>
  <rect x="250" y="150" width="340" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="598" y="163" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">9 400 bytes — header</text>
  <text x="20" y="200" font-size="10.5" fill="var(--muted, #7c6fb0)">Most proxies cap request headers around 8 KB, so the last row fails as a transport problem long before it fails as a design one.</text>
</svg>

## Failure Modes & Edge Cases

1. **`jwt.decode` called without `algorithms`** — older PyJWT raised a `DeprecationWarning`; current versions raise `DecodeError: It is required that you pass in a value for the "algorithms" argument`. Never work around it by passing `algorithms=["RS256","HS256"]` — that reopens the downgrade attack. Pin to the single algorithm you actually use.

2. **`InvalidAlgorithmError: The specified alg value is not allowed`** — the token header declares an algorithm outside your allow-list (often an `alg=none` or `HS256` downgrade attempt). This is the pin working correctly; return `401` and log the offending `kid`/`alg`.

3. **`ExpiredSignatureError`** with correct clocks — usually the issuer and API disagree on time zone. `exp` is a UTC epoch; if your issuer builds it from a naive local `datetime`, tokens expire early or late. Always mint `exp` from `datetime.now(UTC)` and give the verifier a small `leeway`.

4. **Scope check runs *after* the data query** — a subtle but severe bug. If you fetch features first and filter by scope in Python, an attacker can time or side-channel the full result set, and a large out-of-scope query still burns a connection. Always enforce scope in the dependency, before the handler body — the gate must precede the read.

5. **`geo_scope` is `null` treated as "allow all"** — a token with a missing or null scope must fail closed. In the example, `parse_scope` raises and the dependency returns `403`. The dangerous inverse — defaulting an absent claim to an unbounded bbox — silently grants global access.

6. **SRID mismatch between claim and data** — the claim says `4326` but the feature column is `3857`. `ST_Within` on mixed-SRID geometries raises `ERROR: Operation on mixed SRID geometries`. Normalise the request envelope to the column SRID (or reproject the scope) inside the dependency, never inside the hot query.

7. **Bounding box passed as `minx > maxx`** — a wrapped or inverted box makes `ST_MakeEnvelope` produce an empty or degenerate polygon, so `ST_Within` returns false and every request 403s. Validate `minx < maxx and miny < maxy` before building the envelope and return `400`, not `403`, for a malformed request.

---

## Performance Notes

**Signature verification cost.** RS256 verification is an asymmetric operation — roughly 0.2–0.5 ms per token on a modern core, versus ~20 µs for HS256. On a hot path serving thousands of requests per second this is real; the mitigation is not to weaken the algorithm but to **verify once per request** and memoise, exactly as `current_claims` caches on `request.state`. Never call `jwt.decode` in more than one dependency.

**Claim decode vs the scope query.** Parsing `geo_scope` from an already-decoded dict is sub-microsecond. The `ST_Within` scope check is a single-row query with no table access — typically 0.3–0.8 ms including the round-trip — so it is cheap relative to the feature query it guards. For bbox and geohash encodings you can skip the database entirely and test containment in Python, dropping the gate to microseconds; reserve the PostGIS check for polygon and `server-side ref` scopes.

**Cross-request caching.** Decoded claims are safe to cache keyed by the raw token string for the token's remaining lifetime — a small LRU keyed on a hash of the compact JWT avoids re-verifying repeat callers. Bound the TTL by `exp` and cap the cache size; a token cache that outlives `exp` re-admits expired tokens.

**JWKS and key rotation.** If you fetch the public key from a JWKS endpoint rather than a file, cache the key set aggressively (minutes to hours) and refresh on an unknown `kid`. A per-request JWKS fetch adds tens of milliseconds and couples every API request to the identity provider's availability.

---

## FAQ

### Why must I pin algorithms to RS256 and never accept alg=none?

PyJWT decodes whatever algorithm the token header declares unless you constrain it. If you omit the `algorithms` argument or allow `none`, an attacker can strip the signature or downgrade an RS256 token to HS256 and sign it with your public key used as the HMAC secret. Always pass `algorithms=["RS256"]` to `jwt.decode` and deploy only the public key on the API — the signing key never leaves the issuer.

### Should I put the geofence polygon directly in the JWT?

Rarely. A raw WKT polygon inflates the token past the ~8 KB header limit most proxies enforce, and it is re-verified on every request. Prefer a compact encoding — a bbox array, a short geohash prefix list, or a set of H3 cell IDs — or store the polygon server-side and reference it by a stable hash in the claim. The decision matrix above weighs each option by size and precision.

### Do I still need row-level security if the JWT already scopes the region?

Yes. The JWT check is a fast application-layer gate that rejects obviously out-of-scope requests with `403` before touching the database, but it is not a substitute for defence in depth. PostGIS row-level security enforces tenant isolation even when a query bypasses the ORM or a bug skips the dependency. Treat the scope check and [row-level security](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) as two independent layers.

---

## Related

- [Encoding Geofence Boundaries in JWT Scope Claims](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/encoding-geofence-boundaries-in-jwt-scope-claims/) — H3, geohash, bbox, and server-side-reference encodings compared by token size and precision
- [Validating Spatial Scope Claims in FastAPI Dependencies](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/validating-spatial-scope-claims-in-fastapi-dependencies/) — a reusable dependency that checks the requested geometry against the token scope and caches decoded claims
- [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) — the database-layer backstop that enforces tenant isolation independently of the token gate
- [Bounding-Box Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — the GiST-backed `ST_Within` / `ST_Intersects` pattern the scope check reuses
- [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/) — the full authentication and authorization architecture this fits into

← Back to [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/)
