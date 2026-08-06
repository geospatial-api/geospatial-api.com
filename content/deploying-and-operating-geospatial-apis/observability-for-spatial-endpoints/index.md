---
layout: layouts/page.njk
title: "Observability for Spatial Endpoints"
description: "Instrument a FastAPI and PostGIS service so slow spatial queries are diagnosable: OpenTelemetry spans around asyncpg, Prometheus histograms keyed by operation, and the PostGIS signals worth alerting on."
slug: observability-for-spatial-endpoints
type: topic
breadcrumb:
  - label: "Deploying and Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Observability for Spatial Endpoints"
    url: "/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Observability for Spatial Endpoints",
      "description": "Instrument a FastAPI and PostGIS service so slow spatial queries are diagnosable: OpenTelemetry spans around asyncpg, Prometheus histograms keyed by operation, and the PostGIS signals worth alerting on.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com" },
      "url": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/"
    },
    {
      "@type": "Article",
      "headline": "Observability for Spatial Endpoints",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Deploying and Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/" },
        { "@type": "ListItem", "position": 3, "name": "Observability for Spatial Endpoints", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Instrument a Spatial API for Production Diagnosis",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Label metrics by spatial operation", "text": "Record latency histograms keyed by the operation — bbox, knn, tile, export — rather than by raw route, so one slow shape is visible against the rest." },
        { "@type": "HowToStep", "position": 2, "name": "Span the database call, not just the request", "text": "Wrap each asyncpg execution in an OpenTelemetry span carrying the query name, the row count and the geometry envelope area." },
        { "@type": "HowToStep", "position": 3, "name": "Capture the plan for slow outliers", "text": "Sample requests over the latency budget and attach EXPLAIN output to the trace so the plan is available after the fact." },
        { "@type": "HowToStep", "position": 4, "name": "Alert on the database signals that precede failure", "text": "Watch index bloat, autovacuum lag, connection saturation and cache hit ratio, not only endpoint latency." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why is average latency useless for spatial endpoints?",
          "acceptedAnswer": { "@type": "Answer", "text": "Spatial workloads are extremely bimodal. A bounding box over an empty ocean tile returns in 3 milliseconds while the same endpoint over central London takes 900. The mean sits between two populations that never occur, so it moves only when everything is broken. Track percentiles — p50, p95 and p99 — split by operation, and treat the p99 as the number the slowest real users experience." }
        },
        {
          "@type": "Question",
          "name": "Should the bounding box go into a metric label?",
          "acceptedAnswer": { "@type": "Answer", "text": "No. Coordinates are unbounded cardinality and would create a new time series per request, which is the classic way to take down a Prometheus server. Put the envelope in the trace span, where high-cardinality attributes belong, and put a bucketed magnitude — the log of the envelope area, or a zoom level — in the metric label instead." }
        },
        {
          "@type": "Question",
          "name": "How do I attach a query plan to a slow request without slowing everything down?",
          "acceptedAnswer": { "@type": "Answer", "text": "Sample. When a request exceeds its budget, re-run the same statement under EXPLAIN with the same parameters on a separate connection and attach the JSON plan to the span. Cap it at a small number per minute with a token bucket, and never run EXPLAIN ANALYZE for a mutation, since that would execute the statement a second time." }
        },
        {
          "@type": "Question",
          "name": "Which PostGIS-specific metrics actually predict incidents?",
          "acceptedAnswer": { "@type": "Answer", "text": "Four. GiST index size relative to the table, which signals bloat; the ratio of index scans to sequential scans on the geometry table, which catches a plan regression the moment a query shape changes; autovacuum lag measured as dead tuples on the largest spatial table; and buffer cache hit ratio, which is what actually turns a 7 millisecond index scan into a 700 millisecond one." }
        }
      ]
    }
  ]
}
</script>

← Back to [Deploying and Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/)

# Observability for spatial endpoints

A generic HTTP dashboard tells you a spatial API is slow. It does not tell you that the slowness is confined to requests whose bounding box exceeds two square degrees, that those requests started missing the GiST index after last week's `ANALYZE`, or that the index no longer fits in the buffer cache. Spatial workloads fail in ways that route-level metrics average away, and the diagnosis almost always lives in the shape of the query rather than in the endpoint that issued it.

