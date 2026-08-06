---
layout: layouts/page.njk
title: "Redacting Coordinate Precision in Application Logs"
description: "Log lines leave the database's access controls behind. Truncate decimal degrees at the formatter, keep the request id, and stay debuggable without shipping doorstep coordinates to a log aggregator."
slug: redacting-coordinate-precision-in-application-logs
type: howto
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "Audit Logging for Location Data Access"
    url: "/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/"
  - label: "Redacting Coordinate Precision in Application Logs"
    url: "/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/redacting-coordinate-precision-in-application-logs/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Redacting Coordinate Precision in Application Logs",
      "description": "Truncate decimal degrees at the log formatter so debugging stays possible without shipping doorstep coordinates to a log aggregator.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/redacting-coordinate-precision-in-application-logs/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/" },
        { "@type": "ListItem", "position": 2, "name": "Audit Logging for Location Data Access", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/" },
        { "@type": "ListItem", "position": 3, "name": "Redacting Coordinate Precision in Application Logs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/redacting-coordinate-precision-in-application-logs/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Coarsen Coordinates in Application Logs",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Redact at the formatter", "text": "Apply the truncation in a logging filter so no call site has to remember, including third-party libraries." },
        { "@type": "HowToStep", "position": 2, "name": "Keep the correlation id", "text": "Replace precision with a request id that ties the line back to the access-controlled audit record." },
        { "@type": "HowToStep", "position": 3, "name": "Cover the indirect paths", "text": "Redact exception messages, SQL echoes and traces too, since those carry coordinates nobody chose to log." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Is truncating a coordinate the same as anonymising it?",
          "acceptedAnswer": { "@type": "Answer", "text": "No. Truncation reduces resolution; it does not break the link to a subject. A trail of 3-decimal-place points still describes a commute, and enough coarse points identify a home and a workplace. Treat coarsening as damage limitation for a log pipeline, not as anonymisation, and keep the access controls on the audit trail itself." }
        },
        {
          "@type": "Question",
          "name": "Where should redaction live — the formatter or the call site?",
          "acceptedAnswer": { "@type": "Answer", "text": "The formatter. A call-site convention holds only until someone adds a log line in a hurry or a dependency logs a request URL for you. A logging filter applies to every record, including ones emitted by libraries you did not write, which is exactly where the leaks come from." }
        },
        {
          "@type": "Question",
          "name": "Does redaction make production debugging impossible?",
          "acceptedAnswer": { "@type": "Answer", "text": "Not if the request id survives. Three decimal places is enough to see which region a request concerned, and the request id lets an authorised investigator pull the exact envelope from the audit table. The log answers what happened; the audit trail answers exactly where, under access control." }
        }
      ]
    }
  ]
}
</script>

← Back to [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/)

# Redacting coordinate precision in application logs

This page shows how to strip identifying precision from coordinates in log output without losing the ability to debug, by truncating at the logging formatter and keeping a correlation id that points back into the access-controlled audit trail.

## Context & When to Use

The database that holds location data usually has careful access control: roles, row-level security, an audit trail. The log pipeline that sits beside it usually does not. Logs are shipped to an aggregator that half the engineering organisation can search, retained for a year, replicated to a backup region, and occasionally exported to a spreadsheet during an incident. A coordinate at six decimal places in a log line has effectively left the security boundary the database spent so much effort establishing.

This is not hypothetical leakage through some exotic channel. It happens through the most ordinary paths: a debug line that prints the request parameters, an exception message that includes the SQL that failed, an access log that records the full query string, a trace span that captures the URL. None of those were written by someone deciding to log a location; the location arrived as a side effect.

The fix is to make coarsening structural. Apply it in the logging configuration where it covers every record, including ones emitted by libraries, and pair it with a request id so an authorised investigator can still recover the precise envelope from the audit table described in [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/).

## Runnable Implementation

