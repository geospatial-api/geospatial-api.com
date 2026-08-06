---
layout: layouts/page.njk
title: "Audit Logging for Location Data Access"
description: "Record who read which geometry, when, and why — without turning the audit trail into a second copy of the location data. Trigger-based logs, coordinate redaction, and retention for spatial APIs."
slug: audit-logging-for-location-data-access
type: topic
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "Audit Logging for Location Data Access"
    url: "/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Audit Logging for Location Data Access",
      "description": "Record who read which geometry, when, and why — without turning the audit trail into a second copy of the location data.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "publisher": { "@type": "Organization", "name": "geospatial-api.com", "url": "https://www.geospatial-api.com" },
      "url": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/"
    },
    {
      "@type": "Article",
      "headline": "Audit Logging for Location Data Access",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.geospatial-api.com/" },
        { "@type": "ListItem", "position": 2, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/" },
        { "@type": "ListItem", "position": 3, "name": "Audit Logging for Location Data Access", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build an Audit Trail for a Spatial API",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Decide what counts as an access", "text": "Define the auditable events — reads of precise coordinates, exports, and every write — and leave aggregate or coarsened reads out of the trail." },
        { "@type": "HowToStep", "position": 2, "name": "Carry identity into the database session", "text": "Set the caller's subject and request id as session variables so a trigger can record them without a second round trip." },
        { "@type": "HowToStep", "position": 3, "name": "Record the query envelope, not the rows", "text": "Store the requested bounding box, the row count and the layer rather than copying every geometry into the audit table." },
        { "@type": "HowToStep", "position": 4, "name": "Make the trail append-only and expire it", "text": "Revoke UPDATE and DELETE from the application role and partition the audit table so retention is a detach." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Should the audit trail store the geometry that was returned?",
          "acceptedAnswer": { "@type": "Answer", "text": "Almost never. Copying returned geometry doubles the exposure of the exact data the audit exists to protect, and it grows faster than the source table. Record the request envelope, the layer, the filter parameters and the row count. If an investigation later needs the precise rows, they can be reconstructed by replaying the recorded query against a point-in-time snapshot." }
        },
        {
          "@type": "Question",
          "name": "Are database triggers or application middleware the right place to audit?",
          "acceptedAnswer": { "@type": "Answer", "text": "Both, for different events. Triggers are the only reliable place to audit writes, because they fire for migrations and manual sessions too. Reads are better captured in application middleware, since a SELECT trigger does not exist and the API layer knows the caller, the endpoint and the query parameters. Use triggers as the tamper-evident backstop and middleware for the richer read trail." }
        },
        {
          "@type": "Question",
          "name": "How precise may coordinates be in application logs?",
          "acceptedAnswer": { "@type": "Answer", "text": "Truncate to the coarsest precision that still supports debugging. Two decimal places is roughly one kilometre and rarely identifies anyone; five decimal places is about one metre and identifies a doorway. Logs are replicated to aggregation systems with looser access control than the database, so treat full-precision coordinates in a log line as a data disclosure." }
        },
        {
          "@type": "Question",
          "name": "How long should a location audit trail be kept?",
          "acceptedAnswer": { "@type": "Answer", "text": "Long enough to investigate an incident and no longer — typically 12 to 24 months, driven by the contractual or regulatory commitment rather than by disk cost. Partition the audit table by month so expiry is a DETACH plus DROP, and record the retention period in the same place as the policy so the two cannot drift apart." }
        }
      ]
    }
  ]
}
</script>

← Back to [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/)

# Audit logging for location data access

Location data has a property that ordinary business records do not: reading it is itself a sensitive act. Knowing that an account queried a 200-metre box around a particular address at 03:00 tells you something even if no row was returned. That makes the audit trail for a spatial API a first-class security control rather than a compliance checkbox — and it makes the naive implementation, "copy every returned feature into a log table", actively harmful.

This page covers a trail that answers the questions an incident actually asks — who read what area, when, under which authorisation, and how much came back — while holding less sensitive data than the table it protects. It builds on the identity plumbing from [Setting Tenant Context in asyncpg Connections](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/) and the scope model in [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/).

## Prerequisites & Environment

PostgreSQL 14+ with PostGIS 3.3+, FastAPI 0.110+, asyncpg 0.29. The application must already authenticate callers and set a per-session identity; everything below assumes `app.subject_id`, `app.tenant_id` and `app.request_id` are available through `current_setting`.

