---
layout: layouts/page.njk
title: "Managing Async Transactions for Bulk Geometry Writes"
description: "Write thousands of geometries efficiently with asyncpg copy_records_to_table and executemany, chunked commits, ST_GeomFromWKB, deferred GiST index rebuilds, and ANALYZE — without bloating WAL or holding locks."
slug: "managing-async-transactions-for-bulk-geometry-writes"
type: "long_tail"
breadcrumb:
  - label: "Advanced Spatial Endpoints & Data Contracts"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/"
  - label: "Async PostGIS Transaction Patterns"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/"
  - label: "Managing Async Transactions for Bulk Geometry Writes"
    url: "/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/"
datePublished: "2026-02-18"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "Managing Async Transactions for Bulk Geometry Writes",
      "description": "Write thousands of geometries efficiently with asyncpg copy_records_to_table and executemany, chunked commits, ST_GeomFromWKB, deferred GiST index rebuilds, and ANALYZE — without bloating WAL or holding locks.",
      "datePublished": "2026-02-18",
      "dateModified": "2026-07-10",
      "author": { "@type": "Organization", "name": "geospatial-api.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Advanced Spatial Endpoints & Data Contracts", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/" },
        { "@type": "ListItem", "position": 2, "name": "Async PostGIS Transaction Patterns", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/" },
        { "@type": "ListItem", "position": 3, "name": "Managing Async Transactions for Bulk Geometry Writes", "item": "https://geospatial-api.com/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/managing-async-transactions-for-bulk-geometry-writes/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Bulk-write geometries with async chunked transactions",
      "step": [
        { "@type": "HowToStep", "position": 1, "text": "Encode geometries as WKB and stage them as records for the copy path." },
        { "@type": "HowToStep", "position": 2, "text": "COPY into a staging table with copy_records_to_table in chunks, committing per chunk." },
        { "@type": "HowToStep", "position": 3, "text": "Convert WKB to geometry with ST_GeomFromWKB when promoting rows into the target table." },
        { "@type": "HowToStep", "position": 4, "text": "Create or rebuild the GiST index after the load rather than during it." },
        { "@type": "HowToStep", "position": 5, "text": "Run ANALYZE so the planner has fresh statistics before opening the table to reads." }
      ]
    },
    {
      "@type": "Article",
      "headline": "Managing Async Transactions for Bulk Geometry Writes",
      "datePublished": "2026-02-18",
      "dateModified": "2026-07-10"
    }
  ]
}
</script>

← Back to [Async PostGIS Transaction Patterns](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/)

# Managing async transactions for bulk geometry writes

Load tens of thousands of geometries into PostGIS from an async service without holding one enormous transaction that bloats WAL, blocks vacuum, and pins a backend for minutes.

## Context & when to use

A row-at-a-time `INSERT` loop is the wrong tool the moment a load exceeds a few hundred geometries: every statement is its own round-trip, and if you wrap the whole thing in one transaction to make it atomic you now hold locks and generate unflushed WAL for the entire load. The general transaction discipline — short scopes, explicit boundaries — is covered in the parent [async PostGIS transaction patterns](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/) guide; this page is the bulk-specific corollary: how to move thousands of rows fast while keeping each transaction small.

Use this pattern for scheduled imports, backfills, and derived-geometry rebuilds that run inside your own async process. If the data arrives as an uploaded file over HTTP, do not run it on the request path at all — hand it to a worker as described in [async bulk uploads with Celery](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/). The two techniques compose: the worker uses exactly the chunked-copy approach below.

The core idea is `asyncpg`'s binary `COPY` protocol (`copy_records_to_table`), which streams rows into PostgreSQL far faster than parameterised `INSERT`s, combined with **chunked commits** so no single transaction grows unbounded. For very large loads, you also defer the GiST index and rebuild it once at the end — maintaining a spatial index while inserting is dramatically slower than building it in one pass.

## Data flow: staged copy, chunked commit, deferred index

