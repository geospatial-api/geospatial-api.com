---
layout: layouts/page.njk
title: "Detecting Geofence Enumeration in the Audit Trail"
description: "Spot an account sweeping your coverage area one bounding box at a time: tiling-pattern queries over the audit envelopes, coverage ratios, and thresholds that ignore ordinary map panning."
slug: detecting-geofence-enumeration-in-the-audit-trail
type: howto
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "Audit Logging for Location Data Access"
    url: "/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/"
  - label: "Detecting Geofence Enumeration in the Audit Trail"
    url: "/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/detecting-geofence-enumeration-in-the-audit-trail/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Detecting Geofence Enumeration in the Audit Trail",
      "description": "Spot an account sweeping a coverage area one bounding box at a time, using coverage ratios over the audit envelopes.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/detecting-geofence-enumeration-in-the-audit-trail/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/" },
        { "@type": "ListItem", "position": 2, "name": "Audit Logging for Location Data Access", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/" },
        { "@type": "ListItem", "position": 3, "name": "Detecting Geofence Enumeration in the Audit Trail", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/detecting-geofence-enumeration-in-the-audit-trail/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Detect Systematic Area Sweeping by an API Client",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Union the envelopes", "text": "Aggregate each subject's audit envelopes over a window into a single coverage geometry." },
        { "@type": "HowToStep", "position": 2, "name": "Compare coverage to overlap", "text": "A sweeper covers a large area with little repetition; a human panning a map revisits the same ground constantly." },
        { "@type": "HowToStep", "position": 3, "name": "Rank and alert", "text": "Score subjects by coverage area divided by request count and alert on the outliers, not on raw volume." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why is request volume a poor signal for enumeration?",
          "acceptedAnswer": { "@type": "Answer", "text": "A busy dispatcher panning a live map generates far more requests than a patient scraper walking a grid once an hour. Volume ranks the legitimate heavy user first and the sweeper somewhere in the middle. What distinguishes them is repetition: the dispatcher revisits the same few square kilometres all day, while the sweeper almost never asks about the same area twice." }
        },
        {
          "@type": "Question",
          "name": "What does a healthy coverage ratio look like?",
          "acceptedAnswer": { "@type": "Answer", "text": "For interactive map users, the unioned area is typically a small multiple of a single viewport, no matter how many requests they make — a ratio well under one square kilometre per request. Systematic sweepers approach the area of one full viewport per request, because each request covers new ground. The gap between the two populations is usually more than an order of magnitude." }
        },
        {
          "@type": "Question",
          "name": "Should detection block automatically?",
          "acceptedAnswer": { "@type": "Answer", "text": "Rate-limit automatically, block manually. A high coverage ratio is also the signature of a legitimate bulk export or a newly onboarded analytics integration, so an automatic block will eventually cut off a paying customer at an awkward moment. Throttling degrades the sweep to an uninteresting speed and gives a human time to look." }
        }
      ]
    }
  ]
}
</script>

← Back to [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/)

# Detecting geofence enumeration in the audit trail

This page shows how to find the account that is quietly rebuilding your dataset one bounding box at a time, using nothing but the envelopes already recorded in the audit table.

## Context & When to Use

Rate limiting stops the crude version of scraping. It does not stop the patient version: a client that requests one viewport-sized box every four seconds, stays comfortably inside every quota, and after a fortnight has retrieved every feature you have. Each individual request is indistinguishable from a legitimate map pan. What gives it away is the *shape of the sequence* — a sweep covers new ground on almost every call, while a human revisits the same few square kilometres over and over.

Because the audit trail stores each access as a geometry rather than a log line, that shape is directly queryable. Union a subject's envelopes over a window and you have their coverage; divide coverage by request count and you have a ratio that separates the two behaviours cleanly. The trail design this depends on is described in [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/), and the throttle you reach for once a sweeper is found is in [Rate Limiting Geofence & Tile Endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/).