This page sets out an instrumentation layer built around that fact: metrics labelled by spatial operation and magnitude, traces that carry the query envelope and row count, sampled plans for the slow tail, and the four database signals that go bad before the API does. It assumes the deployment model from [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/) and complements the tuning work in [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/).

## Prerequisites & Environment

FastAPI 0.110+, asyncpg 0.29, `opentelemetry-sdk` 1.24+ with the OTLP exporter, and `prometheus-client` 0.20+. On the database side, enable the two extensions that make query-level attribution possible:

```sql
-- postgresql.conf
-- shared_preload_libraries = 'pg_stat_statements'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgstattuple;   -- for index bloat measurement

-- Log the statements that matter, not all of them
ALTER SYSTEM SET log_min_duration_statement = '500ms';
ALTER SYSTEM SET auto_explain.log_min_duration = '2s';
ALTER SYSTEM SET auto_explain.log_analyze = on;
SELECT pg_reload_conf();
```

`auto_explain` is worth the small overhead on a spatial workload: the plan for a query that took four seconds at 02:00 is otherwise unrecoverable, because re-running it during business hours produces a different plan against a warm cache.

## The four signals, and what each one catches

| Signal | Source | Catches | Alert when |
|---|---|---|---|
| Latency by operation | app histogram | one query shape regressing | p95 of any operation > 2× its 7-day baseline |
| Index scan ratio | `pg_stat_user_tables` | the planner abandoning GiST | `seq_scan` rate on a geometry table rises above 1 % of reads |
| Buffer cache hit ratio | `pg_statio_user_indexes` | working set outgrowing RAM | index hit ratio < 0.98 sustained for 15 min |
| Autovacuum lag | `pg_stat_user_tables` | bloat before it bites | dead tuples > 20 % of live on the largest spatial table |

<svg viewBox="0 0 720 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three-layer observability architecture: FastAPI emits metrics and spans, asyncpg spans carry query context, and PostGIS exporters supply index and vacuum statistics" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where each observability signal is produced</title>
  <desc>Three horizontal layers. The API layer emits a latency histogram labelled by operation and magnitude bucket, plus a request span. The data-access layer wraps each asyncpg call in a child span carrying the statement name, row count and envelope area, and samples an EXPLAIN plan when the request exceeds its budget. The database layer exports index scan ratios, buffer cache hit ratios, dead tuple counts and pg_stat_statements totals. All three feed one collector, from which dashboards and alerts are derived.</desc>
  <rect x="0" y="0" width="720" height="300" rx="10" fill="var(--surface, #f5f3ff)"/>
  <rect x="16" y="20" width="440" height="64" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="32" y="42" font-size="12" font-weight="700" fill="currentColor">1 · FastAPI layer</text>
  <text x="32" y="60" font-size="10.5" fill="currentColor">histogram: spatial_request_seconds{operation, magnitude, status}</text>
  <text x="32" y="76" font-size="10.5" fill="var(--muted, #7c6fb0)">one server span per request · budget attached as an attribute</text>
  <rect x="16" y="96" width="440" height="72" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="32" y="118" font-size="12" font-weight="700" fill="currentColor">2 · asyncpg layer</text>
  <text x="32" y="136" font-size="10.5" fill="currentColor">child span: db.statement_name · db.rows · geo.envelope_deg2</text>
  <text x="32" y="152" font-size="10.5" fill="var(--muted, #7c6fb0)">over budget → sampled EXPLAIN (FORMAT JSON) attached to the span</text>
  <rect x="16" y="180" width="440" height="72" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="32" y="202" font-size="12" font-weight="700" fill="currentColor">3 · PostGIS layer</text>
  <text x="32" y="220" font-size="10.5" fill="currentColor">idx_scan / seq_scan · idx_blks_hit ratio · n_dead_tup · bloat</text>
  <text x="32" y="236" font-size="10.5" fill="var(--muted, #7c6fb0)">scraped from pg_stat_* every 30 s — leading indicators, not symptoms</text>
  <path d="M456 52 L520 108" stroke="currentColor" stroke-width="1.4" marker-end="url(#obsArr)"/>
  <path d="M456 132 L520 132" stroke="currentColor" stroke-width="1.4" marker-end="url(#obsArr)"/>
  <path d="M456 216 L520 158" stroke="currentColor" stroke-width="1.4" marker-end="url(#obsArr)"/>
  <rect x="522" y="104" width="180" height="56" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="612" y="128" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Collector</text>
  <text x="612" y="146" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">metrics + traces, one clock</text>
  <path d="M612 160 L612 190" stroke="currentColor" stroke-width="1.4" marker-end="url(#obsArr)"/>
  <rect x="522" y="192" width="86" height="52" rx="7" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="565" y="214" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">Dashboards</text>
  <text x="565" y="230" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">by operation</text>
  <rect x="616" y="192" width="86" height="52" rx="7" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="659" y="214" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">Alerts</text>
  <text x="659" y="230" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">leading signals</text>
  <text x="20" y="278" font-size="10.5" fill="var(--muted, #7c6fb0)">High-cardinality context (coordinates, cursor values, tenant ids) belongs on spans; metrics carry only bounded labels.</text>
  <defs>
    <marker id="obsArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

