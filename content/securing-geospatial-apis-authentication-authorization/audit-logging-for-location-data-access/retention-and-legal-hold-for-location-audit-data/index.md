---
layout: layouts/page.njk
title: "Retention and Legal Hold for Location Audit Data"
description: "Expire an audit trail on schedule while suspending expiry for records under investigation — partition-level retention, a hold registry the retention job consults, and the evidence that the policy ran."
slug: retention-and-legal-hold-for-location-audit-data
type: howto
breadcrumb:
  - label: "Securing Geospatial APIs"
    url: "/securing-geospatial-apis-authentication-authorization/"
  - label: "Audit Logging for Location Data Access"
    url: "/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/"
  - label: "Retention and Legal Hold for Location Audit Data"
    url: "/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/retention-and-legal-hold-for-location-audit-data/"
datePublished: "2026-08-06"
dateModified: "2026-08-06"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Retention and Legal Hold for Location Audit Data",
      "description": "Expire an audit trail on schedule while suspending expiry for records under investigation.",
      "datePublished": "2026-08-06",
      "dateModified": "2026-08-06",
      "author": { "@type": "Organization", "name": "geospatial-api.com" },
      "url": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/retention-and-legal-hold-for-location-audit-data/"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Securing Geospatial APIs", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/" },
        { "@type": "ListItem", "position": 2, "name": "Audit Logging for Location Data Access", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/" },
        { "@type": "ListItem", "position": 3, "name": "Retention and Legal Hold for Location Audit Data", "item": "https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/retention-and-legal-hold-for-location-audit-data/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Run Retention on an Audit Trail with Legal Holds",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Encode the policy once", "text": "Store the retention period as data the job reads, not as a constant buried in a script." },
        { "@type": "HowToStep", "position": 2, "name": "Keep a hold registry", "text": "Record active holds with a subject, a time range and an owner, and have the retention job consult it before expiring anything." },
        { "@type": "HowToStep", "position": 3, "name": "Log the expiry itself", "text": "Write a record of what was deleted and when, so the policy's execution is provable after the data is gone." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "How can a partition be held when retention works partition by partition?",
          "acceptedAnswer": { "@type": "Answer", "text": "Skip the partition entirely while any hold overlaps its range. Holds are rare and short compared to a retention window, so leaving one month in place for an extra quarter costs little. Copying held rows out of a partition before dropping it is possible, but it breaks the guarantee that the trail is append-only, which is usually worth more than the disk." }
        },
        {
          "@type": "Question",
          "name": "Should deleted audit records leave a tombstone?",
          "acceptedAnswer": { "@type": "Answer", "text": "Yes, at the aggregate level. Record which partition was expired, how many rows it held, the date range it covered and where it was archived. That is enough to prove the policy ran on schedule without keeping the personal data itself, and it answers the audit question of whether a gap in the trail was deletion or an outage." }
        },
        {
          "@type": "Question",
          "name": "Who should be able to place a hold?",
          "acceptedAnswer": { "@type": "Answer", "text": "A named role with its own credentials, and never the application. A hold suspends a data-protection commitment, so its creation should be as deliberate and as attributable as the deletion it prevents. Record the owner and an expected release date, and report on holds that outlive their expected release." }
        }
      ]
    }
  ]
}
</script>

← Back to [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/)

# Retention and legal hold for location audit data

This page covers the two halves of an audit-retention policy that has to survive scrutiny: expiring records on schedule, and reliably *not* expiring the ones an open investigation depends on.

## Context & When to Use

An audit trail of location access is personal data about the people whose locations were read and about the staff who read them. Keeping it forever is a liability; deleting it too early destroys the ability to investigate. So the policy has two commitments — "we keep it for 24 months" and "we delete it after 24 months" — and both need to be demonstrably true.

The complication is holds. When an incident is under investigation, or a regulator has asked a question, the records relevant to it must survive past their expiry date. A retention job that does not know about holds will cheerfully destroy evidence on schedule, and the deletion will look deliberate afterwards no matter how automatic it was.

The design below keeps the policy as data, keeps holds in a registry the job consults, and records the fact of each expiry so the policy's execution is provable after the underlying rows are gone. It builds on the partitioned audit table from [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/) and the rollover mechanics in [Automating Partition Rollover and Retention](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/automating-partition-rollover-and-retention/).

