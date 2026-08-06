---
layout: layouts/page.njk
title: "Prometheus Histograms for Spatial Endpoint Latency"
description: "Pick buckets from your real distribution, label by operation and magnitude instead of by route, and keep the series count fixed while a spatial API's traffic varies wildly."
slug: prometheus-histograms-for-spatial-endpoint-latency
type: howto
breadcrumb:
  - label: "Deploying and Operating Geospatial APIs"
    url: "/deploying-and-operating-geospatial-apis/"
  - label: "Observability for Spatial Endpoints"
    url: "/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/"
  - label: "Prometheus Histograms for Spatial Endpoint Latency"
    url: "/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/prometheus-histograms-for-spatial-endpoint-latency/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Prometheus Histograms for Spatial Endpoint Latency",
      "description": "Pick buckets from your real distribution and label by operation and magnitude instead of by route.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/prometheus-histograms-for-spatial-endpoint-latency/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Deploying and Operating Geospatial APIs", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/" },
        { "@type": "ListItem", "position": 2, "name": "Observability for Spatial Endpoints", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/" },
        { "@type": "ListItem", "position": 3, "name": "Prometheus Histograms for Spatial Endpoint Latency", "item": "https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/prometheus-histograms-for-spatial-endpoint-latency/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Design a Latency Histogram for a Spatial API",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Sample the real distribution", "text": "Collect a day of raw durations and place buckets where the mass actually is." },
        { "@type": "HowToStep", "position": 2, "name": "Bound every label", "text": "Use operation and a magnitude bucket; never a coordinate, a tile id or a tenant id." },
        { "@type": "HowToStep", "position": 3, "name": "Compute the series budget", "text": "Multiply every label's cardinality by the bucket count before shipping the metric." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is wrong with the default Prometheus buckets?",
          "acceptedAnswer": { "@type": "Answer", "text": "They span 5 milliseconds to 10 seconds with most resolution around half a second, which suits a generic web service. A spatial API's interesting range is usually 5 to 200 milliseconds for indexed queries with a slow trailing band past a second for large envelopes. With the defaults, every quantile below the ninetieth percentile falls into the same two buckets and reads as an identical number." }
        },
        {
          "@type": "Question",
          "name": "How many time series will one histogram create?",
          "acceptedAnswer": { "@type": "Answer", "text": "Buckets plus two, multiplied by the product of every label's cardinality. Eleven buckets with four operations, six magnitudes and three status classes is thirteen times seventy-two, or 936 series from one metric. That is comfortable. Adding a tenant label with two hundred values takes it to 187,200, which is not." }
        },
        {
          "@type": "Question",
          "name": "Should tile requests share a histogram with feature queries?",
          "acceptedAnswer": { "@type": "Answer", "text": "Same metric, different operation label. They have very different distributions, so mixing them into one aggregate is misleading, but keeping them as separate metrics means every dashboard and alert has to be written twice. The operation label gives separation where it matters and a shared definition everywhere else." }
        }
      ]
    }
  ]
}
</script>

← Back to [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/)

# Prometheus histograms for spatial endpoint latency

This page covers the two decisions that determine whether a latency histogram is useful on a spatial API: where the bucket boundaries sit, and which labels are allowed to exist.

## Context & When to Use

A histogram answers percentile questions by counting observations into fixed buckets. That makes the bucket boundaries the resolution limit of every answer it can give: `histogram_quantile` interpolates within a bucket, so if 80 % of your traffic lands between the 25 ms and 100 ms boundaries, every percentile in that range is an interpolation across a four-fold span and the numbers are close to fiction.

Spatial APIs make this worse than most, because their distribution is not merely skewed but genuinely bimodal — small-envelope requests served from an index and cache in single-digit milliseconds, large-envelope requests that legitimately take seconds. Default buckets place almost no boundaries in the first mode and far too many in the gap between the two.

The second decision, labels, is where spatial APIs go wrong in a more dangerous way. The natural things to label by — the bounding box, the tile coordinates, the tenant — are all unbounded, and a metric with unbounded labels is how a monitoring system runs out of memory. Bounded proxies exist for all of them, and the magnitude bucketing from [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) is the important one.

## Runnable Implementation