Run this as a scheduled report rather than in the request path. It is a detection control, not a gate, and it should be looking at hours of history rather than the last five seconds.

## Runnable Implementation

```sql
-- Coverage report: which subjects covered the most NEW ground per request?
WITH window_access AS (
    SELECT subject_id,
           envelope,
           row_count
    FROM   access_audit
    WHERE  occurred_at >= now() - interval '24 hours'
      AND  action = 'read'
      AND  envelope IS NOT NULL
),
coverage AS (
    SELECT subject_id,
           count(*)                                       AS requests,
           sum(row_count)                                 AS rows_returned,
           -- Total area asked for, counting overlaps repeatedly
           sum(ST_Area(envelope::geography)) / 1e6        AS requested_km2,
           -- Distinct ground actually covered, overlaps collapsed
           ST_Area(ST_Union(envelope)::geography) / 1e6   AS covered_km2
    FROM   window_access
    GROUP  BY subject_id
    HAVING count(*) >= 50            -- ignore casual traffic entirely
)
SELECT subject_id,
       requests,
       rows_returned,
       round(covered_km2::numeric, 1)                            AS covered_km2,
       round((covered_km2 / requests)::numeric, 3)               AS km2_per_request,
       -- 1.0 means every request was new ground; 0.05 means heavy revisiting
       round((covered_km2 / NULLIF(requested_km2, 0))::numeric, 3) AS novelty
FROM   coverage
ORDER  BY novelty DESC, covered_km2 DESC
LIMIT  25;
```

`novelty` is the discriminating column. It is the ratio of distinct ground covered to ground requested: a client that never repeats itself scores close to 1.0, while one that pans around a neighbourhood all day scores under 0.1 because its envelopes pile up on the same ground.

<svg viewBox="0 0 720 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two maps of accumulated request envelopes, one showing a dispatcher's overlapping cluster and one showing a sweeper's regular grid" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>What 400 requests look like from each kind of client</title>
  <desc>Two panels showing accumulated request envelopes over 24 hours. On the left, a dispatcher made 412 requests whose envelopes pile up on one another around a depot, covering 31 square kilometres in total with a novelty score of 0.06. On the right, a sweeper made 398 requests laid out as a regular non-overlapping grid, covering 2840 square kilometres with a novelty score of 0.98. The shapes are immediately distinguishable even before any number is computed.</desc>
  <rect x="0" y="0" width="720" height="280" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Same request count, opposite shapes</text>
  <text x="180" y="52" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good, #1f6b3a)">dispatcher · 412 requests</text>
  <rect x="40" y="62" width="280" height="150" rx="6" fill="none" stroke="currentColor" stroke-width="1" opacity="0.35"/>
  <rect x="132" y="108" width="72" height="48" rx="2" fill="var(--accent, #7c3aed)" fill-opacity="0.16" stroke="var(--accent, #7c3aed)" stroke-width="0.8"/>
  <rect x="140" y="100" width="72" height="48" rx="2" fill="var(--accent, #7c3aed)" fill-opacity="0.16" stroke="var(--accent, #7c3aed)" stroke-width="0.8"/>
  <rect x="126" y="118" width="72" height="48" rx="2" fill="var(--accent, #7c3aed)" fill-opacity="0.16" stroke="var(--accent, #7c3aed)" stroke-width="0.8"/>
  <rect x="148" y="112" width="72" height="48" rx="2" fill="var(--accent, #7c3aed)" fill-opacity="0.16" stroke="var(--accent, #7c3aed)" stroke-width="0.8"/>
  <rect x="120" y="98" width="72" height="48" rx="2" fill="var(--accent, #7c3aed)" fill-opacity="0.16" stroke="var(--accent, #7c3aed)" stroke-width="0.8"/>
  <rect x="156" y="122" width="72" height="48" rx="2" fill="var(--accent, #7c3aed)" fill-opacity="0.16" stroke="var(--accent, #7c3aed)" stroke-width="0.8"/>
  <rect x="112" y="126" width="72" height="48" rx="2" fill="var(--accent, #7c3aed)" fill-opacity="0.16" stroke="var(--accent, #7c3aed)" stroke-width="0.8"/>
  <text x="180" y="232" text-anchor="middle" font-size="10.5" fill="currentColor">covered 31 km² · novelty <tspan font-weight="700">0.06</tspan></text>
  <text x="180" y="250" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">the same depot, all day</text>
  <text x="540" y="52" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-bad, #a32b23)">sweeper · 398 requests</text>
  <rect x="400" y="62" width="280" height="150" rx="6" fill="none" stroke="currentColor" stroke-width="1" opacity="0.35"/>
  <rect x="410" y="70" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="464" y="70" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="518" y="70" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="572" y="70" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="626" y="70" width="44" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="410" y="104" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="464" y="104" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="518" y="104" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="572" y="104" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="626" y="104" width="44" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="410" y="138" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="464" y="138" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="518" y="138" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="572" y="138" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="410" y="172" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="464" y="172" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <rect x="518" y="172" width="52" height="32" rx="2" fill="var(--viz-bad, #a32b23)" fill-opacity="0.14" stroke="var(--viz-bad, #a32b23)" stroke-width="0.8"/>
  <text x="540" y="232" text-anchor="middle" font-size="10.5" fill="currentColor">covered 2 840 km² · novelty <tspan font-weight="700">0.98</tspan></text>
  <text x="540" y="250" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">never the same ground twice</text>
  <text x="20" y="272" font-size="10.5" fill="var(--muted, #7c6fb0)">Request volume ranks these two identically. Coverage novelty separates them by a factor of sixteen.</text>
