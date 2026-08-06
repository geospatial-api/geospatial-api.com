---
layout: layouts/page.njk
title: "Rotating JWT Signing Keys Without Dropping Sessions"
description: "Publish a JWKS with overlapping keys, sign with the newest and verify against all valid ones, and retire an old key only after the last token signed with it has expired."
slug: rotating-jwt-signing-keys-without-dropping-sessions
type: howto
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "JWT Authentication for Spatial Scopes"
    url: "/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/"
  - label: "Rotating JWT Signing Keys Without Dropping Sessions"
    url: "/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/rotating-jwt-signing-keys-without-dropping-sessions/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Rotating JWT Signing Keys Without Dropping Sessions",
      "description": "Publish a JWKS with overlapping keys, sign with the newest, verify against all valid ones, and retire keys safely.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/rotating-jwt-signing-keys-without-dropping-sessions/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/" },
        { "@type": "ListItem", "position": 2, "name": "JWT Authentication for Spatial Scopes", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/" },
        { "@type": "ListItem", "position": 3, "name": "Rotating JWT Signing Keys Without Dropping Sessions", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/rotating-jwt-signing-keys-without-dropping-sessions/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Rotate a JWT Signing Key Safely",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Publish before signing", "text": "Add the new key to the JWKS and let clients and caches pick it up before any token is signed with it." },
        { "@type": "HowToStep", "position": 2, "name": "Switch the signer", "text": "Start signing with the new key id while continuing to verify against both." },
        { "@type": "HowToStep", "position": 3, "name": "Retire after the last token expires", "text": "Remove the old key only once its longest-lived token has passed its expiry." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does the new key have to be published before it is used?",
          "acceptedAnswer": { "@type": "Answer", "text": "Verifiers cache the JWKS, typically for minutes to hours. If a token signed with a key nobody has fetched yet arrives at a verifier with a warm cache, verification fails and the user is logged out. Publishing first, then waiting at least one cache lifetime, means every verifier already holds the key by the time a token needs it." }
        },
        {
          "@type": "Question",
          "name": "How long must the overlap last?",
          "acceptedAnswer": { "@type": "Answer", "text": "At least the maximum lifetime of any token signed with the old key, plus the JWKS cache lifetime, plus a margin. If access tokens last one hour and refresh tokens thirty days, and refresh tokens are also signed with the same key, the overlap is thirty days — not one hour. Signing refresh tokens with a separate, longer-lived key is what avoids that." }
        },
        {
          "@type": "Question",
          "name": "Does the spatial scope claim complicate rotation?",
          "acceptedAnswer": { "@type": "Answer", "text": "Not the rotation itself, but it raises the cost of getting it wrong. A token carrying a geofence scope is often long-lived because re-issuing it means recomputing an authorisation boundary. Long-lived tokens force long overlaps, so keeping the scope claim compact and the token short-lived makes rotation cheaper as well as safer." }
        }
      ]
    }
  ]
}
</script>

← Back to [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/)

# Rotating JWT signing keys without dropping sessions

This page covers the ordering that makes key rotation invisible to users: publish, wait, switch, wait again, retire — and why doing any two of those steps in the wrong order logs everybody out.

## Context & When to Use

Signing keys need rotating on a schedule, after a suspected exposure, and whenever someone with access to them leaves. The mechanics are simple; the sequencing is where outages come from. Swap the key in one deployment and every token already in the wild becomes unverifiable, which for a spatial API means every dispatcher, every field device and every partner integration receives 401 simultaneously.

The safe version rests on two properties of JWT verification. The `kid` header names which key signed a token, and a verifier can hold several keys at once. That means signing and verification can be decoupled in time: verify against a set, sign with exactly one member of it, and move the signing member forward while the set still contains the old one.

Rotation interacts with token lifetime in a way that surprises people. The overlap must outlast the longest-lived token signed with the outgoing key. For an API whose tokens carry [spatial scope claims](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/encoding-geofence-boundaries-in-jwt-scope-claims/) — expensive to compute, therefore often long-lived — that can be weeks rather than hours.

## Runnable Implementation