## Step-by-Step Implementation

### 1. Label metrics by operation and magnitude, never by geometry

The label set is the whole design. `operation` separates workload shapes that have genuinely different latency distributions; `magnitude` is a bucketed proxy for how much work the request asked for. Both are bounded, so the time-series count stays fixed.

```python
from prometheus_client import Histogram, Counter

SPATIAL_LATENCY = Histogram(
    "spatial_request_seconds",
    "End-to-end latency of a spatial request",
    labelnames=("operation", "magnitude", "status"),
    # Buckets chosen around the real distribution, not the defaults
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

ROWS_RETURNED = Histogram(
    "spatial_rows_returned",
    "Rows returned per spatial query",
    labelnames=("operation",),
    buckets=(1, 10, 100, 1_000, 10_000, 100_000),
)

INDEX_FALLBACK = Counter(
    "spatial_seq_scan_total",
    "Queries observed falling back to a sequential scan",
    labelnames=("operation",),
)


def magnitude_bucket(area_deg2: float) -> str:
    """Bounded label: how much of the world the request asked about."""
    if area_deg2 < 0.01:
        return "xs"        # a few city blocks
    if area_deg2 < 1:
        return "s"         # a city
    if area_deg2 < 25:
        return "m"         # a region
    if area_deg2 < 500:
        return "l"         # a country
    return "xl"            # continental or unbounded
```

An `xl` request that takes eight seconds is working as designed; an `xs` request that takes eight seconds is an incident. Without the magnitude label those two are the same data point, which is why undifferentiated dashboards never catch the second case.

### 2. Span the database call with spatial context

The request span is not enough — almost all the time is inside one statement, and the interesting attributes are its parameters.

```python
import json
from contextlib import asynccontextmanager

import asyncpg
from opentelemetry import trace

tracer = trace.get_tracer("geospatial-api")


@asynccontextmanager
async def spatial_query(
    conn: asyncpg.Connection,
    name: str,
    *,
    operation: str,
    envelope_deg2: float | None = None,
):
    """Wrap one statement in a span carrying the context needed to diagnose it."""
    with tracer.start_as_current_span(f"db.{name}") as span:
        span.set_attribute("db.system", "postgresql")
        span.set_attribute("db.statement_name", name)
        span.set_attribute("geo.operation", operation)
        if envelope_deg2 is not None:
            span.set_attribute("geo.envelope_deg2", round(envelope_deg2, 4))
            span.set_attribute("geo.magnitude", magnitude_bucket(envelope_deg2))
        yield span


async def fetch_features(conn, sql: str, args: tuple, *, operation: str, area: float):
    async with spatial_query(conn, "features_bbox", operation=operation,
                             envelope_deg2=area) as span:
        rows = await conn.fetch(sql, *args)
        span.set_attribute("db.rows", len(rows))
        ROWS_RETURNED.labels(operation=operation).observe(len(rows))
        return rows
```

