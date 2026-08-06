---
layout: layouts/page.njk
title: "Rejecting Invalid Polygons with ST_IsValid"
description: "Self-intersections, unclosed rings and holes outside their shell break ST_Intersects, ST_Area and every tile that touches them. Validate on write, report the exact failure location, and know when to repair instead."
slug: rejecting-invalid-polygons-with-st-isvalid
type: howto
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Strict Pydantic Validation for Geometry"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/"
  - label: "Rejecting Invalid Polygons with ST_IsValid"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/rejecting-invalid-polygons-with-st-isvalid/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Rejecting Invalid Polygons with ST_IsValid",
      "description": "Validate polygon geometry on write, report the exact failure location, and know when to repair instead of reject.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/rejecting-invalid-polygons-with-st-isvalid/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "Strict Pydantic Validation for Geometry", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/" },
        { "@type": "ListItem", "position": 3, "name": "Rejecting Invalid Polygons with ST_IsValid", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/rejecting-invalid-polygons-with-st-isvalid/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Validate Polygon Geometry at the API Boundary",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Check with ST_IsValidDetail", "text": "Use the detail form so the response can name the failure reason and its coordinates." },
        { "@type": "HowToStep", "position": 2, "name": "Enforce in the schema", "text": "Add a CHECK constraint so no writer, including a migration, can insert invalid geometry." },
        { "@type": "HowToStep", "position": 3, "name": "Decide repair versus reject", "text": "Reject interactive writes; repair bulk imports with ST_MakeValid and record what changed." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What actually breaks when an invalid polygon is stored?",
          "acceptedAnswer": { "@type": "Answer", "text": "Predicates give wrong or inconsistent answers — ST_Intersects may return true one way and false the other — ST_Area can return a negative or nonsensical number, and topology-preserving operations such as simplification or union raise a TopologyException. The failure often surfaces far from the insert, inside a tile request or a nightly aggregate, which is what makes it expensive." }
        },
        {
          "@type": "Question",
          "name": "Should the API repair invalid geometry automatically?",
          "acceptedAnswer": { "@type": "Answer", "text": "Not on an interactive write. ST_MakeValid may split a self-intersecting polygon into a multipolygon or drop a degenerate sliver, so silently accepting it means storing something the client did not send. Reject with a clear message there. For bulk imports where rejection means losing a whole file, repair is the pragmatic choice, provided the change is recorded." }
        },
        {
          "@type": "Question",
          "name": "Is the validity check expensive?",
          "acceptedAnswer": { "@type": "Answer", "text": "It is roughly proportional to vertex count: tens of microseconds for a simple parcel, a few milliseconds for a coastline with fifty thousand vertices. On an interactive write that is negligible. On a bulk load of millions of rows it is material, which is why bulk paths validate in batches and often in parallel rather than per row." }
        }
      ]
    }
  ]
}
</script>

← Back to [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/)

# Rejecting invalid polygons with ST_IsValid

This page covers validating polygon topology at the API boundary: what invalidity actually means to PostGIS, how to report it usefully, and where the schema-level backstop belongs.

## Context & When to Use

A polygon can be well-formed JSON, have the right number of coordinates, sit in the right coordinate system, and still be geometrically invalid. The common cases are a ring that crosses itself, a hole that lies outside its shell or overlaps another hole, a ring with fewer than four positions, or a first position that does not equal the last. All of them parse. None of them raise on insert into an untyped column.

The cost arrives later and somewhere else. `ST_Intersects` against an invalid polygon can be inconsistent depending on argument order. `ST_Area` may return a value that is meaningless. `ST_SimplifyPreserveTopology`, which every vector tile request calls, raises `TopologyException` and the tile fails — so a single bad row taken in on Tuesday breaks a map on Friday, and the stack trace points at the tile route rather than at the import.

Validate at the boundary, where the client is still present to be told what is wrong. The shape and range checks in [Validating WKT and GeoJSON with Pydantic v2](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/) run first and catch malformed input; this check runs after and catches input that is well-formed but geometrically impossible.