<svg viewBox="0 0 760 300" role="img" aria-label="Bulk geometry write flow: WKB records copied in chunks into a staging table, each chunk committed, promoted with ST_GeomFromWKB, then GiST index built and ANALYZE run once" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:760px;font-family:inherit;">
  <title>Chunked bulk geometry write pipeline</title>
  <desc>Source geometries are encoded as WKB records and streamed with copy_records_to_table into an unindexed staging table in chunks of a few thousand rows, committing after each chunk. Rows are promoted into the target table converting WKB to geometry with ST_GeomFromWKB. Only after all data lands is the GiST index created and ANALYZE run once.</desc>
  <rect x="0" y="0" width="760" height="300" rx="12" fill="var(--surface, #f5f3ff)" stroke="var(--border, #c4b5fd)" stroke-width="1.5"/>
  <text x="380" y="28" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Load first, index once</text>
  <!-- source -->
  <rect x="24" y="60" width="140" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="94" y="90" text-anchor="middle" font-size="11" fill="currentColor">Source features</text>
  <text x="94" y="108" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">→ WKB records</text>
  <!-- chunk loop -->
  <rect x="196" y="48" width="230" height="150" rx="10" fill="none" stroke="var(--accent, #7c3aed)" stroke-width="1.5" stroke-dasharray="6 3"/>
  <text x="311" y="42" text-anchor="middle" font-size="10" font-weight="600" fill="var(--muted, #7c6fb0)">for each chunk (≈5k rows)</text>
  <rect x="216" y="66" width="190" height="44" rx="8" fill="var(--accent, #7c3aed)" opacity="0.15" stroke="var(--accent, #7c3aed)" stroke-width="1.5"/>
  <text x="311" y="86" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">copy_records_to_table</text>
  <text x="311" y="101" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">binary COPY → staging</text>
  <rect x="216" y="126" width="190" height="44" rx="8" fill="#d1fae5" stroke="#10b981" stroke-width="1.5"/>
  <text x="311" y="146" text-anchor="middle" font-size="11" font-weight="600" fill="#065f46">COMMIT chunk</text>
  <text x="311" y="161" text-anchor="middle" font-size="10" fill="#065f46">WAL flushed, locks freed</text>
  <!-- promote -->
  <rect x="458" y="60" width="140" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="528" y="84" text-anchor="middle" font-size="11" fill="currentColor">Promote rows</text>
  <text x="528" y="102" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">ST_GeomFromWKB</text>
  <text x="528" y="118" text-anchor="middle" font-size="10" fill="var(--muted, #7c6fb0)">→ target table</text>
  <!-- index + analyze -->
  <rect x="630" y="48" width="108" height="82" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="684" y="76" text-anchor="middle" font-size="11" font-weight="600" fill="#92400e">CREATE INDEX</text>
  <text x="684" y="92" text-anchor="middle" font-size="10" fill="#92400e">GiST · once</text>
  <text x="684" y="112" text-anchor="middle" font-size="11" font-weight="600" fill="#92400e">ANALYZE</text>
  <!-- footer note -->
  <rect x="24" y="228" width="714" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="380" y="248" text-anchor="middle" font-size="11" fill="currentColor">One big transaction over the whole load = WAL bloat + held locks + delayed vacuum.</text>
  <text x="380" y="265" text-anchor="middle" font-size="11" fill="var(--muted, #7c6fb0)">Many small chunk transactions = bounded WAL, quick lock release, restartable.</text>
  <!-- arrows -->
  <line x1="164" y1="95" x2="216" y2="88" stroke="currentColor" stroke-width="1.5" marker-end="url(#a1)"/>
  <line x1="311" y1="110" x2="311" y2="126" stroke="var(--accent, #7c3aed)" stroke-width="1.5" marker-end="url(#a1)"/>
  <line x1="426" y1="95" x2="458" y2="95" stroke="currentColor" stroke-width="1.5" marker-end="url(#a1)"/>
  <line x1="598" y1="90" x2="630" y2="90" stroke="#d97706" stroke-width="1.5" marker-end="url(#a2)"/>
  <defs>
    <marker id="a1" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/></marker>
    <marker id="a2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
</svg>

## Runnable implementation

This loads geometries through a raw `asyncpg` connection (the `COPY` protocol is an asyncpg feature, so we borrow the driver connection from the SQLAlchemy engine rather than going through the ORM). Geometries arrive as Shapely objects, are encoded to WKB, and stream into an unindexed staging table in chunks. The GiST index and `ANALYZE` come last.