```sql
-- What the audit layer expects to find on every session
SELECT current_setting('app.subject_id', true)  AS subject,
       current_setting('app.tenant_id',  true)  AS tenant,
       current_setting('app.request_id', true)  AS request;
```

If any of those return `NULL` in production traffic, fix that before building the trail — an audit record without an actor is a timestamp.

## What to record, and what not to

The design decision that matters is the granularity of the record. Three levels are common, and the middle one is almost always right.

| Level | Stored per access | Storage per 1 M reads | Investigative value |
|---|---|---|---|
| Endpoint only | route, subject, timestamp | ~90 MB | Weak — cannot tell which area was read |
| Query envelope | route, subject, bbox, filters, row count | ~340 MB | Strong — the area and volume are reconstructable |
| Full result copy | every geometry returned | 40–900 GB | Marginally stronger, and a second breach surface |

<svg viewBox="0 0 720 290" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram of the audit path: a request carries identity into the database session, the read is recorded as an envelope in the audit table, and writes are captured independently by a trigger" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Where audit records are produced</title>
  <desc>A request enters FastAPI carrying a bearer token. A dependency resolves the subject and tenant and stamps them onto the database session with SET LOCAL. Reads are recorded by application middleware as an envelope record containing route, subject, bounding box and row count. Writes travel through the same session but are captured separately by an AFTER trigger on the features table, which cannot be bypassed by migrations or manual sessions. Both streams land in an append-only audit table partitioned by month, from which the application role has had UPDATE and DELETE revoked.</desc>
  <rect x="0" y="0" width="720" height="290" rx="10" fill="var(--surface, #f5f3ff)"/>
  <rect x="16" y="34" width="120" height="52" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="76" y="56" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Request</text>
  <text x="76" y="72" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">bearer + bbox</text>
  <path d="M136 60 L166 60" stroke="currentColor" stroke-width="1.4" marker-end="url(#audArr)"/>
  <rect x="168" y="20" width="150" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="243" y="42" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">FastAPI dependency</text>
  <text x="243" y="60" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">verify token → subject</text>
  <text x="243" y="76" text-anchor="middle" font-size="10" font-family="monospace" fill="currentColor">SET LOCAL app.*</text>
  <text x="243" y="92" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">identity on the session</text>
  <path d="M318 46 L360 46" stroke="currentColor" stroke-width="1.4" marker-end="url(#audArr)"/>
  <path d="M318 78 L360 110" stroke="currentColor" stroke-width="1.4" marker-end="url(#audArr)"/>
  <rect x="362" y="20" width="160" height="56" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="442" y="40" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">READ path</text>
  <text x="442" y="56" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">middleware records</text>
  <text x="442" y="70" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">envelope + row count</text>
  <rect x="362" y="96" width="160" height="56" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="442" y="116" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">WRITE path</text>
  <text x="442" y="132" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">AFTER trigger on features</text>
  <text x="442" y="146" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">fires for psql too</text>
  <path d="M522 48 L566 78" stroke="currentColor" stroke-width="1.4" marker-end="url(#audArr)"/>
  <path d="M522 124 L566 96" stroke="currentColor" stroke-width="1.4" marker-end="url(#audArr)"/>
  <rect x="568" y="60" width="134" height="60" rx="8" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.8"/>
  <text x="635" y="82" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">access_audit</text>
  <text x="635" y="98" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">append-only</text>
  <text x="635" y="112" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">partitioned by month</text>
  <line x1="16" y1="172" x2="704" y2="172" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="194" font-size="12" font-weight="700" fill="currentColor">Privileges that make the trail evidence rather than a log</text>
  <rect x="20" y="204" width="216" height="62" rx="7" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="128" y="224" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">api_rw</text>
  <text x="128" y="240" text-anchor="middle" font-size="10" fill="currentColor">INSERT only on access_audit</text>
  <text x="128" y="255" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">cannot rewrite its own history</text>
  <rect x="252" y="204" width="216" height="62" rx="7" fill="var(--surface-alt, #ede8f8)"/>
  <text x="360" y="224" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">auditor</text>
  <text x="360" y="240" text-anchor="middle" font-size="10" fill="currentColor">SELECT only, no feature access</text>
  <text x="360" y="255" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">reads the trail, not the data</text>
  <rect x="484" y="204" width="218" height="62" rx="7" fill="var(--viz-warn-soft, #fbeed6)"/>
  <text x="593" y="224" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">retention job</text>
  <text x="593" y="240" text-anchor="middle" font-size="10" fill="currentColor">DETACH + DROP monthly</text>
  <text x="593" y="255" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">the only deletion path</text>
  <defs>
    <marker id="audArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

