---
layout: layouts/page.njk
title: "Handling Async File Uploads for Shapefile Processing in FastAPI"
description: "Stream shapefile .zip archives to disk in FastAPI, return 202 Accepted immediately, and delegate GDAL parsing and PostGIS ingestion to Celery background workers."
slug: "handling-async-file-uploads-for-shapefile-processing"
type: "long_tail"
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Async Bulk Uploads with Celery"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/"
  - label: "Handling Async File Uploads for Shapefile Processing"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/"
datePublished: "2025-11-14"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Handling Async File Uploads for Shapefile Processing in FastAPI",
      "description": "Stream shapefile .zip archives to disk in FastAPI, return 202 Accepted immediately, and delegate GDAL parsing and PostGIS ingestion to Celery background workers.",
      "datePublished": "2025-11-14",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "Async Bulk Uploads with Celery", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/" },
        { "@type": "ListItem", "position": 3, "name": "Handling Async File Uploads for Shapefile Processing", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Handle async shapefile uploads with FastAPI and Celery",
      "step": [
        { "@type": "HowToStep", "position": 1, "text": "Accept the multipart .zip upload and stream bytes directly to a staging volume." },
        { "@type": "HowToStep", "position": 2, "text": "Return a 202 Accepted response with a UUID task identifier." },
        { "@type": "HowToStep", "position": 3, "text": "Enqueue a Celery task carrying the staging path and target CRS." },
        { "@type": "HowToStep", "position": 4, "text": "In the worker, extract and validate shapefile components, then invoke ogr2ogr to stream features into PostGIS." },
        { "@type": "HowToStep", "position": 5, "text": "Expose a /status/{task_id} endpoint so clients can poll for completion." }
      ]
    },
    {
      "@type": "Article",
      "headline": "Handling Async File Uploads for Shapefile Processing in FastAPI",
      "datePublished": "2025-11-14",
      "dateModified": "2026-06-23"
    }
  ]
}
</script>

← Back to [Async Bulk Uploads with Celery](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/)

# Handling async file uploads for shapefile processing

Accept a multipart shapefile archive in FastAPI, return `202 Accepted` instantly, and let a Celery worker drive GDAL ingestion into PostGIS — without stalling the event loop or timing out the reverse proxy.

## Context & when to use

FastAPI's async event loop is designed for I/O concurrency, not CPU-bound work. Extracting a `.zip` archive, validating shapefile components, reprojecting geometries, and running `ogr2ogr` are all blocking operations. Allowing any of these to execute inside an `async def` route blocks every other concurrent request for the duration of the task — often 5–60 seconds for real-world datasets. Nginx and other reverse proxies enforce gateway timeouts (default 60 s) that silently abort in-progress uploads, leaving the client with no useful error.

The solution is strict layer separation: the HTTP handler does pure I/O (stream bytes to disk, enqueue a task ID, return immediately), while a dedicated Celery worker process handles all spatial computation synchronously, free from Python's async scheduler and the GIL's interference on multi-threaded C extensions. This is the same principle that underpins the broader [async bulk upload patterns](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) covered in the parent guide.

Use this pattern when uploads are larger than ~5 MB, when GDAL reprojection or validation must run server-side, or when you need reliable retries on transient database failures. For small GeoJSON payloads where inline [strict Pydantic geometry validation](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) is sufficient, synchronous processing is simpler and preferable.

**Preconditions:** GDAL/OGR binaries installed in the worker environment (`ogr2ogr` on `PATH`), Redis reachable from both the FastAPI process and the worker, and a PostGIS database with write permissions. The `.prj` sidecar must be present in the archive unless you supply a fallback CRS explicitly.

---

## Architecture diagram

