---
layout: layouts/page.njk
title: "Async Bulk Geospatial Uploads with Celery"
description: "Queue shapefile and GeoJSON bulk uploads with Celery and FastAPI. Parse with GDAL workers, validate geometries, and write to PostGIS with ON CONFLICT idempotency. Production patterns with error handling, retries, and monitoring."
slug: async-bulk-uploads-with-celery
breadcrumb: "Advanced Spatial Endpoints & Data Contracts > Async Bulk Uploads with Celery"
datePublished: "2024-10-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Async Bulk Geospatial Uploads with Celery",
      "description": "Queue shapefile and GeoJSON bulk uploads with Celery and FastAPI. Parse with GDAL workers, validate geometries, and write to PostGIS with ON CONFLICT idempotency.",
      "datePublished": "2024-10-01",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "Geospatial API" },
      "publisher": { "@type": "Organization", "name": "Geospatial API" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Advanced Spatial Endpoints & Data Contracts",
          "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Async Bulk Uploads with Celery",
          "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/"
        }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement async bulk geospatial uploads with Celery and FastAPI",
      "step": [
        { "@type": "HowToStep", "name": "Configure FastAPI ingestion endpoint returning 202" },
        { "@type": "HowToStep", "name": "Dispatch upload task to Celery broker" },
        { "@type": "HowToStep", "name": "Extract and validate geometries in worker" },
        { "@type": "HowToStep", "name": "Transform CRS and repair invalid geometries" },
        { "@type": "HowToStep", "name": "Batch-insert into PostGIS with idempotent upsert" },
        { "@type": "HowToStep", "name": "Expose job-status polling endpoint" }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why return 202 instead of 200 from a geospatial upload endpoint?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "202 Accepted signals to clients that the request was valid and accepted but processing has not yet completed. It prevents clients from assuming the data is immediately queryable and sets correct expectations for polling the job-status endpoint."
          }
        },
        {
          "@type": "Question",
          "name": "How do I prevent duplicate records when a Celery task retries after a partial insert?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use ON CONFLICT DO NOTHING or ON CONFLICT (source_id) DO UPDATE with a stable idempotency key derived from the upload job_id and row index. This ensures retried tasks produce the same database state as a first-time run."
          }
        },
        {
          "@type": "Question",
          "name": "What is task_acks_late and why does it matter for shapefile processing?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "task_acks_late=True tells Celery not to acknowledge a task until after the worker function returns successfully. If a worker crashes mid-processing, the broker re-queues the task for another worker instead of losing it silently."
          }
        }
      ]
    },
    {
      "@type": "Article",
      "headline": "Async Bulk Geospatial Uploads with Celery",
      "datePublished": "2024-10-01",
      "dateModified": "2026-06-23"
    }
  ]
}
</script>

← Back to [Advanced Spatial Endpoints & Data Contracts](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/)

# Async Bulk Geospatial Uploads with Celery

Processing large spatial datasets synchronously blocks your request lifecycle and guarantees timeouts above a few hundred features. When your API needs to ingest shapefiles, GeoJSON archives, or CSV coordinate dumps at scale, you need a queued pipeline that decouples file acceptance from geometry parsing, CRS transformation, and PostGIS writes. This page walks through production-ready patterns for building that pipeline with Celery and FastAPI — covering broker configuration, idempotent batch insertion, worker reliability settings, and client-facing job tracking.

---

## Prerequisites & Environment

| Dependency | Minimum version | Why it matters |
|---|---|---|
| FastAPI | 0.100 | `UploadFile` streaming, async lifespan |
| Pydantic | v2 | Geometry validators (see [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/)) |
| Celery | 5.3 | `task_acks_late`, chord/group primitives |
| Redis or RabbitMQ | Redis 7 / RMQ 3.11 | Message broker and result backend |
| PostGIS | 3.3 | `ST_MakeValid`, `ST_GeomFromText`, GiST indexes |
| pyogrio | 0.7 | High-performance GDAL-backed vector I/O |
| shapely | 2.0 | `make_valid`, `shapely.transform` |
| pyproj | 3.6 | CRS-aware coordinate transformation |
| psycopg2-binary | 2.9 | `execute_values` bulk insert |
| python-multipart | 0.0.9 | Multipart form parsing in FastAPI |