## Runnable Implementation

```sql
-- The policy, as data the job reads rather than a constant in a script
CREATE TABLE retention_policy (
    dataset        text PRIMARY KEY,
    retain_months  int  NOT NULL CHECK (retain_months BETWEEN 1 AND 120),
    approved_by    text NOT NULL,
    approved_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO retention_policy VALUES ('access_audit', 24, 'dpo@example.com');

-- Active holds. A hold is a time range plus, optionally, a subject.
CREATE TABLE legal_hold (
    id            bigserial PRIMARY KEY,
    reason        text        NOT NULL,
    subject_id    text,                       -- NULL = every subject
    covers        tstzrange   NOT NULL,
    placed_by     text        NOT NULL,
    placed_at     timestamptz NOT NULL DEFAULT now(),
    expected_release date,
    released_at   timestamptz
);
CREATE INDEX legal_hold_active ON legal_hold USING GIST (covers)
    WHERE released_at IS NULL;

-- Tombstones: what was expired, proving the policy ran
CREATE TABLE retention_log (
    id             bigserial PRIMARY KEY,
    dataset        text        NOT NULL,
    partition_name text        NOT NULL,
    covers         tstzrange   NOT NULL,
    rows_removed   bigint      NOT NULL,
    archived_to    text,
    executed_at    timestamptz NOT NULL DEFAULT now()
);
```

The retention job then becomes a straightforward loop with one extra condition — does any unreleased hold overlap this partition's range?

```sql
CREATE OR REPLACE FUNCTION expire_audit_partitions()
RETURNS TABLE (partition_name text, outcome text)
LANGUAGE plpgsql AS $$
DECLARE
    keep_months int;
    horizon     timestamptz;
    part        record;
    n           bigint;
BEGIN
    SELECT retain_months INTO STRICT keep_months
    FROM   retention_policy WHERE dataset = 'access_audit';
    horizon := date_trunc('month', now()) - (keep_months || ' month')::interval;

    FOR part IN
        SELECT c.relname,
               tstzrange((regexp_replace(c.relname, '^access_audit_', '') || '_01')::date,
                         ((regexp_replace(c.relname, '^access_audit_', '') || '_01')::date
                          + interval '1 month')) AS covers
        FROM   pg_class c
        JOIN   pg_inherits i ON i.inhrelid = c.oid
        WHERE  i.inhparent = 'access_audit'::regclass
          AND  c.relname ~ '^access_audit_\d{4}_\d{2}$'
    LOOP
        CONTINUE WHEN upper(part.covers) > horizon;

        -- The one extra condition that makes this safe
        IF EXISTS (SELECT 1 FROM legal_hold h
                   WHERE h.released_at IS NULL AND h.covers && part.covers) THEN
            partition_name := part.relname; outcome := 'held';
            RETURN NEXT; CONTINUE;
        END IF;

        EXECUTE format('SELECT count(*) FROM %I', part.relname) INTO n;
        EXECUTE format('ALTER TABLE access_audit DETACH PARTITION %I CONCURRENTLY',
                       part.relname);
        INSERT INTO retention_log (dataset, partition_name, covers, rows_removed,
                                   archived_to)
        VALUES ('access_audit', part.relname, part.covers, n,
                's3://audit-archive/' || part.relname || '.dump');
        EXECUTE format('DROP TABLE %I', part.relname);

        partition_name := part.relname; outcome := 'expired';
        RETURN NEXT;
    END LOOP;
END $$;
```