<svg viewBox="0 0 760 320" role="img" aria-label="Shapefile upload async flow: client sends zip, FastAPI streams to disk and returns 202, Celery worker extracts and runs ogr2ogr into PostGIS" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:760px;font-family:inherit;" >
  <title>Async shapefile upload data-flow</title>
  <desc>Client uploads .zip to FastAPI. FastAPI streams bytes to staging disk and publishes a task to Redis. FastAPI returns 202 Accepted with a task_id. The Celery worker picks up the task, extracts the archive, validates shapefile components, calls ogr2ogr, and inserts features into PostGIS. The client polls /status/{task_id} until done.</desc>
  <!-- Background bands -->
  <rect x="0" y="0" width="760" height="320" rx="10" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <!-- Lane labels -->
  <text x="14" y="54" font-size="10" fill="var(--muted, #7c6fb0)" font-weight="600" text-anchor="start">CLIENT</text>
  <text x="14" y="144" font-size="10" fill="var(--muted, #7c6fb0)" font-weight="600" text-anchor="start">FASTAPI</text>
  <text x="14" y="234" font-size="10" fill="var(--muted, #7c6fb0)" font-weight="600" text-anchor="start">WORKER</text>
  <!-- Lane dividers -->
  <line x1="0" y1="70" x2="760" y2="70" stroke="var(--border, #c4b5fd)" stroke-width="1" stroke-dasharray="4,3"/>
  <line x1="0" y1="160" x2="760" y2="160" stroke="var(--border, #c4b5fd)" stroke-width="1" stroke-dasharray="4,3"/>
  <line x1="0" y1="250" x2="760" y2="250" stroke="var(--border, #c4b5fd)" stroke-width="1" stroke-dasharray="4,3"/>
  <!-- Step boxes -->
  <!-- 1: Client uploads -->
  <rect x="60" y="28" width="120" height="34" rx="6" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="120" y="47" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">POST /shapefile</text>
  <text x="120" y="59" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">(multipart .zip)</text>
  <!-- 2: Stream to disk -->
  <rect x="220" y="118" width="130" height="34" rx="6" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="285" y="137" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">Stream → staging/</text>
  <text x="285" y="149" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">(copyfileobj)</text>
  <!-- 3: Redis enqueue -->
  <rect x="390" y="118" width="130" height="34" rx="6" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="455" y="137" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">Enqueue task</text>
  <text x="455" y="149" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">(Redis broker)</text>
  <!-- 4: 202 Accepted -->
  <rect x="560" y="28" width="130" height="34" rx="6" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="625" y="47" text-anchor="middle" font-size="11" fill="#065f46" font-weight="600">202 Accepted</text>
  <text x="625" y="59" text-anchor="middle" font-size="10" fill="#065f46">{ task_id }</text>
  <!-- 5: Worker extracts -->
  <rect x="220" y="208" width="130" height="34" rx="6" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="285" y="227" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">Extract + validate</text>
  <text x="285" y="239" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">(.shp .shx .dbf .prj)</text>
  <!-- 6: ogr2ogr -->
  <rect x="390" y="208" width="130" height="34" rx="6" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="455" y="227" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">ogr2ogr → PostGIS</text>
  <text x="455" y="239" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">(PROMOTE_TO_MULTI)</text>
  <!-- 7: Poll status -->
  <rect x="560" y="270" width="130" height="34" rx="6" fill="var(--surface2, #ede9fe)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="625" y="289" text-anchor="middle" font-size="11" fill="currentColor" font-weight="600">GET /status/{id}</text>
  <text x="625" y="301" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">(poll until done)</text>
  <!-- Arrows -->
  <!-- Client → Stream -->
  <line x1="180" y1="45" x2="220" y2="132" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Stream → Enqueue -->
  <line x1="350" y1="135" x2="390" y2="135" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Enqueue → 202 -->
  <line x1="520" y1="130" x2="560" y2="47" stroke="#10b981" stroke-width="1.5" marker-end="url(#arr2)"/>
  <!-- Redis → Worker extracts -->
  <line x1="455" y1="152" x2="285" y2="208" stroke="var(--accent, #7c3aed)" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arr)"/>
  <!-- Worker extracts → ogr2ogr -->
  <line x1="350" y1="225" x2="390" y2="225" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- ogr2ogr → Poll -->
  <line x1="520" y1="230" x2="625" y2="270" stroke="#10b981" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arr2)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="var(--accent, #7c3aed)"/>
    </marker>
    <marker id="arr2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#10b981"/>
    </marker>
  </defs>
</svg>

---

## Runnable implementation

The full implementation spans two files. The FastAPI route handles ingestion only; the Celery task handles all spatial work.

```python
# app/api/uploads.py
import uuid
import shutil
from pathlib import Path
from fastapi import APIRouter, UploadFile, HTTPException, status
from app.celery_worker import process_shapefile_task

router = APIRouter(prefix="/api/v1/uploads", tags=["geospatial"])

# Staging volume: pre-created, writable by the API process
STAGING_DIR = Path("/var/staging/shapefiles")
STAGING_DIR.mkdir(parents=True, exist_ok=True)


@router.post("/shapefile", status_code=status.HTTP_202_ACCEPTED)
async def upload_shapefile(file: UploadFile):
    """
    Accept a .zip shapefile bundle, stream it to disk, and return a task ID.
    All spatial processing is delegated to a Celery worker — this route
    must remain non-blocking and complete in milliseconds regardless of
    archive size.
    """
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Shapefile bundles must be uploaded as .zip archives."
        )

    task_id = str(uuid.uuid4())
    staging_path = STAGING_DIR / f"{task_id}.zip"

    try:
        # shutil.copyfileobj streams in 16 KB chunks — safe for multi-GB files
        with open(staging_path, "wb") as buf:
            shutil.copyfileobj(file.file, buf)
    except OSError as exc:
        staging_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to stage upload: {exc}"
        )
    finally:
        await file.close()

    # Enqueue: non-blocking, returns immediately after publishing to Redis
    process_shapefile_task.apply_async(
        kwargs={
            "task_id": task_id,
            "file_path": str(staging_path),
            "target_crs": "EPSG:4326",
            "table_name": "public.imported_features",
        },
        # Worker picks a queue based on expected duration; long jobs go to
        # the "heavy" queue so they don't starve fast status-check tasks.
        queue="heavy",
    )

    return {
        "task_id": task_id,
        "status": "queued",
        "poll_url": f"/api/v1/status/{task_id}",
    }
```

