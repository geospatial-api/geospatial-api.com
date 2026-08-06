---
layout: layouts/page.njk
title: "Instrumenting asyncpg Queries with OpenTelemetry"
description: "Wrap every PostGIS call in a span that carries the statement name, row count and envelope area — so a slow trace explains itself without re-running the query."
slug: instrumenting-asyncpg-queries-with-opentelemetry
type: howto
breadcrumb:
  - label: "Deploying and Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Observability for Spatial Endpoints"
    url: "/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/"
  - label: "Instrumenting asyncpg Queries with OpenTelemetry"
    url: "/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/instrumenting-asyncpg-queries-with-opentelemetry/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Instrumenting asyncpg Queries with OpenTelemetry",
      "description": "Wrap every PostGIS call in a span carrying the statement name, row count and envelope area.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/instrumenting-asyncpg-queries-with-opentelemetry/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Deploying and Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/" },
        { "@type": "ListItem", "position": 2, "name": "Observability for Spatial Endpoints", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/" },
        { "@type": "ListItem", "position": 3, "name": "Instrumenting asyncpg Queries with OpenTelemetry", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/instrumenting-asyncpg-queries-with-opentelemetry/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Add Spatial Context to Database Spans",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Name the statement", "text": "Give every query a stable name so spans aggregate instead of appearing as thousands of distinct SQL strings." },
        { "@type": "HowToStep", "position": 2, "name": "Attach spatial attributes", "text": "Record the envelope area, magnitude bucket and returned row count on the span." },
        { "@type": "HowToStep", "position": 3, "name": "Record the pool wait", "text": "Separate time spent waiting for a connection from time spent executing, since they have different fixes." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why not just use the automatic asyncpg instrumentation?",
          "acceptedAnswer": { "@type": "Answer", "text": "Automatic instrumentation gives you a span per query with the SQL text and a duration, which is a good start and blind to everything that matters spatially. It cannot know the envelope area, the magnitude bucket or the operation the query belongs to, and it will happily put a full SQL string with embedded coordinates into a span attribute. A thin wrapper adds the context and controls what leaves the process." }
        },
        {
          "@type": "Question",
          "name": "Should the SQL text go on the span?",
          "acceptedAnswer": { "@type": "Answer", "text": "The statement name should; the full text should not, and the parameters certainly should not. A parameterised statement is stable and useful as an identifier, while the substituted text carries coordinates into the tracing backend, which usually has looser access control than the database. Store a name and let the code be the reference for what it does." }
        },
        {
          "@type": "Question",
          "name": "How much overhead does a span per query add?",
          "acceptedAnswer": { "@type": "Answer", "text": "Around 40 to 80 microseconds for creation plus a handful of attributes, and no network cost on the request path because the exporter batches. Against a bounding box query that takes tens of milliseconds it is under half a percent. The cost only becomes visible if you create a span per row, which is a mistake in any instrumentation." }
        }
      ]
    }
  ]
}
</script>

← Back to [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/)

# Instrumenting asyncpg queries with OpenTelemetry

This page shows how to wrap PostGIS calls in spans that carry enough spatial context to diagnose a slow request from the trace alone, without re-running anything.

## Context & When to Use

A request span that says "912 ms" tells you a request was slow. A database span that says "912 ms, statement `features_bbox`, 12 rows, envelope 0.004 deg²" tells you it was slow *for no good reason* — a tiny area returning almost nothing should never take that long, so the index or the cache is the suspect. The same span reading "912 ms, 41 000 rows, envelope 380 deg²" tells you the client asked for a continent and got one.

That difference — between a number and an explanation — comes down to three attributes: what the statement was, how much ground it covered, and how much came back. None of them are available to generic database instrumentation, because none of them are visible in the SQL text alone.

The wrapper below is deliberately thin. It does not replace the automatic instrumentation's job of timing the call; it adds the spatial context and it controls what leaves the process, which matters because a naive span attribute containing substituted SQL exports coordinates into a tracing backend — the exposure discussed in [Redacting Coordinate Precision in Application Logs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/redacting-coordinate-precision-in-application-logs/).

## Runnable Implementation