```python
import time
from dataclasses import dataclass
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, Header
from jwt import PyJWKClient

JWKS_URL = "https://auth.example.com/.well-known/jwks.json"
ALGORITHMS = ["RS256"]                 # explicit allow-list; never read alg from the token
ISSUER = "https://auth.example.com/"
AUDIENCE = "geospatial-api"

# Cache the key set, but not forever: a rotation must be picked up automatically
_jwks = PyJWKClient(JWKS_URL, cache_keys=True, lifespan=300, max_cached_keys=8)


@dataclass(frozen=True)
class Principal:
    subject: str
    tenant: str
    scope_wkt: str | None
    key_id: str


def verify(authorization: Annotated[str, Header()]) -> Principal:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, detail={"error": "missing_bearer_token"})
    token = authorization.removeprefix("Bearer ")

    try:
        # The kid header selects the key; the client holds ALL published keys
        signing_key = _jwks.get_signing_key_from_jwt(token)
        claims: dict[str, Any] = jwt.decode(
            token,
            signing_key.key,
            algorithms=ALGORITHMS,        # pinned: alg=none can never verify
            issuer=ISSUER,
            audience=AUDIENCE,
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWKClientError:
        # Unknown kid: the key was retired too early, or the JWKS is stale
        raise HTTPException(401, detail={"error": "unknown_signing_key"})
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, detail={"error": "token_expired"})
    except jwt.InvalidTokenError as exc:
        raise HTTPException(401, detail={"error": "invalid_token", "reason": str(exc)})

    return Principal(
        subject=claims["sub"],
        tenant=claims.get("tenant", ""),
        scope_wkt=claims.get("scope_geom"),
        key_id=jwt.get_unverified_header(token)["kid"],
    )
```

On the issuing side, the only change during rotation is which key the signer selects:

```python
SIGNING_KEYS = {                        # loaded from the secret store
    "2026-02-key": {"private": ..., "not_after": 1793000000},
    "2026-08-key": {"private": ..., "not_after": 1808000000},
}
ACTIVE_KID = "2026-08-key"              # the ONLY thing a rotation changes

def issue(claims: dict[str, Any]) -> str:
    key = SIGNING_KEYS[ACTIVE_KID]
    return jwt.encode(claims, key["private"], algorithm="RS256",
                      headers={"kid": ACTIVE_KID})
```

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline of a key rotation showing the publish, switch and retire phases with the overlap window between them" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The five phases of a safe rotation</title>
  <desc>A timeline across five phases. In phase one only the old key exists and is both published and signing. In phase two the new key is published but not yet signing, and the system waits at least one JWKS cache lifetime. In phase three signing switches to the new key while both remain published; this overlap must outlast the longest token signed with the old key. In phase four the old key is still published but no token signed with it can still be valid. In phase five the old key is removed from the JWKS. Two failure arrows mark what happens if the switch precedes publication or the retirement precedes token expiry.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Publish → wait → switch → wait → retire</text>
  <text x="20" y="60" font-size="10.5" fill="currentColor">old key published</text>
  <rect x="170" y="48" width="400" height="16" rx="3" fill="var(--accent, #7c3aed)" opacity="0.55"/>
  <text x="580" y="61" font-size="9.5" fill="var(--muted, #7c6fb0)">removed at phase 5</text>
  <text x="20" y="90" font-size="10.5" fill="currentColor">old key signing</text>
  <rect x="170" y="78" width="150" height="16" rx="3" fill="var(--accent, #7c3aed)" opacity="0.8"/>
  <text x="20" y="120" font-size="10.5" fill="currentColor">new key published</text>
  <rect x="250" y="108" width="440" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.55"/>
  <text x="20" y="150" font-size="10.5" fill="currentColor">new key signing</text>
  <rect x="320" y="138" width="370" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <line x1="250" y1="40" x2="250" y2="170" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4,3"/>
  <text x="256" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">publish</text>
  <line x1="320" y1="40" x2="320" y2="170" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4,3"/>
  <text x="326" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">switch</text>
  <line x1="570" y1="40" x2="570" y2="170" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4,3"/>
  <text x="540" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">retire</text>
  <path d="M250 200 L320 200" stroke="var(--viz-warn, #8a5000)" stroke-width="1.6"/>
  <text x="285" y="214" text-anchor="middle" font-size="9.5" fill="var(--viz-warn, #8a5000)">≥ 1 JWKS cache lifetime</text>
  <path d="M320 226 L570 226" stroke="var(--viz-warn, #8a5000)" stroke-width="1.6"/>
  <text x="445" y="240" text-anchor="middle" font-size="9.5" fill="var(--viz-warn, #8a5000)">≥ longest token lifetime signed with the old key</text>
  <text x="596" y="200" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">switch before publish</text>
  <text x="596" y="214" font-size="9.5" fill="var(--viz-bad, #a32b23)">→ mass 401s</text>
  <text x="596" y="232" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">retire too early</text>
  <text x="596" y="246" font-size="9.5" fill="var(--viz-bad, #a32b23)">→ mass 401s</text>
