---
layout: layouts/page.njk
title: "OpenAPI Schema Generation for Spatial Types"
description: "Make FastAPI emit correct OpenAPI 3.1 / JSON Schema for GeoJSON geometry types. Pydantic v2 models for RFC 7946, discriminated unions on the type field, json_schema_extra examples, and schema customisation so docs and generated clients are accurate."
slug: "openapi-schema-generation-for-spatial-types"
type: "cluster"
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "OpenAPI Schema Generation for Spatial Types"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/"
datePublished: "2025-09-02"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "OpenAPI Schema Generation for Spatial Types",
      "description": "Make FastAPI emit correct OpenAPI 3.1 / JSON Schema for GeoJSON geometry types. Pydantic v2 models for RFC 7946, discriminated unions on the type field, json_schema_extra examples, and schema customisation so docs and generated clients are accurate.",
      "datePublished": "2025-09-02",
      "dateModified": "2026-07-10",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com", "url": "https://geospatial-api.com" },
      "mainEntityOfPage": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/"
    },
    {
      "@type": "Article",
      "headline": "OpenAPI Schema Generation for Spatial Types",
      "datePublished": "2025-09-02",
      "dateModified": "2026-07-10"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 3, "name": "OpenAPI Schema Generation for Spatial Types", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Generate correct OpenAPI schemas for GeoJSON geometry types in FastAPI",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Model RFC 7946 geometry types as Pydantic v2 models" },
        { "@type": "HowToStep", "position": 2, "name": "Combine geometry models into a discriminated union on the type field" },
        { "@type": "HowToStep", "position": 3, "name": "Attach json_schema_extra examples and SRID/axis-order documentation" },
        { "@type": "HowToStep", "position": 4, "name": "Customise the emitted schema with __get_pydantic_json_schema__ or WithJsonSchema" },
        { "@type": "HowToStep", "position": 5, "name": "Verify the output by inspecting /openapi.json and Swagger UI" }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does my GeoJSON geometry appear as an empty object in the OpenAPI schema?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "An empty {} schema means Pydantic could not introspect the field type. It happens when you type a body as a bare dict, use a plain typing.Any, or annotate with a Shapely geometry class that has no __get_pydantic_core_schema__. Replace the loose type with a typed GeoJSON Pydantic model, or attach an explicit schema via WithJsonSchema so FastAPI has a concrete shape to emit."
          }
        },
        {
          "@type": "Question",
          "name": "How do I make Swagger UI show the correct geometry variant instead of a generic union?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Model each geometry as its own Pydantic model with a Literal type field, then combine them with typing.Annotated[Union[...], Field(discriminator='type')]. Pydantic v2 emits a oneOf with a discriminator mapping keyed on the type property, and Swagger UI renders a dropdown so a user can pick Point, LineString, or Polygon and see the matching schema."
          }
        },
        {
          "@type": "Question",
          "name": "Do I need OpenAPI 3.1 for GeoJSON, or does 3.0 work?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "FastAPI emits OpenAPI 3.1 by default since 0.99, which aligns the schema dialect with JSON Schema 2020-12. That matters for GeoJSON because 3.1 supports the prefixItems and full oneOf/discriminator semantics that coordinate tuples and geometry unions rely on. On OpenAPI 3.0 a position array degrades to a loose array of numbers and the discriminator mapping is more restricted, so prefer 3.1 for spatial APIs."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Advanced Spatial Endpoints & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/)

# OpenAPI schema generation for spatial types

The moment a geospatial API grows past a single consumer, its OpenAPI document stops being documentation and becomes a contract: Swagger UI renders it, `openapi-python-client` and `openapi-generator` compile it into typed SDKs, and QA suites diff it for breaking changes. When that document describes a GeoJSON `geometry` field as an anonymous `{}`, every downstream artefact inherits the ambiguity — the docs show no example, the generated client types the field as `Any`, and validation that should happen client-side silently moves to runtime. This guide makes FastAPI emit correct, useful OpenAPI 3.1 (JSON Schema 2020-12) for [RFC 7946](https://www.rfc-editor.org/rfc/rfc7946) geometry types so the contract is precise enough to generate clients from.

FastAPI derives its schema entirely from Pydantic v2. That is the leverage point: if the Pydantic models are shaped correctly, the OpenAPI output is correct for free. The work is almost never in FastAPI — it is in modelling `Point`, `LineString`, `Polygon`, `Feature`, and `FeatureCollection` so Pydantic's core schema, and the JSON Schema it derives, describe real GeoJSON. This page fits inside the broader [Advanced Spatial Endpoints & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/) area and builds directly on [strict Pydantic validation for geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/); validation shapes *what is accepted*, schema generation shapes *what is documented*.

---

## Architecture Overview

The pipeline from a Python type annotation to a generated client is a straight line, and every stage degrades if the previous one is loose. The diagram traces that path and marks where the two common failure modes — an empty geometry schema and a broken discriminator — are introduced.

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Schema generation pipeline from Pydantic models to a generated client" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>From Pydantic geometry models to a typed client</title>
  <desc>Four stacked stages: Pydantic v2 geometry models with a discriminated union feed FastAPI's schema generator, which emits openapi.json containing a oneOf with a discriminator, which Swagger UI renders and code generators compile into typed clients. Two callouts mark where an empty schema and a discriminator error are introduced.</desc>
  <!-- Stage 1 -->
  <rect x="40" y="24" width="480" height="66" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="280" y="50" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">1 · Pydantic v2 models</text>
  <text x="280" y="70" text-anchor="middle" font-size="11" fill="currentColor">Point · LineString · Polygon · Feature — Literal type + Annotated union discriminator</text>
  <text x="280" y="84" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">source of truth: get the core schema right here</text>
  <!-- Stage 2 -->
  <rect x="40" y="118" width="480" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="280" y="143" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">2 · FastAPI schema generator</text>
  <text x="280" y="163" text-anchor="middle" font-size="11" fill="currentColor">model_json_schema() · $defs · components/schemas · OpenAPI 3.1</text>
  <!-- Stage 3 -->
  <rect x="40" y="206" width="480" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="280" y="231" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">3 · /openapi.json</text>
  <text x="280" y="251" text-anchor="middle" font-size="11" fill="currentColor">oneOf + discriminator.mapping · prefixItems position · examples</text>
  <!-- Stage 4 -->
  <rect x="40" y="294" width="480" height="34" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="280" y="316" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">4 · Swagger UI  +  generated Python / TypeScript clients</text>
  <!-- arrows -->
  <line x1="280" y1="90" x2="280" y2="116" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="280" y1="178" x2="280" y2="204" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="280" y1="266" x2="280" y2="292" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Callouts -->
  <rect x="556" y="30" width="168" height="54" rx="6" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.3"/>
  <text x="640" y="50" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent, #7c3aed)">bare dict / Any here</text>
  <text x="640" y="66" text-anchor="middle" font-size="10" fill="currentColor">⇒ geometry renders</text>
  <text x="640" y="79" text-anchor="middle" font-size="10" fill="currentColor">as empty {} downstream</text>
  <rect x="556" y="200" width="168" height="66" rx="6" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.3"/>
  <text x="640" y="220" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent, #7c3aed)">missing Literal type</text>
  <text x="640" y="236" text-anchor="middle" font-size="10" fill="currentColor">⇒ discriminator error</text>
  <text x="640" y="250" text-anchor="middle" font-size="10" fill="currentColor">or generic anyOf with</text>
  <text x="640" y="262" text-anchor="middle" font-size="10" fill="currentColor">no client dropdown</text>
  <line x1="556" y1="57" x2="522" y2="57" stroke="var(--accent, #7c3aed)" stroke-width="1.2" stroke-dasharray="3 2"/>
  <line x1="556" y1="233" x2="522" y2="233" stroke="var(--accent, #7c3aed)" stroke-width="1.2" stroke-dasharray="3 2"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

---

## Prerequisites & Environment

Schema fidelity for GeoJSON depends on recent Pydantic and FastAPI releases — OpenAPI 3.1 output and the `json_schema_input_type` hooks are relatively new.

| Component | Minimum version | Why it matters here |
|---|---|---|
| Python | 3.10+ | `X | Y` union syntax and `typing.Annotated` ergonomics |
| FastAPI | 0.106+ | Emits OpenAPI 3.1; supports `openapi_examples` on `Body` |
| Pydantic | 2.5+ | Stable `__get_pydantic_json_schema__`, `WithJsonSchema`, `Discriminator` |
| pydantic-core | 2.14+ | `prefixItems` output for fixed-length coordinate tuples |
| Uvicorn | 0.24+ | Serves `/openapi.json` and `/docs` during verification |

```bash
pip install "fastapi>=0.106" "pydantic>=2.5" "uvicorn>=0.24"
```

Confirm the emitted OpenAPI version before doing anything else — every recommendation below assumes 3.1:

```python
from fastapi import FastAPI
app = FastAPI()
print(app.openapi()["openapi"])   # -> "3.1.0"
```

If you see `3.0.x`, upgrade FastAPI; on 3.0 the coordinate `prefixItems` and the discriminator `mapping` degrade and the models below will not document as shown.

---

## Decision Matrix: how to type a geometry field

Three approaches dominate, and the right one depends on how much you trust the payload and how badly you need an accurate contract. This is the analytical anchor for everything that follows.

| Approach | OpenAPI output | Client codegen result | Validation | Use when |
|---|---|---|---|---|
| Loose `dict` / `dict[str, Any]` | Empty `{}` (freeform object) | Field typed as `Any` / `Record<string, unknown>` | None at the boundary | Prototypes, opaque pass-through storage |
| Typed GeoJSON Pydantic models | `oneOf` of `Point`/`LineString`/… with `discriminator` | Tagged union / sum type, real classes | Full structural + coordinate checks | Public APIs, generated SDKs, map frontends |
| Custom `Annotated` type (`WithJsonSchema`) | Exactly the schema you hand-write | Whatever you declared | Your validator, decoupled from schema | Wrapping Shapely/`geoalchemy2`, legacy shapes |

The middle row is the default recommendation for any endpoint whose clients you do not control. The loose `dict` is defensible only where the geometry is genuinely opaque to your service, and even then you pay for it the first time someone generates a client. The custom `Annotated` route matters when the runtime object is not a Pydantic model at all — a Shapely geometry or a `geoalchemy2` element — and you need to bolt a JSON Schema onto it so the contract stays honest. These trade-offs echo the format decision covered in [GeoJSON vs GeoParquet serialisation](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/); the serialisation format you choose determines which of these response schemas you actually emit.

---

## Step-by-Step Implementation

### Step 1: Model each geometry type per RFC 7946

Every GeoJSON geometry has a `type` field with a fixed string value and a `coordinates` field whose nesting depth encodes the geometry. Model the `type` as a `Literal` — this is the single most important detail, because the literal is what makes the discriminated union work later and what stops the schema collapsing to a generic object.

```python
# app/geojson.py
from typing import Literal, Annotated
from pydantic import BaseModel, Field

# A GeoJSON position is [lon, lat] (RFC 7946 §3.1.1) with optional elevation.
# Annotated with min/max length so pydantic-core emits prefixItems, not a
# loose "array of number".
Position = Annotated[list[float], Field(min_length=2, max_length=3)]


class Point(BaseModel):
    type: Literal["Point"]
    coordinates: Position
    model_config = {
        "json_schema_extra": {
            "examples": [{"type": "Point", "coordinates": [-0.1278, 51.5074]}]
        }
    }


class LineString(BaseModel):
    type: Literal["LineString"]
    coordinates: Annotated[list[Position], Field(min_length=2)]


class Polygon(BaseModel):
    type: Literal["Polygon"]
    # Array of linear rings; each ring is >= 4 positions and closed.
    coordinates: list[Annotated[list[Position], Field(min_length=4)]]
    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "type": "Polygon",
                    "coordinates": [
                        [[-0.13, 51.50], [-0.12, 51.50],
                         [-0.12, 51.51], [-0.13, 51.51], [-0.13, 51.50]]
                    ],
                }
            ]
        }
    }
```

The `Field(min_length=2, max_length=3)` on `Position` is what makes Pydantic emit a bounded array. RFC 7946 requires longitude before latitude; that convention is not expressible in JSON Schema structurally, so it belongs in the field description and the examples — never assume a consumer knows the axis order. Coordinate-range and closed-ring enforcement is validation, not schema, and is covered in [validating WKT and GeoJSON with Pydantic v2](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/validating-wkt-and-geojson-with-pydantic-v2/).

### Step 2: Combine geometries into a discriminated union

A GeoJSON `geometry` member can be any geometry type. Represent that with `typing.Annotated[Union[...], Field(discriminator="type")]`. Pydantic v2 reads the shared `Literal` field and emits a `oneOf` plus a `discriminator.mapping` — the exact construct Swagger UI turns into a variant dropdown and code generators turn into a tagged union.

```python
from typing import Union

Geometry = Annotated[
    Union[Point, LineString, Polygon],
    Field(discriminator="type"),
]
```

Without the discriminator you still get a `oneOf`, but validation becomes "try each until one matches" and generators fall back to an untagged union that clients must narrow by hand. With it, both validation and codegen key off `type` directly.

### Step 3: Wrap geometries in Feature and FeatureCollection

```python
from typing import Any

class Feature(BaseModel):
    type: Literal["Feature"]
    geometry: Geometry
    properties: dict[str, Any] | None = None
    id: str | int | None = None


class FeatureCollection(BaseModel):
    type: Literal["FeatureCollection"]
    features: list[Feature]
```

`properties` is deliberately `dict | None` — RFC 7946 allows any JSON object or `null`, never an array. Typing it as `dict[str, Any] | None` documents exactly that and prevents a client from generating a `properties: never[]` type.

### Step 4: Customise the schema where introspection is not enough

When the runtime value is not a Pydantic model — for example a Shapely geometry returned by a repository — attach a schema explicitly. Two mechanisms exist. `WithJsonSchema` is the lightweight one:

```python
from pydantic import WithJsonSchema

GeometrySchema = Annotated[
    dict,
    WithJsonSchema(
        {
            "type": "object",
            "required": ["type", "coordinates"],
            "properties": {
                "type": {"type": "string",
                         "enum": ["Point", "LineString", "Polygon"]},
                "coordinates": {"type": "array"},
            },
            "description": "GeoJSON geometry, RFC 7946, [lon, lat] axis order.",
        }
    ),
]
```

For a reusable named component, implement `__get_pydantic_json_schema__` on a wrapper type so the geometry appears once under `components/schemas` and is referenced by `$ref` everywhere:

```python
from pydantic import GetJsonSchemaHandler
from pydantic.json_schema import JsonSchemaValue
from pydantic_core import core_schema


class GeoJSONGeometry:
    @classmethod
    def __get_pydantic_core_schema__(cls, source, handler):
        # Accept any dict at runtime; validation happens elsewhere.
        return core_schema.no_info_plain_validator_function(lambda v: v)

    @classmethod
    def __get_pydantic_json_schema__(
        cls, schema: core_schema.CoreSchema, handler: GetJsonSchemaHandler
    ) -> JsonSchemaValue:
        return {
            "type": "object",
            "title": "GeoJSONGeometry",
            "required": ["type", "coordinates"],
            "properties": {
                "type": {"type": "string"},
                "coordinates": {"type": "array"},
            },
            "example": {"type": "Point", "coordinates": [-0.1278, 51.5074]},
        }
```

Prefer the typed models from Steps 1–3 whenever you can; reach for these hooks only to wrap objects Pydantic cannot introspect.

---

## Production Code Example

A cohesive endpoint that accepts a `Feature`, echoes it back, and documents SRID and axis-order conventions in the OpenAPI metadata. This is copy-runnable given `app/geojson.py` above.

```python
# app/main.py
from fastapi import FastAPI, Body
from app.geojson import Feature, FeatureCollection, Geometry

app = FastAPI(
    title="Spatial Features API",
    version="1.0.0",
    description=(
        "All geometries are GeoJSON (RFC 7946) in EPSG:4326 with [lon, lat] "
        "axis order. SRID is fixed at 4326; reproject client-side before POST."
    ),
)


@app.post(
    "/features",
    response_model=Feature,
    summary="Create a spatial feature",
    response_description="The stored feature, echoed with a server-assigned id.",
)
async def create_feature(
    feature: Feature = Body(
        ...,
        openapi_examples={
            "point": {
                "summary": "A single Point (London)",
                "value": {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [-0.1278, 51.5074]},
                    "properties": {"name": "Trafalgar Square"},
                },
            },
            "polygon": {
                "summary": "A Polygon catchment area",
                "value": {
                    "type": "Feature",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[
                            [-0.13, 51.50], [-0.12, 51.50],
                            [-0.12, 51.51], [-0.13, 51.51], [-0.13, 51.50],
                        ]],
                    },
                    "properties": {"zone": "central"},
                },
            },
        },
    ),
):
    """Persist a feature. The discriminated `geometry` union is documented as a
    oneOf keyed on the `type` field, so Swagger UI renders a variant selector."""
    stored = feature.model_copy(update={"id": feature.id or 42})
    return stored


@app.get("/features", response_model=FeatureCollection)
async def list_features() -> FeatureCollection:
    """Return a FeatureCollection. `response_model` drives the response schema
    so the generated client knows features[] is a list of tagged geometries."""
    return FeatureCollection(type="FeatureCollection", features=[])
```

Because the request body is a typed `Feature` and the geometry is an `Annotated` discriminated union, `/openapi.json` now carries a `oneOf` with a `discriminator.mapping`, per-variant `examples`, and two request-level `openapi_examples`. Attaching rich, valid request-body examples is worth a page of its own — see [documenting GeoJSON request bodies in OpenAPI](/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/documenting-geojson-request-bodies-in-openapi/) for `Body(..., examples=...)`, `openapi_examples`, and the round-trip gotchas.

---

## Verification & Testing

**Inspect the raw schema.** The geometry component must be a `oneOf` with a discriminator, not an empty object:

```bash
curl -s http://localhost:8000/openapi.json \
  | jq '.components.schemas.Feature.properties.geometry'
```

Expected shape:

```json
{
  "oneOf": [
    { "$ref": "#/components/schemas/Point" },
    { "$ref": "#/components/schemas/LineString" },
    { "$ref": "#/components/schemas/Polygon" }
  ],
  "discriminator": {
    "propertyName": "type",
    "mapping": {
      "Point": "#/components/schemas/Point",
      "LineString": "#/components/schemas/LineString",
      "Polygon": "#/components/schemas/Polygon"
    }
  }
}
```

**Confirm the coordinate tuple is bounded** (this is the tell that `prefixItems`/`min_length` took effect, not a loose array):

```bash
curl -s http://localhost:8000/openapi.json \
  | jq '.components.schemas.Point.properties.coordinates'
# -> { "type": "array", "items": {"type":"number"}, "minItems": 2, "maxItems": 3 }
```

**Open Swagger UI** at `http://localhost:8000/docs` and confirm the `POST /features` body shows a *Point / LineString / Polygon* selector and that the "point" and "polygon" named examples appear in the dropdown.

**Assert the schema in a unit test** so schema drift fails CI:

```python
# tests/test_openapi_schema.py
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_geometry_is_discriminated_union():
    schema = client.get("/openapi.json").json()
    geom = schema["components"]["schemas"]["Feature"]["properties"]["geometry"]
    assert "oneOf" in geom, "geometry collapsed to a non-union schema"
    assert geom["discriminator"]["propertyName"] == "type"
    assert set(geom["discriminator"]["mapping"]) == {"Point", "LineString", "Polygon"}

def test_point_coordinates_are_bounded():
    schema = client.get("/openapi.json").json()
    coords = schema["components"]["schemas"]["Point"]["properties"]["coordinates"]
    assert coords["minItems"] == 2 and coords["maxItems"] == 3
```

---

## Failure Modes & Edge Cases

1. **Geometry renders as an empty `{}` in the schema.** The field is typed as a bare `dict`, `typing.Any`, or a Shapely class with no Pydantic integration. Pydantic has nothing to introspect and emits a freeform object; generators then type the field `Any`. Fix: use the typed models from Steps 1–3, or attach `WithJsonSchema` / `__get_pydantic_json_schema__`.

2. **`PydanticUserError: Model 'Point' needs field 'type' to be a Literal`-style discriminator error.** The union members do not all share a `Literal` discriminator field, or one member uses a plain `str`. Every branch of a discriminated union must declare `type: Literal["..."]` with a distinct value. Audit each model before adding it to the union.

3. **`oneOf` present but no `discriminator` mapping.** You built `Union[Point, LineString]` without `Field(discriminator="type")`. Validation still works by trial, but Swagger UI shows no selector and generated clients produce an untagged union. Wrap the union in `Annotated[..., Field(discriminator="type")]`.

4. **Coordinates document as an unbounded `"array of number"`.** You typed `coordinates: list[float]` without length constraints. Add `Annotated[list[float], Field(min_length=2, max_length=3)]` so pydantic-core emits `minItems`/`maxItems`. Without bounds, a client can send a 1-element or 50-element position and the schema will not flag it.

5. **`properties` documented as `array` or missing entirely.** Typing it as `dict` alone omits the nullable case; typing it as `list` violates RFC 7946. Use `dict[str, Any] | None = None`. On OpenAPI 3.0 (not 3.1) the `| None` is emitted as `nullable: true`; confirm your `openapi` version if the null branch is missing.

6. **Duplicate inline geometry schemas bloat the document.** Redefining the geometry inline on every route inflates `/openapi.json` and produces divergent client types. Define the geometry once as a named model or `Annotated` alias and reference it; Pydantic hoists shared models into `$defs` / `components/schemas` and reuses the `$ref`.

7. **`json_schema_extra` example that fails its own schema.** An example with `coordinates` as `[lat, lon]` or a three-position "closed" ring that is not actually closed will mislead every consumer and can break generators that validate examples. Keep examples valid against the model — see the round-trip check in the request-bodies guide.

---

## Performance Notes

**Schema generation is a startup cost, then cached.** FastAPI builds the OpenAPI document lazily on first request to `/openapi.json` and caches it on `app.openapi_schema`. For a spatial API with a handful of geometry models the build is a few milliseconds; the discriminated union adds negligible overhead because Pydantic resolves the `$defs` once. Do not disable the cache — regenerating on every request under load turns a metadata endpoint into a CPU sink.

**Validation cost, not schema cost, is where geometry hurts.** The schema is emitted once; validation runs per request. A discriminated union is *faster* to validate than an untagged one: pydantic-core reads the `type` discriminator and dispatches to a single branch instead of attempting each member. For large `FeatureCollection` payloads the win compounds — an untagged `Union[Point, LineString, Polygon]` tries up to three validators per feature, a discriminated union tries exactly one.

**Keep the model tree shallow.** Deeply nested `Annotated` chains (position → ring → polygon → multipolygon) are fine for schema output but each layer adds a validator frame. If you accept multi-thousand-vertex `Polygon` bodies, validate structure with Pydantic and defer heavy geometric checks (`ST_IsValid`, ring orientation) to PostGIS, consistent with the two-layer approach in [strict Pydantic validation for geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/).

**Generated clients inherit your model count.** Every named schema becomes a class in the SDK. Five clean geometry models generate five tidy classes; fifty inline variants generate a sprawl. Consolidating on the shared `Geometry` alias keeps both `/openapi.json` and the generated client small — the concern picked up in [generating typed clients from spatial OpenAPI schemas](/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/generating-typed-clients-from-spatial-openapi-schemas/).

---

## FAQ

### Why does my GeoJSON geometry appear as an empty object in the OpenAPI schema?

An empty `{}` schema means Pydantic could not introspect the field type. It happens when you type a body as a bare `dict`, use a plain `typing.Any`, or annotate with a Shapely geometry class that has no `__get_pydantic_core_schema__`. Replace the loose type with a typed GeoJSON Pydantic model, or attach an explicit schema via `WithJsonSchema` so FastAPI has a concrete shape to emit.

### How do I make Swagger UI show the correct geometry variant instead of a generic union?

Model each geometry as its own Pydantic model with a `Literal` `type` field, then combine them with `typing.Annotated[Union[...], Field(discriminator="type")]`. Pydantic v2 emits a `oneOf` with a `discriminator` mapping keyed on the `type` property, and Swagger UI renders a dropdown so a user can pick `Point`, `LineString`, or `Polygon` and see the matching schema.

### Do I need OpenAPI 3.1 for GeoJSON, or does 3.0 work?

FastAPI emits OpenAPI 3.1 by default since 0.99, which aligns the schema dialect with JSON Schema 2020-12. That matters for GeoJSON because 3.1 supports the `prefixItems` and full `oneOf`/`discriminator` semantics that coordinate tuples and geometry unions rely on. On OpenAPI 3.0 a position array degrades to a loose array of numbers and the discriminator mapping is more restricted, so prefer 3.1 for spatial APIs.

---

## Related

- [Documenting GeoJSON Request Bodies in OpenAPI](/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/documenting-geojson-request-bodies-in-openapi/) — attach valid Polygon examples with `openapi_examples` and `Body(..., examples=...)`
- [Generating Typed Clients from Spatial OpenAPI Schemas](/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/generating-typed-clients-from-spatial-openapi-schemas/) — compile the spatial `openapi.json` into typed Python and TypeScript SDKs
- [Strict Pydantic Validation for Geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — enforce coordinate bounds and geometry validity behind the schema
- [GeoJSON vs GeoParquet Serialisation](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — choose the response format the schema documents
- [Advanced Spatial Endpoints & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/) — the broader data-contract patterns this schema work sits within

← Back to [Advanced Spatial Endpoints & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/)