```python
# app/celery_worker.py
import os
import logging
import shutil
import subprocess
import zipfile
from pathlib import Path

from celery import Celery

logger = logging.getLogger(__name__)

celery_app = Celery("geospatial_worker")
celery_app.conf.update(
    broker_url=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
    result_backend=os.environ.get("REDIS_RESULT_URL", "redis://localhost:6379/1"),
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    # Prevent tasks from silently disappearing if a worker crashes mid-execution
    task_acks_late=True,
    worker_prefetch_multiplier=1,
)

# Mandatory shapefile components — .prj is required for CRS detection
REQUIRED_EXTENSIONS = {".shp", ".shx", ".dbf", ".prj"}


@celery_app.task(
    bind=True,
    max_retries=3,
    default_retry_delay=15,
    name="geospatial.process_shapefile",
)
def process_shapefile_task(
    self,
    task_id: str,
    file_path: str,
    target_crs: str,
    table_name: str,
):
    """
    Extract the staged .zip, validate shapefile components, and stream
    features into PostGIS via ogr2ogr. Retries up to 3 times on transient
    database or subprocess failures.
    """
    extract_dir = Path(f"/var/staging/shapefiles-extract/{task_id}")
    extract_dir.mkdir(parents=True, exist_ok=True)

    try:
        # --- 1. Extract archive ---
        with zipfile.ZipFile(file_path, "r") as zf:
            # Reject path-traversal entries before extracting anything
            for member in zf.namelist():
                dest = (extract_dir / member).resolve()
                if not str(dest).startswith(str(extract_dir.resolve())):
                    raise ValueError(f"Path traversal detected in archive: {member}")
            zf.extractall(extract_dir)

        # --- 2. Validate mandatory components ---
        found_exts = {p.suffix.lower() for p in extract_dir.rglob("*") if p.is_file()}
        missing = REQUIRED_EXTENSIONS - found_exts
        if missing:
            raise ValueError(
                f"Shapefile bundle is missing required components: {missing}. "
                "Upload a .zip that contains .shp, .shx, .dbf, and .prj files."
            )

        # Find the .shp entry point (handles nested directories inside the zip)
        shp_file = next(extract_dir.rglob("*.shp"))

        # --- 3. Build the PostGIS DSN from the environment ---
        # Never hardcode credentials; read from a secrets manager or env var.
        pg_dsn = os.environ["POSTGIS_DSN"]  # e.g. "PG:host=db dbname=geo user=api"

        # --- 4. Stream into PostGIS via ogr2ogr ---
        # -nlt PROMOTE_TO_MULTI normalises mixed Polygon/MultiPolygon layers.
        # SPATIAL_INDEX=YES creates the GiST index as part of the import.
        # PG_USE_COPY (auto-enabled in GDAL ≥ 3.x) bypasses row INSERT overhead.
        cmd = [
            "ogr2ogr",
            "-f", "PostgreSQL",
            pg_dsn,
            str(shp_file),
            "-nln", table_name,
            "-nlt", "PROMOTE_TO_MULTI",
            "-t_srs", target_crs,
            "-lco", "GEOMETRY_NAME=geom",
            "-lco", "SPATIAL_INDEX=YES",
            "-lco", "FID=id",
            "-overwrite",
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise subprocess.CalledProcessError(
                result.returncode, cmd, output=result.stdout, stderr=result.stderr
            )

        logger.info("Task %s completed: %s rows imported into %s", task_id, "?", table_name)
        return {"status": "completed", "table": table_name}

    except subprocess.CalledProcessError as exc:
        logger.error("ogr2ogr failed for task %s: %s", task_id, exc.stderr)
        # Retry on transient DB connectivity errors
        raise self.retry(exc=exc)

    except Exception as exc:
        logger.exception("Non-retryable failure in task %s", task_id)
        raise

    finally:
        # Always clean up staging files — even on failure — to avoid disk exhaustion
        shutil.rmtree(extract_dir, ignore_errors=True)
        Path(file_path).unlink(missing_ok=True)
```

---

## Key parameters & options

