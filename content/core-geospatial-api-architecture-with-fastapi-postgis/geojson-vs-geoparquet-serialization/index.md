---
layout: layouts/page.njk
title: "GeoJSON vs GeoParquet Serialization"
description: "Compare GeoJSON vs GeoParquet for FastAPI endpoints. Choose based on payload size, downstream consumption patterns, and client compatibility requirements."
---

# GeoJSON vs GeoParquet Serialization

Selecting the appropriate serialization format for geospatial endpoints directly dictates API latency, memory footprint, and client compatibility. Within modern [Core Geospatial API Architecture with FastAPI & PostGIS](/core-geospatial-api-architecture-with-fastapi-postgis/), the choice between **GeoJSON vs GeoParquet Serialization** is rarely about developer preference; it is a foundational architectural decision driven by payload size, downstream consumption patterns, and infrastructure constraints. This guide provides a step-by-step workflow, tested FastAPI patterns, and production-grade error handling for implementing both formats at scale.

## Prerequisites & Environment Setup

Before implementing serialization pipelines, ensure your stack meets the following baseline requirements:
- **Python 3.10+** with `fastapi`, `uvicorn`, `sqlalchemy[asyncio]`, `asyncpg`
- **PostGIS 3.3+** (for `ST_AsGeoJSON`, `ST_AsBinary`, and CRS metadata functions)
- **Serialization Libraries**: `geopandas`, `pyarrow`, `geoarrow-pyarrow` (recommended for zero-copy geometry encoding)
- **API Tooling**: `httpx` or `curl` for content negotiation testing, `orjson` for high-performance JSON parsing

Install dependencies via:
```bash
pip install fastapi uvicorn sqlalchemy asyncpg geopandas pyarrow orjson geoarrow-pyarrow
```

## Serialization Architecture Decision Matrix

The decision between text-based JSON and binary columnar Parquet hinges on three vectors: client ecosystem, network constraints, and server-side compute overhead.

| Vector | GeoJSON | GeoParquet |
|--------|---------|------------|
| **Format Type** | Text-based, human-readable | Binary, columnar, compressed |
| **Payload Overhead** | High (string escaping, verbose keys) | Low (dictionary encoding, delta compression) |
| **Client Support** | Universal (Leaflet, MapLibre, OpenLayers, browsers) | Specialized (QGIS, Kepler.gl, data engineering pipelines, Python/R) |
| **Server Memory** | Scales linearly with feature count | Scales sub-linearly due to chunked I/O |
| **Schema Evolution** | Implicit, fragile | Explicit, enforced via Arrow schema |

