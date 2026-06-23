---
layout: layouts/page.njk
title: "GeoJSON vs GeoParquet Serialization"
description: "Compare GeoJSON and GeoParquet serialization for FastAPI geospatial endpoints: decision matrix, streaming pipelines, content negotiation, error handling, and performance benchmarks."
slug: geojson-vs-geoparquet-serialization
type: cluster
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "GeoJSON vs GeoParquet Serialization"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/"
datePublished: "2024-03-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "GeoJSON vs GeoParquet Serialization",
      "description": "Compare GeoJSON and GeoParquet serialization for FastAPI geospatial endpoints: decision matrix, streaming pipelines, content negotiation, error handling, and performance benchmarks.",
      "datePublished": "2024-03-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "geospatial-api.com"},
      "publisher": {"@type": "Organization", "name": "geospatial-api.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Core Geospatial API Architecture",
          "item": "https://geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "GeoJSON vs GeoParquet Serialization",
          "item": "https://geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/"
        }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement GeoJSON and GeoParquet serialization in FastAPI",
      "step": [
        {"@type": "HowToStep", "name": "Extract geometry from PostGIS", "position": 1},
        {"@type": "HowToStep", "name": "Build a streaming GeoJSON pipeline", "position": 2},
        {"@type": "HowToStep", "name": "Build a columnar GeoParquet pipeline", "position": 3},
        {"@type": "HowToStep", "name": "Add Accept-header content negotiation", "position": 4},
        {"@type": "HowToStep", "name": "Verify correctness and benchmark performance", "position": 5}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "When should I use GeoParquet instead of GeoJSON?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use GeoParquet for bulk exports, analytical pipelines, and data-engineering consumers (QGIS, Kepler.gl, DuckDB, Python/R). Use GeoJSON for browser-based maps, real-time dashboards, and any client that does not support binary Parquet files."
          }
        },
        {
          "@type": "Question",
          "name": "What is the correct media type for GeoParquet?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The registered IANA media type is application/vnd.apache.parquet. Send this in the Content-Type response header and accept it in the Accept request header during content negotiation."
          }
        },
        {
          "@type": "Question",
          "name": "How much smaller is GeoParquet than GeoJSON?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "On typical polygon datasets with 100 k+ features, GeoParquet with ZSTD compression is 60–85 % smaller than equivalent GeoJSON. The gap widens with attribute cardinality because Parquet applies dictionary encoding to repeated string values."
          }
        }
      ]
    }
  ]
}
</script>

← Back to [Core Geospatial API Architecture](/core-geospatial-api-architecture-with-fastapi-postgis/)

# GeoJSON vs GeoParquet Serialization

Choosing the wrong serialization format for a geospatial endpoint is one of the most common sources of avoidable latency and client incompatibility. Within the broader [Core Geospatial API Architecture with FastAPI & PostGIS](/core-geospatial-api-architecture-with-fastapi-postgis/), the decision between text-based GeoJSON and binary-columnar GeoParquet drives payload size, server memory consumption, and which downstream consumers can read the data. This page walks through the decision matrix, two complete streaming pipelines, `Accept`-header content negotiation, verification steps, and the failure modes that appear in production.

## Prerequisites & Environment

Ensure the following before implementing either pipeline:

- **Python 3.10+** with `fastapi>=0.111`, `uvicorn`, `sqlalchemy[asyncio]>=2.0`, `asyncpg>=0.29`
- **PostGIS 3.3+** — required for `ST_AsGeoJSON`, `ST_AsBinary`, and reliable CRS metadata in `ST_SRID`
- **Serialization libraries**: `geopandas>=0.14`, `pyarrow>=15`, `geoarrow-pyarrow>=0.3` for zero-copy geometry encoding
- **Utility packages**: `orjson>=3.9` for high-throughput JSON serialisation; `httpx` for content-negotiation testing

```bash
pip install "fastapi>=0.111" uvicorn "sqlalchemy[asyncio]>=2.0" asyncpg \
    geopandas "pyarrow>=15" orjson "geoarrow-pyarrow>=0.3" httpx
```

## Decision Matrix

The table below is the analytical starting point. Read it column-by-column to match your consumer profile before writing a single line of code.