## Step-by-Step Implementation

### 1. The audit table

Store the *envelope* of what was read as a geometry, so the trail is itself spatially queryable — "show me everything anyone read within 1 km of this address" becomes an indexed query rather than a log grep.

```sql
CREATE TABLE access_audit (
    id           bigserial,
    occurred_at  timestamptz NOT NULL DEFAULT now(),
    subject_id   text        NOT NULL,
    tenant_id    text,
    request_id   uuid,
    action       text        NOT NULL CHECK (action IN ('read','create','update','delete','export')),
    layer        text        NOT NULL,
    -- The AREA that was requested, not the rows that came back
    envelope     geometry(Polygon, 4326),
    row_count    integer,
    filters      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    status_code  smallint,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX access_audit_env_gix   ON access_audit USING GIST (envelope);
CREATE INDEX access_audit_subject   ON access_audit (subject_id, occurred_at DESC);
CREATE INDEX access_audit_filters   ON access_audit USING GIN (filters);
```

Partitioning is not incidental here — the trail outgrows the feature table within months on a busy API, and expiry has to be cheap. The mechanics are the same as in [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/).

Then take away the ability to rewrite it:

```sql
GRANT INSERT ON access_audit TO api_rw;
REVOKE UPDATE, DELETE, TRUNCATE ON access_audit FROM api_rw;
GRANT SELECT ON access_audit TO auditor;
```

### 2. Capture writes with a trigger

A trigger is the only mechanism that also covers migrations, admin scripts and a developer with `psql`.

```sql
CREATE OR REPLACE FUNCTION audit_feature_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    target geometry;
BEGIN
    target := COALESCE(NEW.geom, OLD.geom);
    INSERT INTO access_audit (
        subject_id, tenant_id, request_id, action, layer,
        envelope, row_count, filters
    ) VALUES (
        COALESCE(current_setting('app.subject_id', true), 'system'),
        current_setting('app.tenant_id', true),
        NULLIF(current_setting('app.request_id', true), '')::uuid,
        lower(TG_OP),
        TG_TABLE_NAME,
        -- Envelope only: the trail never holds the precise geometry
        CASE WHEN target IS NULL THEN NULL
             ELSE ST_Envelope(ST_Buffer(target::geography, 50)::geometry) END,
        1,
        jsonb_build_object('feature_id', COALESCE(NEW.id, OLD.id))
    );
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER features_audit
    AFTER INSERT OR UPDATE OR DELETE ON features
    FOR EACH ROW EXECUTE FUNCTION audit_feature_write();
```

`SECURITY DEFINER` lets the trigger insert into a table the calling role cannot otherwise write to directly — which is what stops an application bug from forging records. The 50-metre buffer before taking the envelope means a point feature produces a real polygon rather than a degenerate one, and coarsens the recorded location slightly on purpose.

### 3. Capture reads in middleware

There is no `SELECT` trigger, and there should not be — reads are far more frequent and the interesting context lives in the API layer.

```python
import json
import time
import uuid
from typing import Any, Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

AUDITED_PREFIXES = ("/v1/features", "/v1/positions", "/v1/exports")
COARSE_DP = 2   # ~1.1 km — enough to investigate, not enough to identify


class SpatialAuditMiddleware(BaseHTTPMiddleware):
    """Record one envelope row per audited read, after the response is known."""

    def __init__(self, app, pool_factory: Callable[[], Any]) -> None:
        super().__init__(app)
        self._pool_factory = pool_factory

    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith(AUDITED_PREFIXES):
            return await call_next(request)

        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        request.state.request_id = request_id
        started = time.perf_counter()
        response: Response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started) * 1000

        subject = getattr(request.state, "subject_id", None)
        if subject is None:              # unauthenticated: nothing to attribute
            return response

        bbox = _parse_bbox(request.query_params.get("bbox"))
        pool = self._pool_factory()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO access_audit (
                    subject_id, tenant_id, request_id, action, layer,
                    envelope, row_count, filters, status_code
                ) VALUES ($1, $2, $3, 'read', $4,
                          CASE WHEN $5::float8 IS NULL THEN NULL
                               ELSE ST_MakeEnvelope($5, $6, $7, $8, 4326) END,
                          $9, $10::jsonb, $11)
                """,
                subject,
                getattr(request.state, "tenant_id", None),
                uuid.UUID(request_id),
                request.url.path.strip("/").split("/")[-1],
                *(bbox or (None, None, None, None)),
                int(response.headers.get("x-result-count", 0) or 0),
                json.dumps({
                    k: v for k, v in request.query_params.items()
                    if k not in {"bbox", "token"}
                }),
                response.status_code,
            )

        response.headers["x-request-id"] = request_id
        response.headers["server-timing"] = f"app;dur={elapsed_ms:.1f}"
        return response


def _parse_bbox(raw: str | None) -> tuple[float, float, float, float] | None:
    if not raw:
        return None
    try:
        minx, miny, maxx, maxy = (round(float(v), COARSE_DP) for v in raw.split(","))
    except ValueError:
        return None
    return minx, miny, maxx, maxy
```