Recording the row count next to the duration is what makes the trace self-explaining: 900 ms for 40 000 rows is arithmetic, 900 ms for 12 rows is a missing index.

### 3. Sample a plan for the slow tail

```python
import asyncio
import time

PLAN_BUDGET_S = 1.0
_plan_tokens = 6          # at most six sampled plans per minute
_plan_window = 0.0


async def maybe_capture_plan(pool, sql: str, args: tuple, elapsed: float, span) -> None:
    """Attach an EXPLAIN plan to the span when a read blew its budget."""
    global _plan_tokens, _plan_window
    if elapsed < PLAN_BUDGET_S:
        return
    now = time.monotonic()
    if now - _plan_window > 60:
        _plan_tokens, _plan_window = 6, now
    if _plan_tokens <= 0:
        span.set_attribute("geo.plan_sampled", False)
        return
    _plan_tokens -= 1

    # Separate connection: never re-enter the one serving the request
    async with pool.acquire() as diag:
        await diag.execute("SET LOCAL statement_timeout = '5s'")
        plan = await diag.fetchval(f"EXPLAIN (FORMAT JSON, BUFFERS, ANALYZE) {sql}", *args)
    span.set_attribute("geo.plan_sampled", True)
    span.set_attribute("db.plan", json.dumps(plan)[:8000])

    # A plan that never touches the GiST index is worth counting, not just tracing
    if "Seq Scan" in str(plan):
        INDEX_FALLBACK.labels(operation=span.attributes.get("geo.operation", "unknown")).inc()
```

`ANALYZE` here executes the statement a second time. That is acceptable for a read that is already slow and rate-limited to six per minute; it is never acceptable for a mutation, so keep this path on the read routes only.

### 4. Scrape the database signals

```sql
-- Index versus sequential access on the geometry tables
SELECT relname,
       seq_scan,
       idx_scan,
       round(100.0 * seq_scan / NULLIF(seq_scan + idx_scan, 0), 2) AS pct_seq,
       n_live_tup,
       n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup, 0), 2)        AS pct_dead,
       last_autovacuum
FROM   pg_stat_user_tables
WHERE  relname IN ('features', 'positions', 'parcels')
ORDER  BY seq_scan DESC;

-- Is the GiST index still served from cache?
SELECT indexrelname,
       pg_size_pretty(pg_relation_size(indexrelid))                AS size,
       idx_blks_read,
       idx_blks_hit,
       round(idx_blks_hit::numeric
             / NULLIF(idx_blks_hit + idx_blks_read, 0), 4)         AS hit_ratio
FROM   pg_statio_user_indexes
WHERE  indexrelname LIKE '%_gix'
ORDER  BY hit_ratio ASC;
```

<svg viewBox="0 0 720 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline showing index cache hit ratio falling over eight days while p95 latency stays flat, then rises sharply once the hit ratio crosses 0.98" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The leading signal moves days before the symptom</title>
  <desc>Two series over eight days. The GiST index cache hit ratio declines steadily from 0.999 on day one to 0.966 on day eight as the index outgrows shared buffers. The p95 latency of bounding box queries stays near 40 milliseconds through day five, then climbs to 95 milliseconds on day six, 210 on day seven and 480 on day eight. The alert threshold on hit ratio fires on day six, two days before the latency alert would have.</desc>
  <rect x="0" y="0" width="720" height="280" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Index cache hit ratio predicts the latency cliff</text>
  <line x1="60" y1="46" x2="60" y2="212" stroke="currentColor" stroke-width="1.1"/>
  <line x1="60" y1="212" x2="676" y2="212" stroke="currentColor" stroke-width="1.1"/>
  <text x="52" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">1.000</text>
  <text x="52" y="132" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0.983</text>
  <text x="52" y="212" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0.965</text>
  <text x="686" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">500 ms</text>
  <text x="686" y="212" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">0 ms</text>
  <line x1="60" y1="119" x2="676" y2="119" stroke="var(--viz-warn, #8a5000)" stroke-width="1.2" stroke-dasharray="6,4"/>
  <text x="66" y="114" font-size="9.5" fill="var(--viz-warn, #8a5000)">alert threshold — hit ratio 0.98</text>
  <polyline points="60,50 148,58 236,72 324,92 412,124 500,158 588,186 676,205" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="2.2"/>
  <circle cx="412" cy="124" r="4" fill="var(--viz-warn, #8a5000)"/>
  <polyline points="60,199 148,199 236,198 324,198 412,197 500,180 588,142 676,53" fill="none" stroke="var(--viz-bad, #a32b23)" stroke-width="2.2" stroke-dasharray="5,3"/>
  <circle cx="588" cy="142" r="4" fill="var(--viz-bad, #a32b23)"/>
  <text x="60" y="230" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">d1</text>
  <text x="236" y="230" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">d3</text>
  <text x="412" y="230" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">d5</text>
  <text x="588" y="230" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">d7</text>
  <text x="676" y="230" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">d8</text>
  <rect x="60" y="242" width="12" height="4" fill="var(--accent, #7c3aed)"/>
  <text x="80" y="248" font-size="10" fill="currentColor">GiST index cache hit ratio (left axis)</text>
  <rect x="330" y="242" width="12" height="4" fill="var(--viz-bad, #a32b23)"/>
  <text x="350" y="248" font-size="10" fill="currentColor">p95 bbox latency (right axis)</text>
  <text x="20" y="270" font-size="10.5" fill="var(--muted, #7c6fb0)">The hit-ratio alert fires on day 5–6; latency only becomes obviously wrong on day 7. Two days of warning.</text>