</svg>

## Key Parameters & Options

| Parameter | Suggested | Notes |
|---|---|---|
| Window | 24 h | Long enough to see a slow sweep; short enough to run cheaply |
| `HAVING count(*) >= 50` | 50 | Removes the trailing mass of casual users before the expensive union |
| `novelty` alert threshold | > 0.7 | Ordinary interactive use rarely exceeds 0.3 |
| `covered_km2` floor | > 100 km² | Prevents a handful of scattered lookups from scoring high |
| Grouping key | `subject_id` | Add `ip_hash` as a secondary key to catch credential sharing |
| Schedule | hourly | Detection, not enforcement — never in the request path |

## From detection to response

Finding a sweeper is the easy half. The response should be graduated, because the same signature is produced by a legitimate bulk consumer who simply picked the wrong endpoint for the job.

<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Escalation ladder from observation through throttling and contact to suspension, with the reversibility of each step marked" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Graduated response to a high coverage score</title>
  <desc>Four escalating responses. Observation adds the subject to a watch list and is fully reversible with no customer impact. Throttling applies a cost-based rate limit, is reversible, and slows the sweep to an uninteresting speed. Contact asks the customer what they are building and often resolves the case, since a bulk consumer usually wants an export endpoint instead. Suspension is last, is disruptive and is the only step that should require a human decision. An arrow marks that the first two steps can be automated safely.</desc>
  <rect x="0" y="0" width="720" height="250" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Escalate gradually — the signature has innocent causes</text>
  <rect x="20" y="44" width="164" height="88" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="102" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">1 · observe</text>
  <text x="102" y="84" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">add to watch list</text>
  <text x="102" y="98" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">no customer impact</text>
  <text x="102" y="118" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">automate freely</text>
  <rect x="192" y="44" width="164" height="88" rx="8" fill="var(--viz-good-soft, #dff2e4)" stroke="var(--viz-good, #1f6b3a)" stroke-width="1.4"/>
  <text x="274" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">2 · throttle</text>
  <text x="274" y="84" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">cost-based rate limit</text>
  <text x="274" y="98" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">sweep becomes too slow</text>
  <text x="274" y="118" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">automate freely</text>
  <rect x="364" y="44" width="164" height="88" rx="8" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="1.4"/>
  <text x="446" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">3 · contact</text>
  <text x="446" y="84" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">"what are you building?"</text>
  <text x="446" y="98" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">often ends here</text>
  <text x="446" y="118" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-warn, #8a5000)">human in the loop</text>
  <rect x="536" y="44" width="164" height="88" rx="8" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.4"/>
  <text x="618" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">4 · suspend</text>
  <text x="618" y="84" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">revoke the credential</text>
  <text x="618" y="98" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">disruptive, reversible late</text>
  <text x="618" y="118" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">never automatic</text>
  <line x1="20" y1="152" x2="700" y2="152" stroke="var(--viz-grid, #d8cff0)" stroke-width="1"/>
  <text x="20" y="176" font-size="11.5" font-weight="700" fill="currentColor">Innocent causes of the same score</text>
  <text x="30" y="196" font-size="10.5" fill="currentColor">· a new analytics integration that should be using the export endpoint instead</text>
  <text x="30" y="212" font-size="10.5" fill="currentColor">· a tile pre-warming job walking the pyramid on a schedule</text>
  <text x="30" y="228" font-size="10.5" fill="currentColor">· a migration backfilling a customer's own historical data through the public API</text>
  <text x="20" y="244" font-size="10.5" fill="var(--muted, #7c6fb0)">All three are best solved by offering the right endpoint, not by blocking the wrong one.</text>