```python
import logging
import re
from typing import Any

# Matches a decimal degree with more than three fractional digits, in any
# surrounding text: query strings, WKT, JSON, exception messages.
COORD_RE = re.compile(r"(-?(?:1[0-7]\d|\d{1,2})\.\d{3})\d+")
REDACTED_DP = 3   # ~110 m at the equator


def coarsen(text: str) -> str:
    """Truncate every decimal degree in a string to REDACTED_DP places."""
    return COORD_RE.sub(r"\1", text)


class CoarsenCoordinates(logging.Filter):
    """Apply coarsening to the message, its args, and any exception text.

    Installed as a filter rather than a formatter so it runs for records from
    third-party libraries too — which is where the accidental leaks live.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = coarsen(record.msg)

        if record.args:
            if isinstance(record.args, dict):
                record.args = {k: coarsen(v) if isinstance(v, str) else v
                               for k, v in record.args.items()}
            else:
                record.args = tuple(coarsen(a) if isinstance(a, str) else a
                                    for a in record.args)

        # Exception text is the most common accidental carrier
        if record.exc_info and record.exc_info[1]:
            exc = record.exc_info[1]
            if exc.args and isinstance(exc.args[0], str):
                exc.args = (coarsen(exc.args[0]),) + exc.args[1:]
        return True


LOGGING: dict[str, Any] = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"coarsen_coords": {"()": CoarsenCoordinates}},
    "formatters": {
        "json": {"format": '{"t":"%(asctime)s","lvl":"%(levelname)s",'
                           '"req":"%(request_id)s","msg":"%(message)s"}'},
    },
    "handlers": {
        "stdout": {
            "class": "logging.StreamHandler",
            "formatter": "json",
            # The filter goes on the HANDLER so every logger inherits it
            "filters": ["coarsen_coords"],
        },
    },
    "root": {"handlers": ["stdout"], "level": "INFO"},
}
```

Attaching the filter to the *handler* rather than to individual loggers is the detail that makes it comprehensive: every record that reaches stdout passes through it, whatever emitted it.

<svg viewBox="0 0 720 270" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram of the paths coordinates take into logs, all converging on a single handler-level filter before leaving the process" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Every path into the log passes one filter</title>
  <desc>Five sources emit log records containing coordinates: an application debug line, an access log recording the query string, a database driver echoing failed SQL, an exception message, and a trace exporter capturing the request URL. All five converge on a handler-level filter that truncates decimal degrees to three places. Only after that do records reach stdout and the log aggregator. A note marks that the audit table is a separate path which deliberately keeps full precision under access control.</desc>
  <rect x="0" y="0" width="720" height="270" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Coordinates reach the log through five doors, not one</text>
  <rect x="16" y="42" width="180" height="28" rx="5" fill="none" stroke="currentColor" stroke-width="1.1"/>
  <text x="28" y="61" font-size="10" fill="currentColor">app debug line</text>
  <rect x="16" y="76" width="180" height="28" rx="5" fill="none" stroke="currentColor" stroke-width="1.1"/>
  <text x="28" y="95" font-size="10" fill="currentColor">access log — query string</text>
  <rect x="16" y="110" width="180" height="28" rx="5" fill="none" stroke="currentColor" stroke-width="1.1"/>
  <text x="28" y="129" font-size="10" fill="currentColor">driver echo — failed SQL</text>
  <rect x="16" y="144" width="180" height="28" rx="5" fill="none" stroke="currentColor" stroke-width="1.1"/>
  <text x="28" y="163" font-size="10" fill="currentColor">exception message</text>
  <rect x="16" y="178" width="180" height="28" rx="5" fill="none" stroke="currentColor" stroke-width="1.1"/>
  <text x="28" y="197" font-size="10" fill="currentColor">trace exporter — URL</text>
  <path d="M196 56 L250 108" stroke="currentColor" stroke-width="1.2" marker-end="url(#rdArr)"/>
  <path d="M196 90 L250 114" stroke="currentColor" stroke-width="1.2" marker-end="url(#rdArr)"/>
  <path d="M196 124 L250 122" stroke="currentColor" stroke-width="1.2" marker-end="url(#rdArr)"/>
  <path d="M196 158 L250 130" stroke="currentColor" stroke-width="1.2" marker-end="url(#rdArr)"/>
  <path d="M196 192 L250 138" stroke="currentColor" stroke-width="1.2" marker-end="url(#rdArr)"/>
  <rect x="252" y="94" width="166" height="60" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.8"/>
  <text x="335" y="118" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">handler filter</text>
  <text x="335" y="134" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">truncate to 3 dp</text>
  <text x="335" y="147" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">one place, no exceptions</text>
  <path d="M418 124 L466 124" stroke="currentColor" stroke-width="1.4" marker-end="url(#rdArr)"/>
  <rect x="468" y="96" width="230" height="56" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="583" y="118" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">stdout → aggregator</text>
  <text x="583" y="134" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">≈110 m resolution · broad access</text>
  <text x="583" y="146" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">request id preserved</text>
  <rect x="468" y="176" width="230" height="56" rx="8" fill="none" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4" stroke-dasharray="5,3"/>
  <text x="583" y="198" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">access_audit table</text>
  <text x="583" y="214" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">full envelope · role-restricted</text>
  <text x="583" y="226" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">joined by request id</text>
  <path d="M335 154 L335 204 L466 204" stroke="var(--viz-warn, #8a5000)" stroke-width="1.3" fill="none" stroke-dasharray="5,3" marker-end="url(#rdArrW)"/>
  <text x="20" y="256" font-size="10.5" fill="var(--muted, #7c6fb0)">The two destinations have different audiences, so they get different precision. The request id is what joins them.</text>
  <defs>
    <marker id="rdArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
    <marker id="rdArrW" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="var(--viz-warn, #8a5000)"/></marker>
  </defs>