```python
from prometheus_client import Counter, Histogram

# Buckets chosen from a day of real durations, not from the library default.
# Dense through 5–250 ms where the indexed traffic lives, sparse in the tail.
SPATIAL_LATENCY = Histogram(
    "spatial_request_seconds",
    "End-to-end latency of a spatial request",
    labelnames=("operation", "magnitude", "status"),
    buckets=(
        0.005, 0.010, 0.020, 0.035, 0.050, 0.075,   # indexed reads
        0.100, 0.150, 0.250,                        # warm but working
        0.500, 1.0, 2.5, 5.0,                       # the honest tail
    ),
)

DB_LATENCY = Histogram(
    "spatial_db_seconds",
    "Time inside PostGIS, excluding pool wait and serialization",
    labelnames=("statement", "magnitude"),
    buckets=(0.002, 0.005, 0.010, 0.025, 0.050, 0.100, 0.250, 1.0, 3.0),
)

POOL_EXHAUSTED = Counter(
    "spatial_pool_exhausted_total",
    "Requests that waited more than 50 ms for a connection",
    labelnames=("operation",),
)

# Label allow-lists make the series budget a property of the code, not a hope.
OPERATIONS = frozenset({"bbox", "knn", "tile", "export", "other"})
MAGNITUDES = frozenset({"xs", "s", "m", "l", "xl", "na"})


def observe(operation: str, magnitude: str, status_code: int, seconds: float) -> None:
    """Record one request, coercing any unexpected label into a known bucket."""
    op = operation if operation in OPERATIONS else "other"
    mag = magnitude if magnitude in MAGNITUDES else "na"
    # Status CLASS, not code: 200 and 204 are the same story, 500 and 503 are not
    status = f"{status_code // 100}xx"
    SPATIAL_LATENCY.labels(operation=op, magnitude=mag, status=status).observe(seconds)
```

Coercing unknown values into `other` rather than passing them through is what keeps the series count fixed when someone adds a route and forgets to update the classifier.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of default and tuned bucket boundaries against the real latency distribution" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Bucket placement against the actual distribution</title>
  <desc>A latency distribution is drawn as a curve with most mass between 8 and 60 milliseconds and a long thin tail past 500. Below it, two rows of tick marks show bucket boundaries. The default Prometheus buckets place only two boundaries inside the main mode, so percentiles there are interpolated across a wide span. The tuned buckets place six boundaries inside the same range and fewer in the empty region, giving usable resolution exactly where the traffic is.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Put the boundaries where the observations are</text>
  <path d="M60 150 L90 148 L120 120 L150 74 L180 52 L210 66 L240 96 L280 122 L330 138 L400 146 L480 149 L560 150 L680 151 L680 150 L60 150 Z" fill="var(--accent, #7c3aed)" fill-opacity="0.14" stroke="var(--accent, #7c3aed)" stroke-width="2.2"/>
  <text x="180" y="42" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">where 84 % of requests land</text>
  <line x1="60" y1="150" x2="690" y2="150" stroke="currentColor" stroke-width="1.1"/>
  <text x="20" y="180" font-size="10.5" fill="currentColor">default</text>
  <line x1="96" y1="164" x2="96" y2="180" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6"/>
  <line x1="132" y1="164" x2="132" y2="180" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6"/>
  <line x1="290" y1="164" x2="290" y2="180" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6"/>
  <line x1="392" y1="164" x2="392" y2="180" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6"/>
  <line x1="470" y1="164" x2="470" y2="180" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6"/>
  <line x1="560" y1="164" x2="560" y2="180" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6"/>
  <line x1="640" y1="164" x2="640" y2="180" stroke="var(--viz-bad, #a32b23)" stroke-width="1.6"/>
  <text x="176" y="178" font-size="9.5" fill="var(--viz-bad, #a32b23)">two boundaries inside the mode → p50 ≈ p75 ≈ p90</text>
  <text x="20" y="212" font-size="10.5" fill="currentColor">tuned</text>
  <line x1="80" y1="196" x2="80" y2="212" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <line x1="108" y1="196" x2="108" y2="212" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <line x1="140" y1="196" x2="140" y2="212" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <line x1="170" y1="196" x2="170" y2="212" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <line x1="200" y1="196" x2="200" y2="212" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <line x1="240" y1="196" x2="240" y2="212" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <line x1="290" y1="196" x2="290" y2="212" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <line x1="360" y1="196" x2="360" y2="212" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <line x1="470" y1="196" x2="470" y2="212" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <line x1="600" y1="196" x2="600" y2="212" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.6"/>
  <text x="330" y="210" font-size="9.5" fill="var(--viz-good, #1f6b3a)">six inside the mode → every percentile distinguishable</text>
  <text x="66" y="234" font-size="9.5" fill="var(--muted, #7c6fb0)">5 ms</text>
  <text x="200" y="234" font-size="9.5" fill="var(--muted, #7c6fb0)">50 ms</text>
  <text x="380" y="234" font-size="9.5" fill="var(--muted, #7c6fb0)">250 ms</text>
  <text x="620" y="234" font-size="9.5" fill="var(--muted, #7c6fb0)">5 s</text>