Two deliberate choices. The record is written *after* the response, so audit latency never appears in the client's timing, and the row count is taken from a response header the route sets. And the bounding box is rounded before storage — the trail knows the neighbourhood, not the doorstep.

### 4. Keep precise coordinates out of application logs

The audit table is access-controlled. The log pipeline usually is not. Redact at the formatter so no route has to remember.

```python
import logging
import re

COORD_RE = re.compile(r"(-?\d{1,3}\.\d{3})\d+")


class CoarsenCoordinates(logging.Filter):
    """Truncate any decimal degree in a log line to 3 dp (~110 m)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = COORD_RE.sub(r"\1", record.msg)
        if record.args:
            record.args = tuple(
                COORD_RE.sub(r"\1", a) if isinstance(a, str) else a for a in record.args
            )
        return True
```

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart showing how the identifying power of a coordinate falls as decimal places are removed, from a doorway at five places to a city district at two" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What each decimal place of a coordinate discloses</title>
  <desc>A scale from six decimal places to one. Six places is 0.11 metres and identifies a specific object; five places is 1.1 metres and identifies a doorway; four places is 11 metres and identifies a building; three places is 110 metres and identifies a block; two places is 1.1 kilometres and identifies a district; one place is 11 kilometres and identifies a city. A marker shows that logs should sit at three places or coarser and audit envelopes at two.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="28" font-size="12.5" font-weight="700" fill="currentColor">Decimal places versus what the number reveals</text>
  <rect x="24" y="46" width="104" height="60" rx="6" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="76" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">6 dp</text>
  <text x="76" y="82" text-anchor="middle" font-size="10" fill="currentColor">0.11 m</text>
  <text x="76" y="97" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">an object</text>
  <rect x="136" y="46" width="104" height="60" rx="6" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="188" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">5 dp</text>
  <text x="188" y="82" text-anchor="middle" font-size="10" fill="currentColor">1.1 m</text>
  <text x="188" y="97" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">a doorway</text>
  <rect x="248" y="46" width="104" height="60" rx="6" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="300" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">4 dp</text>
  <text x="300" y="82" text-anchor="middle" font-size="10" fill="currentColor">11 m</text>
  <text x="300" y="97" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">a building</text>
  <rect x="360" y="46" width="104" height="60" rx="6" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="412" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">3 dp</text>
  <text x="412" y="82" text-anchor="middle" font-size="10" fill="currentColor">110 m</text>
  <text x="412" y="97" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">a block</text>
  <rect x="472" y="46" width="104" height="60" rx="6" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="524" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">2 dp</text>
  <text x="524" y="82" text-anchor="middle" font-size="10" fill="currentColor">1.1 km</text>
  <text x="524" y="97" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">a district</text>
  <rect x="584" y="46" width="104" height="60" rx="6" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="636" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">1 dp</text>
  <text x="636" y="82" text-anchor="middle" font-size="10" fill="currentColor">11 km</text>
  <text x="636" y="97" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">a city</text>
  <line x1="24" y1="124" x2="688" y2="124" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="24" y="146" font-size="11" fill="currentColor">API response payloads</text>
  <rect x="248" y="134" width="216" height="16" rx="3" fill="var(--accent, #7c3aed)" opacity="0.45"/>
  <text x="472" y="146" font-size="10" fill="var(--muted, #7c6fb0)">4–6 dp, access-controlled</text>
  <text x="24" y="172" font-size="11" fill="currentColor">Application logs</text>
  <rect x="360" y="160" width="216" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.45"/>
  <text x="584" y="172" font-size="10" fill="var(--muted, #7c6fb0)">3 dp or coarser</text>
  <text x="24" y="198" font-size="11" fill="currentColor">Audit envelopes</text>
  <rect x="472" y="186" width="216" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.45"/>
  <text x="24" y="220" font-size="10.5" fill="var(--muted, #7c6fb0)">Distances are at the equator; a degree of longitude shortens with latitude, so these are upper bounds.</text>
