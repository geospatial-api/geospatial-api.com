---
layout: layouts/page.njk
title: "Async Bulk Uploads with Celery for Geospatial APIs"
description: "Build async bulk geospatial ingest with Celery and FastAPI. Queue shapefile and GeoJSON uploads, parse with GDAL workers, and write to PostGIS with ON CONFLICT idempotency."
---

# Async Bulk Uploads with Celery for Geospatial APIs

Processing large geospatial datasets synchronously is a guaranteed path to request timeouts, memory exhaustion, and degraded API performance. When building spatial platforms that ingest shapefiles, GeoJSON, or CSV coordinate dumps, you need a robust queueing architecture. **Async bulk uploads with Celery** provide exactly that: a decoupled, scalable pipeline that offloads heavy I/O and CPU-bound geometry transformations away from your FastAPI request lifecycle. This guide walks through production-ready patterns for queuing, parsing, validating, and committing spatial records into PostGIS without blocking your main application threads.

## Prerequisites & Stack Configuration

Before implementing this ingestion pipeline, ensure your stack meets these baseline requirements:
- FastAPI 0.100+ with Pydantic v2 for strict geometry validation and request modeling
- PostGIS 3.3+ with GiST spatial indexing and `ST_MakeValid` support
- Celery 5.3+ paired with Redis or RabbitMQ as the message broker and result backend
- `python-multipart` for form parsing, `geopandas` or `pyogrio` for vector I/O
- Connection pooling configured via `asyncpg` (FastAPI) and `psycopg2`/`SQLAlchemy 2.0` (Celery)
- Familiarity with [Advanced Spatial Endpoint Implementation & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/) principles for structuring your ingestion payloads

Aligning your infrastructure around these components ensures predictable memory footprints and deterministic task execution. For message brokers, Redis offers lower latency for simple task routing, while RabbitMQ provides stronger delivery guarantees and dead-letter queue support—critical when processing multi-gigabyte spatial archives. Always configure your Celery result backend with a reasonable expiration policy (`result_expires=86400`) to prevent Redis memory bloat from stale job metadata.

## Architecture & Workflow Design

The ingestion pipeline follows a strict state machine to guarantee data integrity, traceability, and predictable resource consumption:

1. **Client Upload:** The frontend streams a compressed archive or multipart form to a dedicated `/v1/uploads/geospatial` endpoint.
2. **Payload Validation & Staging:** FastAPI validates file type and size, writes the payload to a temporary directory or object storage, and immediately returns a `job_id`.
3. **Task Dispatch:** The endpoint pushes a Celery task containing the `job_id` and file path to the broker queue.
4. **Worker Processing:** Celery workers pull the job, extract geometries, run topological validation, transform coordinate reference systems (CRS), and batch-insert into PostGIS.
5. **Indexing & Finalization:** Once committed, workers trigger spatial index updates, log metrics, and mark the job as `completed` or `failed`.
6. **Status Polling:** Clients query `/jobs/{job_id}` to track progress, leveraging HTTP polling or WebSockets.

This architecture naturally complements downstream spatial operations like [Bounding Box & Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) and [K-Nearest Neighbor Routing Algorithms](/advanced-spatial-endpoint-implementation-data-contracts/k-nearest-neighbor-routing-algorithms/), which depend on clean, indexed geometry tables. By isolating ingestion from query execution, you prevent write-heavy operations from starving read-heavy analytical workloads.

## FastAPI Ingestion Endpoint

The entry point must remain lightweight. It accepts the file, generates a UUID, and delegates to Celery without performing any heavy computation. Synchronous endpoints should never parse geometry or open database connections during the upload phase.

```python
from fastapi import APIRouter, UploadFile, HTTPException
from uuid import uuid4
import os
from celery_app import process_geospatial_upload

router = APIRouter()
UPLOAD_DIR = "/tmp/geospatial_staging"

@router.post("/v1/uploads/geospatial", status_code=202)
async def upload_geospatial(file: UploadFile):
    if not file.filename.endswith((".zip", ".geojson", ".shp", ".csv")):
        raise HTTPException(400, "Unsupported file format")

    job_id = str(uuid4())
    staging_path = os.path.join(UPLOAD_DIR, f"{job_id}_{file.filename}")

    # Stream to disk to avoid memory spikes
    with open(staging_path, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            f.write(chunk)

    # Dispatch to Celery immediately
    process_geospatial_upload.delay(job_id=job_id, file_path=staging_path)

    return {"job_id": job_id, "status": "queued", "message": "Upload accepted. Processing initiated."}
```

Note that streaming the file in 1MB chunks prevents the entire payload from loading into RAM. For production deployments handling shapefile archives, consider reviewing [Handling async file uploads for shapefile processing](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/) to implement chunked multipart parsing and automatic `.cpg`/`.prj` companion file validation. Always return a `202 Accepted` status code to explicitly signal asynchronous processing.

## Celery Task Orchestration & Worker Logic

Celery workers operate in isolated processes. This isolation is crucial for geospatial workloads because libraries like `geopandas` and `shapely` rely heavily on C-extensions that can cause memory fragmentation if reused across threads. Configure your Celery app with `worker_prefetch_multiplier=1` and `task_acks_late=True` to ensure fair task distribution and prevent lost jobs during worker restarts.

```python
from celery import Celery
import logging

app = Celery("geospatial_worker", broker="redis://localhost:6379/0", backend="redis://localhost:6379/1")
app.conf.update(
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    worker_max_tasks_per_child=50  # Prevents long-running memory leaks
)

@app.task(bind=True, max_retries=3, default_retry_delay=60)
def process_geospatial_upload(self, job_id: str, file_path: str):
    logger = logging.getLogger(__name__)
    try:
        logger.info(f"Processing job {job_id} from {file_path}")
        # 1. Extract & Parse
        # 2. Validate & Transform CRS
        # 3. Batch Insert
        # 4. Update Job Status
        pass
    except Exception as exc:
        logger.error(f"Job {job_id} failed: {exc}")
        self.retry(exc=exc)
```