</svg>

## Key Parameters & Options

| Decision | Recommended | Consequence if ignored |
|---|---|---|
| Bucket source | one day of real durations | Percentiles inside the main mode are interpolations |
| Bucket count | 10–14 | Each one multiplies the series count |
| `operation` label | 4–5 values, allow-listed | Mixed distributions make the aggregate meaningless |
| `magnitude` label | 6 values | Cannot tell "big request" from "broken request" |
| `status` label | class, not code | 20+ values instead of 5, for no extra insight |
| Forbidden labels | bbox, tile z/x/y, tenant, user | Unbounded series; the classic monitoring outage |

## Counting the series before shipping

The series budget is arithmetic, and it is worth doing before the metric reaches production rather than after the monitoring system falls over.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Series count for four label schemes, from a safe bounded design to an unbounded one" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Time series produced by each label scheme</title>
  <desc>Four label schemes with their resulting series counts on a logarithmic scale. Operation alone with thirteen buckets produces 65 series. Operation with magnitude produces 390. Operation, magnitude and status class produces 1170, marked as the recommended design. Adding a tenant label with two hundred values produces 234,000, marked as an outage. The chart makes clear that the first three are all comfortable and the fourth is categorically different.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Series count = (buckets + 2) × product of label cardinalities</text>
  <line x1="250" y1="44" x2="250" y2="176" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="400" y1="44" x2="400" y2="176" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="550" y1="44" x2="550" y2="176" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <line x1="690" y1="44" x2="690" y2="176" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="250" y="192" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">100</text>
  <text x="400" y="192" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">1 000</text>
  <text x="550" y="192" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">10 000</text>
  <text x="690" y="192" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">100 000+</text>
  <text x="20" y="62" font-size="10.5" font-family="monospace" fill="currentColor">operation</text>
  <rect x="180" y="50" width="55" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="243" y="63" font-size="10" fill="currentColor">65</text>
  <text x="20" y="98" font-size="10.5" font-family="monospace" fill="currentColor">+ magnitude</text>
  <rect x="180" y="86" width="152" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.7"/>
  <text x="340" y="99" font-size="10" fill="currentColor">390</text>
  <text x="20" y="134" font-size="10.5" font-family="monospace" fill="currentColor">+ status class</text>
  <rect x="180" y="122" width="228" height="16" rx="3" fill="var(--viz-good, #1f6b3a)" opacity="0.85"/>
  <text x="416" y="135" font-size="10" font-weight="700" fill="var(--viz-good, #1f6b3a)">1 170 — recommended</text>
  <text x="20" y="170" font-size="10.5" font-family="monospace" fill="currentColor">+ tenant (200)</text>
  <rect x="180" y="158" width="450" height="16" rx="3" fill="var(--viz-bad, #a32b23)" opacity="0.8"/>
  <text x="638" y="171" font-size="10" font-weight="700" fill="var(--viz-bad, #a32b23)">234 000</text>
  <text x="20" y="216" font-size="10.5" fill="var(--muted, #7c6fb0)">The first three differ by a factor of eighteen and all fit comfortably. The fourth is two hundred times the third</text>
  <text x="20" y="232" font-size="10.5" fill="var(--muted, #7c6fb0)">and grows every time a customer signs up — put tenant on a span, never on a metric.</text>
</svg>

## Reading the result

A histogram is only worth its storage if someone looks at it, and the panels worth building are the ones that answer a question you would otherwise have to guess at.

<svg viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four dashboard panels and the decision each supports" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The four panels worth building first</title>
  <desc>Four dashboard panels described with the decision each supports. p95 split by operation answers which workload regressed. p95 for the extra-small magnitude bucket answers whether small requests got slow, which is the real regression signal. The ratio of five hundred responses to total answers whether errors accompany the slowness. Pool exhaustion count answers whether the fix is database tuning or pool sizing. Each is annotated with the action it leads to.</desc>
  <rect x="0" y="0" width="720" height="230" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Build these four panels before any others</text>
  <rect x="16" y="42" width="336" height="76" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="30" y="64" font-size="10.5" font-weight="700" fill="currentColor">p95 by operation</text>
  <text x="30" y="82" font-size="9.5" fill="var(--muted, #7c6fb0)">"which workload regressed?"</text>
  <text x="30" y="100" font-size="9.5" fill="currentColor">→ narrows the search to one query shape</text>
  <rect x="368" y="42" width="336" height="76" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="382" y="64" font-size="10.5" font-weight="700" fill="currentColor">p95 where magnitude = xs</text>
  <text x="382" y="82" font-size="9.5" fill="var(--muted, #7c6fb0)">"did SMALL requests get slow?"</text>
  <text x="382" y="100" font-size="9.5" fill="currentColor">→ the single best regression signal</text>
  <rect x="16" y="126" width="336" height="76" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="30" y="148" font-size="10.5" font-weight="700" fill="currentColor">rate of status = 5xx</text>
  <text x="30" y="166" font-size="9.5" fill="var(--muted, #7c6fb0)">"is it failing as well as slow?"</text>
  <text x="30" y="184" font-size="9.5" fill="currentColor">→ separates saturation from a bad deploy</text>
  <rect x="368" y="126" width="336" height="76" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="currentColor" stroke-width="1.2"/>
  <text x="382" y="148" font-size="10.5" font-weight="700" fill="currentColor">pool exhaustion count</text>
  <text x="382" y="166" font-size="9.5" fill="var(--muted, #7c6fb0)">"is the database even the problem?"</text>
  <text x="382" y="184" font-size="9.5" fill="currentColor">→ decides tuning versus pool sizing</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">Each panel maps to a different first action, which is what makes it worth a place on the wall.</text>