</svg>

### 5. Know which questions the trail can answer

An audit design is only as good as the questions it can answer under pressure. Before shipping, write down the queries an incident will actually ask and check that each one is answerable from the columns you chose — most trails fail this test on the third or fourth question, and the missing column is usually the row count or the request id that ties an access back to a specific call.

The four questions below are the ones that come up in practice. Two are answered by the subject index, one by the spatial index on the envelope, and one only by having stored the row count. None of them need the returned geometry, which is the whole argument for not storing it.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Table mapping four incident questions to the audit columns and indexes that answer them" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Incident questions and the columns that answer them</title>
  <desc>Four questions with the audit column and index each depends on. Who read this address maps to the envelope column and its GiST index. What did this account access maps to subject id and the subject index. Was there a bulk extraction maps to row count and action, with no index needed. Which API call produced this maps to request id, joined to the trace. A footnote notes that none of the four require storing the returned geometry.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">What an investigation asks, and what answers it</text>
  <rect x="20" y="40" width="680" height="26" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="34" y="58" font-size="10.5" font-weight="700" fill="currentColor">Question</text>
  <text x="392" y="58" font-size="10.5" font-weight="700" fill="currentColor">Column</text>
  <text x="560" y="58" font-size="10.5" font-weight="700" fill="currentColor">Served by</text>
  <text x="34" y="88" font-size="10.5" fill="currentColor">“Who read anything near this address?”</text>
  <text x="392" y="88" font-size="10.5" font-family="monospace" fill="currentColor">envelope</text>
  <rect x="554" y="76" width="142" height="17" rx="3" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="625" y="89" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">GiST index</text>
  <line x1="20" y1="100" x2="700" y2="100" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="122" font-size="10.5" fill="currentColor">“What did this account touch last week?”</text>
  <text x="392" y="122" font-size="10.5" font-family="monospace" fill="currentColor">subject_id</text>
  <rect x="554" y="110" width="142" height="17" rx="3" fill="var(--viz-good-soft, #dff2e4)"/>
  <text x="625" y="123" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">btree index</text>
  <line x1="20" y1="134" x2="700" y2="134" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="156" font-size="10.5" fill="currentColor">“Was this a bulk extraction?”</text>
  <text x="392" y="156" font-size="10.5" font-family="monospace" fill="currentColor">row_count · action</text>
  <rect x="554" y="144" width="142" height="17" rx="3" fill="var(--surface-alt, #ede8f8)"/>
  <text x="625" y="157" text-anchor="middle" font-size="9.5" fill="currentColor">stored value</text>
  <line x1="20" y1="168" x2="700" y2="168" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="34" y="190" font-size="10.5" fill="currentColor">“Which API call produced this row?”</text>
  <text x="392" y="190" font-size="10.5" font-family="monospace" fill="currentColor">request_id</text>
  <rect x="554" y="178" width="142" height="17" rx="3" fill="var(--surface-alt, #ede8f8)"/>
  <text x="625" y="191" text-anchor="middle" font-size="9.5" fill="currentColor">join to the trace</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">None of the four needs the returned geometry — which is exactly why the trail should not hold it.</text>
</svg>

## Production Code Example

The query an investigation actually runs — everything read near a location in a window, grouped by who read it:

```sql
SELECT a.subject_id,
       count(*)                                   AS accesses,
       min(a.occurred_at)                         AS first_seen,
       max(a.occurred_at)                         AS last_seen,
       sum(a.row_count)                           AS rows_returned,
       array_agg(DISTINCT a.layer)                AS layers,
       -- How tightly the accesses cluster on the point of interest
       round(min(ST_Distance(
           ST_Centroid(a.envelope)::geography,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
       ))::numeric, 0)                            AS closest_m
FROM   access_audit a
WHERE  a.occurred_at >= $3
  AND  a.occurred_at <  $4
  AND  a.envelope && ST_Buffer(
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $5
       )::geometry
GROUP  BY a.subject_id
HAVING count(*) > 1
ORDER  BY accesses DESC
LIMIT  50;
```

Because the envelope is a real geometry with a GiST index, this runs in single-digit milliseconds over hundreds of millions of audit rows — the same index behaviour described in [Bounding Box & Spatial Index Queries](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/), applied to the trail rather than the data.