</svg>

## Gotchas & Failure Modes

- **`ST_Union` over a full day of envelopes is expensive.** On a busy subject this can be tens of thousands of polygons. Aggregate hourly into a rollup table and union the rollups, or use `ST_Union` on a snapped grid rather than raw envelopes.
- **Coarse envelopes flattening the signal.** If the audit trail rounds envelopes to two decimal places, small adjacent requests collapse into the same box and novelty drops artificially. Two places is still fine at city scale; verify the rounding does not exceed a typical viewport.
- **Tile traffic mixed with feature traffic.** A map client legitimately requests hundreds of non-overlapping tiles per pan, which scores as pure novelty. Filter to `layer` values that return features, or exclude `action = 'read'` rows originating from tile routes.
- **One subject, many API keys.** A determined scraper spreads the sweep across credentials. Group by billing account as well as subject, and treat a set of accounts whose unions tile neatly together as one actor.
- **Alerting on absolute area.** A customer whose licence covers a whole country legitimately reads a whole country. Compare coverage against the *scope* in their token rather than against a global constant — the scope model is in [Encoding Geofence Boundaries in JWT Scope Claims](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/jwt-authentication-for-spatial-scopes/encoding-geofence-boundaries-in-jwt-scope-claims/).
- **No record of the decision.** When throttling is applied, write it to the audit trail too. Otherwise next quarter nobody can explain why one account is slower than the rest.

## Choosing a threshold from your own traffic

There is no universal threshold, because the ratio that separates the two populations depends on how big a typical viewport is for your clients. Derive it empirically: run the report against a week of known-good traffic, plot the distribution of `km2_per_request`, and set the alert above the highest legitimate value with some headroom.