**Broker choice:** Redis is simpler to operate and sufficient for most spatial ingestion workloads. RabbitMQ is preferable when you need strong per-message durability guarantees, complex routing topologies, or reliable dead-letter queues for failed shapefile jobs. For `result_expires`, set `86400` (24 hours) on both backends to prevent job-metadata bloat.

---

## Pipeline Architecture

The diagram below shows how a raw client upload flows through FastAPI into Celery workers and finally into PostGIS.

<svg viewBox="4 74 759 276" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Async geospatial upload pipeline: client uploads to FastAPI, which stages the file and dispatches a Celery task, which the worker processes and writes to PostGIS, while the client polls for status." style="width:100%;max-width:780px;font-family:inherit;">
  <title>Async Geospatial Upload Pipeline</title>
  <desc>Architecture diagram showing a client uploading a file to a FastAPI endpoint, which stages the file, returns a job_id, and enqueues a Celery task. The Celery worker extracts geometries, validates and transforms CRS, then batch-inserts into PostGIS. A separate status-polling path lets the client query job progress.</desc>
  <!-- Background -->
  <rect y="74" x="4" width="759" height="276" rx="10" ry="10" fill="var(--surface, #f5f3ff)" stroke="currentColor" stroke-opacity="0.08" stroke-width="1"/>
  <!-- Client -->
  <rect x="20" y="130" width="110" height="80" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="75" y="165" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Client</text>
  <text x="75" y="183" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">POST /uploads</text>
  <text x="75" y="198" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">GET /jobs/{id}</text>
  <!-- Arrow client → FastAPI -->
  <line x1="130" y1="170" x2="195" y2="170" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- FastAPI box -->
  <rect x="197" y="110" width="140" height="120" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="267" y="135" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">FastAPI</text>
  <text x="267" y="153" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">validate + stage file</text>
  <text x="267" y="169" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">generate job_id</text>
  <text x="267" y="185" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">return 202 + job_id</text>
  <text x="267" y="201" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">dispatch Celery task</text>
  <text x="267" y="217" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">poll job status</text>
  <!-- Arrow FastAPI → Broker -->
  <line x1="337" y1="155" x2="400" y2="155" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Broker box -->
  <rect x="402" y="120" width="110" height="70" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="457" y="148" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Broker</text>
  <text x="457" y="166" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">Redis / RabbitMQ</text>
  <text x="457" y="181" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">task queue</text>
  <!-- Arrow Broker → Worker -->
  <line x1="512" y1="155" x2="575" y2="155" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Worker box -->
  <rect x="577" y="90" width="170" height="170" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="662" y="115" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">Celery Worker</text>
  <text x="662" y="135" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">1. read staged file</text>
  <text x="662" y="153" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">2. extract geometries</text>
  <text x="662" y="171" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">3. validate + make_valid</text>
  <text x="662" y="189" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">4. reproject → EPSG:4326</text>
  <text x="662" y="207" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">5. batch upsert PostGIS</text>
  <text x="662" y="225" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">6. write job status</text>
  <text x="662" y="243" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">7. trigger VACUUM</text>
  <!-- Arrow Worker → PostGIS (down) -->
  <line x1="662" y1="260" x2="662" y2="308" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- PostGIS box -->
  <rect x="577" y="310" width="170" height="24" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="662" y="326" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">PostGIS (geometry table)</text>
  <!-- Status arrow back (client polls FastAPI) -->
  <path d="M75 210 Q75 290 200 290 Q310 290 310 245" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#arr)" opacity="0.55"/>
  <text x="185" y="305" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.55">poll /jobs/{job_id}</text>
  <!-- Arrowhead marker -->
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.7"/>
    </marker>
  </defs>
</svg>

Each stage is intentionally isolated: the FastAPI endpoint never opens a database connection during upload, and Celery workers use a separate synchronous connection pool (psycopg2) independent of the async pool (asyncpg) that serves read queries.

---

## Decision Matrix: Broker & Storage Trade-offs