A second query worth having ready is the inverse: everything one subject touched, ordered by how unusual it was. Sorting by `row_count` descending surfaces bulk extractions immediately, and joining on `request_id` ties each access back to the trace captured by the [observability layer](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/), so an investigator can see the endpoint, the latency and the audit record as one story rather than three systems to reconcile.

## Verification & Testing

Test that the trail cannot be bypassed, not merely that it records.

```python
import pytest


@pytest.mark.asyncio
async def test_direct_sql_write_is_still_audited(db_conn):
    """A write that bypasses the API must still leave a record."""
    before = await db_conn.fetchval("SELECT count(*) FROM access_audit")
    await db_conn.execute(
        "INSERT INTO features (layer, geom) "
        "VALUES ('roads', ST_SetSRID(ST_MakePoint(-0.12, 51.50), 4326))"
    )
    after = await db_conn.fetchval("SELECT count(*) FROM access_audit")
    assert after == before + 1


@pytest.mark.asyncio
async def test_application_role_cannot_rewrite_history(api_conn):
    with pytest.raises(Exception) as exc:
        await api_conn.execute("DELETE FROM access_audit WHERE true")
    assert "permission denied" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_audit_envelope_is_coarsened(client, auth_headers):
    await client.get(
        "/v1/features",
        params={"bbox": "-0.127761,51.507351,-0.127700,51.507400"},
        headers=auth_headers,
    )
    row = await _latest_audit_row()
    # 2 dp rounding: the stored envelope must not resolve the original box
    assert abs(row["xmin"] - (-0.13)) < 1e-9
```

## Failure Modes & Edge Cases

1. **Audit writes inside the request transaction.** If the middleware's insert shares the transaction and the request later rolls back, the record disappears with it. Use a separate connection, as above, so an audited failure is still audited.
2. **`current_setting('app.subject_id')` unset.** With `SET LOCAL` on a pooled connection the setting is transaction-scoped; a trigger firing outside that transaction records `'system'`. Alert on the rate of `'system'` rows rather than ignoring them.
3. **The trail becomes the biggest table in the database.** At 1 200 reads per second the envelope-level trail grows roughly 30 GB a month. Partition from day one; retrofitting later means a full rewrite.
4. **`SECURITY DEFINER` without a fixed `search_path`.** A definer function is a privilege escalation path if a caller can shadow a table name. Always add `SET search_path = pg_catalog, public` to the function definition.
5. **Audit inserts contending on one index.** The `(subject_id, occurred_at DESC)` index becomes a hot spot when a handful of service accounts generate most traffic. Watch for index page contention and consider dropping to a BRIN index on `occurred_at` for the append-heavy partitions.
6. **Exports treated as ordinary reads.** A bulk export is qualitatively different from a map pan — record it with `action = 'export'` and a row count, and alert above a threshold. Bulk paths are described in [Async Bulk Uploads with Celery](https://www.geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) and deserve their own retention rules.
7. **Retention deleted by row.** A `DELETE FROM access_audit WHERE occurred_at < …` on an append-only table produces an enormous vacuum backlog. Detach and drop the partition instead.

## Performance Notes

An envelope-level audit insert costs 0.4–0.9 ms on a warm connection and runs off the response path, so client-visible latency is unchanged. The write trigger adds roughly 0.2 ms per mutated row — negligible for interactive writes, but material for bulk loads: a 500 000 row import produces 500 000 audit rows and doubles the load time. For bulk paths, disable the row trigger inside the load transaction and write one summary record instead.

Storage is the real cost. Measure it early with a projection rather than discovering it:

```sql
SELECT pg_size_pretty(pg_total_relation_size('access_audit')) AS total,
       count(*)                                              AS rows,
       pg_size_pretty(
         (pg_total_relation_size('access_audit') / GREATEST(count(*), 1))::bigint
       )                                                     AS per_row
FROM   access_audit;
```

Roughly 340 bytes per row including the three indexes is typical; the GIN index on `filters` is the largest single contributor, so drop it if nobody queries by filter.

---

## Related

- [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) — the isolation the audit trail is evidence for
- [Setting Tenant Context in asyncpg Connections](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/setting-tenant-context-in-asyncpg-connections/) — how identity reaches the session the trigger reads
- [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) — where the subject and scope come from
- [Table Partitioning for Large Spatial Datasets](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/) — making retention a detach rather than a delete
- [Rate Limiting Geofence & Tile Endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/) — throttling the enumeration patterns the trail exposes

← Back to [Securing Geospatial APIs](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/)