<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline of monthly audit partitions showing which are expired, which are retained, and one held past its expiry date by an open investigation" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Retention with one active hold</title>
  <desc>A timeline of monthly audit partitions across 28 months. Partitions older than the 24-month horizon are marked expired and each has a tombstone recorded. One partition older than the horizon is marked held, because an open investigation covers part of its range; it stays attached and queryable. The remaining 24 months are within retention. An annotation notes that the held partition will be expired automatically in the next run after the hold is released.</desc>
  <rect x="0" y="0" width="720" height="260" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">One hold changes one partition, not the policy</text>
  <rect x="24" y="72" width="60" height="48" rx="5" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.2"/>
  <text x="54" y="94" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor">m28</text>
  <text x="54" y="108" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">expired</text>
  <rect x="90" y="72" width="60" height="48" rx="5" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.2"/>
  <text x="120" y="94" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor">m27</text>
  <text x="120" y="108" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">expired</text>
  <rect x="156" y="66" width="60" height="60" rx="5" fill="var(--viz-warn-soft, #fbeed6)" stroke="var(--viz-warn, #8a5000)" stroke-width="2"/>
  <text x="186" y="90" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor">m26</text>
  <text x="186" y="104" text-anchor="middle" font-size="9" font-weight="700" fill="var(--viz-warn, #8a5000)">HELD</text>
  <text x="186" y="117" text-anchor="middle" font-size="8.5" fill="var(--muted, #7c6fb0)">case #4471</text>
  <rect x="222" y="72" width="60" height="48" rx="5" fill="var(--viz-bad-soft, #fbe4e1)" stroke="var(--viz-bad, #a32b23)" stroke-width="1.2"/>
  <text x="252" y="94" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor">m25</text>
  <text x="252" y="108" text-anchor="middle" font-size="9" fill="var(--muted, #7c6fb0)">expired</text>
  <line x1="288" y1="52" x2="288" y2="146" stroke="var(--accent, #7c3aed)" stroke-width="2"/>
  <text x="294" y="48" font-size="10" font-weight="700" fill="var(--accent, #7c3aed)">24-month horizon</text>
  <rect x="296" y="72" width="396" height="48" rx="6" fill="var(--accent, #7c3aed)" fill-opacity="0.14" stroke="var(--accent, #7c3aed)" stroke-width="1.3"/>
  <text x="494" y="94" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">within retention — 24 months, queryable</text>
  <text x="494" y="110" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">m24 … m1</text>
  <text x="24" y="166" font-size="10.5" fill="currentColor">Each expired partition leaves a tombstone in <tspan font-family="monospace" font-size="10">retention_log</tspan>:</text>
  <rect x="24" y="176" width="668" height="24" rx="4" fill="var(--surface-alt, #ede8f8)"/>
  <text x="36" y="192" font-size="9.5" font-family="monospace" fill="currentColor">access_audit_2024_04 · [2024-04-01, 2024-05-01) · 41 882 022 rows · s3://audit-archive/… · 2026-08-06</text>
  <text x="24" y="224" font-size="10.5" fill="var(--muted, #7c6fb0)">The held partition is expired automatically by the first scheduled run after the hold is released — no</text>
  <text x="24" y="240" font-size="10.5" fill="var(--muted, #7c6fb0)">manual follow-up, which is what stops a released hold from turning into indefinite retention by neglect.</text>
</svg>

## Key Parameters & Options

| Element | Choice | Reasoning |
|---|---|---|
| Policy storage | a table, not a constant | Auditable, and changing it leaves a record |
| Hold granularity | partition, not row | Keeps the trail append-only; over-retention is cheap and rare |
| `covers` type | `tstzrange` with GiST | Overlap test is one indexed operator |
| Tombstone | aggregate only | Proves execution without retaining personal data |
| `expected_release` | required on every hold | Makes stale holds reportable |
| Who may hold | a named role | A hold suspends a commitment; it needs an owner |

## Holds that never get released