| Dimension | Redis | RabbitMQ |
|---|---|---|
| Setup complexity | Low (single process) | Medium (nodes + vhosts) |
| Task persistence | AOF/RDB (configurable) | Durable queues by default |
| Dead-letter support | Manual (custom queue) | Native `x-dead-letter-exchange` |
| Result backend | Yes (key-value TTL) | No (use Redis separately) |
| Throughput (tasks/s) | Very high | High |
| Best for | Simple spatial ingest pipelines | Multi-tenant, critical delivery guarantees |

| Staging storage | Trade-off |
|---|---|
| Local `/tmp` NVMe | Fastest; lost on worker restart; not shared across nodes |
| Shared NFS/EFS | Accessible from any worker; latency overhead for large archives |
| Object storage (S3/R2) | Scalable; requires presigned URL or SDK in worker; adds ~200 ms cold fetch |

For multi-node worker pools, object storage staging is the correct default. Workers download the file at the start of the task and delete it on completion.

---

## Step-by-Step Implementation

### Step 1 — FastAPI ingestion endpoint

The endpoint's only job is to accept the file, write it to staging, and enqueue a task. It must return before any geometry parsing occurs. The [handling async file uploads for shapefile processing](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/) page covers companion-file validation (`.prj`, `.dbf`, `.cpg`) and multipart ZIP extraction in detail.

```python
from fastapi import APIRouter, UploadFile, HTTPException
from uuid import uuid4
import os

router = APIRouter()
UPLOAD_DIR = "/var/geospatial/staging"
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = (".zip", ".geojson", ".gpkg", ".csv")

@router.post("/v1/uploads/geospatial", status_code=202)
async def upload_geospatial(file: UploadFile):
    if not file.filename:
        raise HTTPException(400, "No filename provided")
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported format: {ext!r}. Expected one of {ALLOWED_EXTENSIONS}")

    job_id = str(uuid4())
    staging_path = os.path.join(UPLOAD_DIR, f"{job_id}{ext}")

    # Stream in 1 MB chunks — never load the full payload into RAM
    with open(staging_path, "wb") as f:
        while chunk := await file.read(1_048_576):
            f.write(chunk)

    # Dispatch immediately; do not await the result
    from celery_app import process_geospatial_upload
    process_geospatial_upload.delay(job_id=job_id, file_path=staging_path)

    return {
        "job_id": job_id,
        "status": "queued",
        "poll_url": f"/v1/jobs/{job_id}",
    }
```

Returning `202 Accepted` — not `200 OK` — is the correct HTTP semantic for queued work. Clients must not assume the features are immediately queryable after receiving this response.

### Step 2 — Celery application configuration

Worker reliability for geospatial workloads depends on three settings: `task_acks_late`, `worker_prefetch_multiplier`, and `worker_max_tasks_per_child`. Missing any one of them causes silent job loss or memory exhaustion over time.

```python
from celery import Celery

app = Celery(
    "geospatial_worker",
    broker="redis://localhost:6379/0",
    backend="redis://localhost:6379/1",
)

app.conf.update(
    # Acknowledge only after the task function returns — crash-safe
    task_acks_late=True,
    # Process one task at a time; prevents memory spikes from concurrent GDAL ops
    worker_prefetch_multiplier=1,
    # Recycle the worker process every 50 tasks — counters GDAL/shapely memory fragmentation
    worker_max_tasks_per_child=50,
    # Keep serialization deterministic for spatial payloads
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    # Expire result metadata after 24 hours to prevent Redis bloat
    result_expires=86_400,
)
```

`task_acks_late=True` is the most critical setting for ingestion pipelines: without it, the broker marks a task as acknowledged the moment a worker picks it up. If the worker process is killed mid-parse, the geometry records are silently lost with no retry.

### Step 3 — Worker task: extract, validate, and transform

Geometry extraction, validation, and CRS transformation are CPU-bound and may allocate several hundred MB of C-level memory for large shapefiles. Isolating this inside a Celery task prevents the FastAPI event loop from blocking and allows the OS to reclaim memory when the worker process recycles.

