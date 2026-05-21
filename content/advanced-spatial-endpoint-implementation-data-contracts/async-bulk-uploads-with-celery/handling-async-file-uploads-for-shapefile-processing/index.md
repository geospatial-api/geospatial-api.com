---
layout: layouts/page.njk
title: "Handling async file uploads for shapefile processing"
description: "Handle async shapefile uploads in FastAPI by streaming .zip archives to disk, returning 202 Accepted, and delegating GDAL parsing to Celery background workers."
---

# Handling async file uploads for shapefile processing

Handling async file uploads for shapefile processing requires decoupling HTTP ingestion from CPU-bound GDAL parsing and PostGIS spatial indexing. FastAPI’s async event loop must never block on archive extraction, projection validation, or geometry transformation. Instead, accept the multipart `.zip` payload, persist it to a staging volume, immediately return a `202 Accepted` response with a task identifier, and delegate the heavy lifting to a background worker. This architecture prevents reverse-proxy gateway timeouts, respects Python’s GIL limitations, and scales horizontally across stateless worker nodes.

## Architecture & Async Decoupling

Shapefiles are inherently multi-file formats (`.shp`, `.shx`, `.dbf`, `.prj`, `.cpg`). Transmitting them individually breaks atomicity and complicates validation. Clients must bundle them into a single `.zip` archive before transmission. The API layer should strictly handle I/O: streaming bytes, validating file extensions, and writing to temporary storage. All spatial operations run synchronously in an isolated worker process. This pattern aligns with established [Advanced Spatial Endpoint Implementation & Data Contracts](/advanced-spatial-endpoint-implementation-data-contracts/) by enforcing a hard boundary between routing logic and geospatial computation.

## FastAPI Ingestion Layer

The endpoint acts as a lightweight dispatcher. It streams the upload directly to disk using `shutil.copyfileobj`, avoiding memory spikes from loading large binaries into RAM. A UUID4 task ID is generated, the file is staged, and the Celery task is queued before the response is returned.

```python
# app/api/uploads.py
import uuid
import shutil
from pathlib import Path
from fastapi import APIRouter, UploadFile, HTTPException, status
from app.celery_worker import process_shapefile_task

router = APIRouter(prefix="/api/v1/uploads", tags=["geospatial"])
STAGING_DIR = Path("/tmp/shapefile-staging")
STAGING_DIR.mkdir(exist_ok=True)

@router.post("/shapefile", status_code=status.HTTP_202_ACCEPTED)
async def upload_shapefile(file: UploadFile):
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(
            status_code=400, 
            detail="Shapefile bundles must be uploaded as .zip archives"
        )
    
    task_id = str(uuid.uuid4())
    staging_path = STAGING_DIR / f"{task_id}.zip"
    
    try:
        # Stream directly to disk to avoid RAM exhaustion
        with open(staging_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        # Delegate to Celery; non-blocking
        process_shapefile_task.delay(
            task_id=task_id,
            file_path=str(staging_path),
            target_crs="EPSG:4326",
            table_name="public.imported_features"
        )
        
        return {
            "task_id": task_id,
            "status": "queued",
            "message": "Processing initiated. Poll /status/{task_id} for updates."
        }
    except Exception as e:
        # Clean up partial writes on failure
        if staging_path.exists():
            staging_path.unlink()
        raise HTTPException(status_code=500, detail=f"Staging failed: {str(e)}")
```

## Celery Worker & GDAL Execution

The worker extracts the archive, validates mandatory shapefile components, and invokes `ogr2ogr` for ingestion. Using the GDAL CLI is strongly preferred over Python ORM bulk inserts because it handles CRS translation, geometry type normalization, and spatial index creation natively at the C++ level.