## Runnable Implementation

```python
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

router = APIRouter(prefix="/v1/features", tags=["features"])

# ST_IsValidDetail returns (valid, reason, location) — everything a client needs
VALIDATE_SQL = """
SELECT (d).valid                        AS valid,
       (d).reason                       AS reason,
       ST_AsGeoJSON((d).location, 6)    AS location,
       ST_NPoints(g)                    AS vertices,
       GeometryType(g)                  AS geom_type
FROM  (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) s,
LATERAL (SELECT ST_IsValidDetail(s.g) AS d) v
"""

INSERT_SQL = """
INSERT INTO features (layer, geom)
VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))
RETURNING id
"""


@router.post("")
async def create_feature(
    payload: dict[str, Any],
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    geometry_json = json_dumps(payload["geometry"])

    async with pool.acquire() as conn:
        check = await conn.fetchrow(VALIDATE_SQL, geometry_json)

        if not check["valid"]:
            # Name the reason AND the coordinates — "invalid geometry" is useless
            raise HTTPException(
                status_code=422,
                detail={
                    "error": "invalid_geometry",
                    "reason": check["reason"],          # e.g. "Self-intersection"
                    "at": json_loads(check["location"]) if check["location"] else None,
                    "vertices": check["vertices"],
                    "hint": "repair the ring locally, or POST to /v1/features:repair",
                },
            )

        feature_id = await conn.fetchval(INSERT_SQL, payload["layer"], geometry_json)

    return {"id": feature_id, "vertices": check["vertices"], "type": check["geom_type"]}
```

The schema-level backstop costs one constraint and covers every writer the API does not control:

```sql
ALTER TABLE features
  ADD CONSTRAINT features_geom_valid CHECK (ST_IsValid(geom)) NOT VALID;

-- Validate existing rows separately: NOT VALID applies the check to new rows
-- immediately and lets you fix the backlog without holding a long lock.
ALTER TABLE features VALIDATE CONSTRAINT features_geom_valid;
```

<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Illustrations of the four common polygon validity failures with the reason string PostGIS reports for each" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The four invalidity cases and what PostGIS calls them</title>
  <desc>Four small polygon sketches. A bow-tie shape whose boundary crosses itself is reported as Self-intersection. A shell with a hole drawn entirely outside it is reported as Hole lies outside shell. Two holes that overlap each other are reported as Holes are nested. A ring whose last position does not repeat its first is reported at parse time as an unclosed ring. Each is annotated with the reason string that appears in the API response so a client can match on it.</desc>
  <rect x="0" y="0" width="720" height="260" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">What invalid looks like, and what the response says</text>
  <path d="M40 60 L150 60 L40 150 L150 150 Z" fill="var(--viz-bad, #a32b23)" fill-opacity="0.16" stroke="var(--viz-bad, #a32b23)" stroke-width="1.8"/>
  <circle cx="95" cy="105" r="5" fill="var(--viz-bad, #a32b23)"/>
  <text x="95" y="180" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">bow-tie</text>
  <text x="95" y="196" text-anchor="middle" font-size="9.5" font-family="monospace" fill="var(--viz-bad, #a32b23)">Self-intersection</text>
  <text x="95" y="212" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">location: the crossing point</text>
  <rect x="200" y="60" width="110" height="90" rx="3" fill="var(--accent, #7c3aed)" fill-opacity="0.12" stroke="var(--accent, #7c3aed)" stroke-width="1.6"/>
  <rect x="322" y="86" width="42" height="38" rx="3" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.8" stroke-dasharray="4,3"/>
  <text x="282" y="180" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">hole outside</text>
  <text x="282" y="196" text-anchor="middle" font-size="9.5" font-family="monospace" fill="var(--viz-bad, #a32b23)">Hole lies outside shell</text>
  <text x="282" y="212" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">location: a hole vertex</text>
  <rect x="400" y="60" width="120" height="90" rx="3" fill="var(--accent, #7c3aed)" fill-opacity="0.12" stroke="var(--accent, #7c3aed)" stroke-width="1.6"/>
  <circle cx="440" cy="105" r="26" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.8"/>
  <circle cx="472" cy="105" r="26" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.8"/>
  <text x="460" y="180" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">overlapping holes</text>
  <text x="460" y="196" text-anchor="middle" font-size="9.5" font-family="monospace" fill="var(--viz-bad, #a32b23)">Holes are nested</text>
  <text x="460" y="212" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">location: an intersection</text>
  <path d="M570 60 L680 60 L680 150 L578 150" fill="none" stroke="var(--viz-warn, #8a5000)" stroke-width="1.8"/>
  <circle cx="570" cy="60" r="4" fill="var(--viz-warn, #8a5000)"/>
  <circle cx="578" cy="150" r="4" fill="var(--viz-warn, #8a5000)"/>
  <text x="625" y="180" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">unclosed ring</text>
  <text x="625" y="196" text-anchor="middle" font-size="9.5" font-family="monospace" fill="var(--viz-warn, #8a5000)">caught at parse</text>
  <text x="625" y="212" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">before ST_IsValid runs</text>
  <text x="20" y="242" font-size="10.5" fill="var(--muted, #7c6fb0)">Returning the reason string and the location turns a support ticket into a client-side fix — the coordinate</text>
  <text x="20" y="256" font-size="10.5" fill="var(--muted, #7c6fb0)">points straight at the vertex the client needs to change.</text>
