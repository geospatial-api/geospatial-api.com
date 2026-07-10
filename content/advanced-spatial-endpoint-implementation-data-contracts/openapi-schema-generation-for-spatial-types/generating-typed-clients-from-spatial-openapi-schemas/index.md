---
layout: layouts/page.njk
title: "Generating Typed Clients from Spatial OpenAPI Schemas"
description: "Produce typed Python and TypeScript clients from a spatial openapi.json with openapi-python-client and openapi-generator-cli, and understand how GeoJSON discriminated unions map to client types for map frontends."
slug: "generating-typed-clients-from-spatial-openapi-schemas"
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "OpenAPI Schema Generation for Spatial Types"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/"
  - label: "Generating Typed Clients from Spatial OpenAPI Schemas"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/generating-typed-clients-from-spatial-openapi-schemas/"
datePublished: "2025-11-19"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Generating Typed Clients from Spatial OpenAPI Schemas",
      "description": "Produce typed Python and TypeScript clients from a spatial openapi.json with openapi-python-client and openapi-generator-cli, and understand how GeoJSON discriminated unions map to client types for map frontends.",
      "datePublished": "2025-11-19",
      "dateModified": "2026-07-10",
      "author": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "OpenAPI Schema Generation for Spatial Types", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/" },
        { "@type": "ListItem", "position": 3, "name": "Generating Typed Clients from Spatial OpenAPI Schemas", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/generating-typed-clients-from-spatial-openapi-schemas/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Generate typed Python and TypeScript clients from a spatial OpenAPI schema",
      "step": [
        { "@type": "HowToStep", "position": 1, "text": "Export the API's openapi.json from the running FastAPI app." },
        { "@type": "HowToStep", "position": 2, "text": "Generate a typed Python client with openapi-python-client." },
        { "@type": "HowToStep", "position": 3, "text": "Generate a typed TypeScript client with openapi-generator-cli." },
        { "@type": "HowToStep", "position": 4, "text": "Narrow the geometry discriminated union in client code by the type field." },
        { "@type": "HowToStep", "position": 5, "text": "Call the generated client against the live API to confirm the round-trip." }
      ]
    },
    {
      "@type": "Article",
      "headline": "Generating Typed Clients from Spatial OpenAPI Schemas",
      "datePublished": "2025-11-19",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [OpenAPI Schema Generation for Spatial Types](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/)

# Generating typed clients from spatial OpenAPI schemas

Compile a spatial `openapi.json` into typed Python and TypeScript SDKs, and map GeoJSON discriminated unions onto client types so map frontends narrow geometry by its `type` field instead of casting `any`.

## Context & when to use

Once the API emits an accurate schema — typed geometry models, a `oneOf` with a discriminator, valid examples — the payoff is that clients no longer have to be written by hand. A generator reads `openapi.json` and produces request/response models, method stubs, and (crucially for geospatial work) a tagged union for `geometry` that a TypeScript map frontend can `switch` on. Generate clients when more than one team or language consumes the API, when you want compile-time safety against schema drift, or when a map UI needs geometry types it can narrow rather than probe at runtime.

This is the downstream end of the pipeline in [OpenAPI schema generation for spatial types](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/): the quality of the generated client is capped by the quality of the schema, so a clean discriminated union upstream is what makes a clean sum type downstream. Prefer generated clients over hand-written HTTP calls for anything beyond a throwaway script; the main cost is a regeneration step in CI whenever the schema changes.

The two generators covered here occupy different niches. `openapi-python-client` is Python-native, produces `attrs`-based models and an `httpx` transport, and tends to render `oneOf` unions faithfully as `typing.Union` with per-variant classes — a good fit when the consumer is another Python service. `openapi-generator-cli` is the polyglot workhorse (dozens of target languages) and is usually how a TypeScript map frontend gets its client; its `typescript-fetch` generator maps a discriminated `oneOf` onto a TypeScript tagged union that narrows on the discriminator. Pick per consumer; there is no need to standardise on one generator across languages.

**Preconditions:** a reachable `openapi.json` (from a running app or exported to a file), Python 3.10+ with `pipx` for `openapi-python-client`, and Node.js with `npx` (plus a JRE) for `openapi-generator-cli`.

---

## Generator pipeline

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Spatial openapi.json feeding two generators into Python and TypeScript clients" style="width:100%;max-width:760px;display:block;margin:1.5rem auto;">
  <title>One schema, two typed clients</title>
  <desc>A single openapi.json with a geometry oneOf and discriminator feeds two generators: openapi-python-client producing attrs/Pydantic models and a typed Python client, and openapi-generator-cli producing a TypeScript tagged union and a fetch client. Both narrow geometry on the type field.</desc>
  <!-- source -->
  <rect x="280" y="24" width="200" height="60" rx="8" fill="var(--surface, #f5f3ff)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="380" y="48" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">openapi.json</text>
  <text x="380" y="66" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">geometry oneOf + discriminator</text>
  <!-- left branch -->
  <rect x="60" y="130" width="280" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="200" y="150" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">openapi-python-client</text>
  <text x="200" y="168" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">attrs models · httpx · typed</text>
  <rect x="60" y="210" width="280" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="200" y="237" text-anchor="middle" font-size="11" fill="currentColor">Python: Union[Point, LineString, Polygon]</text>
  <!-- right branch -->
  <rect x="420" y="130" width="280" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="560" y="150" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">openapi-generator-cli</text>
  <text x="560" y="168" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">typescript-fetch generator</text>
  <rect x="420" y="210" width="280" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="560" y="237" text-anchor="middle" font-size="11" fill="currentColor">TS: type Geometry = Point | Polygon</text>
  <!-- arrows -->
  <line x1="340" y1="70" x2="200" y2="128" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="420" y1="70" x2="560" y2="128" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="200" y1="180" x2="200" y2="208" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="560" y1="180" x2="560" y2="208" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

---

## Runnable implementation

Export the schema, generate both clients, then narrow the geometry union in each language.

```bash
# 1. Export openapi.json from the running FastAPI app (or curl it directly)
curl -s http://localhost:8000/openapi.json -o openapi.json

# 2. Typed PYTHON client (attrs models + httpx, fully typed)
pipx run openapi-python-client generate \
  --path openapi.json \
  --meta pyproject \
  --output-path ./spatial_client_py
# Produces: spatial_client_py/spatial_features_api_client/models/{point,polygon,feature}.py
#   with a `Geometry` union and per-variant classes keyed on `type`.

# 3. Typed TYPESCRIPT client (fetch-based, tagged unions preserved)
npx @openapitools/openapi-generator-cli generate \
  -i openapi.json \
  -g typescript-fetch \
  -o ./spatial_client_ts \
  --additional-properties=supportsES6=true,withInterfaces=true,useSingleRequestParameter=true
# Produces: spatial_client_ts/models/{Point,Polygon,Feature}.ts
#   and a Geometry.ts discriminated union type.
```

Using the generated **Python** client — the discriminated `geometry` becomes a `Union`, narrowed with `isinstance`:

```python
# consume_py.py
from spatial_features_api_client import Client
from spatial_features_api_client.models import Feature, Point, Polygon
from spatial_features_api_client.api.default import create_feature_features_post

client = Client(base_url="http://localhost:8000")

# Build a typed request body — mypy checks the geometry variant.
body = Feature.from_dict({
    "type": "Feature",
    "geometry": {"type": "Point", "coordinates": [-0.1278, 51.5074]},
    "properties": {"name": "Trafalgar Square"},
})

resp: Feature = create_feature_features_post.sync(client=client, body=body)

# Narrow the union on the concrete class the generator produced.
geom = resp.geometry
if isinstance(geom, Point):
    lon, lat = geom.coordinates
    print(f"point at {lon}, {lat}")
elif isinstance(geom, Polygon):
    print(f"polygon with {len(geom.coordinates[0])} vertices in outer ring")
```

Using the generated **TypeScript** client in a map frontend — `switch` on the discriminator, no `any`:

```typescript
// consume.ts
import { DefaultApi, Configuration, Feature, Geometry } from "./spatial_client_ts";

const api = new DefaultApi(new Configuration({ basePath: "http://localhost:8000" }));

const feature: Feature = await api.createFeatureFeaturesPost({
  feature: {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-0.1278, 51.5074] },
    properties: { name: "Trafalgar Square" },
  },
});

// The generator maps oneOf+discriminator to a tagged union: narrow on `type`.
function toLngLat(geom: Geometry): [number, number] {
  switch (geom.type) {
    case "Point":
      return [geom.coordinates[0], geom.coordinates[1]]; // [lon, lat]
    case "Polygon":
      return geom.coordinates[0][0] as [number, number];  // first vertex
    default:
      // Exhaustiveness check — a new geometry type breaks the build here.
      throw new Error(`unhandled geometry: ${(geom as { type: string }).type}`);
  }
}
```

---

## Key parameters & options

| Generator | Flag | Effect |
|---|---|---|
| `openapi-python-client` | `--meta pyproject` | Emit an installable package with `pyproject.toml` rather than bare modules |
| `openapi-python-client` | `--config config.yml` | Override class names, add field aliases, post-process hooks |
| `openapi-generator-cli` | `-g typescript-fetch` | Fetch-based TS client; `typescript-axios` if you prefer axios |
| `openapi-generator-cli` | `withInterfaces=true` | Emit interfaces alongside classes so unions stay structural |
| `openapi-generator-cli` | `useSingleRequestParameter=true` | One request-object arg per method — friendlier for many params |
| `openapi-generator-cli` | `--type-mappings` | Remap a schema type to a client type (rarely needed for GeoJSON) |
| both | pin generator version | Reproducible output; unpinned generators drift model names across CI runs |

For the TypeScript generator, `withInterfaces=true` plus a discriminated `oneOf` is what yields a real narrowable union; without the discriminator upstream the generator falls back to an `object` and the `switch` above will not type-check.

`openapi-python-client` accepts a `--config` YAML that is worth setting up for spatial APIs: it lets you pin generated class names (so `Point` does not become `PointType1` when the generator disambiguates), add field-level `property_overrides`, and register post-generation hooks. A minimal config that stabilises geometry class names looks like:

```yaml
# config.yml — passed via --config
class_overrides:
  Point:
    class_name: GeoPoint
    module_name: geo_point
use_path_prefixes_for_title_model_names: false
```

Regeneration is meant to be cheap and frequent, so keep both the export command and the generate command in a single `make client` target and run it in CI on every schema change.

---

## Gotchas & failure modes

- **`oneOf` without a discriminator generates an untagged union.** If the schema has `oneOf` but no `discriminator.mapping`, `openapi-generator-cli` emits `Point | Polygon` with no tag, so `switch (geom.type)` does not narrow and you are back to runtime casts. Fix upstream: add `Field(discriminator="type")` as shown in [OpenAPI schema generation for spatial types](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/).
- **`additionalProperties: true` on geometry weakens the type.** If a geometry model allows extra properties, some generators widen it to `[key: string]: any`, defeating strictness. Set `model_config = {"extra": "forbid"}` on the geometry models so the schema emits `additionalProperties: false`.
- **Schema drift silently breaks the client.** Regenerating against a changed schema can rename or drop model classes; consumers fail to compile with no warning until then. Regenerate in CI and fail the build on a non-empty `git diff` of the generated directory so drift is caught at the source, in step with [versioning geospatial APIs without breaking clients](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/versioning-geospatial-apis-without-breaking-clients/).
- **Unbounded coordinate arrays generate `number[]` with no shape.** If the schema did not constrain `coordinates` length, the client types a position as `number[]`, so `const [lon, lat]` gives no safety. Bound the position array upstream so `minItems`/`maxItems` reach the generator.
- **JRE missing for `openapi-generator-cli`.** The CLI is a Java tool; `npx @openapitools/openapi-generator-cli` fails with `Unable to locate a Java Runtime` if no JDK/JRE is on `PATH`. Install a JRE 11+ or use the Docker image `openapitools/openapi-generator-cli`.
- **FastAPI operationIds produce ugly method names.** Names like `create_feature_features_post` come from the default operationId. Set explicit `operation_id=` on routes (or a custom `generate_unique_id_function`) before exporting the schema for cleaner generated method names.

---

## Verification

Confirm the generated client compiles and actually round-trips against the live API:

```bash
# Python client: install locally and type-check
pip install -e ./spatial_client_py
python -m mypy consume_py.py        # 0 errors => geometry union narrows cleanly
python consume_py.py                # prints "point at -0.1278, 51.5074"

# TypeScript client: type-check the union narrowing
cd spatial_client_ts && npm install && npx tsc --noEmit ../consume.ts
# A missing `case` for a geometry type fails the exhaustiveness check at build time.
```

A successful `mypy`/`tsc` pass proves the discriminated union survived the schema→client trip; a live `python consume_py.py` returning the echoed feature proves the wire contract matches the generated models.

---

## Related

- [OpenAPI Schema Generation for Spatial Types](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/) — produce the discriminated-union schema these generators consume
- [Documenting GeoJSON Request Bodies in OpenAPI](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/documenting-geojson-request-bodies-in-openapi/) — the request examples that ship into the generated SDK
- [API Versioning for GIS Endpoints](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — manage schema drift so regenerated clients do not break consumers

← Back to [OpenAPI Schema Generation for Spatial Types](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/openapi-schema-generation-for-spatial-types/)