```python
# app/celery_worker.py
import os
import subprocess
import zipfile
import logging
from pathlib import Path
from celery import Celery

logger = logging.getLogger(__name__)
celery_app = Celery("geospatial_worker")
celery_app.conf.update(
    broker_url="redis://localhost:6379/0",
    result_backend="redis://localhost:6379/1",
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
)

REQUIRED_EXTENSIONS = {".shp", ".shx", ".dbf", ".prj"}

@celery_app.task(bind=True, max_retries=3, default_retry_delay=10)
def process_shapefile_task(self, task_id: str, file_path: str, target_crs: str, table_name: str):
    extract_dir = Path(f"/tmp/shapefile-extract/{task_id}")
    extract_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        with zipfile.ZipFile(file_path, "r") as zip_ref:
            zip_ref.extractall(extract_dir)
            
        # Validate mandatory files
        found_exts = {p.suffix.lower() for p in extract_dir.iterdir()}
        if not REQUIRED_EXTENSIONS.issubset(found_exts):
            raise ValueError(f"Missing required shapefile components. Found: {found_exts}")
            
        # Find the .shp base name
        shp_file = next(extract_dir.glob("*.shp"))
        base_name = shp_file.stem
        
        # Execute ogr2ogr for direct PostGIS streaming
        # See official GDAL documentation: https://gdal.org/programs/ogr2ogr.html
        cmd = [
            "ogr2ogr",
            "-f", "PostgreSQL",
            f"PG:host=localhost dbname=geodb user=postgres password=secret",
            str(shp_file),
            "-nln", table_name,
            "-nlt", "PROMOTE_TO_MULTI",
            "-t_srs", target_crs,
            "-lco", "GEOMETRY_NAME=geom",
            "-lco", "SPATIAL_INDEX=YES",
            "-lco", "FID=id",
            "-overwrite"
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        logger.info(f"Task {task_id} completed successfully: {result.stdout}")
        
        return {"status": "completed", "table": table_name, "records_ingested": True}
        
    except subprocess.CalledProcessError as e:
        logger.error(f"ogr2ogr failed for {task_id}: {e.stderr}")
        self.retry(exc=e)
    except Exception as e:
        logger.error(f"Unexpected error in {task_id}: {str(e)}")
        raise
    finally:
        # Cleanup staging and extraction dirs
        for p in [Path(file_path), extract_dir]:
            if p.exists():
                shutil.rmtree(p, ignore_errors=True)
```

## PostGIS Streaming & Indexing

The `ogr2ogr` command streams features directly into PostgreSQL using the `PG_USE_COPY` optimization (enabled by default in modern GDAL versions). This bypasses row-by-row `INSERT` overhead and leverages PostgreSQL's bulk copy protocol. The `-nlt PROMOTE_TO_MULTI` flag ensures mixed geometry types (e.g., `Polygon` and `MultiPolygon`) coexist in a single `GEOMETRY` column without schema violations. Spatial indexes are created automatically via the `-lco SPATIAL_INDEX=YES` layer creation option, eliminating a separate `CREATE INDEX` step.

For robust task orchestration, configure Celery to use exponential backoff on retries and route long-running spatial jobs to dedicated queues. Review the official [Celery task documentation](https://docs.celeryq.dev/en/stable/userguide/tasks.html) for advanced retry policies, rate limiting, and result backend configuration.

## Client Integration & Status Tracking

Once the `202 Accepted` response is returned, clients must track progress. Implement a lightweight `/status/{task_id}` endpoint that queries the Celery result backend. Return structured states: `queued`, `processing`, `completed`, or `failed` (with error details). For high-throughput platforms, replace polling with Server-Sent Events (SSE) or WebSockets to push state transitions. Detailed patterns for implementing resilient polling, idempotent retries, and result serialization are covered in [Async Bulk Uploads with Celery](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/).

## Production Hardening Checklist

- **Zip Bomb Protection**: Validate archive size limits and compression ratios before extraction. Reject archives exceeding 500MB or with extreme compression ratios (>1000:1).
- **Path Traversal Mitigation**: Sanitize extracted filenames. Never allow `../` sequences in archive entries.
- **CRS Validation**: Reject uploads missing `.prj` files unless a fallback CRS is explicitly provided by the client.
- **Connection Pooling**: Use `psycopg2` or `asyncpg` connection pooling for the worker database interactions. Avoid creating a new connection per task.
- **Idempotency**: Design the `table_name` parameter to support upserts or append-only modes. Include a `--skipfailures` flag in `ogr2ogr` if partial ingestion is acceptable.
- **Monitoring**: Instrument Celery with Prometheus metrics. Track queue depth, task duration, and GDAL exit codes to detect worker degradation early.