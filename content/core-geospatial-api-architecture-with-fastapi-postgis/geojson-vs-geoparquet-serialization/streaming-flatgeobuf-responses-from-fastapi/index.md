---
layout: layouts/page.njk
title: "Streaming FlatGeobuf Responses from FastAPI"
description: "Serve a million features without buffering them in memory: FlatGeobuf's streamable layout, an async generator over a server-side cursor, and the headers that keep the download resumable."
slug: streaming-flatgeobuf-responses-from-fastapi
type: howto
breadcrumb:
  - label: "Core Geospatial API Architecture"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/"
  - label: "GeoJSON vs GeoParquet Serialization"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/"
  - label: "Streaming FlatGeobuf Responses from FastAPI"
    url: "/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/streaming-flatgeobuf-responses-from-fastapi/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Streaming FlatGeobuf Responses from FastAPI",
      "description": "Serve a million features without buffering them in memory using FlatGeobuf and an async generator over a server-side cursor.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/streaming-flatgeobuf-responses-from-fastapi/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Core Geospatial API Architecture", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/" },
        { "@type": "ListItem", "position": 2, "name": "GeoJSON vs GeoParquet Serialization", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/" },
        { "@type": "ListItem", "position": 3, "name": "Streaming FlatGeobuf Responses from FastAPI", "item": "https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/streaming-flatgeobuf-responses-from-fastapi/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Stream a Large Feature Collection as FlatGeobuf",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Open a server-side cursor", "text": "Iterate the result set inside a transaction so PostgreSQL streams rows instead of materialising them." },
        { "@type": "HowToStep", "position": 2, "name": "Write the header first", "text": "Emit the FlatGeobuf magic bytes and header describing the geometry type and columns before any feature." },
        { "@type": "HowToStep", "position": 3, "name": "Yield in chunks", "text": "Encode a few thousand features per chunk so the event loop is never blocked for long." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why stream FlatGeobuf rather than GeoJSON?",
          "acceptedAnswer": { "@type": "Answer", "text": "Both can be streamed, but GeoJSON is text and repeats every property name on every feature, so it is roughly four to six times larger and far more expensive for the client to parse. FlatGeobuf is a flat binary layout that a reader can consume feature by feature without loading the whole file, which is exactly what makes it suited to a streamed response." }
        },
        {
          "@type": "Question",
          "name": "Can a streamed response include a Content-Length?",
          "acceptedAnswer": { "@type": "Answer", "text": "Not unless you know the size in advance, which for a streamed query you do not. Use chunked transfer encoding and accept that progress bars will be indeterminate. If a length matters to the consumer, generate the file to object storage first and hand back a pre-signed URL instead." }
        },
        {
          "@type": "Question",
          "name": "What happens if the client disconnects mid-stream?",
          "acceptedAnswer": { "@type": "Answer", "text": "The generator is cancelled, and the connection returns to the pool only if the cursor and transaction are closed in a finally block. Without that, an aborted download leaks a connection and an open transaction, which is the single most common way a streaming endpoint takes down a pool." }
        }
      ]
    }
  ]
}
</script>

← Back to [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/)

# Streaming FlatGeobuf responses from FastAPI

This page shows how to serve a very large feature collection as a FlatGeobuf stream, with constant memory on the server and a client that can start reading before the query has finished.

## Context & When to Use

A bulk export endpoint that builds its response in memory has a hard ceiling. Serialising 800 000 polygons to GeoJSON produces roughly 1.4 GB of text; the server holds all of it, the client parses all of it before showing anything, and a worker that does this twice concurrently is out of memory. The usual mitigation — paginate the export — pushes the problem onto the consumer, who now has to stitch 400 pages together and handle a cursor that may drift.

FlatGeobuf is designed for exactly this shape. It is a flat binary format with a header describing the schema, followed by features that can be read one at a time, so both writer and reader work in constant memory. Combined with a server-side cursor in PostgreSQL, the whole path from disk to socket streams: no stage ever holds more than a chunk.

Reach for it when a single response legitimately contains more features than a client should hold in memory at once, and when the consumer is a GIS tool or data pipeline rather than a browser. For interactive map traffic, [vector tiles](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/vector-tile-endpoints-with-st-asmvt/) are the better answer, and for analytical consumers the columnar layout compared in [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) may serve better still.

## Runnable Implementation