When designing [Spatial Resource Modeling Patterns](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-resource-modeling-patterns/), treat GeoJSON as the default for interactive map rendering and GeoParquet as the standard for bulk exports, analytical workloads, and ETL ingestion. The [GeoJSON specification (RFC 7946)](https://datatracker.ietf.org/doc/html/rfc7946) mandates strict structural compliance, while GeoParquet relies on the [Apache Parquet format](https://parquet.apache.org/docs/) for columnar efficiency and schema validation.

## Step-by-Step Implementation Workflow

### 1. PostGIS Data Extraction

Extract geometry and attributes using parameterized queries. Avoid `SELECT *`; explicitly cast geometries to the target CRS and extract bounding boxes for spatial filtering.

```sql
SELECT 
  id, 
  name, 
  ST_AsGeoJSON(geom) AS geom_json,
  ST_AsBinary(geom) AS geom_wkb,
  ST_SRID(geom) AS srid,
  attributes
FROM spatial_features
WHERE geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)
ORDER BY id
LIMIT :limit;
```

For datasets exceeding 100,000 features, cursor-based pagination prevents memory exhaustion and query planner degradation. Implement keyset pagination instead of `OFFSET`, as detailed in [Spatial Pagination & Cursor Strategies](/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/). Always validate SRID consistency before serialization to prevent client-side projection mismatches.

### 2. GeoJSON Serialization Pipeline

GeoJSON requires strict RFC 7946 compliance. The serialization step transforms database rows into a `FeatureCollection` structure while preserving coordinate precision and CRS metadata. In-memory construction is acceptable for payloads under 50 MB, but larger datasets demand streaming to prevent OOM crashes.

```python
import orjson
from fastapi import FastAPI, Response
from fastapi.responses import StreamingResponse
from typing import AsyncGenerator, Dict, Any

app = FastAPI()

async def geojson_stream(rows: AsyncGenerator) -> AsyncGenerator[bytes, None]:
    """Yield GeoJSON chunks to avoid loading entire payload into memory."""
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
                **row["attributes"]
            }
        }
        if not first:
            yield b","
        yield orjson.dumps(feature)
        first = False
    yield b"]}"

@app.get("/api/features/geojson")
async def get_geojson_stream():
    # Replace with actual asyncpg cursor execution
    rows = fetch_features_async() 
    return StreamingResponse(
        geojson_stream(rows),
        media_type="application/geo+json"
    )
```

For comprehensive memory optimization techniques, review [Best practices for serializing large GeoJSON responses](/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/best-practices-for-serializing-large-geojson-responses/). When payloads exceed browser WebSocket limits, consider chunked delivery or switch to binary formats. See Handling large GeoJSON exports with streaming responses for production deployment patterns.

### 3. GeoParquet Serialization Pipeline

GeoParquet leverages Apache Arrow's in-memory columnar format, enabling zero-copy serialization and aggressive compression. The pipeline converts WKB geometries directly into Arrow arrays, preserving topology and CRS metadata without intermediate Python object allocation.

```python
import pyarrow as pa
import pyarrow.parquet as pq
from fastapi.responses import Response
from io import BytesIO

def serialize_geoparquet(rows: list[dict]) -> bytes:
    """Convert database rows to compressed GeoParquet bytes."""
    # Define explicit Arrow schema
    schema = pa.schema([
        ("id", pa.int64()),
        ("name", pa.string()),
        ("geometry", pa.binary()),
        ("srid", pa.int32()),
        ("attributes", pa.struct([
            ("category", pa.string()),
            ("value", pa.float64())
        ]))
    ])

    # Build Arrow Table
    table = pa.Table.from_pylist(rows, schema=schema)
    
    # Attach GeoParquet metadata (required for client compatibility)
    geo_meta = {
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                "geometry_type": ["Polygon", "MultiPolygon"],
                "crs": "EPSG:4326"
            }
        },
        "version": "1.0.0"
    }
    table = table.replace_schema_metadata({
        **table.schema.metadata or {},
        "geo": orjson.dumps(geo_meta).decode()
    })

    # Serialize to in-memory buffer
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
        headers={"Content-Disposition": "attachment; filename=features.parquet"}
    )
```

GeoParquet's columnar layout enables downstream consumers to read only required fields, reducing I/O by 60–85% compared to row-based formats. Always validate WKB encoding against the GeoParquet 1.0 specification to ensure cross-platform compatibility.

### 4. FastAPI Routing & Content Negotiation

Implement `Accept` header negotiation to serve both formats from a single endpoint. FastAPI's `Request` object provides direct access to client preferences.

```python
from fastapi import Request, HTTPException

@app.get("/api/features")
async def get_features(request: Request):
    accept = request.headers.get("accept", "application/geo+json")
    
    if "application/vnd.apache.parquet" in accept or "application/octet-stream" in accept:
        rows = fetch_features_sync()
        return Response(
            content=serialize_geoparquet(rows),
            media_type="application/vnd.apache.parquet"
        )
    elif "application/geo+json" in accept or "application/json" in accept:
        rows = fetch_features_async()
        return StreamingResponse(
            geojson_stream(rows),
            media_type="application/geo+json"
        )
    else:
        raise HTTPException(status_code=406, detail="Unsupported media type")
```

## Production Considerations & Performance Tuning

Serialization performance degrades rapidly without proper resource management. Apply the following tuning strategies:

1. **Coordinate Precision**: Round coordinates to 6 decimal places (~10 cm precision) before serialization. This reduces payload size by 15–30% without perceptible map degradation.
2. **Compression**: Enable `gzip` or `brotli` at the reverse proxy level (NGINX/Caddy). GeoJSON compresses exceptionally well due to repetitive JSON keys. GeoParquet benefits less from transport compression since it uses internal columnar compression (ZSTD/Snappy).
3. **Geometry Validation**: Strip invalid geometries at the query layer using `ST_IsValid(geom)`. Invalid WKB or malformed GeoJSON triggers client-side crashes and increases retry traffic.
4. **CRS Enforcement**: Always normalize to `EPSG:4326` (WGS84) before serialization. Client libraries assume this default; embedding custom CRS objects in GeoJSON increases parsing overhead.

## Error Handling & Validation

Production endpoints must gracefully handle malformed data, connection drops, and schema mismatches. Implement centralized exception handlers:

```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

@app.exception_handler(ValidationError)
async def validation_error_handler(request: Request, exc: ValidationError):
    return JSONResponse(
        status_code=422,
        content={"error": "Invalid request parameters", "details": exc.errors()}
    )

@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception):
    # Log exc for monitoring; return sanitized message
    return JSONResponse(
        status_code=500,
        content={"error": "Internal serialization failure"}
    )
```

Wrap database cursors in `try/except` blocks to release connections on client disconnects. Use `asyncio.shield()` for critical serialization steps to prevent partial writes during graceful shutdowns.

## Conclusion

The **GeoJSON vs GeoParquet Serialization** decision ultimately balances client accessibility against infrastructure efficiency. GeoJSON remains indispensable for browser-based mapping, real-time dashboards, and lightweight integrations. GeoParquet excels in data engineering pipelines, bulk exports, and analytical workloads where schema enforcement and compression matter. By implementing streaming responses, explicit Arrow schemas, and content negotiation, your API can serve both ecosystems reliably without duplicating infrastructure. Benchmark both formats against your specific feature density and network constraints before committing to a default.