| Characteristic | GeoJSON | GeoParquet |
|---|---|---|
| **Format type** | Text, UTF-8, human-readable | Binary, columnar, Parquet container |
| **Spec** | RFC 7946 | GeoParquet 1.0 (Apache Parquet + `geo` metadata) |
| **Media type** | `application/geo+json` | `application/vnd.apache.parquet` |
| **Payload overhead** | High — verbose JSON keys repeated per feature | Low — dictionary encoding + ZSTD/Snappy compression |
| **Typical compression ratio** | 3–5× with gzip/brotli (transport) | 10–20× natively; 60–85 % smaller than GeoJSON |
| **Client support** | Universal — Leaflet, MapLibre, OpenLayers, browsers | Specialised — QGIS, Kepler.gl, DuckDB, Python, R |
| **Server memory** | Scales linearly with feature count | Sub-linear — chunked Arrow I/O |
| **Schema enforcement** | Implicit; fragile under schema drift | Explicit Arrow schema; Parquet footer stores column types |
| **Geometry encoding** | WGS 84 coordinate pairs in JSON arrays | WKB bytes in a binary column; CRS declared in `geo` metadata |
| **Streaming** | Chunk-level via `StreamingResponse` | Parquet row groups; stream with `pyarrow.parquet.ParquetWriter` |
| **Best for** | Browser maps, real-time dashboards, lightweight integrations | Bulk exports, ETL pipelines, analytical workloads |

When modelling spatial resources as detailed in [Spatial Resource Modeling Patterns](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/), treat GeoJSON as the default for interactive rendering and GeoParquet as the standard for bulk and analytical endpoints.

---

<svg viewBox="0 0 780 300" role="img" aria-label="Serialization format selection flow for FastAPI geospatial endpoints" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:780px;display:block;margin:1.5rem auto;">
  <title>Serialization format selection flow</title>
  <desc>A decision flow diagram showing how a FastAPI endpoint chooses between GeoJSON streaming and GeoParquet binary output based on the incoming Accept header and consumer type.</desc>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto">
      <path d="M0,0 L0,7 L8,3.5 Z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Client request box -->
  <rect x="10" y="120" width="130" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="75" y="141" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif" font-weight="600">Client Request</text>
  <text x="75" y="158" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.8">GET /api/features</text>
  <text x="75" y="172" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">Accept: ???</text>
  <!-- Arrow client → router -->
  <line x1="140" y1="146" x2="188" y2="146" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)" opacity="0.6"/>
  <!-- Content negotiation diamond -->
  <polygon points="220,110 310,146 220,182 130,146" transform="translate(80,0)" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="300" y="141" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" font-weight="600">Accept</text>
  <text x="300" y="156" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" font-weight="600">header?</text>
  <!-- Arrow → GeoJSON branch -->
  <line x1="300" y1="110" x2="300" y2="50" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)" opacity="0.6"/>
  <text x="305" y="84" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.75">geo+json</text>
  <!-- GeoJSON box -->
  <rect x="200" y="8" width="200" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="300" y="24" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" font-weight="600">GeoJSON StreamingResponse</text>
  <text x="300" y="40" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.8">ST_AsGeoJSON → orjson → chunks</text>
  <!-- Arrow → GeoParquet branch -->
  <line x1="300" y1="182" x2="300" y2="242" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)" opacity="0.6"/>
  <text x="305" y="216" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.75">vnd.apache.parquet</text>
  <!-- GeoParquet box -->
  <rect x="200" y="244" width="200" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="300" y="260" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" font-weight="600">GeoParquet Response</text>
  <text x="300" y="276" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.8">ST_AsBinary → PyArrow → ZSTD</text>
  <!-- Arrow → 406 branch -->
  <line x1="390" y1="146" x2="450" y2="146" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)" opacity="0.6"/>
  <text x="395" y="139" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.75">other</text>
  <!-- 406 box -->
  <rect x="452" y="122" width="130" height="56" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="517" y="141" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" font-weight="600">406 Not Acceptable</text>
  <text x="517" y="157" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.8">supported types listed</text>
  <text x="517" y="171" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.8">in error body</text>
  <!-- PostGIS annotation -->
  <rect x="590" y="48" width="180" height="56" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="5,3" opacity="0.4"/>
  <text x="680" y="66" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" font-weight="600" opacity="0.8">PostGIS extraction</text>
  <text x="680" y="82" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">ST_AsGeoJSON → text</text>
  <text x="680" y="96" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.7">ST_AsBinary → WKB bytes</text>
  <!-- Connecting line from PostGIS to both outputs -->
  <line x1="590" y1="76" x2="402" y2="30" stroke="currentColor" stroke-width="1" stroke-dasharray="4,3" opacity="0.3" marker-end="url(#arrow)"/>
  <line x1="590" y1="96" x2="402" y2="264" stroke="currentColor" stroke-width="1" stroke-dasharray="4,3" opacity="0.3" marker-end="url(#arrow)"/>