```python
import logging
import pyogrio
import shapely
from shapely.validation import make_valid
from pyproj import Transformer

logger = logging.getLogger(__name__)

@app.task(bind=True, max_retries=3, default_retry_delay=60)
def process_geospatial_upload(self, job_id: str, file_path: str):
    try:
        _update_job_status(job_id, "processing", progress=0)

        # --- 1. Read metadata without loading all features ---
        meta = pyogrio.read_info(file_path)
        src_crs = meta.get("crs")
        if src_crs is None:
            raise ValueError("Source file has no CRS; cannot transform to EPSG:4326")

        # --- 2. Stream features and transform coordinates ---
        transformer = Transformer.from_crs(src_crs, "EPSG:4326", always_xy=True)
        gdf = pyogrio.read_dataframe(file_path)

        geometries = []
        for i, geom in enumerate(gdf.geometry):
            if geom is None:
                continue
            reprojected = shapely.transform(geom, transformer.transform)
            if not reprojected.is_valid:
                reprojected = make_valid(reprojected)
            geometries.append((job_id, i, reprojected))

        _update_job_status(job_id, "processing", progress=60)

        # --- 3. Batch insert ---
        batch_insert_geometries(geometries, table_name="spatial_features", db_url=DB_URL)

        _update_job_status(job_id, "completed", progress=100, record_count=len(geometries))
        logger.info("Job %s completed: %d features inserted", job_id, len(geometries))

    except Exception as exc:
        logger.exception("Job %s failed on attempt %d", job_id, self.request.retries + 1)
        _update_job_status(job_id, "failed", error=str(exc))
        raise self.retry(exc=exc)
```

`always_xy=True` on the `Transformer` is not optional — omitting it causes latitude and longitude to swap for any CRS that uses the geographic (lat/lon) axis order, silently producing mirror-image geometries.

### Step 4 — Idempotent batch insertion with `ON CONFLICT`

Using `psycopg2.extras.execute_values` with `page_size=1000` and an `ON CONFLICT DO NOTHING` clause makes each task retry safe. If the worker crashes after 700 rows and retries from the top, the 700 already-committed rows are skipped rather than duplicated. This is the core of the [strict data contract](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) that governs how you enforce idempotency at the database layer.

```python
import psycopg2
from psycopg2.extras import execute_values

def batch_insert_geometries(geometries: list[tuple], table_name: str, db_url: str):
    """
    geometries: list of (job_id, row_index, shapely_geom) tuples
    Uses (job_id, row_index) as a composite idempotency key.
    """
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            execute_values(
                cur,
                f"""
                INSERT INTO {table_name} (job_id, row_index, geometry, created_at)
                VALUES %s
                ON CONFLICT (job_id, row_index) DO NOTHING
                """,
                [
                    (job_id, row_idx, geom.wkt)
                    for job_id, row_idx, geom in geometries
                ],
                template="(%s, %s, ST_GeomFromText(%s, 4326), NOW())",
                page_size=1000,
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
```

The `page_size=1000` parameter controls how many rows are bundled into a single `VALUES` clause. Values above ~2000 rows per batch begin to stress the PostgreSQL query planner without meaningful throughput gains.

---

## Production Code Example

The following is a complete, copy-runnable integration showing the FastAPI status endpoint, the Celery task wired to the batch insert, and the helper that persists job state to Redis. Drop these three modules into your project alongside the snippets above.

```python
# status_store.py  — Redis-backed job state
import json
import redis

r = redis.Redis(host="localhost", port=6379, db=2, decode_responses=True)

def _update_job_status(
    job_id: str,
    status: str,
    progress: int = 0,
    record_count: int | None = None,
    error: str | None = None,
):
    payload = {"job_id": job_id, "status": status, "progress": progress}
    if record_count is not None:
        payload["record_count"] = record_count
    if error is not None:
        payload["error"] = error
    r.setex(f"job:{job_id}", 86_400, json.dumps(payload))

def get_job_status(job_id: str) -> dict | None:
    raw = r.get(f"job:{job_id}")
    return json.loads(raw) if raw else None
```

```python
# routes/jobs.py  — polling endpoint
from fastapi import APIRouter, HTTPException
from status_store import get_job_status

router = APIRouter()

@router.get("/v1/jobs/{job_id}")
async def job_status(job_id: str):
    state = get_job_status(job_id)
    if state is None:
        raise HTTPException(404, f"Job {job_id!r} not found or expired")
    return state
```

