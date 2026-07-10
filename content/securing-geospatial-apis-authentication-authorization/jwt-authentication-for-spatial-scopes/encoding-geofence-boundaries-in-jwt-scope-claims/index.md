---
layout: layouts/page.njk
title: "Encoding Geofence Boundaries in JWT Scope Claims"
description: "Represent geofence boundaries compactly inside a JWT — H3 cell IDs, geohash prefixes, bbox arrays, or a hash referencing a server-side polygon — without blowing the token size limit."
slug: "encoding-geofence-boundaries-in-jwt-scope-claims"
type: "long_tail"
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "JWT Authentication for Spatial Scopes"
    url: "/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/"
  - label: "Encoding Geofence Boundaries in JWT Scope Claims"
    url: "/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/encoding-geofence-boundaries-in-jwt-scope-claims/"
datePublished: "2026-04-18"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Encoding Geofence Boundaries in JWT Scope Claims",
      "description": "Represent geofence boundaries compactly inside a JWT — H3 cell IDs, geohash prefixes, bbox arrays, or a hash referencing a server-side polygon — without blowing the token size limit.",
      "datePublished": "2026-04-18",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Securing Geospatial APIs", "item": "https://geospatial-api.com/securing-geospatial-apis-authentication-authorization/"},
        {"@type": "ListItem", "position": 2, "name": "JWT Authentication for Spatial Scopes", "item": "https://geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/"},
        {"@type": "ListItem", "position": 3, "name": "Encoding Geofence Boundaries in JWT Scope Claims", "item": "https://geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/encoding-geofence-boundaries-in-jwt-scope-claims/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Encode a geofence boundary compactly inside a JWT claim",
      "step": [
        {"@type": "HowToStep", "position": 1, "text": "Choose an encoding by measuring the fence's shape, size, and required precision."},
        {"@type": "HowToStep", "position": 2, "text": "Cover the polygon with H3 cells or geohash prefixes at a resolution that fits the token budget."},
        {"@type": "HowToStep", "position": 3, "text": "Fall back to a server-side reference plus content hash when the cell set is too large."},
        {"@type": "HowToStep", "position": 4, "text": "Write and read the geo_scope claim, asserting the encoded token stays under the header limit."}
      ]
    },
    {
      "@type": "Article",
      "headline": "Encoding Geofence Boundaries in JWT Scope Claims",
      "datePublished": "2026-04-18",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [JWT Authentication for Spatial Scopes](/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/)

# Encoding geofence boundaries in JWT scope claims

Fit a geofence boundary inside a `geo_scope` claim so the token stays well under the header size limit while still describing the permitted area precisely enough to enforce.

## Context & when to use

A JWT rides in the `Authorization` header on every request, and every reverse proxy and application server caps that header. Nginx defaults to an 8 KB `large_client_header_buffers`; Node's HTTP parser and many CDNs draw the line near the same place. A base64url-encoded token triples quickly once you start embedding geometry, so the naive move — pasting a `POLYGON((...))` with a few thousand vertices into the claim — produces a token that a proxy silently truncates or rejects with `431 Request Header Fields Too Large`. The whole point of putting the fence in the token is lost if the token no longer fits.

You need a compact encoding when the geofence is anything more than a rectangle. Reach for this when a subject's territory is an irregular shape (a delivery zone, a national boundary, a franchise polygon), when you scope many regions into one token, or when several services re-verify the same token per request and every byte is amplified. If the fence genuinely is an axis-aligned rectangle, a `bbox` array is already optimal and you can stop reading; this page is about everything more complex than a box. The encoding you pick here is what the [validating spatial scope claims dependency](/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/validating-spatial-scope-claims-in-fastapi-dependencies/) will parse, and it is one row of the decision matrix in the parent guide on [JWT authentication for spatial scopes](/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/).

---

## Encoding size vs precision

The four practical encodings occupy different points on a size-versus-precision curve. Cheap encodings approximate the boundary with a grid; exact encodings cost bytes or a lookup.

<svg viewBox="0 0 720 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of JWT geofence encodings by token size and boundary precision" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Geofence encoding size vs precision</title>
  <desc>A chart plotting four JWT scope encodings. The horizontal axis is token bytes, low on the left to high on the right. The vertical axis is boundary precision, coarse at the bottom to exact at the top. Bbox array sits low-left as small and coarse. Geohash prefix list sits low-left, small and coarse. H3 cell set sits centre, medium size and medium-to-high precision. Inline WKT polygon sits top-right, large and exact. Server-side reference sits far left near the top, tiny and exact via lookup.</desc>
  <!-- axes -->
  <line x1="70" y1="300" x2="680" y2="300" stroke="var(--muted, #7c6fb0)" stroke-width="1.5"/>
  <line x1="70" y1="300" x2="70" y2="40" stroke="var(--muted, #7c6fb0)" stroke-width="1.5"/>
  <text x="375" y="336" text-anchor="middle" font-size="12" fill="var(--muted, #7c6fb0)" font-weight="600">token size  →  larger</text>
  <text x="24" y="170" text-anchor="middle" font-size="12" fill="var(--muted, #7c6fb0)" font-weight="600" transform="rotate(-90 24 170)">precision  →  exact</text>
  <!-- gridlines -->
  <line x1="70" y1="170" x2="680" y2="170" stroke="var(--border, #c4b5fd)" stroke-width="1" stroke-dasharray="3,4" opacity="0.6"/>
  <line x1="375" y1="300" x2="375" y2="40" stroke="var(--border, #c4b5fd)" stroke-width="1" stroke-dasharray="3,4" opacity="0.6"/>
  <!-- server-side ref: tiny + exact (top-left) -->
  <circle cx="120" cy="80" r="10" fill="var(--accent, #7c3aed)" opacity="0.85"/>
  <text x="138" y="76" font-size="12" fill="currentColor" font-weight="600">server-side ref</text>
  <text x="138" y="92" font-size="10" fill="var(--muted, #7c6fb0)">~50 B · exact via lookup</text>
  <!-- H3 cell set: middle -->
  <circle cx="360" cy="150" r="10" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="378" y="146" font-size="12" fill="currentColor" font-weight="600">H3 cell set</text>
  <text x="378" y="162" font-size="10" fill="var(--muted, #7c6fb0)">16 B/cell · uniform hex</text>
  <!-- geohash prefix list: low-left, coarse -->
  <circle cx="150" cy="250" r="10" fill="var(--accent, #7c3aed)" opacity="0.55"/>
  <text x="168" y="246" font-size="12" fill="currentColor" font-weight="600">geohash prefixes</text>
  <text x="168" y="262" font-size="10" fill="var(--muted, #7c6fb0)">6–12 B/cell · coarse</text>
  <!-- bbox array: low, coarse -->
  <circle cx="255" cy="272" r="10" fill="var(--accent, #7c3aed)" opacity="0.55"/>
  <text x="273" y="276" font-size="12" fill="currentColor" font-weight="600">bbox array</text>
  <text x="273" y="292" font-size="10" fill="var(--muted, #7c6fb0)">rectangle only</text>
  <!-- WKT polygon: top-right, exact + huge -->
  <circle cx="600" cy="70" r="10" fill="var(--accent, #7c3aed)" opacity="0.85"/>
  <text x="588" y="66" font-size="12" fill="currentColor" font-weight="600" text-anchor="end">inline WKT</text>
  <text x="588" y="82" font-size="10" fill="var(--muted, #7c6fb0)" text-anchor="end">exact · can exceed 8 KB</text>
  <!-- danger zone -->
  <line x1="540" y1="40" x2="540" y2="300" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="5,4" opacity="0.8"/>
  <text x="612" y="292" font-size="10" fill="#dc2626" text-anchor="middle">header-limit risk</text>
</svg>

---

## Runnable implementation

The example covers a polygon fence with the H3 cell-set encoding — the best general-purpose choice — plus the server-side-reference fallback for polygons too large to tile cheaply. It builds the claim on the issuer and reads it on the API.

```python
# geofence_encoding.py
# pip install "h3>=4.1" shapely pyjwt[crypto]
import json
import hashlib
import h3
from shapely.geometry import shape, Point

# --- 1. BUILD (issuer side): cover a polygon with H3 cells -------------------

def encode_h3_scope(geojson_polygon: dict, resolution: int = 7) -> dict:
    """
    Fill a GeoJSON polygon with H3 cells at the given resolution.
    res 7 ≈ 5.16 km² per cell; res 8 ≈ 0.74 km²; res 9 ≈ 0.11 km².
    Higher resolution = tighter boundary but many more cells (≈7× per step).
    """
    cells = h3.polygon_to_cells(
        h3.geo_to_h3shape(geojson_polygon), resolution
    )
    cells = sorted(cells)                       # deterministic ordering
    # h3.compact_cells merges full children into a coarser parent -> fewer IDs
    compacted = sorted(h3.compact_cells(cells))
    return {"srid": 4326, "encoding": "h3", "res": resolution, "regions": compacted}


def encode_server_ref(fence_id: str, geojson_polygon: dict) -> dict:
    """
    When the H3 cell set is still too large, store the polygon server-side and
    put only a stable content hash in the token. The API resolves the hash to
    the polygon and confirms it has not been swapped out underneath the token.
    """
    canonical = json.dumps(geojson_polygon, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode()).hexdigest()[:16]
    return {"srid": 4326, "encoding": "ref",
            "regions": [{"ref": f"fence:{fence_id}", "hash": digest}]}


# --- 2. READ (API side): is a point inside the scoped cells? -----------------

def point_in_h3_scope(lon: float, lat: float, claim: dict) -> bool:
    """Membership test with no database round-trip: O(1) per scoped cell."""
    res = claim["res"]
    target = h3.latlng_to_cell(lat, lon, res)
    scoped = set(claim["regions"])
    if target in scoped:
        return True
    # A compacted claim may hold coarse parents; walk the target up to res floor
    for parent_res in range(res - 1, 0, -1):
        if h3.cell_to_parent(target, parent_res) in scoped:
            return True
    return False


# --- 3. Guardrail: reject a claim that would overflow the header -------------

MAX_SCOPE_BYTES = 4096   # leave headroom under the ~8 KB header limit after base64

def assert_within_budget(claim: dict) -> dict:
    encoded = json.dumps(claim, separators=(",", ":"))
    size = len(encoded.encode())
    if size > MAX_SCOPE_BYTES:
        raise ValueError(
            f"geo_scope is {size} B (> {MAX_SCOPE_BYTES}); coarsen the H3 "
            f"resolution or switch encoding to 'ref'."
        )
    return claim


if __name__ == "__main__":
    poly = {"type": "Polygon", "coordinates": [[
        [-2.71, 51.32], [-2.28, 51.32], [-2.28, 51.53],
        [-2.71, 51.53], [-2.71, 51.32]]]}
    scope = assert_within_budget(encode_h3_scope(poly, resolution=7))
    print(f"cells={len(scope['regions'])}  "
          f"bytes={len(json.dumps(scope, separators=(',', ':')))}")
    # Bath sits inside; central London does not
    print(point_in_h3_scope(-2.5, 51.4, scope))   # True
    print(point_in_h3_scope(-0.1, 51.5, scope))    # False
```

---

## Key parameters & options

| Parameter / knob | Controls | Guidance |
|---|---|---|
| Header limit | Hard ceiling on the whole token | Nginx `large_client_header_buffers` default 8 KB; keep the claim under ~4 KB |
| `MAX_SCOPE_BYTES` | Your own budget for `geo_scope` | 4096 B leaves room for registered claims + base64 expansion |
| H3 `resolution` | Cell size vs cell count | res 7 ≈ 5 km²; each +1 step ≈7× more cells and ~7× tighter boundary |
| `h3.compact_cells` | Merges full child cells into parents | Always apply before encoding; can cut cell count 3–10× on solid regions |
| geohash prefix length | Cell size (chars) | 5 chars ≈ 4.9 km × 4.9 km; 6 chars ≈ 1.2 km × 0.6 km |
| `ref` + `hash` | Token size vs a lookup | Fixed ~50 B; requires a server-side fetch and a hash re-check on read |
| `srid` | Coordinate reference of the scope | Fix to 4326 unless the fence is authored in a projected CRS |

Choosing among these is a size-versus-precision decision; the [parent decision matrix](/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) tabulates the same encodings against query mapping and use case. The encoded region describes *permission*, not feature data, so keep it minimal — it is an access-control artefact, not a payload.

---

## Gotchas & failure modes

- **`431 Request Header Fields Too Large` from the proxy, not the app.** An oversized token is rejected before FastAPI runs, so you see no application log. Reproduce with `curl -v` and watch for the 431 on the proxy; the fix is a coarser H3 resolution or the `ref` encoding, never raising the proxy buffer to hide the problem.
- **Forgetting `compact_cells` bloats the token silently.** A solid res-9 polygon over a city can be tens of thousands of cells; compaction to mixed resolutions cuts that dramatically. Skipping it is the most common cause of a token that "randomly" exceeds the budget for larger fences.
- **H3 cell coverage over-includes the boundary.** `polygon_to_cells` returns every cell whose centre falls in the polygon; edge cells extend slightly beyond the true boundary, so a point just outside the fence can test inside. For hard boundaries, either raise the resolution near the edge or keep the exact polygon server-side via `ref` and test with `ST_Within`.
- **`h3` v3 vs v4 API drift.** v4 renamed functions (`geo_to_h3` → `latlng_to_cell`, `h3_to_parent` → `cell_to_parent`). Pin `h3>=4.1` and expect `AttributeError: module 'h3' has no attribute 'geo_to_h3'` if a v3 snippet is copied in.
- **Reference hash not re-checked on read.** If you store the polygon server-side but never compare its current hash to the claim's `hash`, an operator who edits the fence silently changes what an already-issued token permits. Re-hash the fetched polygon and reject on mismatch.

---

## Verification

Confirm the encoded scope both fits the budget and enforces correctly:

```bash
python geofence_encoding.py
# cells=… bytes=…   (bytes must be < 4096)
# True
# False
```

```python
# assert the encoded token itself stays under the header limit
import jwt, json
from geofence_encoding import encode_h3_scope, assert_within_budget
poly = {"type": "Polygon", "coordinates": [[
    [-2.71, 51.32], [-2.28, 51.32], [-2.28, 51.53], [-2.71, 51.53], [-2.71, 51.32]]]}
scope = assert_within_budget(encode_h3_scope(poly, 7))
token = jwt.encode({"sub": "svc-test", "geo_scope": scope},
                   open("jwt-private.pem").read(), algorithm="RS256")
assert len(token) < 8192, "token exceeds the 8 KB header budget"
print(f"token bytes = {len(token)}")
```

---

## Related

- [JWT Authentication for Spatial Scopes](/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) — the parent guide with the full encoding decision matrix and the signing/verification pipeline
- [Validating Spatial Scope Claims in FastAPI Dependencies](/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/validating-spatial-scope-claims-in-fastapi-dependencies/) — parse and enforce whichever encoding you chose here inside a reusable dependency
- [Bounding-Box Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — the `ST_Within` / `ST_Intersects` predicates used when a `ref`-encoded polygon is resolved against PostGIS

← Back to [JWT Authentication for Spatial Scopes](/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/)