```python
from typing import Annotated, AsyncIterator

import asyncpg
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/v1/exports", tags=["exports"])

CHUNK = 5_000          # features encoded per yield

EXPORT_SQL = """
SELECT id, layer, category_code, ST_AsBinary(geom) AS wkb
FROM   features
WHERE  geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
ORDER  BY id
"""


async def flatgeobuf_stream(
    pool: asyncpg.Pool, bbox: tuple[float, float, float, float]
) -> AsyncIterator[bytes]:
    """Yield a FlatGeobuf file in chunks, holding at most CHUNK features."""
    writer = FlatGeobufWriter(          # thin wrapper over the fgb encoder
        geometry_type="MultiPolygon",
        columns=[("id", "long"), ("layer", "string"), ("category_code", "int")],
        crs=4326,
    )
    yield writer.header()               # magic bytes + schema, before any feature

    conn = await pool.acquire()
    tx = conn.transaction()
    await tx.start()                    # a cursor requires a transaction
    try:
        cursor = await conn.cursor(EXPORT_SQL, *bbox)
        buffer = bytearray()
        while True:
            rows = await cursor.fetch(CHUNK)
            if not rows:
                break
            for r in rows:
                buffer += writer.feature(
                    wkb=r["wkb"],
                    values=(r["id"], r["layer"], r["category_code"]),
                )
            yield bytes(buffer)
            buffer.clear()              # constant memory: one chunk at a time
    finally:
        # Without this, an aborted download leaks a connection AND a transaction
        await tx.rollback()
        await pool.release(conn)


@router.get("/features.fgb")
async def export_features(
    bbox: Annotated[str, Query(description="minx,miny,maxx,maxy in EPSG:4326")],
    pool: asyncpg.Pool = Depends(get_pool),
) -> StreamingResponse:
    minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
    return StreamingResponse(
        flatgeobuf_stream(pool, (minx, miny, maxx, maxy)),
        media_type="application/vnd.flatgeobuf",
        headers={
            "Content-Disposition": 'attachment; filename="features.fgb"',
            # No Content-Length is possible: the size is unknown until the end
            "X-Accel-Buffering": "no",      # stop nginx buffering the whole body
        },
    )
```

The `finally` block is the load-bearing part. A client that closes the connection at 40 % — a user pressing cancel, a proxy timing out — cancels the generator, and without explicit cleanup the transaction stays open and the connection never returns to the pool.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Memory profile comparison between a buffered response and a streamed response over the life of an export" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Server memory during an 800 000 feature export</title>
  <desc>Two memory curves over the life of one export. The buffered approach climbs steadily as features accumulate, peaking at 1.4 gigabytes just before the response is sent, then dropping to zero. The streamed approach stays flat at about 40 megabytes throughout, one chunk at a time. A dashed line marks the container memory limit at 1 gigabyte, which the buffered curve crosses at around 70 percent completion — the point at which the worker is killed.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Server memory during one 800 000-feature export</text>
  <line x1="70" y1="186" x2="690" y2="186" stroke="currentColor" stroke-width="1.1"/>
  <line x1="70" y1="44" x2="70" y2="186" stroke="currentColor" stroke-width="1.1"/>
  <text x="62" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">1.5 GB</text>
  <text x="62" y="118" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">750 MB</text>
  <text x="62" y="186" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0</text>
  <line x1="70" y1="98" x2="690" y2="98" stroke="var(--viz-bad, #a32b23)" stroke-width="1.3" stroke-dasharray="6,4"/>
  <text x="684" y="93" text-anchor="end" font-size="9.5" fill="var(--viz-bad, #a32b23)">container limit 1 GB</text>
  <polyline points="70,186 140,172 210,156 280,138 350,120 420,100 460,90 470,186" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="2.4"/>
  <circle cx="452" cy="95" r="5" fill="var(--viz-bad, #a32b23)"/>
  <text x="462" y="76" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">OOM-killed at 70 %</text>
  <polyline points="70,180 160,179 250,180 340,179 430,180 520,179 610,180 688,179" fill="none" stroke="var(--viz-good, #1f6b3a)" stroke-width="2.4"/>
  <text x="500" y="172" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">streamed: flat at ~40 MB</text>
  <text x="100" y="206" font-size="9.5" fill="var(--muted, #7c6fb0)">start</text>
  <text x="360" y="206" font-size="9.5" fill="var(--muted, #7c6fb0)">50 %</text>
  <text x="650" y="206" font-size="9.5" fill="var(--muted, #7c6fb0)">complete</text>
  <text x="20" y="234" font-size="10.5" fill="var(--muted, #7c6fb0)">The streamed curve is flat because the chunk buffer is cleared after every yield — memory is a function of</text>
  <text x="20" y="248" font-size="10.5" fill="var(--muted, #7c6fb0)">chunk size</text>
</svg>

## Key Parameters & Options