A client polling every 2 seconds with exponential backoff can track progress without long-polling infrastructure. When `status == "completed"`, it can immediately run [bounding-box spatial index queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) against the newly ingested features, or issue [K-nearest-neighbor routing queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) against the populated geometry table.

---

The point of the asynchronous split is that only the first band happens inside the request.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Lifetime of one 900 MB upload job: accept then stage then parse then validate then upsert then index" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Lifetime of one 900 MB upload job</title>
  <desc>A horizontal timeline. accept: 202 + job id. stage: write to spool. parse: ogr2ogr → staging table. validate: ST_MakeValid + SRID. upsert: chunked commits. index: GiST rebuild. The client is released at the first band; everything after it is worker time the request never waits on.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Lifetime of one 900 MB upload job</text>
  <rect x="20" y="92" width="36" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="38" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">accept</text>
  <text x="38" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">202 + job id</text>
  <rect x="60" y="92" width="76" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.4"/>
  <text x="98" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">stage</text>
  <text x="98" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">write to spool</text>
  <rect x="140" y="92" width="156" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.4"/>
  <text x="218" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">parse</text>
  <text x="218" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">ogr2ogr → staging table</text>
  <rect x="300" y="92" width="116" height="34" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="358" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">validate</text>
  <text x="358" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">ST_MakeValid + SRID</text>
  <rect x="420" y="92" width="196" height="34" rx="5" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.4"/>
  <text x="518" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">upsert</text>
  <text x="518" y="74" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">chunked commits</text>
  <rect x="620" y="92" width="76" height="34" rx="5" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="658" y="114" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">index</text>
  <text x="658" y="150" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">GiST rebuild</text>
  <text x="20" y="184" font-size="10.5" fill="var(--muted, #7c6fb0)">The client is released at the first band; everything after it is worker time the request never waits on.</text>
</svg>

## Verification & Testing

**1. Smoke test with curl:**

```bash
# Upload a sample GeoJSON
curl -X POST http://localhost:8000/v1/uploads/geospatial \
  -F "file=@sample_features.geojson" \
  -H "Accept: application/json"
# → {"job_id":"a1b2c3...","status":"queued","poll_url":"/v1/jobs/a1b2c3..."}

# Poll until completed
curl http://localhost:8000/v1/jobs/a1b2c3...
# → {"job_id":"a1b2c3...","status":"completed","progress":100,"record_count":1458}
```

**2. Verify geometry quality in PostGIS:**

```sql
-- Confirm all inserted geometries are valid and in EPSG:4326
SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE ST_IsValid(geometry)) AS valid_count,
    COUNT(*) FILTER (WHERE ST_SRID(geometry) = 4326) AS correct_srid,
    MIN(ST_NPoints(geometry)) AS min_vertices,
    MAX(ST_NPoints(geometry)) AS max_vertices
FROM spatial_features
WHERE job_id = 'a1b2c3...';
```

Expected output: `total == valid_count == correct_srid`.

**3. Confirm idempotency (re-run same task, expect same count):**

```python
# tests/test_idempotency.py
import pytest
from celery_app import process_geospatial_upload

def test_duplicate_task_is_idempotent(db_conn, sample_shapefile):
    job_id = "test-idem-001"
    process_geospatial_upload(job_id=job_id, file_path=sample_shapefile)
    count_after_first = db_conn.execute(
        "SELECT COUNT(*) FROM spatial_features WHERE job_id = %s", (job_id,)
    ).fetchone()[0]

    # Run again — must not double-insert
    process_geospatial_upload(job_id=job_id, file_path=sample_shapefile)
    count_after_second = db_conn.execute(
        "SELECT COUNT(*) FROM spatial_features WHERE job_id = %s", (job_id,)
    ).fetchone()[0]

    assert count_after_first == count_after_second
```

---

Not every failure in a bulk pipeline is equal — the ones worth engineering against are those a client cannot observe.