</svg>

## Key Parameters & Options

| Choice | Value | Effect |
|---|---|---|
| `REDACTED_DP` | 3 | ~110 m; keeps regional context, loses the building |
| Filter placement | on the handler | Covers third-party loggers; a logger-level filter does not |
| Regex bound | `-?(1[0-7]\d|\d{1,2})\.\d{3}` | Restricts to plausible degree ranges, so version strings and ids survive |
| Exception rewriting | on | The most common accidental carrier |
| Request id | always logged | The only bridge back to full precision |
| Projected coordinates | separate rule | Eastings are 6-digit integers; a degree regex will not match them |

That last row matters if any part of the stack speaks a national grid. A British National Grid easting like `530034.271` is not a decimal degree and passes the filter untouched, while being just as identifying — add a second pattern for the projected systems your API accepts, using the ranges from [Handling Mixed SRID Inputs from Legacy Clients](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/coordinate-reference-systems-and-srid-handling/handling-mixed-srid-inputs-from-legacy-clients/).

## What each level of redaction still leaks

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart of re-identification risk against log usefulness for four redaction levels" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Re-identification risk versus debugging usefulness</title>
  <desc>Four redaction levels plotted on two measures. No redaction at six decimal places scores maximum on both risk and usefulness. Four decimal places, about eleven metres, still identifies a building and remains high risk. Three decimal places, about 110 metres, drops risk substantially while keeping enough context to identify the region a request concerned. Dropping coordinates entirely removes all risk but also removes the ability to tell which area a bug affected, which is why three places is marked as the recommended setting.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Choosing the level: risk against usefulness</text>
  <rect x="470" y="14" width="12" height="12" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <text x="488" y="25" font-size="10" fill="currentColor">re-identification risk</text>
  <rect x="610" y="14" width="12" height="12" rx="2" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="628" y="25" font-size="10" fill="currentColor">debug value</text>
  <text x="20" y="62" font-size="10.5" fill="currentColor">6 dp — no redaction</text>
  <rect x="190" y="46" width="460" height="14" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <rect x="190" y="62" width="470" height="14" rx="3" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="600" y="42" font-size="9.5" fill="var(--viz-bad, #a32b23)">identifies a person</text>
  <text x="20" y="112" font-size="10.5" fill="currentColor">4 dp — ~11 m</text>
  <rect x="190" y="96" width="390" height="14" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <rect x="190" y="112" width="450" height="14" rx="3" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="592" y="108" font-size="9.5" fill="var(--viz-bad, #a32b23)">identifies a building</text>
  <text x="20" y="162" font-size="10.5" font-weight="700" fill="currentColor">3 dp — ~110 m</text>
  <rect x="190" y="146" width="120" height="14" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <rect x="190" y="162" width="380" height="14" rx="3" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="322" y="158" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">recommended — a block, not a door</text>
  <text x="20" y="212" font-size="10.5" fill="currentColor">dropped entirely</text>
  <rect x="190" y="196" width="6" height="14" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <rect x="190" y="212" width="70" height="14" rx="3" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="272" y="223" font-size="9.5" fill="var(--muted, #7c6fb0)">cannot tell which region a bug affected</text>
</svg>

Three places is the knee of the curve: risk falls off sharply between four and three, while debugging value barely moves until coordinates disappear altogether.

## Gotchas & Failure Modes