</svg>

### 5. Read the histogram as two populations, not one

The payoff for labelling by magnitude arrives the first time you look at a latency distribution and see the shape rather than a single number. A healthy spatial service produces a distinctly bimodal picture: a tall, narrow mode for small-envelope requests served from the index and the buffer cache, and a low, wide mode for the large-envelope requests that genuinely have work to do. Both are fine. What is not fine is mass appearing between them, or the small-envelope mode drifting right — that is the signature of a plan regression or a cache that has stopped holding the working set.

Averaging those two populations produces a number that describes neither, and a single alert threshold on it either fires constantly or never fires at all. Alert per magnitude bucket instead: the `xs` bucket gets a tight budget measured in tens of milliseconds, the `xl` bucket gets seconds, and each is compared against its own baseline.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Histogram showing two separate latency populations for small and large envelope requests, with the average falling in the empty gap between them" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Spatial latency is bimodal — the mean lands where nothing happens</title>
  <desc>A latency histogram with two clear modes. Small-envelope requests cluster between 5 and 30 milliseconds and account for most of the traffic. Large-envelope requests form a second, much lower and wider mode between 400 milliseconds and 2 seconds. The arithmetic mean at 140 milliseconds falls in the empty valley between the two, describing no real request. Per-bucket p95 markers are shown inside each mode.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One endpoint, two populations (24 h of requests)</text>
  <line x1="52" y1="186" x2="700" y2="186" stroke="currentColor" stroke-width="1.1"/>
  <line x1="52" y1="44" x2="52" y2="186" stroke="currentColor" stroke-width="1.1"/>
  <rect x="62" y="96" width="22" height="90" fill="var(--accent, #7c3aed)" opacity="0.5"/>
  <rect x="86" y="60" width="22" height="126" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <rect x="110" y="48" width="22" height="138" fill="var(--accent, #7c3aed)" opacity="0.85"/>
  <rect x="134" y="72" width="22" height="114" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <rect x="158" y="118" width="22" height="68" fill="var(--accent, #7c3aed)" opacity="0.5"/>
  <rect x="182" y="158" width="22" height="28" fill="var(--accent, #7c3aed)" opacity="0.35"/>
  <rect x="206" y="176" width="22" height="10" fill="var(--accent, #7c3aed)" opacity="0.25"/>
  <text x="132" y="40" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">magnitude xs / s</text>
  <line x1="164" y1="48" x2="164" y2="186" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6" stroke-dasharray="4,3"/>
  <text x="170" y="60" font-size="9.5" fill="var(--viz-good, #1f6b3a)">p95 = 31 ms</text>
  <rect x="470" y="164" width="22" height="22" fill="var(--viz-warn, #8a5000)" opacity="0.4"/>
  <rect x="494" y="150" width="22" height="36" fill="var(--viz-warn, #8a5000)" opacity="0.55"/>
  <rect x="518" y="142" width="22" height="44" fill="var(--viz-warn, #8a5000)" opacity="0.7"/>
  <rect x="542" y="148" width="22" height="38" fill="var(--viz-warn, #8a5000)" opacity="0.6"/>
  <rect x="566" y="160" width="22" height="26" fill="var(--viz-warn, #8a5000)" opacity="0.45"/>
  <rect x="590" y="172" width="22" height="14" fill="var(--viz-warn, #8a5000)" opacity="0.3"/>
  <text x="540" y="128" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">magnitude l / xl</text>
  <line x1="586" y1="140" x2="586" y2="186" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6" stroke-dasharray="4,3"/>
  <text x="592" y="152" font-size="9.5" fill="var(--viz-good, #1f6b3a)">p95 = 1.8 s</text>
  <line x1="330" y1="44" x2="330" y2="186" stroke="var(--viz-bad, #a32b23)" stroke-width="1.8"/>
  <text x="336" y="70" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">mean = 140 ms</text>
  <text x="336" y="86" font-size="10" fill="var(--viz-bad, #a32b23)">no request is ever this fast or this slow</text>
  <text x="60" y="204" font-size="9.5" fill="var(--muted, #7c6fb0)">5 ms</text>
  <text x="200" y="204" font-size="9.5" fill="var(--muted, #7c6fb0)">50 ms</text>
  <text x="330" y="204" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">140 ms</text>
  <text x="470" y="204" font-size="9.5" fill="var(--muted, #7c6fb0)">400 ms</text>
  <text x="640" y="204" font-size="9.5" fill="var(--muted, #7c6fb0)">3 s</text>
  <text x="20" y="234" font-size="10.5" fill="var(--muted, #7c6fb0)">Alert per bucket against its own baseline; the aggregate is only useful as an externally-promised SLO headline.</text>
