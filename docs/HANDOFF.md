# Handoff — the refine chain, P2.7, and the Phase 4 front end

Written 28 September 2026 by the session that built them. Read `docs/STATUS.md`'s top two entries
for *why* any of it is shaped the way it is; this file is only what the next session must not
assume.

## State in one line

The pipeline runs itself from a harvest to a scored place, and there is a travel app on top of it:
trips, onboarding, the Trip Document with Postcards, map, timeline, share link, and a Places page
built for the Phase 2 gate. 1,370 tests pass (1,345 under `turbo run test` plus 25 under
`test:tools`, one live test skipped), seam clean at 176 files. Everything is committed and pushed
to `claude/zen-hypatia-4kjc9j`, **not merged to `main`**.

## Do this before merging to `main`

**Apply migrations 0011 and 0012 to hosted: `pnpm db:migrate:hosted`.** The worker runs from `main`
on a cron against hosted Postgres. From the merge on, every `refine.extract` chains a
`refine.resolve`, which writes `evidence.mention_id` (0011); the API's trips routes read
`trips.share_token` (0012).

## Decisions waiting for Aswin

Aswin asked for these to be asked **one at a time, with an explanation**, after the work. Each has
a default already in the code, chosen to be the reversible one; the bracket says what it is.

1. **Q17 — dedup and the `ร้าน` opener.** Two spellings of one shop 5 m apart are not merged.
   [Left unmerged; lean in QUESTIONS.md is Thai openers only.]
2. **Who creates the `users` row.** Sign-up does not exist; the verifier yields only `sub`, and
   `users.email` is NOT NULL. [`POST /trips` answers 403 "no account for this sign-in yet";
   `pnpm db:seed` makes the dev one.]
3. **Fonts.** Google Fonts link, as the canvas does (a third-party request per page view), or
   self-hosted. [Google Fonts.]
4. **Canvas copy that promises the nightly daemon (P5.2).** "Tonight the OS starts reading
   Bangkok…", "Harvest nightly · 6 new places". [Replaced with what is true until P5.2 exists.]
5. **Trip status tags.** The schema has dreaming/planning/travelling/done; the canvas shows
   PLANNING/DRAFT/SHARED. [The schema's names; "shared" is a fact about a link, not a status.]
6. **Trip dates are calendar days at midnight UTC,** and photo times keep the camera's wall clock.
   [So everywhere.]
7. **Photo storage.** P4.6 says upload; there is no bucket. [The card keeps a downscaled JPEG
   thumbnail in its payload; Postcard bodies are capped at 256 KB.]
8. **Link conversion (P4.7) and Hundred Eyes (Phase 3) are not built.** [Link and Price cards say
   so; no buttons that do nothing.]
9. **Postcards removed from the document keep their rows** so undo works; nothing cleans up
   orphans. [No cleanup.]
10. **Gate-review marks on `/lab/places`** live in the reviewer's browser, not a table. [Browser
    storage; P6.6's thumbs-into-scoring would need a table.]
11. **`/lab/places` shows the top 30** because of the CPU budget. [No cursor yet.]
12. **The basemap.** ADR-0018's PMTiles extract, fonts and sprites are not built or hosted, and
    reading PMTiles needs the `pmtiles` package, which is not on PLAN §4's list. [The map is the
    canvas's midnight plane with HTML pins until then.]
13. **Onboarding offers Bangkok and Tokyo** as the canvas does, though the pipeline covers only
    Thailand until P6.4. [As the canvas.]
14. **Building Phase 4 before the Phase 2 gate** — done at Aswin's request; recorded so the order
    is not mistaken for the plan's.

## Where the work stopped

**The kernel dashboard (P5.5) was started and not written.** No code was changed for it. The one
finding: `apps/api` compiles against Workers types, and `@samsara/kernel`'s `ceilings.ts` has
`process.env` as a default parameter, so the API cannot import `loadCeilings` to show "minutes
today of the ceiling". The plan was to move `DEFAULT_CEILINGS` and a `ceilingsFrom(env)` into a
Workers-safe file that `ceilings.ts` re-exports, keeping `loadCeilings()`'s signature (two callers
use it with no argument), and to add an ops read model — sessions open, minutes today by purpose,
meters used against ceilings, blocked rate per source over 24 h, persona health, queue depth — to
`@samsara/kernel/postgres`. The `global.day` window fraction is 1, so the daily ceiling is the
configured ceiling itself.

## Things that will bite you

- **MapLibre sets `position: relative` on its container.** Give it a wrapper that holds the
  position; `absolute inset-0` on the container itself collapses it to zero height and clips every
  pin. Its worker is loaded with `?worker&url` because Vite's pre-bundling moves the file.
- **The trip route and the share route are lazy chunks.** The share page reuses the editor and
  map from `src/trip/`; keep them importable without the app shell.
- **Route ids carry the layout:** `useParams({ from: "/app/trips/$tripId" })`, not the path.
- **A handler that returns normally after SIGTERM is marked `succeeded`.** Only a throw under an
  aborted signal is released. `refine.dedup` throws on cancel; `refine.resolve` and
  `refine.score` return, which is survivable for them.
- **`places.evidence_count` is never maintained**; count `evidence` rows.
- **Docker had no daemon here.** Checks ran against the system Postgres 16 (`service postgresql
  start`, `pnpm db:migrate`, `pnpm db:seed`); CI uses 17. `pnpm test` truncates the local tables,
  so re-seed before clicking around.
- The P2.5 handoff's list still holds: the keyset cursor stays a string, `insert().select()` lists
  all 17 evidence columns, `DATABASE_URL` in `.env` must point at a database the tests may
  truncate, `npx tsx -e` cannot top-level await.

## Open, and not this session's to close

- **The Phase 1 backfill** spends against hosted data: the migrations above, then
  `./tools/with-hosted-env.sh npx tsx tools/backfill-refine.ts travel` (prints count and cost),
  then `--commit`. The chain takes it the rest of the way.
- **P2.3's open question** (golden set into `raw_items`, or wait for a real harvest).
- **Tier 2's geocoder is deferred on purpose.** Do not sign up for LocationIQ or Geoapify.
- **Phase 2's acceptance and gate** need a real week of Bangkok harvests through the chain on
  hosted; `/lab/places` now shows the numbers and counts the review.