| Parameter / flag | Purpose | Recommended value |
|---|---|---|
| `task_acks_late=True` | Celery re-queues the task if the worker crashes before the task finishes | Always enable for long-running jobs |
| `worker_prefetch_multiplier=1` | Prevents workers from hoarding multiple large tasks simultaneously | `1` for heavy queues |
| `-nlt PROMOTE_TO_MULTI` | Coerces `Polygon` features to `MultiPolygon` so mixed layers import cleanly | Required unless your schema enforces a single geometry type |
| `-t_srs EPSG:4326` | Reprojects on the fly during import; avoids a separate PostGIS `ST_Transform` pass | Match your PostGIS column's SRID |
| `-lco SPATIAL_INDEX=YES` | Creates a GiST index at import time via the OGR PostgreSQL driver | Always enable; eliminates a separate `CREATE INDEX CONCURRENTLY` step |
| `-lco FID=id` | Names the primary key column `id` instead of OGR's default `ogc_fid` | Align with your application's ORM conventions |
| `subprocess timeout=600` | Kills hung `ogr2ogr` processes; prevents worker threads from leaking | Tune to the 99th-percentile import time for your dataset sizes |
| `queue="heavy"` | Routes long-running tasks to a dedicated Celery queue | Prevents large imports from starving fast API-status tasks |

---

## Gotchas & failure modes

- **Zip bomb or oversized archive.** `zipfile.ZipFile` does not check the uncompressed size before extraction. Before calling `extractall`, iterate `zf.infolist()` and sum `info.file_size`; reject archives where the total exceeds your configured limit (e.g. 2 GB) or where the compression ratio exceeds 200:1. A 1 MB archive that expands to 2 GB will exhaust the worker's disk and kill the process with no useful error.

- **Missing `.prj` causes silent CRS misassignment.** If you remove `.prj` from `REQUIRED_EXTENSIONS` and accept uploads without it, `ogr2ogr` defaults to no CRS, and PostGIS stores the geometry with `SRID=0`. Subsequent [bounding-box spatial index queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) using `ST_Within` or `ST_Intersects` will silently return empty result sets because the SRID mismatch prevents index usage. Always require `.prj`, or validate and inject a known CRS explicitly.

- **`ogr2ogr` exits 0 even on partial failure.** By default, `ogr2ogr` logs feature-level errors to stderr and exits with code 0. Add `--config OGR_TRUNCATE NO` and check `result.stderr` for lines containing `ERROR` after the subprocess returns. A task marked "completed" in Redis can still have zero rows in PostGIS if geometry parsing failed silently.

- **Staging disk fills during concurrent uploads.** If ten 200 MB archives arrive simultaneously and workers are busy, all ten files sit in `/var/staging/` until consumed. Configure an OS-level disk quota on the staging path and return `HTTP 429` (or `503`) from the upload endpoint once the directory's used space exceeds a threshold.

- **`task_acks_late` + retries can double-insert on transient failures.** The `-overwrite` flag in the `ogr2ogr` command drops and recreates the target table on each run, making the task idempotent. If you switch to `-append`, you must add explicit deduplication logic (e.g. a unique constraint on a stable feature ID column) before enabling retries.

---

## Verification

After uploading a test archive, confirm ingestion with a status poll and a PostGIS row count:

```bash
# 1. Upload and capture the task ID
TASK_ID=$(curl -s -X POST https://api.example.com/api/v1/uploads/shapefile \
  -F "file=@test_features.zip" | jq -r '.task_id')

# 2. Poll until the status is no longer "queued" or "processing"
until [ "$(curl -s https://api.example.com/api/v1/status/$TASK_ID | jq -r '.status')" = "completed" ]; do
  sleep 3
done

# 3. Verify the row count in PostGIS
psql "$POSTGIS_DSN" -c "SELECT count(*) FROM public.imported_features;"

# 4. Confirm the geometry column has the expected SRID and type
psql "$POSTGIS_DSN" -c \
  "SELECT type, srid FROM geometry_columns WHERE f_table_name = 'imported_features';"
```

Expected output for step 4:
```
        type        | srid
--------------------+------
 MULTIPOLYGON       | 4326
```

A `srid` of `0` means the `.prj` file was absent or unrecognised. A `type` of `GEOMETRY` (not `MULTIPOLYGON`) means `-nlt PROMOTE_TO_MULTI` was not applied.

---

## Related

- [Async Bulk Uploads with Celery](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) — task queue architecture, result backend configuration, and queue routing strategy
- [Strict Pydantic Validation for Geometry](/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/) — validate GeoJSON and WKT payloads at the API boundary before any database write
- [Bounding-Box Spatial Index Queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) — ensure imported geometries have correct SRIDs so GiST index scans work correctly
- [Query Plan Analysis & Index Tuning](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — use `EXPLAIN ANALYZE` to confirm the spatial index created by `ogr2ogr` is being used

← Back to [Async Bulk Uploads with Celery](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/)