```python
# app/ingest/bulk_geometry.py
import asyncio
from typing import Iterable, Sequence
from shapely.geometry.base import BaseGeometry
from shapely import wkb as shp_wkb
from sqlalchemy.ext.asyncio import AsyncEngine

CHUNK_SIZE = 5_000          # rows per COPY + COMMIT — see the parameters table
TARGET_SRID = 4326


def _to_records(geoms: Iterable[BaseGeometry], srid: int) -> list[tuple]:
    """Encode each geometry to WKB bytes for the binary COPY stream."""
    return [(shp_wkb.dumps(g), srid) for g in geoms]


async def bulk_load(engine: AsyncEngine, geoms: Sequence[BaseGeometry]) -> int:
    total = 0
    # Borrow the raw asyncpg connection: copy_records_to_table is driver-level.
    async with engine.connect() as sa_conn:
        raw = await sa_conn.get_raw_connection()
        pg = raw.driver_connection          # the underlying asyncpg.Connection

        # 1. Fresh, UNLOGGED, UNINDEXED staging table — fast to fill, cheap to drop.
        await pg.execute("""
            DROP TABLE IF EXISTS parcels_staging;
            CREATE UNLOGGED TABLE parcels_staging (geom_wkb bytea, srid int);
        """)

        # 2. Stream WKB records in chunks, one transaction per chunk.
        records = _to_records(geoms, TARGET_SRID)
        for start in range(0, len(records), CHUNK_SIZE):
            chunk = records[start:start + CHUNK_SIZE]
            async with pg.transaction():                    # BEGIN ... COMMIT per chunk
                await pg.copy_records_to_table(
                    "parcels_staging",
                    records=chunk,
                    columns=["geom_wkb", "srid"],
                )
            total += len(chunk)

        # 3. Promote into the real table, converting WKB -> geometry ONCE.
        #    ST_GeomFromWKB parses the binary; ST_SetSRID stamps the CRS.
        async with pg.transaction():
            await pg.execute(f"""
                INSERT INTO parcels (geom)
                SELECT ST_SetSRID(ST_GeomFromWKB(geom_wkb), {TARGET_SRID})
                FROM parcels_staging
                WHERE geom_wkb IS NOT NULL;
            """)

        # 4. Build the spatial index AFTER the data lands — one pass, not per-insert.
        async with pg.transaction():
            await pg.execute(
                "CREATE INDEX IF NOT EXISTS idx_parcels_geom ON parcels USING GIST (geom);"
            )

        # 5. Refresh planner statistics; ANALYZE cannot run inside a transaction block
        #    when combined with VACUUM, so run it on its own.
        await pg.execute("ANALYZE parcels;")

        await pg.execute("DROP TABLE IF EXISTS parcels_staging;")
    return total


if __name__ == "__main__":
    # demo: load 50k random points
    from shapely.geometry import Point
    import random
    from app.database import engine
    pts = [Point(random.uniform(-180, 180), random.uniform(-85, 85)) for _ in range(50_000)]
    print(asyncio.run(bulk_load(engine, pts)), "rows loaded")
```

If the target table already exists and is indexed, the alternative is to `DROP INDEX` before the load and recreate it after — for an existing table, `CREATE INDEX CONCURRENTLY` avoids taking an `ACCESS EXCLUSIVE` lock but runs slower and cannot be inside a transaction. For a fresh load into a new table, a plain `CREATE INDEX` at the end is fastest.

For datasets small enough that a single `INSERT ... VALUES` with `executemany` is simpler, `asyncpg`'s `executemany` still beats a Python loop — but it is bounded by the 65,535-parameter limit per statement (see the gotchas), so chunk it too.

## Key parameters & options

| Parameter | What it controls | Recommended value |
|---|---|---|
| `CHUNK_SIZE` | Rows per `COPY` + `COMMIT`; caps WAL per transaction and lock hold time | 2,000–10,000; 5,000 is a good default for mid-size polygons |
| Commit interval | How often WAL is flushed and locks released | One commit per chunk — never one commit for the whole load |
| Staging table type | `UNLOGGED` skips WAL for the staging copy entirely | `UNLOGGED` for staging you will drop; never for the final table |
| `ST_GeomFromWKB` | Parses binary WKB to a geometry once, during promotion | Pair with `ST_SetSRID`; WKB carries no SRID |
| Index timing | Build GiST after load vs maintain during insert | Defer to the end; `CREATE INDEX` (new table) or `CONCURRENTLY` (live table) |
| `ANALYZE` | Refreshes planner statistics after the row count changes | Always, once, after the final insert — before opening reads |
| `executemany` batch | Rows per multi-row `INSERT` when not using `COPY` | Keep `rows × columns < 65,535` parameters |