</svg>

## Production Code Example

The middleware that ties operation, magnitude, latency and trace together:

```python
import time
from typing import Callable

from fastapi import Request, Response
from opentelemetry import trace
from starlette.middleware.base import BaseHTTPMiddleware

OPERATION_BY_PREFIX = {
    "/v1/features":  "bbox",
    "/v1/nearest":   "knn",
    "/v1/tiles":     "tile",
    "/v1/exports":   "export",
}


def classify(path: str) -> str:
    for prefix, op in OPERATION_BY_PREFIX.items():
        if path.startswith(prefix):
            return op
    return "other"


def envelope_area(bbox: str | None) -> float | None:
    if not bbox:
        return None
    try:
        minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
    except ValueError:
        return None
    return abs(maxx - minx) * abs(maxy - miny)


class SpatialTelemetryMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        operation = classify(request.url.path)
        if operation == "other":
            return await call_next(request)

        area = envelope_area(request.query_params.get("bbox"))
        magnitude = magnitude_bucket(area) if area is not None else "na"

        span = trace.get_current_span()
        span.set_attribute("geo.operation", operation)
        span.set_attribute("geo.magnitude", magnitude)
        if area is not None:
            span.set_attribute("geo.envelope_deg2", round(area, 4))

        started = time.perf_counter()
        status = "500"
        try:
            response = await call_next(request)
            status = str(response.status_code)
            return response
        finally:
            elapsed = time.perf_counter() - started
            SPATIAL_LATENCY.labels(
                operation=operation, magnitude=magnitude, status=status
            ).observe(elapsed)
            span.set_attribute("geo.elapsed_ms", round(elapsed * 1000, 1))
```

Note the `finally`: a request that raises must still be measured, or the p99 quietly excludes exactly the requests that failed. This is the most common instrumentation bug in an otherwise well-monitored service.

## Verification & Testing

Assert on the label set rather than on the numbers — labels are the part that breaks silently.