</svg>

## Key Parameters & Options

| Function | Returns | Use for |
|---|---|---|
| `ST_IsValid(geom)` | boolean | The `CHECK` constraint |
| `ST_IsValidReason(geom)` | text | Logging and quick diagnosis |
| `ST_IsValidDetail(geom)` | (valid, reason, location) | API responses — the location is the valuable part |
| `ST_MakeValid(geom)` | geometry | Bulk repair; may change the geometry type |
| `ST_IsValidDetail(geom, 1)` | ESRI-compatible check | Data originating from ESRI tooling, which permits self-touching rings |
| `CHECK … NOT VALID` | constraint | Enforce for new rows without scanning the backlog |

`NOT VALID` is the one to know when adding the constraint to a live table. It applies to every new write immediately and skips the full-table verification, so the lock is brief; run `VALIDATE CONSTRAINT` later, once the existing invalid rows have been dealt with.

## Repair or reject?

The decision differs by path, and getting it backwards is a common source of both bad data and lost imports.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision matrix mapping write paths to a repair or reject policy" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Repair or reject, by write path</title>
  <desc>Four write paths with their recommended policy. An interactive single-feature POST should reject, because the client is present and can fix the input. A bulk file import should repair with ST_MakeValid and record what changed, because rejecting the file loses everything. A migration from a legacy system should repair and produce a report, since the source cannot be corrected. A partner feed should reject and notify, because silently repairing another organisation's data hides a defect they need to fix at source.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">The policy depends on whether anyone can fix the source</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="34" y="58" font-size="10.5" font-weight="700" fill="currentColor">Write path</text>
  <text x="330" y="58" font-size="10.5" font-weight="700" fill="currentColor">Policy</text>
  <text x="470" y="58" font-size="10.5" font-weight="700" fill="currentColor">Why</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">interactive POST</text>
  <rect x="324" y="76" width="86" height="17" rx="3" fill="var(--viz-bad-soft, #fbe4e1)"/>
  <text x="367" y="89" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">reject 422</text>
  <text x="470" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">the client is present and can fix it</text>
  <line x1="20" y1="100" x2="700" y2="100" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="124" font-size="10.5" fill="currentColor">bulk file import</text>
  <rect x="324" y="112" width="86" height="17" rx="3" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="367" y="125" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">repair + log</text>
  <text x="470" y="124" font-size="9.5" fill="var(--muted, #7c6fb0)">rejecting one row loses the file</text>
  <line x1="20" y1="136" x2="700" y2="136" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="160" font-size="10.5" fill="currentColor">legacy migration</text>
  <rect x="324" y="148" width="86" height="17" rx="3" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="367" y="161" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">repair + report</text>
  <text x="470" y="160" font-size="9.5" fill="var(--muted, #7c6fb0)">the source cannot be corrected</text>
  <line x1="20" y1="172" x2="700" y2="172" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="196" font-size="10.5" fill="currentColor">partner feed</text>
  <rect x="324" y="184" width="86" height="17" rx="3" fill="var(--viz-bad-soft, #fbe4e1)"/>
  <text x="367" y="197" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">reject + notify</text>
  <text x="470" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">silent repair hides their defect</text>
  <text x="20" y="228" font-size="10.5" fill="var(--muted, #7c6fb0)">Whenever repair is chosen, record the original alongside the fixed geometry — a repair is a data change.</text>