On most feature APIs the distribution is strongly bimodal, so the choice is easy — there is a wide empty band between the interactive population and anything automated. If your distribution has no such gap, that usually means tile traffic is mixed into the sample, or a legitimate bulk consumer is already using the feature endpoint as an export.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Distribution of coverage per request across all subjects, showing an interactive population, an empty band and a small automated population" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Distribution of km² covered per request, one week</title>
  <desc>A histogram of subjects by coverage per request. A tall cluster of interactive users sits between 0.01 and 0.4 square kilometres per request. An empty band runs from 0.4 to 3. A short second group of automated clients sits between 3 and 9. The threshold is drawn in the empty band at 1.5, comfortably above every interactive user and well below every automated one, so it can move substantially in either direction without changing which subjects it catches.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Where to put the line — one week of real traffic</text>
  <line x1="60" y1="176" x2="690" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <line x1="60" y1="44" x2="60" y2="176" stroke="currentColor" stroke-width="1.1"/>
  <text x="52" y="52" text-anchor="end" font-size="9.5" fill="var(--muted, #7c6fb0)">subjects</text>
  <rect x="70" y="96" width="26" height="80" fill="var(--accent, #7c3aed)" opacity="0.55"/>
  <rect x="98" y="62" width="26" height="114" fill="var(--accent, #7c3aed)" opacity="0.75"/>
  <rect x="126" y="52" width="26" height="124" fill="var(--accent, #7c3aed)" opacity="0.85"/>
  <rect x="154" y="78" width="26" height="98" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <rect x="182" y="118" width="26" height="58" fill="var(--accent, #7c3aed)" opacity="0.55"/>
  <rect x="210" y="152" width="26" height="24" fill="var(--accent, #7c3aed)" opacity="0.4"/>
  <rect x="238" y="168" width="26" height="8" fill="var(--accent, #7c3aed)" opacity="0.3"/>
  <text x="160" y="42" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">interactive users</text>
  <rect x="482" y="158" width="26" height="18" fill="var(--viz-bad, #a32b23)" opacity="0.6"/>
  <rect x="510" y="150" width="26" height="26" fill="var(--viz-bad, #a32b23)" opacity="0.7"/>
  <rect x="566" y="164" width="26" height="12" fill="var(--viz-bad, #a32b23)" opacity="0.6"/>
  <rect x="622" y="168" width="26" height="8" fill="var(--viz-bad, #a32b23)" opacity="0.55"/>
  <text x="560" y="132" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-bad, #a32b23)">automated clients</text>
  <line x1="340" y1="44" x2="340" y2="188" stroke="var(--viz-good, #1f6b3a)" stroke-width="2"/>
  <text x="348" y="70" font-size="10.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">threshold 1.5 km²/req</text>
  <text x="348" y="86" font-size="9.5" fill="var(--viz-good, #1f6b3a)">sits in an empty band —</text>
  <text x="348" y="100" font-size="9.5" fill="var(--viz-good, #1f6b3a)">insensitive to tuning</text>
  <text x="70" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">0.01</text>
  <text x="230" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">0.4</text>
  <text x="332" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">1.5</text>
  <text x="480" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">3</text>
  <text x="640" y="196" font-size="9.5" fill="var(--muted, #7c6fb0)">9</text>
  <text x="20" y="222" font-size="10.5" fill="var(--muted, #7c6fb0)">If your histogram has no empty band, tile traffic is probably in the sample — filter it out and re-plot.</text>
</svg>

## Verification Snippet

```sql
-- Sanity check on known-good traffic: interactive users should score low
SELECT subject_id,
       count(*) AS requests,
       round((ST_Area(ST_Union(envelope)::geography) / 1e6
              / count(*))::numeric, 4) AS km2_per_request
FROM   access_audit
WHERE  occurred_at >= now() - interval '24 hours'
  AND  subject_id IN (SELECT subject_id FROM known_interactive_users)
GROUP  BY subject_id
ORDER  BY km2_per_request DESC
LIMIT  5;
--  subject_id | requests | km2_per_request
-- ------------+----------+-----------------
--  usr_8841   |      412 |          0.0752
```

```bash
# Simulate a sweep in staging and confirm the report flags it
python scripts/simulate_sweep.py --subject test_sweeper --tiles 400 --step 0.05
psql -f reports/coverage_novelty.sql | grep test_sweeper
# test_sweeper | 400 | 2840.0 | 7.100 | 0.981
```

---

## Related

- [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/) — the envelope records this report reads
- [Rate Limiting Geofence & Tile Endpoints](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/) — the throttle applied at escalation step two
- [Cost-Based Throttling for Expensive PostGIS Queries](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/rate-limiting-geofence-and-tile-endpoints/cost-based-throttling-for-expensive-postgis-queries/) — charging by area rather than by request

← Back to [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/)