</svg>

---

## Step-by-Step Implementation

### 1. PostGIS Data Extraction

Extract geometry in both text and binary form in a single query. This avoids a second round-trip when the same endpoint serves both formats.

```sql
SELECT
  id,
  name,
  ST_AsGeoJSON(ST_Transform(geom, 4326))::text AS geom_json,
  ST_AsBinary(ST_Transform(geom, 4326))        AS geom_wkb,
  ST_SRID(geom)                                AS srid,
  attributes
FROM spatial_features
WHERE geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)
ORDER BY id
LIMIT :limit;
```

Explicitly call `ST_Transform` before `ST_AsGeoJSON` and `ST_AsBinary`. Leaving projection to the client is a correctness hazard — PostGIS stores geometries in their native SRID and the column default is not always 4326.

For datasets exceeding 100,000 features, combine this query with keyset pagination to prevent memory exhaustion and query-planner degradation, as described in [Spatial Pagination & Cursor Strategies](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/).

### 2. GeoJSON Streaming Pipeline

GeoJSON demands strict RFC 7946 structure: a `FeatureCollection` wrapping individual `Feature` objects, each with a `geometry` and a `properties` map. For payloads above ~50 MB, in-memory construction triggers out-of-memory crashes under concurrent load. Stream instead.

```python
import orjson
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from typing import AsyncGenerator

app = FastAPI()


async def geojson_stream(rows: AsyncGenerator) -> AsyncGenerator[bytes, None]:
    """Yield FeatureCollection chunks; never loads the full set into memory."""
    yield b'{"type":"FeatureCollection","features":['
    first = True
    async for row in rows:
        feature = {
            "type": "Feature",
            "id": row["id"],
            "geometry": orjson.loads(row["geom_json"]),
            "properties": {
                "name": row["name"],
                "srid": row["srid"],
                **row["attributes"],
            },
        }
        if not first:
            yield b","
        yield orjson.dumps(feature)
        first = False
    yield b"]}"


@app.get("/api/features/geojson")
async def get_geojson_stream():
    rows = fetch_features_async()   # asyncpg cursor yielding dicts
    return StreamingResponse(
        geojson_stream(rows),
        media_type="application/geo+json",
    )
```

`orjson.dumps` is 3–5× faster than the stdlib `json.dumps` for geometry-heavy payloads because it natively handles `bytes` and avoids the Unicode escaping step. For additional memory-optimisation techniques for very large exports, see [Best Practices for Serializing Large GeoJSON Responses](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/best-practices-for-serializing-large-geojson-responses/).

### 3. GeoParquet Binary Pipeline

GeoParquet uses Apache Arrow's columnar in-memory format and writes a Parquet file with a mandatory `geo` metadata key that describes the geometry column. WKB bytes from `ST_AsBinary` map directly into the `geometry` binary column — no intermediate Python object allocation is needed.

```python
import pyarrow as pa
import pyarrow.parquet as pq
import orjson
from fastapi.responses import Response
from io import BytesIO


def serialize_geoparquet(rows: list[dict]) -> bytes:
    """Convert PostGIS rows to GeoParquet 1.0-compliant bytes (ZSTD compressed)."""
    schema = pa.schema([
        ("id",       pa.int64()),
        ("name",     pa.string()),
        ("geometry", pa.binary()),   # raw WKB from ST_AsBinary
        ("srid",     pa.int32()),
    ])

    table = pa.Table.from_pydict(
        {
            "id":       [r["id"]       for r in rows],
            "name":     [r["name"]     for r in rows],
            "geometry": [r["geom_wkb"] for r in rows],
            "srid":     [r["srid"]     for r in rows],
        },
        schema=schema,
    )

    # GeoParquet 1.0 requires a "geo" key in the Parquet file metadata.
    # null crs means WGS 84 (EPSG:4326) per spec.
    geo_meta = {
        "version": "1.0.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                "geometry_types": ["Polygon", "MultiPolygon"],
                "crs": None,
            }
        },
    }
    updated_schema = table.schema.with_metadata({
        **(table.schema.metadata or {}),
        b"geo": orjson.dumps(geo_meta),
    })
    table = table.cast(updated_schema)

    buf = BytesIO()
    pq.write_table(table, buf, compression="zstd", use_dictionary=True)
    return buf.getvalue()


@app.get("/api/features/geoparquet")
async def get_geoparquet():
    rows = fetch_features_sync()
    parquet_bytes = serialize_geoparquet(rows)
    return Response(
        content=parquet_bytes,
        media_type="application/vnd.apache.parquet",
        headers={"Content-Disposition": "attachment; filename=features.parquet"},
    )
```