The predictable failure of a hold registry is not that holds are missed — it is that they are never lifted. A hold placed during an incident outlives the incident, nobody remembers it exists, and two years later the "24-month" trail quietly contains five years of data.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chart comparing expected and actual hold durations, with several holds far past their expected release date" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Expected versus actual hold duration</title>
  <desc>Six holds plotted as paired bars. Case 4471 expected 30 days and has run 34, which is normal. Case 4502 expected 60 days and has run 61. Case 4388 expected 45 days and has run 402, marked overdue. Case 4103 expected 30 days and has run 611, marked overdue. Case 4610 expected 90 days and has run 12, still active. Case 3990 expected 30 days and has run 894, marked as the oldest and flagged for review. Four of the six are inside expectation; the two long-running ones are what a stale-hold report exists to surface.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Stale-hold report — days open against days expected</text>
  <rect x="500" y="14" width="12" height="12" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <text x="518" y="25" font-size="10" fill="currentColor">expected</text>
  <rect x="588" y="14" width="12" height="12" rx="2" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="606" y="25" font-size="10" fill="currentColor">actual</text>
  <text x="20" y="58" font-size="10.5" fill="currentColor">case 4610</text>
  <rect x="110" y="46" width="54" height="7" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <rect x="110" y="54" width="8" height="7" rx="2" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="176" y="58" font-size="9.5" fill="var(--viz-good, #1f6b3a)">12 / 90 — active</text>
  <text x="20" y="88" font-size="10.5" fill="currentColor">case 4471</text>
  <rect x="110" y="76" width="18" height="7" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <rect x="110" y="84" width="21" height="7" rx="2" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="176" y="88" font-size="9.5" fill="var(--viz-good, #1f6b3a)">34 / 30 — normal</text>
  <text x="20" y="118" font-size="10.5" fill="currentColor">case 4502</text>
  <rect x="110" y="106" width="36" height="7" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <rect x="110" y="114" width="37" height="7" rx="2" fill="var(--accent, #7c3aed)" opacity="0.7"/>
  <text x="176" y="118" font-size="9.5" fill="var(--viz-good, #1f6b3a)">61 / 60 — normal</text>
  <text x="20" y="148" font-size="10.5" fill="currentColor">case 4388</text>
  <rect x="110" y="136" width="27" height="7" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <rect x="110" y="144" width="242" height="7" rx="2" fill="var(--viz-warn, #8a5000)" opacity="0.75"/>
  <text x="362" y="151" font-size="9.5" font-weight="700" fill="var(--viz-warn, #8a5000)">402 / 45 — overdue</text>
  <text x="20" y="178" font-size="10.5" fill="currentColor">case 4103</text>
  <rect x="110" y="166" width="18" height="7" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <rect x="110" y="174" width="367" height="7" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="487" y="181" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">611 / 30 — overdue</text>
  <text x="20" y="208" font-size="10.5" fill="currentColor">case 3990</text>
  <rect x="110" y="196" width="18" height="7" rx="2" fill="var(--muted, #7c6fb0)" opacity="0.6"/>
  <rect x="110" y="204" width="536" height="7" rx="2" fill="var(--viz-bad, #a32b23)" opacity="0.75"/>
  <text x="656" y="211" font-size="9.5" font-weight="700" fill="var(--viz-bad, #a32b23)">894 / 30</text>
  <text x="20" y="232" font-size="10.5" fill="var(--muted, #7c6fb0)">Report monthly on holds past their expected release. Two forgotten holds can double the trail's retention.</text>
</svg>

## Gotchas & Failure Modes

- **A hold placed after the partition was dropped.** Retention runs on a schedule; an investigation opened on Monday cannot protect data expired on Sunday. Keep the archive copy long enough to restore from, and record where it went in the tombstone.
- **`STRICT` on the policy lookup.** If the policy row is missing, `SELECT … INTO STRICT` raises rather than defaulting to zero months. That failure mode — job errors loudly — is much better than the alternative, which deletes everything.
- **Holds without a subject filter treated as narrow.** A hold with `subject_id IS NULL` covers every subject in the range. Make the registry display that explicitly, or someone will place a broad hold thinking it was narrow.
- **Deleting rows instead of partitions when held data is mixed in.** Deleting the unheld rows from a held partition breaks the append-only guarantee and destroys the tamper-evidence argument. Skip the whole partition instead.
- **The tombstone table growing unbounded.** It is small — one row per partition — but it must never be expired itself, or the proof of deletion disappears with the data.
- **Archive not verified.** Confirm the dump is readable before dropping, the same discipline as in [Automating Partition Rollover and Retention](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/automating-partition-rollover-and-retention/).

## Proving the policy ran

The awkward question in any review is not "what is your retention period" — it is "show me that it happened". Once the rows are gone, the only evidence is what you wrote down at the time, which is why the tombstone table is part of the design rather than an afterthought.