- **Structured logging that bypasses the message.** If coordinates are passed as structured fields rather than inside the message string, a filter that only rewrites `record.msg` misses them. Extend the filter to walk `record.__dict__` for known field names, or normalise all logging through one helper.
- **The regex matching version numbers.** An unbounded `\d+\.\d+` pattern will happily truncate `PostGIS 3.3.4` and timing values like `1247.891`. Bounding the integer part to plausible degree ranges, as above, avoids most of it; test against a corpus of real log lines.
- **Coordinates arriving base64-encoded.** A cursor token or a WKB hex string carries a location the regex cannot see. Redact those by field name rather than by pattern — see [Implementing Cursor-Based Pagination for Spatial Queries](https://www.geospatial-api.com/core-geospatial-api-architecture-with-fastapi-postgis/spatial-pagination-cursor-strategies/implementing-cursor-based-pagination-for-spatial-queries/) for what a cursor typically contains.
- **Redaction applied only in production.** A developer copying a staging log into a ticket leaks the same data. Apply the filter in every environment; a debugging session that needs full precision should query the audit table.
- **Losing the request id.** Coarsening without a correlation id makes logs both private and useless. The id is what preserves the investigative path.
- **Assuming coarsening is anonymisation.** A sequence of 110-metre points still traces a route. Coarsening limits blast radius; it does not make the data non-personal.

## Keeping the investigative path open

Redaction is only acceptable because there is somewhere else to look. The request id printed on every log line is what turns a coarse log entry back into a precise answer, for the small number of people authorised to ask.

The workflow in practice: an engineer sees an error in the aggregator, notes the request id, and — if the investigation genuinely needs the exact area — an authorised colleague queries the audit table for that id. The engineer gets the diagnosis; the precise envelope never leaves the database. That split is the whole point, and it fails only if the id is dropped somewhere along the chain.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sequence showing an engineer using a coarse log line and its request id to obtain the precise envelope from the access-controlled audit table" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>From a coarse log line to the precise record</title>
  <desc>Four steps left to right. An error appears in the log aggregator at 110 metre resolution, carrying a request id. Any engineer can read it. The engineer opens the trace by that id and sees the operation, magnitude bucket and timing, still without precise coordinates. If the exact area is genuinely needed, an authorised role queries the audit table by the same id and receives the full envelope. A note records that steps one and two need no special access and answer most questions on their own.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One id, three levels of access</text>
  <rect x="16" y="48" width="168" height="84" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="100" y="70" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">1 · log aggregator</text>
  <text x="100" y="88" text-anchor="middle" font-size="9.5" fill="currentColor">bbox=-0.127,51.507</text>
  <text x="100" y="103" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">≈110 m · req=9f3a…</text>
  <text x="100" y="122" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">everyone</text>
  <path d="M184 90 L212 90" stroke="currentColor" stroke-width="1.4" marker-end="url(#rpArr)"/>
  <rect x="214" y="48" width="180" height="84" rx="8" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <text x="304" y="70" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">2 · trace by id</text>
  <text x="304" y="88" text-anchor="middle" font-size="9.5" fill="currentColor">operation · magnitude · timing</text>
  <text x="304" y="103" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">no coordinates at all</text>
  <text x="304" y="122" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">everyone</text>
  <path d="M394 90 L422 90" stroke="currentColor" stroke-width="1.4" marker-end="url(#rpArr)"/>
  <rect x="424" y="48" width="278" height="84" rx="8" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.5"/>
  <text x="563" y="70" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">3 · access_audit by request_id</text>
  <text x="563" y="88" text-anchor="middle" font-size="9.5" fill="currentColor">exact envelope · subject · row count</text>
  <text x="563" y="103" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">and the lookup is itself audited</text>
  <text x="563" y="122" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-warn, #8a5000)">auditor role only</text>
  <line x1="16" y1="152" x2="704" y2="152" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="176" font-size="10.5" fill="currentColor">Roughly 90 % of production questions are answered at step 1 or 2 — "which region, how big, how slow".</text>
  <text x="20" y="194" font-size="10.5" fill="currentColor">Step 3 exists for the rest, and every use of it leaves its own record.</text>
  <text x="20" y="218" font-size="10.5" fill="var(--muted, #7c6fb0)">Drop the request id and the ladder collapses: the logs become both private and useless at the same time.</text>
  <defs>
    <marker id="rpArr" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker>
  </defs>
</svg>

## Verification Snippet

```python
import logging

def test_filter_coarsens_every_carrier(caplog):
    logging.getLogger().addFilter(CoarsenCoordinates())

    logging.info("bbox=-0.127761,51.507351,-0.127700,51.507400")
    logging.info("query %s", "POINT(-0.127761 51.507351)")
    try:
        raise ValueError("no feature at -0.127761, 51.507351")
    except ValueError:
        logging.exception("lookup failed")

    text = caplog.text
    assert "-0.127761" not in text
    assert "-0.127" in text          # coarse value survives
    assert "51.507" in text
    assert "PostGIS 3.3.4" == coarsen("PostGIS 3.3.4")   # version untouched
```

```bash
# Belt and braces: scan shipped logs for anything with 4+ decimal places
grep -REn '(-?[0-9]{1,3}\.[0-9]{4,})' /var/log/api/*.log | head
# (no output expected)
```

---

## Related

- [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/) — where full precision is kept, under access control
- [JWT Authentication for Spatial Scopes](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/) — the subject identifier that accompanies the request id
- [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) — trace attributes have the same exposure question

← Back to [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/)