```python
import time
from contextlib import asynccontextmanager
from typing import Any, Sequence

import asyncpg
from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode

tracer = trace.get_tracer("geospatial-api.db")


def magnitude_bucket(area_deg2: float) -> str:
    if area_deg2 < 0.01:
        return "xs"
    if area_deg2 < 1:
        return "s"
    if area_deg2 < 25:
        return "m"
    if area_deg2 < 500:
        return "l"
    return "xl"


@asynccontextmanager
async def traced_pool_acquire(pool: asyncpg.Pool):
    """Separate 'waiting for a connection' from 'running the query'."""
    started = time.perf_counter()
    async with pool.acquire() as conn:
        wait_ms = (time.perf_counter() - started) * 1000
        span = trace.get_current_span()
        span.set_attribute("db.pool.wait_ms", round(wait_ms, 2))
        span.set_attribute("db.pool.size", pool.get_size())
        span.set_attribute("db.pool.idle", pool.get_idle_size())
        yield conn


async def traced_fetch(
    conn: asyncpg.Connection,
    name: str,
    sql: str,
    *args: Any,
    operation: str,
    envelope_deg2: float | None = None,
) -> Sequence[asyncpg.Record]:
    """Run one statement inside a span carrying its spatial context."""
    with tracer.start_as_current_span(f"db.{name}", kind=SpanKind.CLIENT) as span:
        span.set_attribute("db.system", "postgresql")
        # The NAME, never the substituted text — parameters carry coordinates
        span.set_attribute("db.operation", name)
        span.set_attribute("geo.operation", operation)
        if envelope_deg2 is not None:
            span.set_attribute("geo.envelope_deg2", round(envelope_deg2, 4))
            span.set_attribute("geo.magnitude", magnitude_bucket(envelope_deg2))
        try:
            rows = await conn.fetch(sql, *args)
        except asyncpg.PostgresError as exc:
            span.set_status(Status(StatusCode.ERROR, exc.__class__.__name__))
            span.set_attribute("db.postgres.sqlstate", getattr(exc, "sqlstate", ""))
            raise
        span.set_attribute("db.rows", len(rows))
        # The ratio is the diagnostic: rows per unit of ground asked for
        if envelope_deg2:
            span.set_attribute("geo.rows_per_deg2", round(len(rows) / envelope_deg2, 1))
        return rows
```

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Waterfall of one traced request showing pool wait, query execution and serialization as separate spans with their attributes" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>One request, four spans, and what each one answers</title>
  <desc>A trace waterfall for a single request lasting 214 milliseconds. The server span covers the whole request. Inside it, a pool acquire span takes 148 milliseconds and carries pool size and idle count, revealing connection starvation. The database span takes 51 milliseconds and carries statement name, envelope area, magnitude bucket and row count. A serialization span takes 12 milliseconds. The annotation notes that without the separate pool span, the whole 199 milliseconds would have looked like a slow query.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Trace waterfall — 214 ms request</text>
  <text x="20" y="56" font-size="10.5" fill="currentColor">GET /v1/features</text>
  <rect x="180" y="44" width="500" height="18" rx="3" fill="var(--accent, #7c3aed)" opacity="0.35"/>
  <text x="688" y="57" text-anchor="end" font-size="9.5" fill="currentColor">214 ms</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">pool.acquire</text>
  <rect x="188" y="76" width="346" height="18" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="542" y="89" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">148 ms</text>
  <text x="188" y="108" font-size="9.5" fill="var(--muted, #7c6fb0)">db.pool.size=20 · db.pool.idle=0 → starvation, not a slow query</text>
  <text x="34" y="138" font-size="10.5" fill="currentColor">db.features_bbox</text>
  <rect x="538" y="126" width="119" height="18" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="665" y="139" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">51 ms</text>
  <text x="188" y="158" font-size="9.5" fill="var(--muted, #7c6fb0)">geo.envelope_deg2=0.04 · geo.magnitude=s · db.rows=912 · geo.rows_per_deg2=22800</text>
  <text x="34" y="188" font-size="10.5" fill="currentColor">serialize</text>
  <rect x="657" y="176" width="28" height="18" rx="3" fill="var(--accent, #7c3aed)" opacity="0.6"/>
  <text x="620" y="189" text-anchor="end" font-size="9.5" fill="currentColor">12 ms</text>
  <line x1="20" y1="206" x2="700" y2="206" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="228" font-size="10.5" fill="var(--muted, #7c6fb0)">Without a separate pool span, all 199 ms reads as "the database was slow" and the fix — pool sizing —</text>
  <text x="20" y="242" font-size="10.5" fill="var(--muted, #7c6fb0)">is never considered. The split costs one context manager.</text>