The `max_retries` and `task_acks_late` configuration ensures that transient failures (e.g., temporary database connection drops or network timeouts during object storage fetches) are handled gracefully without data loss. The `worker_max_tasks_per_child` directive forces worker process recycling, which is essential when running native GIS libraries that do not fully release allocated memory back to the OS.

## Geospatial Validation & CRS Transformation

Raw spatial data is notoriously inconsistent. Before insertion, every geometry must pass topological validation and be normalized to a target projection (typically `EPSG:4326` for web mapping or `EPSG:3857` for tiled rendering). Use `pyogrio` for high-performance vector I/O, and leverage `shapely.validation.make_valid` to repair self-intersecting polygons.

```python
import pyogrio
import shapely
from shapely.validation import make_valid
from pyproj import Transformer

def normalize_geometries(file_path: str, target_crs: int = 4326):
    meta = pyogrio.read_info(file_path)
    src_crs = meta.get("crs_wkt") or meta.get("crs")

    transformer = Transformer.from_crs(src_crs, f"EPSG:{target_crs}", always_xy=True)

    geometries = []
    # read_dataframe returns a GeoDataFrame; iterate geometry column for Shapely objects
    gdf = pyogrio.read_dataframe(file_path)
    for geom in gdf.geometry:
        if geom is None:
            continue
        new_geom = shapely.transform(geom, transformer.transform)
        if not new_geom.is_valid:
            new_geom = make_valid(new_geom)
        geometries.append(new_geom)

    return geometries
```

Coordinate transformation should always use `always_xy=True` to prevent latitude/longitude swapping, a common pitfall when migrating from legacy GIS software. For deeper insights into projection handling, spatial reference systems, and OGC compliance, consult the official [PostGIS documentation](https://postgis.net/documentation/).

## Batch Insertion & Transaction Management

Inserting thousands of geometries row-by-row will bottleneck your database. Instead, use `psycopg2.extras.execute_values` or SQLAlchemy 2.0's bulk insert capabilities. Wrap the operation in a transaction to guarantee atomicity: either all records commit, or the entire batch rolls back.

```python
import psycopg2
from psycopg2.extras import execute_values

def batch_insert_geometries(geometries: list, table_name: str, db_url: str):
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            wkt_data = [geom.wkt for geom in geometries]
            # execute_values replaces the single %s in VALUES with per-row templates
            query = f"INSERT INTO {table_name} (geometry, created_at) VALUES %s"
            execute_values(
                cur,
                query,
                [(wkt,) for wkt in wkt_data],
                template="(ST_GeomFromText(%s, 4326), NOW())",
                page_size=1000
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
```

Transaction boundaries must align with your business logic. If you're performing multi-step updates—such as calculating derived attributes, updating materialized views, or triggering webhook notifications—review Managing database transactions for multi-step geospatial updates to implement savepoints and compensating actions. Using `page_size=1000` strikes a balance between network round-trips and memory overhead during bulk inserts.

## Monitoring, Error Handling & Client Polling

A robust async pipeline requires visibility. Store task progress in Redis or a dedicated `job_status` table. FastAPI can expose a lightweight polling endpoint that queries this state without touching the primary database.

```python
@router.get("/jobs/{job_id}")
async def get_job_status(job_id: str):
    # Query Redis or DB for job state
    # Return: {"job_id": job_id, "status": "processing", "progress": 65, "records_processed": 1240}
    pass
```

For lighter workloads where full Celery orchestration introduces unnecessary complexity, consider Using FastAPI background tasks for async geocoding as an alternative. However, for true bulk ingestion with retry logic, distributed worker scaling, and persistent result storage, Celery remains the industry standard.

Implement structured logging to capture task duration, memory usage, and failure reasons. Integrate Prometheus metrics to track queue depth, worker utilization, and insertion throughput. When queue depth exceeds a threshold, auto-scale Celery workers using Kubernetes HPA or AWS ECS scaling policies. Always expose a `/health` endpoint that checks broker connectivity and worker liveness before routing traffic.

## Scaling Considerations & Production Hardening

As your platform grows, several bottlenecks typically emerge:
- **Memory Leaks:** Geospatial libraries allocate native memory. Restart workers periodically or use `worker_max_tasks_per_child` to schedule graceful process recycling.
- **Disk I/O Contention:** Staging large `.zip` archives on the same volume as your database WAL files will degrade performance. Use ephemeral NVMe storage or mount object storage via `s3fs`/`goofys`.
- **CRS Mismatch Hell:** Always enforce a strict data contract. Reject uploads that lack projection metadata or contain mixed-coordinate geometries.
- **Index Bloat:** PostGIS GiST indexes fragment during heavy bulk inserts. Schedule `VACUUM ANALYZE` and `REINDEX` during maintenance windows to reclaim space and maintain query performance.

Refer to the official [Celery documentation](https://docs.celeryq.dev/en/stable/) for advanced configuration patterns like task rate limiting, chord dependencies, and result expiration policies. Implement idempotency keys in your upload requests to prevent duplicate processing when clients retry failed network calls.

## Conclusion

Implementing async bulk uploads with Celery transforms geospatial data ingestion from a fragile, blocking operation into a resilient, horizontally scalable workflow. By decoupling upload acceptance from geometry parsing, enforcing strict validation boundaries, and leveraging batched PostGIS transactions, you ensure your API remains responsive under heavy load. As your spatial datasets grow, this architecture provides the foundation for advanced analytics, real-time routing, and high-throughput mapping services.