## Gotchas & failure modes

- **One giant transaction bloats WAL and holds locks.** Wrapping the entire load in a single `async with pg.transaction()` means nothing commits until the end: WAL grows unbounded, autovacuum cannot reclaim anything the load touched, and every lock is held for the full duration. Symptom: `pg_stat_activity` shows one backend with a multi-minute `xact_start` and `pg_wal` growing fast. Fix: commit per chunk, as above. This is the same "keep transactions short" rule from the [parent guide](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/), applied to loads.

- **Parameter limit on `executemany`.** PostgreSQL's wire protocol caps a single statement at 65,535 bound parameters. A multi-row `INSERT` with 3 columns overflows at ~21,845 rows and fails with `asyncpg.exceptions.ProtocolViolationError` or a silently truncated batch. Fix: use `copy_records_to_table` (no per-value parameters) or chunk `executemany` well under the limit.

- **SRID mismatch produces unindexable geometry.** WKB does not encode an SRID, so `ST_GeomFromWKB(geom_wkb)` yields `SRID=0`. If the target column is declared `geometry(Point, 4326)`, the insert raises `Geometry SRID (0) does not match column SRID (4326)`; if the column is untyped, the rows land with `SRID=0` and later [bounding-box index queries](/advanced-spatial-endpoint-implementation-data-contracts/bounding-box-spatial-index-queries/) using `ST_Intersects` silently return nothing. Fix: always wrap with `ST_SetSRID(..., 4326)` during promotion.

- **Invalid geometries abort the whole promotion.** A single self-intersecting polygon can make a downstream constraint or `ST_MakeValid`-free insert fail, rolling back the entire promotion `INSERT`. Fix: filter or repair during promotion — `WHERE ST_IsValid(ST_GeomFromWKB(geom_wkb))` or wrap the geometry in `ST_MakeValid(...)`.

- **Forgetting `ANALYZE` leaves the planner blind.** Right after a bulk load the table's statistics still say it is empty, so the planner picks sequential scans over the new GiST index. Symptom: the first queries after a load are inexplicably slow. Fix: run `ANALYZE` before serving reads. Confirm plans with [reading EXPLAIN ANALYZE for spatial query optimization](/high-performance-caching-query-optimization/query-plan-analysis-index-tuning/reading-explain-analyze-for-spatial-query-optimization/).

## Verification

Confirm the row count, the SRID, and that the index exists and is used:

```bash
# Row count and SRID sanity
psql "$POSTGIS_DSN" -c "SELECT count(*), min(ST_SRID(geom)), max(ST_SRID(geom)) FROM parcels;"
```

```sql
-- Index present and chosen by the planner after ANALYZE
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM parcels
WHERE geom && ST_MakeEnvelope(-10, -10, 10, 10, 4326);
-- Expect: Index Scan / Bitmap Index Scan using idx_parcels_geom (never Seq Scan)
```

Time the load to catch a runaway single transaction — a healthy chunked load shows steady progress and stable `pg_wal` size:

```sql
SELECT pid, now() - xact_start AS tx_age, state
FROM pg_stat_activity
WHERE query ILIKE '%parcels_staging%';
-- tx_age should reset each chunk, never climb for the whole load
```

## Related

- [Async PostGIS Transaction Patterns](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/) — the transaction-boundary rules this bulk pattern specialises
- [Handling Deadlocks in Concurrent Spatial Updates](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/handling-deadlocks-in-concurrent-spatial-updates/) — what to do when bulk writers contend with live updates
- [Async Bulk Uploads with Celery](/advanced-spatial-endpoint-implementation-data-contracts/async-bulk-uploads-with-celery/) — run large imports off the request path in a worker

← Back to [Async PostGIS Transaction Patterns](/advanced-spatial-endpoint-implementation-data-contracts/async-postgis-transaction-patterns/)