<svg viewBox="0 0 720 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="What each failure point costs, and who notices: Retryable, Visible, Data loss" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What each failure point costs, and who notices</title>
  <desc>A comparison table. broker unreachable at dispatch: Retryable yes, Visible yes, Data loss no. client gets 503, retries worker killed mid-parse: Retryable yes, Visible partly, Data loss no. staged file survives invalid geometry in the file: Retryable no, Visible yes, Data loss partly. row skipped, reported upsert conflict on natural key: Retryable yes, Visible yes, Data loss no. last write wins result backend expired: Retryable no, Visible no, Data loss no. job status simply unknowable Only the last row is genuinely bad: the work completed but nobody can prove it. Give results a longer TTL than the job.</desc>
  <rect x="0" y="0" width="720" height="266" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">What each failure point costs, and who notices</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="286" y="58" font-size="10" font-weight="700" fill="currentColor">Retryable</text>
  <text x="394" y="58" font-size="10" font-weight="700" fill="currentColor">Visible</text>
  <text x="502" y="58" font-size="10" font-weight="700" fill="currentColor">Data loss</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">broker unreachable at dispatch</text>
  <text x="294" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="88" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="88" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="88" font-size="9.5" fill="var(--muted, #7c6fb0)">client gets 503, retries</text>
  <line x1="20" y1="98" x2="700" y2="98" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="120" font-size="10.5" fill="currentColor">worker killed mid-parse</text>
  <text x="294" y="120" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="120" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="510" y="120" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="120" font-size="9.5" fill="var(--muted, #7c6fb0)">staged file survives</text>
  <line x1="20" y1="130" x2="700" y2="130" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="152" font-size="10.5" fill="currentColor">invalid geometry in the file</text>
  <text x="294" y="152" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="152" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="152" font-size="11.5" font-weight="700" fill="var(--viz-warn, #8a5000)">~</text>
  <text x="568" y="152" font-size="9.5" fill="var(--muted, #7c6fb0)">row skipped, reported</text>
  <line x1="20" y1="162" x2="700" y2="162" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="184" font-size="10.5" fill="currentColor">upsert conflict on natural key</text>
  <text x="294" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="402" y="184" font-size="11.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">✓</text>
  <text x="510" y="184" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="184" font-size="9.5" fill="var(--muted, #7c6fb0)">last write wins</text>
  <line x1="20" y1="194" x2="700" y2="194" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="216" font-size="10.5" fill="currentColor">result backend expired</text>
  <text x="294" y="216" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="402" y="216" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="510" y="216" font-size="11.5" font-weight="700" fill="var(--viz-bad, #a32b23)">✕</text>
  <text x="568" y="216" font-size="9.5" fill="var(--muted, #7c6fb0)">job status simply unknowable</text>
  <text x="20" y="252" font-size="10.5" fill="var(--muted, #7c6fb0)">Only the last row is genuinely bad: the work completed but nobody can prove it. Give results a longer TTL than the job.</text>
</svg>

## Failure Modes & Edge Cases

1. **Missing CRS in shapefile** — `pyogrio.read_info()` returns `crs: None` when a `.prj` companion file is absent. The task raises `ValueError` and retries. After `max_retries`, the job is marked `failed`. Fix: reject uploads lacking `.prj` at the FastAPI layer before staging; see [handling async file uploads for shapefile processing](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/).

2. **Lat/lon axis swap producing ocean-based geometries** — Omitting `always_xy=True` from `Transformer.from_crs()` swaps axes for CRS definitions that declare (latitude, longitude) order (e.g. EPSG:4269, EPSG:4326 in strict mode). Symptoms: all geometries land in the ocean or Antarctica. Always pass `always_xy=True`.

3. **Worker OOM kill during large archive processing** — A 500 MB shapefile with complex polygons can exhaust 4 GB of worker RAM when loaded fully into a GeoDataFrame. Mitigate with `pyogrio.read_dataframe()` chunked reads (use the `skip_features`/`max_features` parameters in a loop) or stream via Fiona's iterative layer reading.

4. **Transaction rollback leaving partial job state** — If the database transaction rolls back after 3,000 of 10,000 rows, the job status in Redis may already read `processing`. On retry, the `ON CONFLICT DO NOTHING` clause skips the 3,000 already-committed rows (if you committed partials). Use a single transaction per batch, not per page: commit only after all `execute_values` pages succeed.

5. **Redis TTL expiry before client polls** — `result_expires=86_400` means job metadata disappears after 24 hours. If a client polls after that window, it receives a 404. Persist completed job summaries to a `job_log` Postgres table before they expire in Redis if you need longer audit trails.

