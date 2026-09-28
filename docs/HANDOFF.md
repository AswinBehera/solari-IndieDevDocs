# Handoff — P2.7 and the refine chain

Written 28 September 2026 by the session that built them. Read `docs/STATUS.md`'s top entry for
*why* any of it is shaped the way it is; this file is only what the next session must not assume.

## State in one line

The pipeline runs itself from a harvest to a scored place, and `/lab/places` shows the result.
`pnpm check` passed repo-wide on 28 September: 1,246 tests (1,221 under `turbo run test` plus 25
under `test:tools`, one live test skipped), seam clean at 176 files. Committed and pushed to
`claude/zen-hypatia-4kjc9j`, **not merged to `main`**.

## Do this before merging to `main`

**Apply migration 0011 to hosted: `pnpm db:migrate:hosted`.** The worker runs from `main` on a cron
against hosted Postgres. Until this branch, nothing enqueued `refine.resolve` there; from the merge
on, every `refine.extract` chains one, and resolve writes `evidence.mention_id`, which hosted does not
have yet. Resolve would fail on every run until the migration lands.

## What changed

New:

- `apps/worker/src/chain.ts` — how one stage queues the next; the ordering is read off the pack.
- `apps/worker/src/dedup.ts` — the `refine.dedup` job, plus `dedup.test.ts` (19).
- `packages/travel/pack/src/read.ts` — `PostgresPlaceReader`, exported as `@dt/travel-pack/read`,
  plus `read.pg.test.ts` (8).
- `apps/api/src/places.ts` — `GET /lab/places`, plus `places.test.ts` (11).
- `apps/web/src/places/queries.ts` — the fetch and the ISO-string-to-`Date` conversion, plus the web
  app's first test file (3).

Modified, and the ones worth knowing about:

- `packages/samsara/refine/src/dedup.ts` — `DedupOptions.earlier`. **Any caller that pages must pass
  it**, or the older duplicate is merged into the newer across pages. The job does.
- `apps/worker/src/refine.ts`, `resolve.ts`, `boot.ts` — the chain, and `refine.dedup` registered
  with `PostgresEntityLinks`.
- `apps/api/src/app.ts` — `/lab/places` mounted **before** `/lab`. The order is load-bearing (it
  keeps token verification to one per request) and `places.test.ts` fails if it is swapped.
- `apps/web/src/places/Places.tsx` — live by default; the fixed sample is at `/lab/places?sample`.

## Things that will bite you

- **`places.evidence_count` is never maintained.** Only a merge adds to it. Anything that needs a
  count must count `evidence` rows, as `PostgresPlaceReader` does.
- **`/lab/places` is capped at thirty on purpose** (`MAX_LIMIT`): 3.3 ms of CPU in the Node proxy,
  and sixty is already over the 5 ms budget because every place carries its receipts. More than
  thirty wants a cursor, not a bigger number.
- **A handler that returns normally after SIGTERM is marked `succeeded`.** Only a throw under an
  aborted signal is released. `refine.dedup` throws on cancel for that reason; `refine.resolve` and
  `refine.score` return, which is survivable for them and was left alone.
- **Docker had no daemon in this container**, so the checks ran against the system's Postgres 16
  (`service postgresql start`, then `pnpm db:migrate`), not the compose file's 17. CI uses 17.
- Everything the P2.5 handoff listed still holds: the keyset cursor must stay a string, Drizzle's
  `insert().select()` lists all 17 evidence columns in order, `DATABASE_URL` in `.env` must point at
  a database the tests may truncate, `npx tsx -e` cannot top-level await.

## Open, and deliberately not closed

- **Q17: dedup does not merge `X` with `ร้านX` at the same coordinate.** Found by the end-to-end
  run. The obvious fix also merges "Thep Thai" into "P Thai" through the `the` opener, so it is a
  merge-policy question for Aswin, with a lean written down.
- **The Phase 1 backfill has still not been run.** It spends against hosted data, so it wants the
  migration above, `--commit` and a human: `./tools/with-hosted-env.sh npx tsx tools/backfill-refine.ts travel`
  prints the count and cost first. The chain now takes it the rest of the way to scored places.
- **P2.3's open question** (load the golden set into `raw_items`, or wait for a real travel harvest)
  is still the user's to answer.
- **Tier 2's geocoder provider is deferred on purpose.** Do not sign up for LocationIQ or Geoapify.
- **Phase 2 acceptance and the gate are measurements on real data**, and none of them can be taken
  until a week of Bangkok harvests has gone through the chain on hosted: ≥100 places with geo, ≥30
  with `scores.local` > 0.7, then the top-thirty review at `/lab/places`.