</svg>

## Key Parameters & Options

| Setting | Recommended | Why |
|---|---|---|
| `kid` header | always set | Without it a verifier must try every key, and retirement is guesswork |
| JWKS cache lifespan | 300 s | Short enough to pick up a rotation, long enough to avoid hammering the endpoint |
| `algorithms=` | explicit list | Never infer from the token; this is what blocks `alg=none` |
| Access token TTL | ≤ 1 h | Directly sets the minimum overlap |
| Refresh token key | separate `kid` | Stops a 30-day refresh token forcing a 30-day overlap on the access key |
| Retired keys kept | 1 previous | More than one usually means a rotation was never finished |

## Watching a rotation land

A rotation is not finished when the deployment completes; it is finished when no traffic uses the old key. That is observable, and watching it is what tells you when retirement is safe.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of verification counts per key id over the days following a signing switch" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Verifications by key id after the switch</title>
  <desc>Two series over seven days following the signing switch. Verifications using the new key rise sharply from zero to nearly all traffic within the first day. Verifications using the old key decay as existing tokens expire, dropping below one percent by day two and reaching zero on day six, when the last long-lived token issued before the switch expires. A marker on day seven shows the safe retirement point, one day after the last observed use.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Verifications per key id — the retirement signal</text>
  <line x1="70" y1="176" x2="686" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <line x1="70" y1="44" x2="70" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <text x="62" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">100 %</text>
  <text x="62" y="176" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <polyline points="70,174 158,66 246,50 334,47 422,46 510,46 598,46 686,46" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="2.4"/>
  <text x="250" y="42" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">2026-08-key (new)</text>
  <polyline points="70,48 158,150 246,170 334,173 422,175 510,176 598,176 686,176" fill="none" stroke="var(--viz-warn, #8a5000)" stroke-width="2.4"/>
  <text x="180" y="166" font-size="10" font-weight="700" fill="var(--viz-warn, #8a5000)">2026-02-key (old)</text>
  <circle cx="510" cy="176" r="5" fill="var(--viz-bad, #a32b23)"/>
  <text x="470" y="200" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">last use: day 6</text>
  <line x1="598" y1="40" x2="598" y2="190" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6" stroke-dasharray="5,3"/>
  <text x="606" y="96" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">retire here</text>
  <text x="606" y="110" font-size="9.5" fill="var(--viz-good, #1f6b3a)">one day after</text>
  <text x="90" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">d0</text>
  <text x="330" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">d3</text>
  <text x="670" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">d7</text>
  <text x="20" y="214" font-size="10.5" fill="var(--muted, #7c6fb0)">Count verifications by kid. Retiring on a calendar date is how a straggler integration</text>
  <text x="20" y="230" font-size="10.5" fill="var(--muted, #7c6fb0)">with a long-lived token gets locked out.</text>
</svg>

## Emergency rotation is a different procedure

Everything above assumes a planned rotation, where the old key is trusted right up to retirement. A suspected key compromise inverts the requirement: the old key must stop being trusted *now*, and the cost is that every token signed with it becomes invalid immediately.