The `use_dictionary=True` flag enables Parquet dictionary encoding for string columns (`name`, geometry type tags), often halving the output size when attribute values repeat across features.

### 4. Content Negotiation — One Endpoint, Both Formats

Serving both formats from a single URL via `Accept`-header negotiation avoids endpoint proliferation and lets API clients self-select without changing base URLs. This matters especially for [API Versioning for GIS Endpoints](/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/), where format support may change between versions.

```python
from fastapi import Request, HTTPException

SUPPORTED_TYPES = [
    "application/vnd.apache.parquet",
    "application/geo+json",
    "application/json",
    "application/octet-stream",
]


@app.get("/api/features")
async def get_features(request: Request):
    accept = request.headers.get("accept", "application/geo+json")

    if "application/vnd.apache.parquet" in accept or "application/octet-stream" in accept:
        rows = fetch_features_sync()
        return Response(
            content=serialize_geoparquet(rows),
            media_type="application/vnd.apache.parquet",
            headers={"Content-Disposition": "attachment; filename=features.parquet"},
        )

    if "application/geo+json" in accept or "application/json" in accept or "*/*" in accept:
        rows = fetch_features_async()
        return StreamingResponse(geojson_stream(rows), media_type="application/geo+json")

    raise HTTPException(
        status_code=406,
        detail={
            "error": "Not Acceptable",
            "supported": SUPPORTED_TYPES,
        },
    )
```

Default to `application/geo+json` when the client sends `Accept: */*` — it has the widest support and avoids surprising browser users with a binary download.

## Production Code Example

The following self-contained route integrates the extraction query, both serialization branches, and centralised error handling. Copy this into a working FastAPI app after replacing the `fetch_*` stubs with your actual asyncpg or SQLAlchemy session calls.

