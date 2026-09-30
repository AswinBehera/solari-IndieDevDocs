# Handoff — the refine chain, P2.7, and the Phase 4 front end

Written 28 September 2026 by the session that built them. Read `docs/STATUS.md`'s top two entries
for *why* any of it is shaped the way it is; this file is only what the next session must not
assume.

## 30 September, afternoon: the Samsara redesign

On `main`, after the overnight entry below. Asked for: Samsara as a visible part of the
app, English interests turned into local searches, prices by booking site instead of by
country, codes from locals, and a scrapbook look for the document.

- `6e837e0`, `590042e`: **Samsara at `/samsara`.** Characters are personas with `traits`
  (archetype, bio, interests, sources, look). Migration 0016 (`personas.traits`) was
  applied to hosted on 30 September (`pnpm db:migrate:hosted`).
  Seven presets (`@dt/travel-pack/characters`) are seeded by `pnpm db:seed:demo` with fixed
  ids, along with their real captures (`fixtures/samsara-demo.json`, `fixtures/deals-demo.json`).
  `persona.explore` sends one out: at most eight searches.
- `24f8d3a`: onboarding offers the full interest set; each tag shows the Thai query a local
  would search (`interests.ts`).
- `412a3ff`: **the price card is one hotel across booking sites**, each read once from one
  viewpoint (`POST /probes` takes `countries`). It names a cheaper site only for the same stay
  and a gap over 2%. Under it, codes the Deal hunter (Beam) found go through the new `deals`
  pack (extract only). Beam's real run on 30 Sep read 214 posts and found no code, and the card
  says exactly that. `/lab/deals` reports what was searched.
- `16c312e`: the scrapbook look (tape, stamps, ticket stubs, receipts, Thai slang stickers).
  Every choice is a tested function in `postcard-rules.ts` or `paper.ts`.

Things that will bite you:
- Extraction needs `LLM_MODEL_EXTRACT` in `.env`. `.env.example` has it; a local `.env` made
  before that line was added may not.
- Running `apps/worker` locally queues the daily sweeps on its first run each day: keep-alives
  for every character and a harvest per active trip. Both spend. Delete queued `harvest.run`
  rows or set `TRIP_SWEEP_MAX=0` if you only meant to drain refine jobs.
- `pantip.tag` runs can keep more than 100 items, and extraction refuses those
  (`ITEM_LIST_LIMIT`). Beam's "Agoda" tag run (205 items) is one.
- `apps/web/public/demo/probe.json` and `export-demo-probe.ts` are the old seven-country
  fixture. Nothing seeds from them now.

## 30 September, overnight: read this first

What the 29–30 September session shipped on `main`, and what is still yours to do.

**Shipped (pushed):**

- `38f7f65` `tools/harvest-corpus.ts`: 120 Bangkok queries (English and Thai) queued as
  `harvest.run`. **All harvests succeeded.** A dispatched drain can now run up to 45 minutes
  (`gh workflow run worker.yml -R AswinBehera/solari-TravelOS -f budgetMinutes=45`).
- `fc38a6e` `/place` falls back to OpenStreetMap. Unscored OSM matches appear under
  "OPENSTREETMAP · NOT SCORED YET", and picking one creates a Tier 1 place with a coordinate
  (`POST /places/osm`). Migration 0015 (`common_name`, `common_local`, `alt_names` on
  `osm_places`) is **applied to hosted**. "Wat Pho" now finds Wat Pho, not a smaller temple.
- `c67c0ae` the persona-review fixes:
  - onboarding refuses a trip that starts in the past or ends before it starts;
  - the lab links sit under "Under the hood";
  - the status strip shows only when the server is down;
  - jargon is gone from the slash menu and postcards;
  - focus rings are visible;
  - the price card says a check usually takes a few minutes.

**Later the same morning (`8b0b774`):** the reviewers will run the repo themselves with their
own keys, so no Cloudflare deploy for the demo. The API has in fact never been deployed:
there is no worker on the account, and `wrangler.toml`'s Hyperdrive id is still the
placeholder. I tested a fresh clone against an empty database and fixed what broke:
- `db:migrate` ignored `.env`;
- the OSM data now ships as a snapshot in `data/osm/`;
- `harvest-corpus` makes its own persona.

README's "Try the app" is the tested path.

**Yours to do:**

1. ~~Redeploy the API.~~ Not needed for the demo (see above). A first deploy needs a Hyperdrive
   config (`wrangler hyperdrive create`), `SUPABASE_URL` as a secret, and somewhere to host `apps/web`.
2. **Extraction is the bottleneck, not harvesting.** Each `refine.extract` makes about three
   deepseek calls of about 3 minutes and 5k output tokens each, so roughly 6 minutes per job.
   About 100 were queued at 03:40 UTC. The runner is sequential, the cron only drains for 4
   minutes, and a dispatched run for 45, so the batch needs about 10 hours of drains. The cost is
   small: about $0.003 per extract. The fix I would make, but did not (editing the workflow was
   outside what I was cleared to change unattended):
   - add a `shards` dispatch input that fans the drain job out as a matrix; claims are already
     `FOR UPDATE SKIP LOCKED`;
   - raise `WORKER_LEASE_MS` from 5 to 15 minutes, so a parallel shard does not reclaim a
     6-minute extraction mid-call.
3. ~~One extract failed on `maxOutputTokens (8000)`.~~ Fixed in `508d6d7`: extraction now asks
   for 16k. Drains started before that commit still use 8k.

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