</svg>

When repairing, keep evidence:

```sql
INSERT INTO geometry_repairs (feature_id, reason, original_wkb, repaired_at)
SELECT id, ST_IsValidReason(geom), ST_AsBinary(geom), now()
FROM   features WHERE NOT ST_IsValid(geom);

UPDATE features SET geom = ST_MakeValid(geom) WHERE NOT ST_IsValid(geom);
```

## What repair actually does to a shape

`ST_MakeValid` is not a cosmetic fix. It resolves invalidity by changing the geometry, and knowing which change it makes is the difference between an acceptable repair and a silent data loss.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three examples of what ST_MakeValid produces for each kind of invalid input" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Before and after ST_MakeValid</title>
  <desc>Three transformations. A bow-tie polygon becomes a multipolygon of two triangles, changing the geometry type and doubling the part count. A polygon with a hole lying outside its shell becomes a multipolygon containing both the shell and the former hole as separate parts, which is rarely what the author intended. A polygon with a zero-width spike has the spike removed entirely, losing a vertex and a small amount of area. Each is annotated with whether the change is usually acceptable.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">What comes out the other side</text>
  <path d="M30 54 L110 54 L30 118 L110 118 Z" fill="var(--viz-bad, #a32b23)" fill-opacity="0.16" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6"/>
  <text x="124" y="90" font-size="14" fill="var(--muted, #7c6fb0)">→</text>
  <path d="M150 54 L200 54 L175 86 Z" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.18" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <path d="M150 118 L200 118 L175 88 Z" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.18" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="115" y="146" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">Polygon → MultiPolygon</text>
  <text x="115" y="162" text-anchor="middle" font-size="9.5" fill="var(--viz-warn, #8a5000)">type changed — column may reject</text>
  <rect x="250" y="54" width="80" height="64" rx="3" fill="var(--accent, #7c3aed)" fill-opacity="0.12" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <rect x="338" y="70" width="34" height="32" rx="3" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="1.5" stroke-dasharray="4,3"/>
  <text x="384" y="90" font-size="14" fill="var(--muted, #7c6fb0)">→</text>
  <rect x="404" y="54" width="60" height="64" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.16" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <rect x="470" y="70" width="34" height="32" rx="3" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.16" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="377" y="146" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">hole becomes a second part</text>
  <text x="377" y="162" text-anchor="middle" font-size="9.5" fill="var(--viz-bad, #a32b23)">rarely what was intended</text>
  <path d="M540 118 L590 54 L640 118 L590 118 L590 40" fill="var(--accent, #7c3aed)" fill-opacity="0.12" stroke="var(--viz-bad, #a32b23)" stroke-width="1.5"/>
  <text x="652" y="90" font-size="14" fill="var(--muted, #7c6fb0)">→</text>
  <path d="M540 118 L590 54 L640 118 Z" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.18" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4" transform="translate(52,0) scale(0.6 1) translate(360,0)"/>
  <text x="600" y="146" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">spike removed</text>
  <text x="600" y="162" text-anchor="middle" font-size="9.5" fill="var(--viz-good, #1f6b3a)">usually the right fix</text>
  <text x="20" y="196" font-size="10.5" fill="var(--muted, #7c6fb0)">Only the third case is unambiguously an improvement. The first two change what the feature means, which is</text>
  <text x="20" y="212" font-size="10.5" fill="var(--muted, #7c6fb0)">why an interactive write should refuse rather than guess — and why a repair must always be recorded.</text>