```python
import asyncio
import orjson
import pyarrow as pa
import pyarrow.parquet as pq
from io import BytesIO
from typing import AsyncGenerator, Optional

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, Response, JSONResponse
from pydantic import ValidationError


app = FastAPI(title="Geospatial Feature API")

# ---------------------------------------------------------------------------
# PostGIS helpers (replace with real DB calls)
# ---------------------------------------------------------------------------

async def _query_features_async(
    minx: float, miny: float, maxx: float, maxy: float, limit: int = 1000
) -> AsyncGenerator[dict, None]:
    """Async generator that yields feature dicts from asyncpg cursor."""
    # async with pool.acquire() as conn:
    #     async for row in conn.cursor(SQL, minx, miny, maxx, maxy, limit):
    #         yield dict(row)
    raise NotImplementedError("Replace with asyncpg cursor execution")


def _query_features_sync(
    minx: float, miny: float, maxx: float, maxy: float, limit: int = 5000
) -> list[dict]:
    """Synchronous bulk fetch for Parquet serialization."""
    raise NotImplementedError("Replace with SQLAlchemy / asyncpg bulk fetch")


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

async def _stream_geojson(rows: AsyncGenerator) -> AsyncGenerator[bytes, None]:
    yield b'{"type":"FeatureCollection","features":['
    first = True
    async for row in rows:
        feature = {
            "type": "Feature",
            "id": row["id"],
            "geometry": orjson.loads(row["geom_json"]),
            "properties": {k: v for k, v in row.items()
                           if k not in ("id", "geom_json", "geom_wkb")},
        }
        if not first:
            yield b","
        yield orjson.dumps(feature)
        first = False
    yield b"]}"


def _build_geoparquet(rows: list[dict]) -> bytes:
    geo_meta = {
        "version": "1.0.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {"encoding": "WKB", "geometry_types": [], "crs": None}
        },
    }
    schema = pa.schema([
        ("id", pa.int64()), ("name", pa.string()), ("geometry", pa.binary()),
    ])
    table = pa.Table.from_pydict(
        {"id": [r["id"] for r in rows],
         "name": [r["name"] for r in rows],
         "geometry": [r["geom_wkb"] for r in rows]},
        schema=schema,
    )
    table = table.cast(table.schema.with_metadata(
        {**(table.schema.metadata or {}), b"geo": orjson.dumps(geo_meta)}
    ))
    buf = BytesIO()
    pq.write_table(table, buf, compression="zstd", use_dictionary=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@app.get("/api/v1/features")
async def get_features(
    request: Request,
    minx: float = -180, miny: float = -90,
    maxx: float = 180,  maxy: float = 90,
    limit: int = 1000,
):
    accept = request.headers.get("accept", "application/geo+json")

    try:
        if "application/vnd.apache.parquet" in accept or "application/octet-stream" in accept:
            rows = _query_features_sync(minx, miny, maxx, maxy, min(limit, 100_000))
            return Response(
                content=_build_geoparquet(rows),
                media_type="application/vnd.apache.parquet",
                headers={"Content-Disposition": "attachment; filename=features.parquet"},
            )

        if "application/geo+json" in accept or "application/json" in accept or "*/*" in accept:
            rows = _query_features_async(minx, miny, maxx, maxy, limit)
            return StreamingResponse(_stream_geojson(rows), media_type="application/geo+json")

        raise HTTPException(status_code=406, detail={"supported": [
            "application/geo+json", "application/vnd.apache.parquet"
        ]})

    except ValidationError as exc:
        return JSONResponse(status_code=422, content={"error": "Invalid parameters", "details": exc.errors()})
    except Exception as exc:
        # Log exc to your observability stack here
        return JSONResponse(status_code=500, content={"error": "Serialization failure"})
```

## Verification & Testing

### curl checks

```bash
# GeoJSON — verify FeatureCollection wrapper and media type
curl -s -H "Accept: application/geo+json" \
  "http://localhost:8000/api/v1/features?limit=5" | python3 -m json.tool | head -20

# GeoParquet — verify non-empty binary and correct content-type header
curl -s -o features.parquet \
  -H "Accept: application/vnd.apache.parquet" \
  "http://localhost:8000/api/v1/features?limit=1000" -D -
file features.parquet   # expects: Apache Parquet data file

# 406 round-trip
curl -s -H "Accept: text/html" \
  "http://localhost:8000/api/v1/features" -w "\nHTTP %{http_code}\n"
# expects: HTTP 406

# Inspect GeoParquet metadata with Python
python3 - <<'EOF'
import pyarrow.parquet as pq, json
meta = pq.read_metadata("features.parquet")
geo = json.loads(meta.metadata[b"geo"])
print(geo["version"])            # expects: 1.0.0
print(geo["primary_column"])     # expects: geometry
EOF
```

### Unit test skeleton

```python
import pytest
from httpx import AsyncClient
from myapp.main import app

@pytest.mark.anyio
async def test_geojson_content_type():
    async with AsyncClient(app=app, base_url="http://test") as client:
        r = await client.get("/api/v1/features?limit=1",
                             headers={"Accept": "application/geo+json"})
    assert r.status_code == 200
    assert "geo+json" in r.headers["content-type"]
    body = r.json()
    assert body["type"] == "FeatureCollection"

@pytest.mark.anyio
async def test_geoparquet_content_type():
    async with AsyncClient(app=app, base_url="http://test") as client:
        r = await client.get("/api/v1/features?limit=10",
                             headers={"Accept": "application/vnd.apache.parquet"})
    assert r.status_code == 200
    assert "parquet" in r.headers["content-type"]
    assert r.content[:4] == b"PAR1"  # Parquet magic bytes
```

## Failure Modes & Edge Cases

1. **`ST_AsGeoJSON` returns `null` for empty geometry** — rows with `NULL` geometry columns produce `{"type":"Feature","geometry":null}`, which is valid per RFC 7946 but breaks many map renderers. Filter with `WHERE geom IS NOT NULL` or coerce to an empty geometry using `COALESCE(geom, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326))`.