Three artefacts together make the case: the policy row with its approver and date, one tombstone per expired partition, and the hold registry showing why any apparent exception exists. A reviewer can reconcile them without access to a single audit record, and therefore without any additional exposure of the personal data the review is about.

<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three evidence artefacts and the question each answers during a review" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>The three artefacts a retention review needs</title>
  <desc>Three panels. The policy table answers what the commitment is and who approved it, and contains no personal data. The retention log answers what was actually deleted and when, one row per partition, also containing no personal data. The hold registry answers why any partition older than the horizon still exists. Together they let a reviewer verify the policy without reading a single audit record, which is itself the point.</desc>
  <rect x="0" y="0" width="720" height="240" rx="10" fill="var(--surface, #f5f3ff)"/>
  <text x="20" y="26" font-size="12.5" font-weight="700" fill="currentColor">Evidence that survives the data it describes</text>
  <rect x="16" y="44" width="220" height="128" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="126" y="68" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">retention_policy</text>
  <text x="126" y="90" text-anchor="middle" font-size="9.5" fill="currentColor">"what did you commit to?"</text>
  <text x="126" y="110" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">24 months · approved by DPO</text>
  <text x="126" y="126" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">dated, one row</text>
  <text x="126" y="150" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">no personal data</text>
  <rect x="248" y="44" width="220" height="128" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="358" y="68" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">retention_log</text>
  <text x="358" y="90" text-anchor="middle" font-size="9.5" fill="currentColor">"did it actually happen?"</text>
  <text x="358" y="110" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">one row per expired partition</text>
  <text x="358" y="126" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">range · row count · archive</text>
  <text x="358" y="150" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good, #1f6b3a)">no personal data</text>
  <rect x="480" y="44" width="222" height="128" rx="8" fill="var(--surface-alt, #ede8f8)" stroke="var(--accent, #7c3aed)" stroke-width="1.4"/>
  <text x="591" y="68" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">legal_hold</text>
  <text x="591" y="90" text-anchor="middle" font-size="9.5" fill="currentColor">"why is that month still here?"</text>
  <text x="591" y="110" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">reason · owner · expected release</text>
  <text x="591" y="126" text-anchor="middle" font-size="9.5" fill="var(--muted, #7c6fb0)">released_at when lifted</text>
  <text x="591" y="150" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-warn, #8a5000)">names a person</text>
  <text x="20" y="200" font-size="10.5" fill="currentColor">A reviewer reconciles all three without opening <tspan font-family="monospace" font-size="10">access_audit</tspan> — so the review itself</text>
  <text x="20" y="216" font-size="10.5" fill="currentColor">creates no additional exposure of the location data it is auditing.</text>
  <text x="20" y="234" font-size="10.5" fill="var(--muted, #7c6fb0)">Never expire the tombstone table: it is the only thing left once the trail is gone.</text>
</svg>

## Verification Snippet

```sql
-- Does the trail match the stated policy right now?
SELECT (SELECT retain_months FROM retention_policy WHERE dataset = 'access_audit')
         AS policy_months,
       round(extract(epoch FROM now() - min(occurred_at)) / 2629746)::int
         AS actual_months_held,
       (SELECT count(*) FROM legal_hold WHERE released_at IS NULL) AS active_holds
FROM   access_audit;
--  policy_months | actual_months_held | active_holds
-- ---------------+--------------------+--------------
--             24 |                 26 |            1     ← explained by the hold

-- Holds past their expected release
SELECT id, reason, placed_by, expected_release,
       (current_date - expected_release) AS days_overdue
FROM   legal_hold
WHERE  released_at IS NULL AND expected_release < current_date
ORDER  BY days_overdue DESC;
```

---

## Related

- [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/) — the trail this policy governs
- [Automating Partition Rollover and Retention](https://www.geospatial-api.com/high-performance-caching-query-optimization/table-partitioning-for-large-spatial-datasets/automating-partition-rollover-and-retention/) — the detach-and-drop mechanics
- [Row-Level Security for Multi-Tenant PostGIS](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/row-level-security-for-multi-tenant-postgis/) — restricting who can read the trail at all

← Back to [Audit Logging for Location Data Access](https://www.geospatial-api.com/securing-geospatial-apis-authentication-authorization/audit-logging-for-location-data-access/)