```python
from prometheus_client import REGISTRY


def test_latency_labels_are_bounded(client, auth_headers):
    for bbox in ("-0.1,51.5,-0.09,51.51", "-10,40,10,60", "-180,-85,180,85"):
        client.get("/v1/features", params={"bbox": bbox}, headers=auth_headers)

    samples = [
        s for m in REGISTRY.collect() if m.name == "spatial_request_seconds"
        for s in m.samples
    ]
    magnitudes = {s.labels["magnitude"] for s in samples}
    assert magnitudes <= {"xs", "s", "m", "l", "xl", "na"}
    # No coordinate ever reaches a label
    assert not any("." in s.labels.get("operation", "") for s in samples)
```

And confirm end to end that a slow request produces a plan on its span:

```bash
# Force a deliberately expensive request, then look for the sampled plan
curl -s "http://localhost:8000/v1/features?bbox=-180,-85,180,85&limit=5000" > /dev/null
# In the trace backend, the span db.features_bbox should carry:
#   geo.magnitude=xl  geo.plan_sampled=true  db.plan={"Plan":{...}}
```

## Failure Modes & Edge Cases

1. **Cardinality explosion from a well-meaning label.** Adding `tenant_id` or `layer` to a histogram multiplies the series count by the number of tenants. Put them on spans. If a per-tenant metric is genuinely required, use a separate counter with a hard allow-list of top tenants and an `other` bucket.
2. **Percentiles averaged across operations.** A dashboard showing one p95 for the whole API is dominated by whichever operation is most frequent. Always break it down by `operation`; the aggregate is only useful as an SLO headline.
3. **Histogram buckets left at defaults.** The Prometheus defaults top out at 10 s and are dense around 0.5 s, which is the wrong resolution for a workload whose interesting range is 5–200 ms. Choose buckets from your own distribution or every quantile below p90 reads as the same number.
4. **`EXPLAIN ANALYZE` on the request connection.** Re-entering the connection mid-request deadlocks under some pool configurations and doubles the work in all of them. Always use a separate connection, and cap the sample rate.
5. **Traces without the row count.** A span that says "912 ms" and nothing else cannot distinguish a big result from a bad plan. Row count is the cheapest attribute with the highest diagnostic value.
6. **Alerting on latency alone.** By the time p95 doubles, the cache is already cold and users have noticed. The hit ratio and dead-tuple signals move days earlier — see the chart above.
7. **Metrics endpoint exposed publicly.** `/metrics` reveals internal route names, tenant counts and traffic volumes. Bind it to an internal listener or require authentication, in line with the controls in [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/).
8. **Sampling that discards the slow tail.** Head-based trace sampling at 1 % will almost never keep the slow requests. Use tail-based sampling, or force `sampled=true` on any span that exceeds its budget.

## Performance Notes

The instrumentation described here costs about 0.15 ms per request: roughly 40 µs for the histogram observations, 60 µs for span creation and attributes, and the rest in context propagation. That is under 1 % of a typical 25 ms bounding box request and invisible next to a 400 ms tile.

The exception is plan sampling. An `EXPLAIN (ANALYZE)` re-runs the statement, so a 4-second query costs another 4 seconds of database time. Six per minute is a deliberate cap: enough to catch a regression within one alert window, few enough that a widespread slowdown does not turn the diagnostics into the outage. When a slow query also holds a connection, the interaction with pool sizing described in [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) is what decides whether sampling is safe at all.

Retention matters for the spatial signals specifically. Index bloat and cache-hit trends are only legible over weeks, so keep those series at a coarse resolution for 90 days even if request metrics roll off at 14.

---

## Related

- [CI/CD Pipelines for Spatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/ci-cd-pipelines-for-spatial-apis/) — catching plan regressions before they reach production
- [Containerizing PostGIS & FastAPI](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/containerizing-postgis-and-fastapi/) — where the exporters and collectors live in the deployment
- [Query Plan Analysis & Index Tuning](https://www.geospatial-api.com/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/) — reading the plans this layer captures
- [Connection Pooling & PgBouncer Setup](https://www.geospatial-api.com/high-performance-caching-query-optimization/connection-pooling-pgbouncer-setup/) — the saturation signal behind most latency cliffs
- [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/) — the security counterpart to this operational trail

← Back to [Deploying and Operating Geospatial APIs](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/)