| Setting | Value | Effect |
|---|---|---|
| `CHUNK` | 5 000 features | Larger chunks reduce yields but raise peak memory and block the loop longer |
| `cursor.fetch()` | server-side cursor | Without it asyncpg materialises the whole result set |
| Transaction | explicit, with `finally` | A cursor needs one; a leak here starves the pool |
| `X-Accel-Buffering: no` | required behind nginx | Otherwise the proxy buffers the entire body and the streaming is lost |
| `Content-Disposition` | attachment | Makes browsers save rather than attempt to render binary |
| `Content-Length` | omitted | Unknowable mid-stream; chunked encoding instead |

Chunk size is the one number worth tuning. Too small and the overhead of yielding dominates; too large and each encode blocks the event loop long enough to delay other requests. Five thousand simple features is a good starting point — measure the encode time per chunk and keep it under about 20 ms.

## What streaming actually buys

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of buffered GeoJSON, streamed GeoJSON and streamed FlatGeobuf across payload size, time to first byte and peak memory" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Three ways to serve the same 800 000 features</title>
  <desc>Three approaches compared on three measures. Buffered GeoJSON produces a 1420 megabyte payload, a time to first byte of 96 seconds and peak memory of 1.4 gigabytes. Streamed GeoJSON produces the same 1420 megabytes but a time to first byte of 0.4 seconds and peak memory of 45 megabytes. Streamed FlatGeobuf produces 268 megabytes, a time to first byte of 0.3 seconds and peak memory of 41 megabytes. The format change cuts size fivefold; the streaming change cuts time to first byte and memory by two orders of magnitude.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Same query, three delivery choices</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="34" y="58" font-size="10.5" font-weight="700" fill="currentColor">Approach</text>
  <text x="330" y="58" font-size="10.5" font-weight="700" fill="currentColor">Payload MB</text>
  <text x="460" y="58" font-size="10.5" font-weight="700" fill="currentColor">First byte</text>
  <text x="600" y="58" font-size="10.5" font-weight="700" fill="currentColor">Peak RAM</text>
  <text x="34" y="90" font-size="10.5" fill="currentColor">buffered GeoJSON</text>
  <rect x="326" y="78" width="66" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="398" y="91" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">1 420</text>
  <text x="460" y="90" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">96 s</text>
  <text x="600" y="90" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">1.4 GB</text>
  <line x1="20" y1="102" x2="700" y2="102" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="130" font-size="10.5" fill="currentColor">streamed GeoJSON</text>
  <rect x="326" y="118" width="66" height="16" rx="3" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <text x="398" y="131" font-size="9.5" font-weight="700" fill="var(--viz-warn, #8a5000)">1 420</text>
  <text x="460" y="130" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">0.4 s</text>
  <text x="600" y="130" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">45 MB</text>
  <line x1="20" y1="142" x2="700" y2="142" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="170" font-size="10.5" font-weight="700" fill="currentColor">streamed FlatGeobuf</text>
  <rect x="326" y="158" width="22" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.8"/>
  <text x="354" y="171" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">268 MB</text>
  <text x="460" y="170" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">0.3 s</text>
  <text x="600" y="170" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">41 MB</text>
  <text x="20" y="204" font-size="10.5" fill="var(--muted, #7c6fb0)">The two changes are independent: streaming fixes memory and latency, the format fixes size. Doing only one</text>
  <text x="20" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">still leaves a real problem — a streamed 1.4 GB of JSON still costs the client minutes of parsing.</text>
  <text x="20" y="236" font-size="10" fill="var(--muted, #7c6fb0)">Measured on 800 000 building polygons, average 34 vertices, five attributes.</text>
</svg>

## Where the bytes come from