That trade cannot be avoided, only prepared for. Short access tokens make the blast radius small — with a fifteen-minute TTL, an emergency revocation inconveniences at most fifteen minutes of sessions, and clients holding refresh tokens signed with a different key recover automatically. With a twelve-hour TTL, the same revocation is an outage for every user.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of planned and emergency rotation showing the trade between overlap and exposure" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Planned versus emergency rotation</title>
  <desc>Two procedures compared. A planned rotation publishes the new key, waits a cache lifetime, switches signing, waits for the longest token to expire and then retires the old key, with zero user impact and an exposure window equal to the overlap. An emergency rotation publishes the new key, switches signing and removes the old key from the JWKS immediately, ending exposure at once but invalidating every outstanding token. A note records that short access token lifetimes are what make the emergency path survivable.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Two procedures, opposite priorities</text>
  <rect x="16" y="42" width="336" height="134" rx="9" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="34" y="66" font-size="11" font-weight="700" fill="var(--viz-good, #1f6b3a)">planned</text>
  <text x="34" y="88" font-size="10" fill="currentColor">publish → wait → switch → wait → retire</text>
  <text x="34" y="110" font-size="10" fill="currentColor">user impact: <tspan font-weight="700" fill="var(--viz-good, #1f6b3a)">none</tspan></text>
  <text x="34" y="130" font-size="10" fill="currentColor">old key trusted for: <tspan font-weight="700">the full overlap</tspan></text>
  <text x="34" y="156" font-size="9.5" fill="var(--muted, #7c6fb0)">the default; schedule it quarterly</text>
  <rect x="368" y="42" width="336" height="134" rx="9" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="386" y="66" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">emergency</text>
  <text x="386" y="88" font-size="10" fill="currentColor">publish → switch → remove old key at once</text>
  <text x="386" y="110" font-size="10" fill="currentColor">user impact: <tspan font-weight="700" fill="var(--viz-bad, #a32b23)">every token invalidated</tspan></text>
  <text x="386" y="130" font-size="10" fill="currentColor">old key trusted for: <tspan font-weight="700">zero</tspan></text>
  <text x="386" y="156" font-size="9.5" fill="var(--muted, #7c6fb0)">survivable only with short token lifetimes</text>
  <text x="20" y="200" font-size="10.5" fill="currentColor">Access token TTL sets the cost of the emergency path: 15 min → a blip; 12 h → an outage.</text>
  <text x="20" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">Rehearse it in staging. The first time this procedure runs should not be the day it is needed.</text>
</svg>

## Gotchas & Failure Modes

- **Switching the signer in the same deploy that publishes the key.** Verifiers with a warm JWKS cache reject every new token until their cache expires. Two deploys, separated by at least the cache lifetime.
- **Refresh tokens sharing the access key.** A 30-day refresh token signed with the access key extends the required overlap to 30 days. Give refresh tokens their own `kid`.
- **JWKS served without cache headers.** Either every verification fetches it, or a CDN caches it for a day and rotation stalls. Set an explicit, modest `max-age`.
- **No `kid` in the header.** Verification still works by trying keys, but you lose the per-key metric that tells you when retirement is safe, and the failure mode on retirement becomes untestable.
- **Retiring on a calendar date.** The last straggler is always a long-lived integration token nobody remembered. Retire on the metric reaching zero, not on the date in the ticket.
- **Rotation without an audit record.** The key change is a security event. Record who rotated, when, and why, alongside the other controls in [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/).

Rehearsing matters because the emergency path exercises code that the planned path never touches: the unknown-key branch of the verifier, the client's reaction to a sudden 401, and whatever automation is meant to notice. Run it against staging once a quarter, with the same people who would run it for real, and time how long the whole sequence takes from decision to fully-rotated. That number is the actual exposure window, and it is invariably longer than anyone estimates.

## Verification Snippet

```bash
# The JWKS must contain BOTH keys during the overlap
curl -s https://auth.example.com/.well-known/jwks.json | jq '.keys[] | {kid, alg, use}'
# {"kid":"2026-02-key","alg":"RS256","use":"sig"}
# {"kid":"2026-08-key","alg":"RS256","use":"sig"}

# A freshly issued token must name the new key
curl -s -X POST https://auth.example.com/token -d @creds.json \
  | jq -r .access_token | cut -d. -f1 | base64 -d 2>/dev/null | jq .kid
# "2026-08-key"
```

```python
def test_tokens_from_both_keys_verify_during_overlap(old_token, new_token):
    for token in (old_token, new_token):
        principal = verify(f"Bearer {token}")
        assert principal.subject
    assert verify(f"Bearer {old_token}").key_id == "2026-02-key"
    assert verify(f"Bearer {new_token}").key_id == "2026-08-key"


def test_unknown_kid_is_401_not_500(token_signed_with_retired_key):
    with pytest.raises(HTTPException) as exc:
        verify(f"Bearer {token_signed_with_retired_key}")
    assert exc.value.status_code == 401
    assert exc.value.detail["error"] == "unknown_signing_key"
```

---

## Related

- [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) — the token model being rotated
- [Validating Spatial Scope Claims in FastAPI Dependencies](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/validating-spatial-scope-claims-in-fastapi-dependencies/) — what happens after verification succeeds
- [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/) — recording the rotation as the security event it is

← Back to [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/)