</svg>

## Deriving your own bucket boundaries

The buckets above suit the workload they were measured on. Yours will differ, and the derivation takes about ten minutes: log raw durations for a day, then place boundaries at the deciles of the observed distribution, rounding to friendly numbers.

```python
import numpy as np

durations = np.loadtxt("durations_one_day.txt")       # seconds, one per line
deciles = np.percentile(durations, [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99])
print([round(float(d), 3) for d in deciles])
# [0.006, 0.009, 0.013, 0.018, 0.024, 0.033, 0.048, 0.079, 0.186, 0.42, 2.31]
```

Round those to the nearest sensible value, add one boundary below the fastest observation and one above the slowest you care about, and stop. Ten to fourteen boundaries is the practical range: fewer and the percentiles blur, more and you are paying series count for resolution nobody reads. Re-derive after any change that shifts the distribution — a new index, a caching layer, a partitioning change — because buckets tuned to the old shape quietly stop resolving the new one.

## Gotchas & Failure Modes

- **Measuring only successful requests.** A `try/except` that observes on the happy path only removes exactly the slow, failing requests from the percentile. Observe in a `finally`.
- **`histogram_quantile` over a counter that reset.** Use `rate()` over the bucket counters, not the raw values, or a process restart produces a nonsensical spike.
- **One dashboard panel for all operations.** The aggregate p95 is dominated by whichever operation is most frequent. Break out by `operation` in every panel that matters.
- **Buckets changed in place.** Editing bucket boundaries makes historical data incomparable; the old series keep their old boundaries. Version the metric name if the change is significant.
- **`le` labels drifting between instances.** Every replica must use identical bucket definitions, or aggregation across them silently drops observations. Define the buckets in one module.
- **Exposing `/metrics` publicly.** It reveals route names, traffic volume and error rates. Bind it internally, as noted in [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/).

## Verification Snippet

```python
from prometheus_client import REGISTRY


def test_series_budget_is_bounded(client, auth_headers):
    for bbox in ("-0.1,51.5,-0.09,51.51", "-10,40,10,60", "-180,-85,180,85"):
        for path in ("/v1/features", "/v1/nearest", "/v1/tiles/12/2048/1361.mvt"):
            client.get(path, params={"bbox": bbox}, headers=auth_headers)

    samples = [s for m in REGISTRY.collect()
               if m.name == "spatial_request_seconds" for s in m.samples]
    labels = {(s.labels.get("operation"), s.labels.get("magnitude"),
               s.labels.get("status")) for s in samples}
    assert len(labels) <= 5 * 6 * 5          # the declared budget
    assert all(o in OPERATIONS for o, _, _ in labels)
```

```promql
# p95 per operation — the panel that should exist before any other
histogram_quantile(0.95,
  sum by (le, operation) (rate(spatial_request_seconds_bucket[5m])))

# Small requests that got slow: the alert that catches real regressions
histogram_quantile(0.95,
  sum by (le) (rate(spatial_request_seconds_bucket{magnitude="xs"}[5m]))) > 0.1
```

---

## Related

- [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/) — the signal design these metrics implement
- [Instrumenting asyncpg Queries with OpenTelemetry](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/instrumenting-asyncpg-queries-with-opentelemetry/) — where high-cardinality context belongs instead
- [Cost-Based Throttling for Expensive PostGIS Queries](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/cost-based-throttling-for-expensive-postgis-queries/) — the same magnitude estimate, used to charge rather than to measure

← Back to [Observability for Spatial Endpoints](https://www.geospatial-api.com/deploying-and-operating-geospatial-apis/observability-for-spatial-endpoints/)