</svg>

## Key Parameters & Options

| Attribute | Example | Diagnostic value |
|---|---|---|
| `db.operation` | `features_bbox` | Stable name; groups spans that share SQL |
| `geo.envelope_deg2` | `0.04` | How much ground was requested |
| `geo.magnitude` | `s` | Bounded bucket, safe to also use as a metric label |
| `db.rows` | `912` | Distinguishes "big answer" from "bad plan" |
| `geo.rows_per_deg2` | `22800` | Density; a sudden change signals a data or filter bug |
| `db.pool.wait_ms` | `148` | Separates saturation from execution |
| `db.postgres.sqlstate` | `57014` | Statement timeout versus a real error |

Never add the substituted SQL or the parameter values. The statement name plus the source file is a complete reference for what ran, without exporting coordinates.

## What the attributes let you ask afterwards

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four trace queries and the attribute combination each depends on" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Questions answerable from span attributes alone</title>
  <desc>Four investigative questions with the attributes each requires. Is this slow request unreasonable needs envelope area with row count. Is the pool the bottleneck needs pool wait against total duration. Which statement regressed this week needs the statement name with duration. Did a data change alter density needs rows per square degree over time. Each row notes that the question cannot be answered without those attributes, which is the argument for recording them at the time rather than reconstructing later.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">What each attribute pair unlocks</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="34" y="58" font-size="10.5" font-weight="700" fill="currentColor">Question at 3 a.m.</text>
  <text x="420" y="58" font-size="10.5" font-weight="700" fill="currentColor">Attributes needed</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">"Is this slow request unreasonable?"</text>
  <text x="420" y="88" font-size="10" font-family="monospace" fill="currentColor">envelope_deg2 + db.rows</text>
  <line x1="20" y1="100" x2="700" y2="100" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="122" font-size="10.5" fill="currentColor">"Is the pool the bottleneck?"</text>
  <text x="420" y="122" font-size="10" font-family="monospace" fill="currentColor">pool.wait_ms + duration</text>
  <line x1="20" y1="134" x2="700" y2="134" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="156" font-size="10.5" fill="currentColor">"Which statement regressed this week?"</text>
  <text x="420" y="156" font-size="10" font-family="monospace" fill="currentColor">db.operation + duration</text>
  <line x1="20" y1="168" x2="700" y2="168" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="190" font-size="10.5" fill="currentColor">"Did a data change alter density?"</text>
  <text x="420" y="190" font-size="10" font-family="monospace" fill="currentColor">geo.rows_per_deg2 over time</text>
  <text x="20" y="218" font-size="10.5" fill="var(--muted, #7c6fb0)">None of these can be reconstructed after the fact — the attributes have to be on the span when it is created.</text>
</svg>

## Gotchas & Failure Modes

- **Span per row.** Creating a span inside a result loop turns a 900-row query into 900 spans and dominates the request. One span per statement, attributes for the aggregate.
- **Head-based sampling at 1 %.** The slow requests are by definition rare, so a uniform sample almost never keeps one. Use tail-based sampling, or force `sampled=true` when the request exceeds its budget.
- **Coordinates in attributes.** `db.statement` with substituted parameters, or a `bbox` attribute copied verbatim, exports precise locations to the tracing backend. Record the area, not the box.
- **Pool wait invisible.** If the acquire happens outside the span, connection starvation looks exactly like a slow query and the wrong thing gets optimised — the interaction described in [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/).
- **Exceptions swallowing the span status.** Catching `PostgresError` without calling `set_status` leaves a failed query recorded as a success, and the error rate derived from traces silently under-reports.
- **Cardinality leaking from attributes into metrics.** Span attributes tolerate high cardinality; metric labels do not. Keep `geo.magnitude` for metrics and `geo.envelope_deg2` for spans only.

## Wiring it into the route without repeating yourself

Threading `operation` and `envelope_deg2` through every call site by hand goes stale within a sprint. Derive both once, in the dependency that already parses the bounding box, and stash them on the request so the data layer can read them without another argument.

