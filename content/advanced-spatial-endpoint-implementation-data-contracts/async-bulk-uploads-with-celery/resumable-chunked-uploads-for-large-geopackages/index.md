---
layout: layouts/page.njk
title: "Resumable Chunked Uploads for Large GeoPackages"
description: "A 4 GB GeoPackage over a flaky link fails at 80% and starts again. Accept it in chunks, checksum each one, and let the client resume from the last byte the server actually holds."
slug: resumable-chunked-uploads-for-large-geopackages
type: howto
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Async Bulk Uploads with Celery"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/"
  - label: "Resumable Chunked Uploads for Large GeoPackages"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/resumable-chunked-uploads-for-large-geopackages/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Resumable Chunked Uploads for Large GeoPackages",
      "description": "Accept large spatial files in checksummed chunks so a broken connection resumes instead of restarting.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/resumable-chunked-uploads-for-large-geopackages/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "Async Bulk Uploads with Celery", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/" },
        { "@type": "ListItem", "position": 3, "name": "Resumable Chunked Uploads for Large GeoPackages", "item": "https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/resumable-chunked-uploads-for-large-geopackages/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Accept a Large Spatial File in Resumable Chunks",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Create an upload session", "text": "Register the total size and expected checksum up front and return an upload id the client keeps." },
        { "@type": "HowToStep", "position": 2, "name": "Accept chunks by offset", "text": "Each PUT carries a byte range and a per-chunk checksum, so a corrupt chunk is rejected rather than stored." },
        { "@type": "HowToStep", "position": 3, "name": "Report progress on demand", "text": "A HEAD on the session returns the highest contiguous byte held, which is where the client resumes." },
        { "@type": "HowToStep", "position": 4, "name": "Finalise and hand off", "text": "Verify the whole-file checksum, then queue the import task rather than parsing inside the request." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why not use a pre-signed object storage URL instead?",
          "acceptedAnswer": { "@type": "Answer", "text": "Often you should — object storage already implements multipart uploads, resumption and checksums, and it keeps large bodies away from the API entirely. Build this endpoint when the file must be validated or transformed before it is durable, when clients cannot reach the storage provider directly, or when a compliance requirement puts the ingest path inside your own perimeter." }
        },
        {
          "@type": "Question",
          "name": "What chunk size works best?",
          "acceptedAnswer": { "@type": "Answer", "text": "Between 8 and 32 megabytes for most links. Smaller chunks mean more round trips and more session bookkeeping; larger ones mean more data to re-send after a failure. Eight megabytes loses at most eight megabytes of progress per broken connection, which on a poor link is the number that matters." }
        },
        {
          "@type": "Question",
          "name": "Should chunks be validated as spatial data on arrival?",
          "acceptedAnswer": { "@type": "Answer", "text": "No. A GeoPackage is a SQLite database and an arbitrary byte range of it is not parseable on its own. Validate the bytes with a checksum during transfer and the spatial content after assembly, in the import task, where a real reader can open the whole file." }
        }
      ]
    }
  ]
}
</script>

← Back to [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/)

# Resumable chunked uploads for large GeoPackages

This page covers accepting multi-gigabyte spatial files over connections that cannot be relied on to stay up, so a failure at 80 % costs one chunk rather than the whole transfer.

## Context & When to Use

Field data arrives as large files over poor links: a 4 GB GeoPackage from a survey laptop on a hotel connection, a multi-gigabyte shapefile bundle from a partner over a VPN. A single `POST` of that file is a bet that nothing interrupts it for twenty minutes. When the bet loses — and over a mobile link it loses regularly — the client starts again from zero, and the third attempt is no more likely to succeed than the first.

Chunked, resumable upload changes the unit of failure from the file to the chunk. The client asks the server what it already holds, sends the next piece, and repeats. A dropped connection costs the chunk in flight. The pattern is what object storage providers implement for multipart uploads, and it is worth building into the API when the bytes cannot go straight to a bucket.

