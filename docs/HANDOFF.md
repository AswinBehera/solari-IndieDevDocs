# Handoff — P2.5, verified and committed

Written 26 September 2026 at the end of the session that built P2.5; updated 28 September 2026
by the session that verified and committed it. Read `docs/PLAN.md`'s P2.5 line and
`docs/STATUS.md`'s P2.5 entry for *why* any of it is shaped the way it is; this file is only what
the next session must not assume.

## State in one line

P2.5 is committed and pushed. `pnpm check` passed repo-wide on 28 September with Docker up:
1,190 tests (1,165 under `turbo run test` plus 25 under `test:tools`, one live test skipped),
seam clean at 176 files, both Postgres suites live — `refine.pg.test.ts` 38, `places.pg.test.ts` 31.

## What was done on 28 September

1. `pnpm db:up`, then `pnpm check` — green.
2. The Thailand extract reloaded into **local** Postgres after the check truncated it (184,202
   rows). The command, for the next time `pnpm check` runs against a database that should keep it:
   ```
   set -a && . ./.env && set +a && \
     npx tsx tools/load-osm.ts --city thailand --from .osm/thailand-2026-09-20T07-31-52-196Z.json --commit
   ```
3. `docs/STATUS.md`'s count corrected from the carried-forward "about 1,215" to the measured 1,190.
   P2.5 added a net 80, not 105; the gap was not investigated.

A session that is not on the original machine has none of the local state above: no Docker
database, no `.env`, no `.osm/` extract, and migration `0011` applied nowhere.

## What changed

New:

- `packages/samsara/refine/src/score.ts` — the stage, plus `score.test.ts` (14).
- `packages/travel/pack/src/scores.ts` — travel's eight factors, plus `scores.test.ts` (30).
- `apps/worker/src/score.ts` — the `refine.score` job, plus `score.test.ts` (18).
- `packages/travel/db/migrations/0011_add_evidence_mention_id.sql` — **already applied to local
  Postgres**, not to hosted.

Modified, and the ones worth knowing about:

- `packages/samsara/refine/src/pack.ts` — `ScoreFactor`, `ScoreSpec`, `FactorReading`;
  `EntityRepo.writeScores` and `EntityRepo.page`; `EntityPage`.
- `packages/samsara/refine/src/resolve.ts` — an optional `EvidenceWriter`, and `report.evidence`.
- `packages/samsara/refine/src/postgres.ts` — `PostgresEvidenceWriter`, `PostgresEvidenceStore`,
  `EVIDENCE_PER_ENTITY`.
- `packages/travel/pack/src/postgres.ts` — `writeScores`, `page`, `toEntity`, `parseCursor`.
- `apps/worker/src/boot.ts` — the writer wired into `refine.resolve`, the store into `refine.score`.

## Things that will bite you

- **The cursor is a string and must stay one.** `PostgresPlaceRepo.page` puts the timestamp in as
  Postgres renders it (`::text`), not as a JS `Date`. `timestamptz` keeps microseconds and a `Date`
  keeps milliseconds, so a rounded cursor seeks from a moment *before* the row it names, re-reads
  it, and the page loop never ends. This was an actual failure, not a hypothetical.
- **Drizzle's `insert().select()` compares the selected fields to the table definition exactly and
  in order**, including columns with defaults. `PostgresEvidenceWriter` lists all 17 evidence
  columns in table order for that reason; adding a column to `evidence` breaks it loudly, which is
  the intent.
- **`pnpm check:seam` fails the build on travel vocabulary under `packages/samsara/**`.** Currently
  0 of 5 allowances across 176 files. Two violations crept in through test names and docstrings
  during P2.5; check it before committing, not after.
- **`DATABASE_URL` in `.env` points at local Docker and must keep doing so**, because the Postgres
  tests truncate tables. The hosted string lives in `.env.supabase` and reaches a command only
  through `tools/with-hosted-env.sh`.
- Hosted Postgres still holds the **Bangkok** extract, not Thailand, because `PostgresOsmSearch`
  filters `eq(city, "Bangkok")`.
- `npx tsx -e '...'` fails with "Top-level await is currently not supported with the cjs output
  format" — wrap scratch scripts in `const main = async () => { ... }; void main()`.

## Open, and deliberately not closed

- **Nothing enqueues `refine.score`.** It is a registered handler with no schedule and no chain —
  the same position `refine.resolve` is in. `tools/backfill-refine.ts` queues extract jobs only.
  Both need either a cron or a chain from the stage before them; the idempotency keys already take
  a `window` argument for exactly that.
- **The Phase 1 backfill has still not been run.** It spends against hosted data, so it wants
  `--commit` and a human: `./tools/with-hosted-env.sh npx tsx tools/backfill-refine.ts travel`
  prints the item count and the estimated cost without queueing anything.
- **P2.3's open question is unanswered** and is the user's to answer: load the golden set into
  `raw_items`, or wait for a real travel harvest. There is a doc comment marking it.
- **Tier 2's geocoder provider is deferred on purpose.** Do not sign up for LocationIQ or Geoapify.
- P2.3's other documented non-fixes: `city`-column semantics under a nationwide extract, a guard
  that survives widening, deterministic tie-breaking in Tier 1.