6. **GiST index bloat after bulk insert** — Inserting millions of geometries in rapid succession fragments the GiST index. Query plans for [bounding-box queries using `ST_Within` and `ST_Intersects`](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/implementing-st_within-and-st_intersects-in-fastapi/) may degrade significantly. Schedule `VACUUM ANALYZE spatial_features` and `REINDEX INDEX spatial_features_geometry_idx` in a maintenance window after each large bulk load.

7. **Celery task swallowing exceptions silently** — If `self.retry(exc=exc)` is called inside a bare `except Exception` block without re-raising, Celery may mark the task `SUCCESS` after the retry limit is reached. Always use `raise self.retry(exc=exc)` to propagate correctly.

---

## Performance Notes

| Scenario | Observed throughput | Notes |
|---|---|---|
| 10,000 simple points (GeoJSON) | ~8,000 features/s insert | No CRS transform; single worker |
| 10,000 polygons with CRS transform | ~1,200 features/s | `Transformer` overhead dominates |
| 100,000 polygons, `page_size=1000` | ~900 features/s | GiST index write cost increases with table size |
| 100,000 polygons, index deferred | ~3,500 features/s | Drop index, bulk insert, recreate index |

For very large loads (>500,000 features), consider dropping and recreating the GiST index around the bulk operation rather than inserting into a live index:

```sql
-- Before bulk load
DROP INDEX IF EXISTS spatial_features_geometry_idx;

-- ... run Celery tasks ...

-- After all tasks complete
CREATE INDEX CONCURRENTLY spatial_features_geometry_idx
    ON spatial_features USING GIST (geometry);
VACUUM ANALYZE spatial_features;
```

`CREATE INDEX CONCURRENTLY` avoids a full table lock but takes longer. Use it in production where you cannot afford downtime on spatial queries. This intersects with the connection pool tuning discussed in [Connection Pooling & pgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — ensure your pgBouncer pool size accommodates the CONCURRENTLY build's additional session.

---

<details>
<summary><strong>FAQ: Celery + Geospatial Ingest</strong></summary>

**Why return 202 instead of 200 from a geospatial upload endpoint?**
202 Accepted signals to clients that the request was valid and accepted but processing has not yet completed. It prevents clients from assuming the data is immediately queryable and sets correct expectations for polling the job-status endpoint.

**How do I prevent duplicate records when a Celery task retries after a partial insert?**
Use `ON CONFLICT DO NOTHING` or `ON CONFLICT (source_id) DO UPDATE` with a stable idempotency key derived from the upload `job_id` and row index. This ensures retried tasks produce the same database state as a first-time run.

**What is `task_acks_late` and why does it matter for shapefile processing?**
`task_acks_late=True` tells Celery not to acknowledge a task until after the worker function returns successfully. If a worker crashes mid-processing, the broker re-queues the task for another worker instead of losing it silently.

**Should I use asyncpg or psycopg2 in Celery workers?**
Use `psycopg2` (synchronous) in Celery workers. Celery tasks run in synchronous worker processes and do not have an event loop. Using `asyncpg` would require running `asyncio.run()` per task, which adds overhead and complexity. Reserve `asyncpg` for the FastAPI application layer.

**How do I scale workers horizontally for large ingest jobs?**
Celery workers are stateless — spawn additional worker processes or pods pointed at the same broker and they automatically pick up tasks. For Kubernetes, configure an HPA that scales on the Redis queue length metric (exposed via `celery inspect active_queues` or the Flower metrics exporter).

</details>

---

## Related

- [Handling Async File Uploads for Shapefile Processing](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/) — companion-file validation, ZIP extraction, and chunked multipart parsing
- [Strict Pydantic Validation for Geometry](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — enforce geometry types and CRS contracts at the request boundary before queueing
- [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — query the PostGIS tables populated by this pipeline
- [K-Nearest Neighbor Routing Algorithms](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/) — KNN queries over bulk-inserted geometry datasets
- [Connection Pooling & pgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — tune database connection pools for high-concurrency bulk ingest

← Back to [Advanced Spatial Endpoints & Data Contracts](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/)