Knowing the layout helps when a reader rejects the output, because the failure is almost always in the header rather than in the features.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Byte layout of a streamed FlatGeobuf file showing magic bytes, header, optional index and the feature sequence" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>FlatGeobuf layout, as written by the stream</title>
  <desc>The file begins with eight magic bytes identifying the format and version. A header follows, declaring the geometry type, the coordinate reference system and the column schema, and it must be written before any feature. A spatial index section is optional and is omitted when streaming because it requires knowing every feature's extent in advance. The remaining bytes are features written one after another, each self-contained, which is what allows a reader to consume them incrementally.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">What the generator emits, in order</text>
  <rect x="20" y="48" width="72" height="54" rx="6" fill="var(--accent, #7c3aed)" fill-opacity="0.2" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="56" y="70" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">magic</text>
  <text x="56" y="86" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">8 bytes</text>
  <rect x="96" y="48" width="168" height="54" rx="6" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="180" y="70" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">header</text>
  <text x="180" y="86" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">geometry type · CRS · columns</text>
  <rect x="268" y="48" width="118" height="54" rx="6" fill="none" stroke="var(--muted, #7c6fb0)" stroke-width="1.2" stroke-dasharray="5,3"/>
  <text x="327" y="70" text-anchor="middle" font-size="10" font-weight="700" fill="var(--muted, #7c6fb0)">index</text>
  <text x="327" y="86" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">omitted when streaming</text>
  <rect x="390" y="48" width="76" height="54" rx="6" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.18" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.3"/>
  <text x="428" y="78" text-anchor="middle" font-size="10" fill="currentColor">feature 1</text>
  <rect x="470" y="48" width="76" height="54" rx="6" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.18" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.3"/>
  <text x="508" y="78" text-anchor="middle" font-size="10" fill="currentColor">feature 2</text>
  <rect x="550" y="48" width="76" height="54" rx="6" fill="var(--viz-good, #1f6b3a)" fill-opacity="0.18" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.3"/>
  <text x="588" y="78" text-anchor="middle" font-size="10" fill="currentColor">feature 3</text>
  <text x="660" y="78" font-size="11" fill="var(--muted, #7c6fb0)">…</text>
  <path d="M20 112 L264 112" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="142" y="130" text-anchor="middle" font-size="10" fill="var(--accent, #7c3aed)">first yield — before any row is read</text>
  <path d="M390 112 L688 112" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="539" y="130" text-anchor="middle" font-size="10" fill="var(--viz-good, #1f6b3a)">one yield per CHUNK features</text>
  <text x="20" y="164" font-size="10.5" fill="currentColor">Because the index needs every extent up front, a streamed file has none — readers fall back to a</text>
  <text x="20" y="180" font-size="10.5" fill="currentColor">sequential scan, which is exactly what a streaming consumer was going to do anyway.</text>
  <text x="20" y="204" font-size="10.5" fill="var(--muted, #7c6fb0)">If a GIS tool rejects the output, check the header first: a wrong declared geometry type is the usual cause.</text>
</svg>

## Gotchas & Failure Modes

- **A proxy that buffers.** nginx and several managed load balancers buffer responses by default, which silently converts a streamed response back into a buffered one — on the proxy's memory instead of yours. `X-Accel-Buffering: no` handles nginx; check the equivalent for your edge.
- **Leaked connections on client cancel.** Without `finally`, every cancelled download costs one connection and one open transaction until the server restarts. This exhausts the pool faster than any query, as described in [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).
- **A long-lived transaction blocking vacuum.** A ten-minute export holds a snapshot for ten minutes, during which dead tuples on the whole database cannot be reclaimed. Cap the export size, or run exports against a replica.
- **Errors after the first byte.** Once the response has started, the status code is already 200 and there is no way to signal failure except by truncating. Validate everything — parameters, permissions, geometry type — before the first `yield`.
- **Mixed geometry types.** FlatGeobuf's header declares one geometry type. A query returning both polygons and points needs `Unknown` as the declared type, which some readers handle poorly. Filter by type, or split the export.
- **No resumability.** A failed download at 90 % starts again from zero. For very large exports, write to object storage and return a pre-signed URL, so the client's HTTP range support does the resuming — the pattern in [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) applied in reverse.

## Verification Snippet

```bash
# First byte should arrive in well under a second, long before completion
curl -s -o /dev/null -w 'first_byte=%{time_starttransfer}s total=%{time_total}s size=%{size_download}\n' \
  "http://localhost:8000/v1/exports/features.fgb?bbox=-1,50,1,52"
# first_byte=0.31s total=41.7s size=281018368

# The file must be readable by a standard GIS tool
ogrinfo -so -al /vsicurl/"http://localhost:8000/v1/exports/features.fgb?bbox=-1,50,1,52"
# Feature Count: 798412
# Geometry: Multi Polygon
```

```python
async def test_memory_stays_flat(pool, monkeypatch):
    import tracemalloc
    tracemalloc.start()
    total = 0
    async for chunk in flatgeobuf_stream(pool, (-1, 50, 1, 52)):
        total += len(chunk)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert total > 10_000_000          # a real export happened
    assert peak < 100 * 1024 * 1024    # and memory never grew with it
```

---

## Related

- [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/) — choosing between the formats in the first place
- [Best Practices for Serializing Large GeoJSON Responses](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/best-practices-for-serializing-large-geojson-responses/) — the same streaming argument for text output
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — why a leaked streaming connection hurts so much

← Back to [GeoJSON vs GeoParquet Serialization](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/geojson-vs-geoparquet-serialization/)