</svg>

## Gotchas & Failure Modes

- **`ST_MakeValid` changing the geometry type.** Repairing a self-intersecting `Polygon` frequently yields a `MultiPolygon`, which a typed column rejects with `Geometry type (MultiPolygon) does not match column type (Polygon)`. Type the column as multi, or apply `ST_CollectionExtract(…, 3)`.
- **Validating after the insert.** A `CHECK` catches it, but the client gets a database error rather than a useful message. Validate first, insert second.
- **`ST_IsValid` on a huge geometry inside a request.** A coastline with 200 000 vertices takes tens of milliseconds. Acceptable once, expensive in a loop — batch bulk validation outside the request path.
- **Ignoring the `location` field.** It is the single most useful thing in the response and costs nothing extra to return.
- **A constraint added without `NOT VALID`.** The full-table verification holds a lock for the duration on a large table. Add it `NOT VALID`, clean the backlog, then validate.
- **Repair applied on read.** Wrapping every query in `ST_MakeValid` hides the problem and pays the cost forever. Fix the data once, at write time.

## Keeping the backlog from returning

Adding the constraint stops new invalid rows, but nothing stops the same upstream source producing them again through a path that bypasses the API. Track the rejection rate per source as a metric, and treat a rising rate as a data-quality signal to take back to whoever produces the file, rather than as noise to be filtered out. A partner feed that has produced self-intersecting parcels every month for a year is not a validation problem; it is a conversation nobody has had yet.

## Keeping the backlog from returning

Adding the constraint stops new invalid rows, but nothing stops the same upstream source producing them again through a path that bypasses the API. Track the rejection rate per source as a metric, and treat a rising rate as a data-quality signal to take back to whoever produces the file, rather than as noise to be filtered out. A partner feed that has produced self-intersecting parcels every month for a year is not a validation problem; it is a conversation nobody has had yet.

Repairing on the client's behalf is a last resort, and it is worth being honest with the client when it happens: return the repaired geometry in the response so the caller can see what was stored rather than assuming their payload was accepted verbatim.

## Verification Snippet

```sql
-- Backlog check before adding the constraint
SELECT count(*) FILTER (WHERE NOT ST_IsValid(geom)) AS invalid,
       count(*)                                     AS total
FROM   features;

-- What is wrong, and where
SELECT id, (ST_IsValidDetail(geom)).reason,
       ST_AsText((ST_IsValidDetail(geom)).location)
FROM   features WHERE NOT ST_IsValid(geom) LIMIT 5;
--  id  |      reason       |        st_astext
-- -----+-------------------+--------------------------
--  912 | Self-intersection | POINT(-0.1274 51.5069)
```

```bash
curl -s -X POST localhost:8000/v1/features -H 'content-type: application/json' -d '{
  "layer":"parcels",
  "geometry":{"type":"Polygon","coordinates":[[[0,0],[1,1],[1,0],[0,1],[0,0]]]}}' | jq
# {"detail":{"error":"invalid_geometry","reason":"Self-intersection",
#            "at":{"type":"Point","coordinates":[0.5,0.5]},"vertices":5, ...}}
```

---

## Related

- [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — the validation layer this completes
- [Validating WKT and GeoJSON with Pydantic v2](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/) — the shape checks that run first
- [Handling Async File Uploads for Shapefile Processing](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/) — where repair rather than rejection is the right policy

← Back to [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/)