2. **`table.cast` fails with `ArrowTypeError: Could not convert` when `geo` metadata already exists** — occurs when the Arrow table is rebuilt from an already-annotated schema. Check `table.schema.metadata` before calling `with_metadata` and remove the existing `b"geo"` key first.

3. **`StreamingResponse` masks exceptions raised mid-stream** — FastAPI commits the HTTP 200 status and headers the moment the generator yields its first byte. Any exception after that point silently truncates the response. Wrap the generator body in a `try/except` that yields a terminal sentinel or closes the connection cleanly.

4. **WKB encoding mismatch — `bigendian` vs `littleendian`** — `ST_AsBinary` defaults to NDR (little-endian) on most PostGIS builds, matching what PyArrow and GDAL expect. If geometry reads as garbled coordinates in the client, force endianness explicitly: `ST_AsBinary(geom, 'NDR')`.

5. **Parquet `compression` not supported error on older PyArrow** — ZSTD support was stabilised in PyArrow 12. On earlier versions fall back to `compression="snappy"`. Check with `pa.supported_compressions()`.

6. **`Accept: */*` from browser triggers a binary download** — when defaulting to GeoJSON for `*/*`, this is correct. But if your Nginx reverse proxy sets `Accept: */*` on cache-miss probes, you may accidentally cache the GeoParquet branch. Set a `Vary: Accept` response header so cache keys include the `Accept` value.

7. **Coordinate precision bloat** — PostGIS stores coordinates as double-precision floats (15+ decimal places). Round to 6 decimal places (~10 cm) before serialising to GeoJSON using `ST_SnapToGrid(geom, 0.000001)` in the query. This alone reduces GeoJSON payload size by 20–35 %.

## Performance Notes

| Scenario | GeoJSON (streaming) | GeoParquet (in-memory) |
|---|---|---|
| 10 k polygon features | ~18 MB wire, ~120 ms | ~2.1 MB wire, ~85 ms |
| 100 k polygon features | ~180 MB wire, ~1.1 s | ~14 MB wire, ~420 ms |
| 1 M point features | OOM risk at default uvicorn limits | ~45 MB wire, ~2.3 s |
| Cold PostGIS query | Dominated by `ST_AsGeoJSON` text cast | Dominated by `ST_AsBinary` + Arrow build |

Key trade-offs:

- **Async vs sync**: GeoJSON benefits from async cursor streaming because the generator yields while I/O waits. GeoParquet's `pq.write_table` is CPU-bound and blocks the event loop — offload to a thread pool with `asyncio.get_event_loop().run_in_executor(None, _build_geoparquet, rows)` for large payloads.
- **Index impact**: Both formats benefit equally from a GiST index on the geometry column for the bounding-box filter (`&&` operator). Without it, the extraction query degrades to a sequential scan regardless of serialization format. See [Bounding Box & Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) for indexing guidance.
- **NGINX compression**: Enable `gzip` or `brotli` at the proxy for GeoJSON responses — they compress 4–7× due to repetitive JSON key names. GeoParquet's internal ZSTD compression makes transport-level compression largely redundant and adds CPU overhead for minimal gain.
- **Query plan caching**: For the [Redis Caching for Spatial Queries](/high-performance-caching-query-optimization/redis-caching-for-spatial-queries/) layer, cache serialized GeoParquet bytes keyed by bounding box and `limit` — the binary is stable and deterministic. Avoid caching GeoJSON streams because the chunked generator cannot be replayed from a Redis string without buffering the whole response first.

---

## Related

- [Best Practices for Serializing Large GeoJSON Responses](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/best-practices-for-serializing-large-geojson-responses/) — streaming architecture, coordinate rounding, and memory profiling for high-volume exports
- [Spatial Pagination & Cursor Strategies](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/) — keyset pagination patterns that pair with both serialization formats
- [Spatial Resource Modeling Patterns](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/) — how to structure FastAPI routers and PostGIS table models before adding serialization
- [API Versioning for GIS Endpoints](/core-geospatial-api-architecture-with-fastapi-postgis/api-versioning-for-gis-endpoints/) — managing format support changes across API versions
- [Bounding Box & Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — GiST indexing and `&&` operator optimisation that reduces extraction query cost for both formats

← Back to [Core Geospatial API Architecture](/core-geospatial-api-architecture-with-fastapi-postgis/)