It also composes cleanly with the asynchronous import path. Once the last chunk lands and the whole-file checksum matches, the request queues a task and returns immediately — the arrangement described in [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/). Upload and import stay separate concerns with separate failure modes.

## Runnable Implementation

```python
import hashlib
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException, Request, Response, status

router = APIRouter(prefix="/v1/uploads", tags=["uploads"])

CHUNK_MAX = 32 * 1024 * 1024          # reject anything larger in one request
STAGING = Path("/var/spool/uploads")


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_session(total_bytes: int, sha256: str, filename: str) -> dict[str, Any]:
    """Register the upload before any bytes move."""
    if total_bytes <= 0 or total_bytes > 32 * 1024**3:
        raise HTTPException(422, detail={"error": "total_bytes_out_of_range"})
    upload_id = await register_upload(total_bytes, sha256, filename)
    (STAGING / upload_id).touch()
    return {"upload_id": upload_id, "chunk_max_bytes": CHUNK_MAX}


@router.head("/{upload_id}")
async def upload_status(upload_id: str, response: Response) -> Response:
    """Tell the client where to resume: the highest CONTIGUOUS byte held."""
    session = await load_upload(upload_id)
    if session is None:
        raise HTTPException(404, detail={"error": "unknown_upload"})
    response.headers["Upload-Offset"] = str(session.contiguous_bytes)
    response.headers["Upload-Length"] = str(session.total_bytes)
    return response


@router.put("/{upload_id}")
async def put_chunk(
    upload_id: str,
    request: Request,
    content_range: Annotated[str, Header(alias="Content-Range")],
    chunk_sha256: Annotated[str, Header(alias="X-Chunk-SHA256")],
) -> dict[str, Any]:
    session = await load_upload(upload_id)
    if session is None:
        raise HTTPException(404, detail={"error": "unknown_upload"})

    # "bytes 33554432-67108863/4294967296"
    try:
        span, total = content_range.removeprefix("bytes ").split("/")
        start, end = (int(v) for v in span.split("-"))
    except ValueError:
        raise HTTPException(422, detail={"error": "malformed_content_range"})

    if int(total) != session.total_bytes:
        raise HTTPException(409, detail={"error": "total_size_mismatch"})
    if end - start + 1 > CHUNK_MAX:
        raise HTTPException(413, detail={"error": "chunk_too_large",
                                         "max_bytes": CHUNK_MAX})

    body = await request.body()
    if hashlib.sha256(body).hexdigest() != chunk_sha256:
        # Reject rather than store: a corrupt chunk found now costs one chunk
        raise HTTPException(422, detail={"error": "chunk_checksum_mismatch",
                                         "resume_at": session.contiguous_bytes})

    with open(STAGING / upload_id, "r+b") as fh:
        fh.seek(start)
        fh.write(body)
    session = await record_chunk(upload_id, start, len(body))

    if session.contiguous_bytes < session.total_bytes:
        return {"received": session.contiguous_bytes, "total": session.total_bytes}

    # Complete: verify the whole file, then hand off to the import worker
    digest = await sha256_file(STAGING / upload_id)
    if digest != session.sha256:
        await discard_upload(upload_id)
        raise HTTPException(422, detail={"error": "file_checksum_mismatch"})

    task_id = enqueue_import.delay(upload_id, session.filename).id
    return {"received": session.total_bytes, "total": session.total_bytes,
            "task_id": task_id, "status_url": f"/v1/jobs/{task_id}"}
```

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sequence of a chunked upload interrupted mid-transfer and resumed from the last contiguous byte" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>An interrupted upload, resumed</title>
  <desc>A sequence over eight chunks of a 4 gigabyte file. Chunks one to five transfer successfully. The connection drops during chunk six, which is discarded. The client reconnects and issues a HEAD, which reports 160 megabytes contiguous. It resumes at chunk six, then sends seven and eight. On the final chunk the server verifies the whole-file checksum and enqueues the import task. The total re-sent data is one chunk rather than the whole file.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">4 GB file, 8 chunks, one dropped connection</text>
  <rect x="30" y="52" width="70" height="28" rx="4" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.5"/>
  <text x="65" y="71" text-anchor="middle" font-size="9.5" fill="currentColor">1</text>
  <rect x="104" y="52" width="70" height="28" rx="4" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.5"/>
  <text x="139" y="71" text-anchor="middle" font-size="9.5" fill="currentColor">2</text>
  <rect x="178" y="52" width="70" height="28" rx="4" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.5"/>
  <text x="213" y="71" text-anchor="middle" font-size="9.5" fill="currentColor">3</text>
  <rect x="252" y="52" width="70" height="28" rx="4" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.5"/>
  <text x="287" y="71" text-anchor="middle" font-size="9.5" fill="currentColor">4</text>
  <rect x="326" y="52" width="70" height="28" rx="4" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.5"/>
  <text x="361" y="71" text-anchor="middle" font-size="9.5" fill="currentColor">5</text>
  <rect x="400" y="52" width="70" height="28" rx="4" fill="var(--viz-bad, #a32b23)" fill-opacity="0.45" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4" stroke-dasharray="4,3"/>
  <text x="435" y="71" text-anchor="middle" font-size="9.5" fill="currentColor">6 ✕</text>
  <rect x="474" y="52" width="70" height="28" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1" stroke-dasharray="3,3"/>
  <text x="509" y="71" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">7</text>
  <rect x="548" y="52" width="70" height="28" rx="4" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1" stroke-dasharray="3,3"/>
  <text x="583" y="71" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">8</text>
  <text x="435" y="100" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">connection drops</text>
  <path d="M435 106 L435 126" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4" marker-end="url(#upArr)"/>
  <rect x="200" y="130" width="330" height="30" rx="6" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="365" y="150" text-anchor="middle" font-size="10.5" font-family="monospace" fill="currentColor">HEAD → Upload-Offset: 167772160</text>
  <path d="M365 160 L365 178" stroke="currentColor" stroke-width="1.4" marker-end="url(#upArr)"/>
  <rect x="400" y="180" width="70" height="28" rx="4" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.5"/>
  <text x="435" y="199" text-anchor="middle" font-size="9.5" fill="currentColor">6 ✓</text>
  <rect x="474" y="180" width="70" height="28" rx="4" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.5"/>
  <text x="509" y="199" text-anchor="middle" font-size="9.5" fill="currentColor">7</text>
  <rect x="548" y="180" width="70" height="28" rx="4" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.5"/>
  <text x="583" y="199" text-anchor="middle" font-size="9.5" fill="currentColor">8</text>
  <text x="30" y="199" font-size="10.5" fill="currentColor">resumes from byte 167 772 160</text>
  <text x="20" y="232" font-size="10.5" fill="var(--muted, #7c6fb0)">Data re-sent: <tspan font-weight="700" fill="var(--viz-good, #1f6b3a)">32 MB</tspan> — one chunk, not 4 GB. Over a link that drops every ten minutes,</text>
  <text x="20" y="246" font-size="10.5" fill="var(--muted, #7c6fb0)">that is the difference between an upload that completes and one that never does.</text>
  <defs>
    <marker id="upArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

## Key Parameters & Options

| Element | Value | Purpose |
|---|---|---|
| Chunk size | 8–32 MB | The unit of lost progress on a failure |
| `Content-Range` | `bytes start-end/total` | Standard, and lets chunks arrive out of order |
| `X-Chunk-SHA256` | per chunk | Catches corruption at the chunk, not at the end |
| Whole-file `sha256` | declared at session creation | The only check that proves reassembly worked |
| `Upload-Offset` on HEAD | highest contiguous byte | Resumption point; not the highest byte received |
| Session TTL | 24–72 h | Abandoned uploads must not fill the staging disk |

The distinction between "highest contiguous byte" and "highest byte received" matters when chunks arrive out of order. If chunks 1, 2 and 4 are held, the resumption point is the end of chunk 2 — reporting the end of chunk 4 would leave a hole that only the final checksum catches, after the whole file has been transferred.

## Where the time and the risk go

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of expected total transfer time for a 4 GB file at three failure rates, comparing single-shot and chunked uploads" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Expected transfer time by link quality</title>
  <desc>Three link qualities compared. On a stable link with no drops, single-shot and chunked uploads both take about 18 minutes and chunked adds a small overhead. On a link dropping once per hour, single-shot averages 41 minutes because of restarts while chunked stays at 19. On a link dropping every ten minutes, single-shot effectively never completes while chunked takes 23 minutes. The chunked line is nearly flat across all three, which is the property being bought.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Expected time to transfer 4 GB, by link quality</text>
  <rect x="470" y="14" width="12" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="488" y="25" font-size="10" fill="currentColor">single POST</text>
  <rect x="586" y="14" width="12" height="12" rx="2" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="604" y="25" font-size="10" fill="currentColor">chunked</text>
  <text x="20" y="62" font-size="10.5" fill="currentColor">stable link</text>
  <rect x="180" y="48" width="150" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="338" y="61" font-size="10" fill="currentColor">18 min</text>
  <rect x="180" y="66" width="158" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="346" y="79" font-size="10" fill="currentColor">19 min — small overhead</text>
  <text x="20" y="118" font-size="10.5" fill="currentColor">drops once per hour</text>
  <rect x="180" y="104" width="342" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="530" y="117" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">41 min</text>
  <rect x="180" y="122" width="158" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="346" y="135" font-size="10" fill="currentColor">19 min</text>
  <text x="20" y="174" font-size="10.5" fill="currentColor">drops every 10 min</text>
  <rect x="180" y="160" width="500" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <text x="188" y="155" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">never completes</text>
  <rect x="180" y="178" width="192" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.75"/>
  <text x="380" y="191" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">23 min</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">The chunked series barely moves. That flatness — not raw speed — is what resumability buys, and it is</text>
  <text x="20" y="236" font-size="10.5" fill="var(--muted, #7c6fb0)">why field users experience it as "the upload works now".</text>
</svg>

## Cleaning up after abandoned uploads

Every upload session reserves disk for a file that may never arrive. A field laptop that closes its lid mid-transfer leaves a sparse multi-gigabyte file in staging with no client left to finish it, and unless something removes it the staging volume fills within weeks.

Expiry has to consider two clocks. A session that has received no chunk for several hours is abandoned regardless of how recently it was created; a session created days ago is abandoned even if a chunk trickled in this morning. Sweeping on both catches the stalled uploader and the pathologically slow one without cutting off a legitimately slow transfer that is still making progress.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of staging disk usage over a month with and without a sweeper for abandoned upload sessions" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Staging disk with and without expiry</title>
  <desc>Staging volume usage over thirty days. Without a sweeper, disk usage climbs steadily as abandoned sessions accumulate, reaching the 500 gigabyte volume limit on day 23 and causing every subsequent upload to fail. With a sweeper running hourly and expiring sessions idle for six hours or older than three days, usage oscillates between 30 and 90 gigabytes indefinitely. The completed uploads are identical in both cases; the difference is entirely abandoned sessions.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Staging volume over 30 days</text>
  <line x1="70" y1="170" x2="686" y2="170" stroke="currentColor" stroke-width="1.1"/>
  <line x1="70" y1="44" x2="70" y2="170" stroke="currentColor" stroke-width="1.1"/>
  <text x="62" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">500 GB</text>
  <text x="62" y="170" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <line x1="70" y1="52" x2="686" y2="52" stroke="var(--viz-bad, #a32b23)" stroke-width="1.3" stroke-dasharray="6,4"/>
  <text x="680" y="47" text-anchor="end" font-size="9.5" fill="var(--viz-bad, #a32b23)">volume full — every upload fails</text>
  <polyline points="70,166 150,146 230,124 310,102 390,80 470,58 530,52 686,52" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="2.4"/>
  <circle cx="530" cy="52" r="5" fill="var(--viz-bad, #a32b23)"/>
  <text x="440" y="76" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">day 23</text>
  <polyline points="70,166 120,150 170,162 220,144 270,158 320,146 370,160 420,148 470,162 520,150 570,158 620,146 686,158" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="2.2"/>
  <text x="200" y="190" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">hourly sweep: idle &gt; 6 h or age &gt; 3 days</text>
  <text x="90" y="188" font-size="9.5" fill="var(--muted, #7c6fb0)">d1</text>
  <text x="660" y="188" font-size="9.5" fill="var(--muted, #7c6fb0)">d30</text>
  <text x="20" y="214" font-size="10.5" fill="var(--muted, #7c6fb0)">Completed uploads are identical in both lines. The entire difference is sessions nobody ever finished.</text>
</svg>

## Gotchas & Failure Modes

- **Reporting the highest byte received rather than the highest contiguous one.** Out-of-order chunks leave a hole the client never re-sends, and it is only discovered by the final checksum after the whole file has moved.
- **No session expiry.** Abandoned uploads accumulate full-size sparse files in staging. Expire sessions and sweep the directory on a schedule.
- **Parsing the file in the request.** Opening a 4 GB GeoPackage inside the final `PUT` blocks a worker for minutes. Queue the import, as in [Handling Async File Uploads for Shapefile Processing](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/).
- **A proxy body-size limit below the chunk size.** nginx defaults to 1 MB; a 32 MB chunk gets a 413 from the proxy that never reaches the application. Set `client_max_body_size` to match `CHUNK_MAX`.
- **Trusting the declared total.** A client that lies about `total_bytes` can reserve arbitrary disk. Cap it, and check free space before creating the session.
- **Chunk checksums skipped for speed.** Detecting corruption only at the end means re-sending gigabytes. A SHA-256 over 32 MB takes about 90 ms — cheap next to the transfer it protects.

## Verification Snippet

```bash
UP=$(curl -s -X POST "localhost:8000/v1/uploads?total_bytes=4294967296&sha256=$FULL&filename=survey.gpkg" | jq -r .upload_id)

# Where should we resume?
curl -sI "localhost:8000/v1/uploads/$UP" | grep -i upload-offset
# Upload-Offset: 167772160

# Send the next chunk from that offset
dd if=survey.gpkg bs=1M skip=160 count=32 2>/dev/null > /tmp/chunk
curl -s -X PUT "localhost:8000/v1/uploads/$UP" \
  -H "Content-Range: bytes 167772160-201326591/4294967296" \
  -H "X-Chunk-SHA256: $(sha256sum /tmp/chunk | cut -d' ' -f1)" \
  --data-binary @/tmp/chunk | jq
# {"received":201326592,"total":4294967296}
```

```python
async def test_resume_after_interruption(client, big_file):
    upload_id = await create_session(client, big_file)
    await send_chunks(client, upload_id, big_file, stop_after=5)

    head = await client.head(f"/v1/uploads/{upload_id}")
    offset = int(head.headers["Upload-Offset"])
    assert offset == 5 * CHUNK_SIZE          # contiguous, not merely received

    result = await send_chunks(client, upload_id, big_file, start_at=offset)
    assert result["task_id"]                  # completed and handed off
```

---

## Related

- [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) — what happens after the last chunk lands
- [Handling Async File Uploads for Shapefile Processing](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/handling-async-file-uploads-for-shapefile-processing/) — the import task itself
- [Rejecting Invalid Polygons with ST_IsValid](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/strict-pydantic-validation-for-geometry/rejecting-invalid-polygons-with-st-isvalid/) — the validation that runs once the file is assembled

← Back to [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/)
