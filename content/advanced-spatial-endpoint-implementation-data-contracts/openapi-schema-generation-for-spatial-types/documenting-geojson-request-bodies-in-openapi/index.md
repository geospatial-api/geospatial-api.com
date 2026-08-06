---
layout: layouts/page.njk
title: "Documenting GeoJSON Request Bodies in OpenAPI"
description: "Attach rich, valid GeoJSON examples to FastAPI request bodies with openapi_examples, Body(..., examples=...), and model json_schema_extra so Swagger UI shows a real Polygon and generated clients validate."
slug: "documenting-geojson-request-bodies-in-openapi"
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "OpenAPI Schema Generation for Spatial Types"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/"
  - label: "Documenting GeoJSON Request Bodies in OpenAPI"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/documenting-geojson-request-bodies-in-openapi/"
datePublished: "2025-10-08"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Documenting GeoJSON Request Bodies in OpenAPI",
      "description": "Attach rich, valid GeoJSON examples to FastAPI request bodies with openapi_examples, Body(..., examples=...), and model json_schema_extra so Swagger UI shows a real Polygon and generated clients validate.",
      "datePublished": "2025-10-08",
      "dateModified": "2026-07-10",
      "author": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "OpenAPI Schema Generation for Spatial Types", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/" },
        { "@type": "ListItem", "position": 3, "name": "Documenting GeoJSON Request Bodies in OpenAPI", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/documenting-geojson-request-bodies-in-openapi/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Document GeoJSON request bodies with valid examples in FastAPI",
      "step": [
        { "@type": "HowToStep", "position": 1, "text": "Add a canonical example to the Pydantic model via json_schema_extra." },
        { "@type": "HowToStep", "position": 2, "text": "Attach multiple named request examples with Body(..., openapi_examples=...)." },
        { "@type": "HowToStep", "position": 3, "text": "Ensure lon/lat axis order and closed Polygon rings in every example." },
        { "@type": "HowToStep", "position": 4, "text": "Open /docs and confirm the example round-trips through the endpoint." }
      ]
    },
    {
      "@type": "Article",
      "headline": "Documenting GeoJSON Request Bodies in OpenAPI",
      "datePublished": "2025-10-08",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [OpenAPI Schema Generation for Spatial Types](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/)

# Documenting GeoJSON request bodies in OpenAPI

Attach real, valid GeoJSON examples to a FastAPI request body so Swagger UI shows a usable Polygon instead of `"string"`, and so generated clients ship with example payloads that actually validate.

## Context & when to use

A correct schema tells a consumer what shape a geometry must have; a good *example* tells them what a real one looks like. Without an explicit example, FastAPI synthesises a placeholder from the schema — for a GeoJSON body that means `coordinates: [0]` or `"string"`, which is not valid GeoJSON and cannot be posted from the "Try it out" panel without hand-editing. For a `Polygon`, whose `coordinates` is a triply-nested array of closed rings, no consumer reconstructs a valid value from the schema alone. Examples are what make the docs operable.

Reach for this whenever a route accepts a `Feature`, a raw geometry, or a `FeatureCollection` — which is most write endpoints in a spatial API. It builds directly on the models and discriminated union from [OpenAPI schema generation for spatial types](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/); here we focus purely on the example layer that sits on top of that schema. There are three insertion points — model-level `json_schema_extra`, parameter-level `Body(..., examples=...)`, and the richer `openapi_examples` — and they compose rather than compete.

A word on why examples deserve their own treatment for geometry specifically. Most request bodies are flat objects a consumer can guess — a `name`, an `email`, an integer. GeoJSON is not: a `Polygon`'s `coordinates` is a three-level array (`[[[lon, lat], ...]]`) whose innermost ring must be closed, and the axis order is a convention no type system encodes. A consumer staring at the schema sees "array of array of array of number" and has no way to produce a valid value on the first try. A single, correct, copy-pasteable example removes that friction entirely and is often the difference between an API that gets adopted and one that generates support tickets.

**Preconditions:** FastAPI 0.106+ (for `openapi_examples` on `Body`), Pydantic 2.5+, and the geometry models already defined. Every example you write must validate against the model, or it becomes a lie that generators may propagate.

---

## Data flow: where each example surfaces

<svg viewBox="14 24 732 202" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="How model and parameter examples flow into the OpenAPI document and Swagger UI" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>Example sources merging into the OpenAPI request body</title>
  <desc>Two example sources — model json_schema_extra and Body openapi_examples — merge in FastAPI's schema builder, land in different parts of openapi.json (components schema example versus requestBody examples), and both render in Swagger UI as a selectable example dropdown.</desc>
  <rect x="14" y="24" width="732" height="202" rx="10" fill="var(--surface, #f5f3ff)"/>
  <!-- Left sources -->
  <rect x="30" y="40" width="210" height="60" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="135" y="64" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">model_config</text>
  <text x="135" y="82" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">json_schema_extra → schema.example</text>
  <rect x="30" y="150" width="210" height="60" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="135" y="174" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Body(openapi_examples=)</text>
  <text x="135" y="192" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">named, per-request examples</text>
  <!-- Merge -->
  <rect x="300" y="90" width="170" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="385" y="120" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">FastAPI schema</text>
  <text x="385" y="138" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">builder</text>
  <!-- openapi.json -->
  <rect x="530" y="40" width="200" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="630" y="64" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">/openapi.json</text>
  <text x="630" y="82" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">requestBody.content.examples</text>
  <!-- Swagger -->
  <rect x="530" y="150" width="200" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="630" y="174" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Swagger UI /docs</text>
  <text x="630" y="192" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">example dropdown, prefilled body</text>
  <!-- arrows -->
  <line x1="240" y1="70" x2="300" y2="110" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="240" y1="180" x2="300" y2="140" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="470" y1="115" x2="530" y2="75" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="470" y1="135" x2="530" y2="178" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

---

## Runnable implementation

One file, three example mechanisms layered so Swagger UI shows a selectable set of valid GeoJSON bodies. The models are the discriminated `Feature`/`Geometry` types from the parent guide.

```python
# app/routes/geojson_body.py
from typing import Literal, Annotated, Any, Union
from fastapi import FastAPI, Body
from pydantic import BaseModel, Field

Position = Annotated[list[float], Field(min_length=2, max_length=3,
                                        description="[longitude, latitude] (RFC 7946)")]


class Point(BaseModel):
    type: Literal["Point"]
    coordinates: Position
    # (1) Model-level example: attached to the schema itself, so it appears
    #     wherever this model is referenced — responses included.
    model_config = {
        "json_schema_extra": {
            "example": {"type": "Point", "coordinates": [-0.1278, 51.5074]}
        }
    }


class Polygon(BaseModel):
    type: Literal["Polygon"]
    # A ring must be closed: first position == last position, >= 4 positions.
    coordinates: list[Annotated[list[Position], Field(min_length=4)]]


Geometry = Annotated[Union[Point, Polygon], Field(discriminator="type")]


class Feature(BaseModel):
    type: Literal["Feature"]
    geometry: Geometry
    properties: dict[str, Any] | None = None


app = FastAPI()


@app.post("/zones")
async def create_zone(
    feature: Feature = Body(
        ...,
        # (2) openapi_examples: multiple *named* request examples. Each renders
        #     as an entry in the Swagger "Examples" dropdown. Unlike the older
        #     `examples=[...]` list, these carry a summary and description.
        openapi_examples={
            "point_poi": {
                "summary": "Point of interest",
                "description": "A single Point in EPSG:4326, lon before lat.",
                "value": {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [-0.1278, 51.5074]},
                    "properties": {"name": "Trafalgar Square", "kind": "poi"},
                },
            },
            "polygon_zone": {
                "summary": "Closed Polygon catchment",
                "description": "Note the ring is closed — last == first position.",
                "value": {
                    "type": "Feature",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[
                            [-0.130, 51.500], [-0.120, 51.500],
                            [-0.120, 51.510], [-0.130, 51.510],
                            [-0.130, 51.500],
                        ]],
                    },
                    "properties": {"zone": "central", "kind": "catchment"},
                },
            },
            "invalid_axis_order": {
                "summary": "WRONG — lat/lon swapped (for contrast)",
                "description": "Do not copy: coordinates are [lat, lon]; London lands off Somalia.",
                "value": {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [51.5074, -0.1278]},
                    "properties": {},
                },
            },
        },
    ),
):
    """Accept a GeoJSON Feature. The named examples above populate the
    'Try it out' body; the point_poi and polygon_zone examples validate,
    the invalid_axis_order one is documented deliberately as a counter-example."""
    return {"received_type": feature.geometry.type, "properties": feature.properties}
```

The three counterpart mechanisms, ranked by scope: `json_schema_extra` on the model is broadest (follows the schema everywhere), `openapi_examples` is per-endpoint and richest (named, described, multiple), and the older `Body(..., examples=[...])` list is a lighter middle ground when you only need one or two unnamed samples and do not need summaries.

---

Documentation lands in two very different places, and only some of it survives the trip to a generated client.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Where each documentation artefact shows up: Swagger UI, Generated client" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where each documentation artefact shows up</title>
  <desc>A comparison table. field description: Swagger UI yes, Generated client yes. becomes a docstring example on the model: Swagger UI yes, Generated client no. UI "try it" prefill examples on the route: Swagger UI yes, Generated client no. multiple named cases $ref component name: Swagger UI yes, Generated client yes. becomes the class name json_schema_extra: Swagger UI yes, Generated client partly. passes through verbatim Examples never reach a generated client, so anything a client author must know belongs in a description rather than an example.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Where each documentation artefact shows up</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Swagger UI</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Generated client</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">field description</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">becomes a docstring</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">example on the model</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="460" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">UI "try it" prefill</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">examples on the route</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="460" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">multiple named cases</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">$ref component name</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="460" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">becomes the class name</text>
  <line x1="20" y1="194" x2="700" y2="194" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="216" font-size="10.5" fill="currentColor">json_schema_extra</text>
  <text x="294" y="216" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="216" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="460" y="216" font-size="9.5" fill="var(--muted, #7c6fb0)">passes through verbatim</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">Examples never reach a generated client, so anything a client author must know belongs in a description rather than an example.</text>
</svg>

## Key parameters & options

| Mechanism | Where it lives | Multiple? | Named + described | Best for |
|---|---|---|---|---|
| `model_config["json_schema_extra"]["example"]` | On the Pydantic model | One canonical | No | A default example reused across every route using the model |
| `Body(..., examples=[{...}])` | Endpoint parameter | Yes (list) | No | A couple of quick request samples, no metadata |
| `Body(..., openapi_examples={...})` | Endpoint parameter | Yes (dict) | Yes (`summary`, `description`) | Public docs: labelled valid + counter-examples |
| `Field(..., examples=[...])` | Individual model field | Yes | No | Illustrating one member (e.g. a `properties` shape) |

Notes that matter for geometry specifically:

- `openapi_examples` keys become the dropdown labels — make them human-readable (`polygon_zone`, not `ex2`).
- A `value` in `openapi_examples` is emitted verbatim into `requestBody.content."application/json".examples`; it is **not** re-validated by FastAPI at schema-build time, which is exactly why an invalid example can slip through.
- `json_schema_extra` accepts either a dict or a callable; use the callable form if you need to strip internal fields before publishing.

---

Inline schemas feel convenient at the point of writing and are paid for by every consumer.

<svg viewBox="0 0 720 198" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two ways to describe the same request body: ✕ one inline schema per route versus ✓ one component, referenced" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Two ways to describe the same request body</title>
  <desc>Two panels. ✕ one inline schema per route: geometry described five times five generated classes, subtly different a fix has to be applied five times the UI shows five near-identical shapes ✓ one component, referenced: geometry described once one generated class, reused a fix propagates everywhere the UI links to a single definition The duplication is invisible in the source and glaring in the generated client, which is where it is discovered.</desc>
  <rect x="0" y="0" width="720" height="198" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Two ways to describe the same request body</text>
  <rect x="16" y="40" width="336" height="122" rx="9" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.5"/>
  <text x="34" y="62" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">✕ one inline schema per route</text>
  <text x="34" y="84" font-size="10" fill="currentColor">geometry described five times</text>
  <text x="34" y="106" font-size="10" fill="currentColor">five generated classes, subtly different</text>
  <text x="34" y="128" font-size="10" fill="currentColor">a fix has to be applied five times</text>
  <text x="34" y="150" font-size="10" fill="currentColor">the UI shows five near-identical shapes</text>
  <rect x="368" y="40" width="336" height="122" rx="9" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.5"/>
  <text x="386" y="62" font-size="11" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓ one component, referenced</text>
  <text x="386" y="84" font-size="10" fill="currentColor">geometry described once</text>
  <text x="386" y="106" font-size="10" fill="currentColor">one generated class, reused</text>
  <text x="386" y="128" font-size="10" fill="currentColor">a fix propagates everywhere</text>
  <text x="386" y="150" font-size="10" fill="currentColor">the UI links to a single definition</text>
  <text x="20" y="194" font-size="10.5" fill="var(--muted, #7c6fb0)">The duplication is invisible in the source and glaring in the generated client, which is where it is discovered.</text>
</svg>

## Gotchas & failure modes

- **Example does not validate against its own schema.** FastAPI does not check `openapi_examples` values, so a `Polygon` example with an unclosed ring or a `Point` with a single-element `coordinates` renders happily in `/docs` but 422s the moment someone clicks "Execute". Assert examples in a test (see Verification) so drift fails CI.
- **Coordinate order silently wrong.** `[lat, lon]` is structurally valid GeoJSON — two floats in an array — so nothing rejects it, but the geometry lands in the wrong hemisphere. The `invalid_axis_order` counter-example above exists to teach this; keep every real example in `[lon, lat]` per RFC 7946, matching the enforcement in [validating WKT and GeoJSON with Pydantic v2](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/).
- **Nested Feature example collapses to the geometry only.** If you attach the example to the `Geometry` union but the body type is `Feature`, Swagger shows a bare geometry, not a full Feature. Attach the example at the level that matches the body parameter's type.
- **`example` (singular, 3.0) vs `examples` (3.1) confusion.** On OpenAPI 3.1, `openapi_examples` maps to the `examples` object; a stray top-level `example` key you added by hand may be dropped. Let FastAPI emit the examples rather than hand-editing the document.
- **Giant Polygon example bloats `/openapi.json`.** A 5,000-vertex example makes the schema payload megabytes and slows `/docs` load. Keep example geometries small (a 4–6 vertex ring is plenty); real payloads can be large, documentation examples should not be.
- **Response examples are separate from request examples.** A `json_schema_extra` example on a model flows into *both* the request schema and any response that uses the model, but `openapi_examples` on `Body` is request-only. If you want a documented response, attach the example to the model (or use `responses=` on the route decorator); a request-side example never appears under `responses`.
- **`FeatureCollection` bodies need a whole-collection example, not a per-feature one.** Attaching an example to `Feature` documents a single feature; a route that accepts a `FeatureCollection` still shows a bare `{}` for the collection wrapper unless you attach a full `{"type":"FeatureCollection","features":[...]}` example at the body level. Document at the exact type the endpoint receives.

---

## Verification

Confirm the example is present in the document and that it actually round-trips:

```bash
# 1. The named examples are in the request body
curl -s http://localhost:8000/openapi.json \
  | jq '.paths."/zones".post.requestBody.content."application/json".examples | keys'
# -> ["invalid_axis_order", "point_poi", "polygon_zone"]

# 2. The valid Polygon example round-trips (should return 200)
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8000/zones \
  -H "Content-Type: application/json" \
  -d '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[-0.130,51.500],[-0.120,51.500],[-0.120,51.510],[-0.130,51.510],[-0.130,51.500]]]},"properties":{"zone":"central"}}'
# -> 200
```

Guard every *valid* example against its schema in a test so a bad edit cannot ship:

```python
# tests/test_examples_validate.py
from app.routes.geojson_body import Feature, app

def test_named_examples_validate():
    route = next(r for r in app.routes if getattr(r, "path", "") == "/zones")
    body_field = route.dependant.body_params[0].field_info
    for name, ex in body_field.openapi_examples.items():
        if name.startswith("invalid_"):
            continue  # counter-examples are meant to fail
        Feature.model_validate(ex["value"])  # raises if the example is broken
```

---

## Related

- [OpenAPI Schema Generation for Spatial Types](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/) — the discriminated-union models these examples decorate
- [Generating Typed Clients from Spatial OpenAPI Schemas](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/generating-typed-clients-from-spatial-openapi-schemas/) — where documented examples end up in the generated SDK
- [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — make sure the examples you document are the ones the validator accepts

← Back to [OpenAPI Schema Generation for Spatial Types](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/)