```python
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Query, Request


@dataclass(frozen=True)
class SpatialRequestContext:
    operation: str
    envelope_deg2: float | None

    @property
    def magnitude(self) -> str:
        return magnitude_bucket(self.envelope_deg2) if self.envelope_deg2 else "na"


def spatial_context(
    request: Request,
    bbox: Annotated[str | None, Query()] = None,
) -> SpatialRequestContext:
    area = None
    if bbox:
        try:
            minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, detail={"error": "bbox_must_be_four_numbers"})
        area = abs(maxx - minx) * abs(maxy - miny)

    ctx = SpatialRequestContext(operation=classify(request.url.path), envelope_deg2=area)
    request.state.spatial = ctx        # available to middleware and metrics too
    return ctx
```

Every route then passes one object, and adding a future attribute — the tenant's scope area, say, or the requested output projection — means changing one dataclass rather than every query call. The middleware described in [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) reads the same object for its metric labels, so the span and the histogram can never disagree about what a request was.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram showing one context object derived in a dependency and consumed by spans, metrics and the audit trail" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>One derivation, three consumers</title>
  <desc>A single dependency parses the bounding box once and produces a context object holding operation, envelope area and magnitude. Three consumers read it: the database span uses the full area, the Prometheus histogram uses only the bounded magnitude bucket, and the audit middleware uses the coarsened envelope. Because all three read the same object, they cannot disagree about what the request was, which is the failure mode when each derives its own labels.</desc>
  <rect x="0" y="0" width="720" height="220" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Derive once in the dependency, read three times</text>
  <rect x="20" y="76" width="176" height="72" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.6"/>
  <text x="108" y="100" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">spatial_context()</text>
  <text x="108" y="118" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">parses bbox once</text>
  <text x="108" y="133" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">operation · area · magnitude</text>
  <path d="M196 96 L256 66" stroke="currentColor" stroke-width="1.3" marker-end="url(#ctxArr)"/>
  <path d="M196 112 L256 112" stroke="currentColor" stroke-width="1.3" marker-end="url(#ctxArr)"/>
  <path d="M196 128 L256 160" stroke="currentColor" stroke-width="1.3" marker-end="url(#ctxArr)"/>
  <rect x="258" y="44" width="200" height="46" rx="7" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="358" y="64" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">database span</text>
  <text x="358" y="80" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">full area · high cardinality fine</text>
  <rect x="258" y="90" width="200" height="46" rx="7" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="358" y="110" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">histogram label</text>
  <text x="358" y="126" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">magnitude only · bounded</text>
  <rect x="258" y="140" width="200" height="46" rx="7" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="358" y="160" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">audit middleware</text>
  <text x="358" y="176" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">coarsened envelope</text>
  <rect x="482" y="76" width="218" height="72" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="591" y="100" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">they cannot disagree</text>
  <text x="591" y="118" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">one parse, one classification</text>
  <text x="591" y="133" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">one place to change</text>
  <path d="M458 112 L480 112" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4" marker-end="url(#ctxArrG)"/>
  <text x="20" y="208" font-size="10.5" fill="var(--muted, #7c6fb0)">When each consumer derives its own labels, a trace and a dashboard eventually tell different stories about the same request.</text>
  <defs>
    <marker id="ctxArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
    <marker id="ctxArrG" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="var(--viz-good, #1f6b3a)"/></marker>
  </defs>
</svg>

## Verification Snippet

```python
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


async def test_span_carries_spatial_context(pool):
    exporter = InMemorySpanExporter()
    trace.get_tracer_provider().add_span_processor(SimpleSpanProcessor(exporter))

    async with traced_pool_acquire(pool) as conn:
        await traced_fetch(conn, "features_bbox", FEATURES_SQL,
                           -0.2, 51.4, 0.0, 51.6, 200,
                           operation="bbox", envelope_deg2=0.04)

    span = next(s for s in exporter.get_finished_spans() if s.name == "db.features_bbox")
    assert span.attributes["geo.magnitude"] == "s"
    assert span.attributes["db.rows"] > 0
    # No coordinates anywhere in the exported attributes
    assert not any("51.5" in str(v) for v in span.attributes.values())
```

```bash
# Confirm attributes arrive in the collector
otel-cli span --service test --name db.features_bbox --verbose 2>&1 | grep geo.
```

---

## Related

- [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) — the wider signal design these spans feed
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — what a large `pool.wait_ms` is telling you
- [Redacting Coordinate Precision in Application Logs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/redacting-coordinate-precision-in-application-logs/) — the same exposure question for traces

← Back to [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/)
