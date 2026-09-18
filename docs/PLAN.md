# Samsara and Doen Thang: Build Plan v2

**Role of this document:** the architect's brief. Aswin owns product and architecture decisions. Claude Code and `agy` (Gemini) execute tasks from this plan across sessions. Executors do not re-plan; they build what a task says, report back, and raise questions in the designated file.

**Status:** v2, 11 September 2026. Repo is a fresh fork of the Solari cookbook with no product code yet.

**What changed in v2.** Two corrections to v1, both structural.

1. **We are not building an operating system.** We are building a *service layer* over Solari's infrastructure: session orchestration, budgets, deadlines, scheduled processes, and a pipeline. Solari is the hardware and the drivers. "OS" remains the product-facing metaphor for Doen Thang, and it is earned only to the degree that the daemons, personas, and executable Postcards are real. It is not a description of the architecture, and executors should never reason about the code as if it were one. See section 1.5.

2. **The service layer is domain-agnostic and has a name: Samsara.** The horizontal primitive underneath Doen Thang is *situated observation*: seeing the internet exactly as a specific kind of person in a specific place sees it, at scale, repeatedly, and turning that into structured evidence. Personas are incarnations; Samsara is the machinery that runs them. Travel is vertical one, not the substrate. Section 1.6 defines the seam, and section 2.5 defines the contract a vertical implements. **The seam is enforced in CI, not in comments.**

---

## 0. How to use this document (read this first, every session)

This plan lives at `docs/PLAN.md` in the repo. Three companion files:

| File | Purpose | Who writes |
|---|---|---|
| `docs/PLAN.md` | This document. Product, architecture, phases, tasks. | Architect only |
| `docs/STATUS.md` | Current phase, last completed task, next task, known breakage. | Executor, at the end of every session |
| `docs/QUESTIONS.md` | Anything the spec doesn't answer. Executor writes, architect answers inline. | Both |
| `docs/adr/NNNN-title.md` | Architecture decision records. One file per decision. | Architect proposes, executor records |

### Session protocol for executors

Paste this at the top of every Claude Code or Gemini session:

```
You are the code executor for Doen Thang. Read docs/PLAN.md, then docs/STATUS.md,
then docs/QUESTIONS.md. Do exactly one task from the current phase, the one marked
NEXT in STATUS.md. Definition of done is in PLAN.md section 0. When finished, update
STATUS.md (what you did, what you touched, what is NEXT, anything broken). If the task
is underspecified, write the question in QUESTIONS.md and stop. Do not expand scope.
Do not refactor code outside the task. Do not add dependencies not listed in PLAN.md
section 4 without writing a QUESTIONS.md entry first.

Hard architectural rule: packages under packages/samsara/ are domain-agnostic. They may
not contain travel vocabulary or import any @dt/* package. Travel lives in the places
PLAN.md section 1.6 lists, and nowhere else. Run `pnpm check:seam` before you report done.
```

### Definition of done for any task

1. Code compiles, typecheck passes (`pnpm typecheck`), lint passes.
2. Unit tests exist for pure logic (parsers, scorers, dedup). Integration tests that hit Solari are tagged `@live` and skipped in CI.
3. Any Solari session opened is closed in a `finally`. Any sandbox is `kill()`ed, not `close()`d.
4. `STATUS.md` updated. If a decision was made that the plan didn't cover, an ADR exists.
5. No secrets in the repo. `.env.example` updated if a new variable was introduced.
6. `pnpm check:seam` passes. No package under `packages/samsara/` gained a travel word or a `@dt/*` import. See section 1.6.

### Division of labour between executors

Either executor can do any task. Practical split that has worked elsewhere:

- **Claude Code:** Samsara packages, Solari integration, scheduler, data model, the domain-pack contract, anything where correctness matters more than speed.
- **`agy` (Gemini Pro):** frontend iteration, UI polish, copy, design-system components, adapter parsers against saved fixtures, exploratory prototypes.

Invoke the second executor as `agy --model <gemini-pro-id> -p "<task>"` from the repo root, or interactively with `agy -i`. Give it the same session protocol block.

Hard rule: never run two executors on the same package at the same time. If parallel, use separate branches named `exec/<package>/<task-id>`.

### Escalate to the architect when

- A task would require violating a non-goal (section 1.3).
- A scraping target blocks you after two adapter strategies.
- Solari spend for a single task exceeds the budget in section 8.
- The data model needs a new entity.

---

## 1. Product definition

### 1.1 One line

**Doen Thang** is a Travel OS: it runs background processes on your behalf (watching prices, living inside local feeds, resolving places) and hands you the results as executable Postcards inside a trip document you just type into.

**Samsara** is what actually runs underneath: a service layer over Solari that maintains situated personas, harvests what they see, refines it into structured evidence, and probes any URL from any country on a schedule. Doen Thang is the first thing built on it. It should not be the last.

### 1.2 The three pillars, ranked by build priority

| Priority | Pillar | Internal name | What it is | Why this rank |
|---|---|---|---|---|
| 1 | Discovery | **Persona Lab** + **Harvest** | Locally situated browser personas read regional feeds; a pipeline turns what they see into structured, geocoded Places with evidence. | The only pillar with no direct competitor and the only one that produces a demo nobody else can make (tourist feed vs local feed, side by side). |
| 2 | Retention | **Trip Document** + **Postcards** | A dynamic document (type like a journal) whose blocks are typed, geo-aware Postcards. Map and timeline are derived views, not separate tools. | Where the harvested places land. Without it, Discovery is a feed with nowhere to go. |
| 3 | Hook | **Hundred Eyes** | Price observatory: one URL, N countries, one table of what each locale is shown. | Cheap to build once Solari wrapper exists. Great marketing. Deliberately scoped to observation only (see non-goals). |
| Later | Execution | **Agents** | Sandbox agents that act on a Postcard (book a train, hold a table). | High value, high liability, needs the first three to exist. |

### 1.3 Non-goals for v1 (these are decisions, not omissions)

- **No purchase routing through proxies.** Hundred Eyes shows price discrimination; it never completes a transaction on a foreign locale. Billing-address mismatch, ToS exposure, and denied-boarding risk make this a liability we don't want. Revisit only with a partner that can legally issue localized payment.
- **No auto-posting to the user's Instagram/TikTok.** Logging into users' social accounts from cloud browsers is an account-ban and trust problem. Export a scrapbook page instead; let them post it.
- **No logged-in persona farming in Phase 1.** Tier 1 harvest uses logged-out surfaces only. Seeded, logged-in personas are Phase 5 and gated on legal review.
- **No infinite canvas.** The document is linear text with rich blocks. Spatial views are derived.
- **No mobile native app.** Responsive web. A PWA wrapper is acceptable in Phase 6.
- **No multiplayer editing in v1.** Single-owner documents with share links. Yjs later.

### 1.4 First user, first city

- **First city:** Bangkok. Reason: brand alignment, Thai-language content is abundant on TikTok/YouTube, strong local forum culture (Pantip), and hostile-enough anti-bot posture to prove the pipeline without being the hardest target.
- **Answered by ADR-0015: Bangkok stays, and the Thai IP was never the load-bearing part.** Platforms
  rank by a stack of signals — account region, query language, stored region preference, browser
  locale and timezone, engagement history, and only then the egress IP. A persona that asks in Thai,
  from a `th-TH` browser on `Asia/Bangkok`, with Thai regional parameters and a warmed profile, is
  closer to a Bangkok viewpoint than a Thai IP asking in English would be. Egress is one ingredient
  and the weakest; Singapore supplies it, one hour and 1,400km away, labelled as what it is.
- **The finding that forced this, from P0.4: Solari has no Thai residential egress.** A live launch with `country: "th"` returns `400 Unsupported proxy country`; the pool is `au br ca de es fr gb in it jp kr mx nl sg us` (read 11 September 2026, recorded in `packages/samsara/kernel/src/countries.ts`). A Bangkok persona therefore cannot browse from a Thai IP today. The kernel refuses `th` locally and names `sg` as nearest, but **never substitutes it** — a silent country swap would change what a persona sees, which is the one variable the Persona Lab exists to hold still. This is question 9 in section 10 and is Aswin's call, not the kernel's.
- **First user:** an English-speaking traveller with 2 to 6 weeks before a Bangkok trip, who already saves TikToks and screenshots and has nowhere to put them. Not the backpacker on a shoestring; the person who would pay $8/month to not eat at a tourist trap.
- **Second city (Phase 6 validation):** Tokyo. Different script, different platforms (Tabelog), proves the adapter model generalises.

### 1.5 What "OS" means here, honestly

Doen Thang is a service layer, not an operating system. Solari supplies the isolated machines, the proxies, and the profile storage; Samsara supplies scheduling, budgets, deadlines, and a pipeline; Doen Thang supplies a document. No process table, no memory manager, no syscall boundary. Anyone reading the code should read it as an orchestration layer over a compute API, because that is what it is.

The metaphor still earns its place in the **product**, and we keep it there: the UI says TRAVEL OS, the ops view is `/kernel`, loading states name the daemon that is running. That is honest exactly as long as the daemons are real — background work that continues when the tab is closed, personas with persistent state, Postcards that do something when clicked. The day those become a landing page, the word becomes a lie and we drop it.

So the table below is a **product** rubric, not an architecture diagram. Use it to decide what belongs in v1:

| Metaphor | Doen Thang implementation | Where it lives |
|---|---|---|
| Kernel | Session orchestrator over Solari: allocates browsers/sandboxes, enforces budgets, kills strays | `apps/worker` + `@samsara/kernel` |
| Processes | Long-running jobs: persona keepalive, harvest runs, price watchers | Rows in a `jobs` table, drained by a scheduled runner |
| Filesystem | Trip documents and typed Postcards with metadata | Postgres, `@dt/core` schemas |
| Syscalls | Postcard actions (`refresh`, `watch`, `resolve`, later `execute`) that dispatch to the orchestrator | `apps/api` |
| Users / context switch | Persona selection: "tourist view" vs "local view" swaps which personas harvest | `@samsara/personas` |
| Daemons | Scheduled keepalive and watcher ticks | GitHub Actions cron, enqueuing the next tick |

If a feature request doesn't map to one of these rows, it's an app feature, not an OS feature, and it goes to the backlog.

---

### 1.6 Samsara: the horizontal layer and the seam

**The primitive.** Situated observation. Give Samsara an identity (country, locale, optional persisted browser profile) and a target (a query on a platform, or a URL), and it returns what that identity was actually shown, with evidence, repeatably, on a schedule, under a budget. Everything Doen Thang does is that primitive plus a travel-shaped interpretation of the results.

**Why it matters commercially.** The same engine, with a different domain pack, does algorithm auditing (what does TikTok show a teenager in Jakarta versus Lyon), geo-pricing intelligence, localised SERP and ad monitoring, in-language market research, and diaspora feeds. Most of those are B2B and pay 50 to 500 times what a traveller pays for a Pro plan. We are not building them now — platforms without a wedge die quietly — but we refuse to make them expensive later.

**The rule.** Exactly four kinds of thing are allowed to know the word "travel":

| Allowed to know about travel | Not allowed, ever |
|---|---|
| `packages/travel/pack/**` — the domain pack: entity schema, prompts, resolver, dedup keys, scoring weights, query sets, city configs | `packages/samsara/**` — every engine package |
| `packages/travel/core/**`, `packages/travel/db/**` — Trip, Document, Postcard, and their tables | Any engine Zod schema, DB column, queue name, or log field |
| `packages/travel/ui/**` — Postcards, map, timeline, design system | Any engine prompt file |
| `apps/web/**` — the entire travel UI | `apps/api` and `apps/worker` route/queue *plumbing* (they wire packs in, they don't hardcode one) |

**How it is enforced.** Two mechanical checks in `pnpm check:seam`, run in CI and in the definition of done:

1. **Lexicon check.** Fail if any file under `packages/samsara/**` matches a word-boundary hit on a forbidden list: `travel`, `trip`, `place` (as an identifier), `postcard`, `hotel`, `flight`, `itinerary`, `tourist`, `bangkok`, `tokyo`, `restaurant`, `booking`. Escape hatch: a line-level `// seam:allow <reason>` comment, which the check counts and prints. If the allow-count climbs above five, the seam is wrong and we redesign it rather than adding a sixth.
2. **Dependency direction check.** Fail if any `packages/samsara/*/package.json` lists a `@dt/*` dependency. The arrow points one way: travel depends on Samsara, never the reverse.

Source adapters are the subtle case and the rule is: **adapters are per-source, not per-domain.** A TikTok adapter, a Google Maps reviews adapter, a Booking.com price adapter are all horizontal — algorithm auditors and pricing analysts want exactly the same ones. They live in `@samsara/sources`. What is travel-specific is *which queries we run, in which city, and what we conclude from the results*, and that is the domain pack.

**When to break the seam.** When holding it would cost more than a week of travel-product progress. In that case: write an ADR saying what leaked and what it would take to clean up, get Aswin's sign-off, and proceed. The seam exists to keep the second vertical cheap, not to be a religion.

---

## 2. Architecture

### 2.1 Monorepo layout

Two scopes, one repo. `@samsara/*` is the domain-agnostic service layer; `@dt/*` is travel. The directory split is what the seam check keys on, so it is load-bearing, not cosmetic.

```
doen-thang/
  apps/
    web/                  React + Vite + TS. TanStack Router + Query. Tailwind. Travel UI. @dt scope.
    api/                  Hono on Node 22. REST + SSE. Auth middleware. Thin: validates, enqueues, reads.
    worker/               Scheduled runner: claims jobs, drains, exits. All Solari sessions are opened here and only here.
  packages/
    samsara/              ---- the service layer. No travel vocabulary below this line. ----
      core/               @samsara/core     Zod schemas for engine entities (section 3.1). Deps: zod only.
      db/                 @samsara/db       Drizzle schema for engine tables. Exports schema; owns no migrations.
      kernel/             @samsara/kernel   Solari wrapper: session registry, budget guard, deadlines, retry, logs.
      personas/           @samsara/personas Persona lifecycle: create, seed, keepalive, health, ban detection.
      sources/            @samsara/sources  Source adapters, one folder per source. Per-source, not per-domain.
      harvest/            @samsara/harvest  Run orchestration: persona x source x query -> RawItem[].
      refine/             @samsara/refine   The pipeline (extract/resolve/dedup/score) + the DomainPack contract.
      probe/              @samsara/probe    Locale probe: one URL x N countries -> Observation[]. Hundred Eyes' engine.
      llm/                @samsara/llm      Provider-agnostic interface. OpenRouter by default. Model is config, not code. Engine prompts only.
    travel/               ---- vertical one. Everything here may know it is about travel. ----
      pack/               @dt/travel-pack   The domain pack: Place schema, prompts, resolver, dedup, scoring, queries.
      core/               @dt/core          Zod schemas: User, Trip, Document, Postcard.
      db/                 @dt/db            Travel tables + composes @samsara/db. Owns migrations/ for the one database.
      ui/                 @dt/ui            Design system: tokens, Postcard components, map primitives.
  docs/
    PLAN.md STATUS.md QUESTIONS.md adr/ phases/
  tools/
    check-seam.ts         Lexicon + dependency-direction check. Wired to `pnpm check:seam`. See section 1.6.
  examples/               Keep the Solari cookbook examples as reference. Do not import from them.
```

Tooling: pnpm workspaces, Turborepo for task graph, Biome for lint/format, Vitest, tsx for scripts.

Two consequences worth stating plainly, because they are where the seam usually breaks:

- **`apps/api` and `apps/worker` wire packs in; they do not hardcode one.** A queue is `refine.run` carrying a `domainId`, not `refine.places`. A route is `/entities/:domainId/...` or it is a travel route that calls a generic service. Today there is one pack registered and that is fine; the registry still exists.
- **`@dt/db` owns the single migration history.** `@samsara/db` exports Drizzle table definitions and nothing else. One Postgres, one `migrations/` folder, no cross-package migration ordering problem. If Samsara is ever extracted to its own repo, that folder splits then, not now.

### 2.2 Runtime topology

Revised by ADR-0014. There is no always-on box and no Redis: a fixed monthly hosting fee competes directly with the browser minutes that produce the demo's actual output.

```
Browser (web)                      GitHub Actions (scheduled)
      |                                      |
      | HTTPS                                | wakes, claims jobs, drains, exits
      v                                      v
  api (Hono on Cloudflare Workers)       worker (Node)
      |                                      |
      |  Hyperdrive                          |  jobs table:
      v                                      v  SELECT ... FOR UPDATE SKIP LOCKED
                    Postgres (Supabase)  <-------------------  Solari API
                            ^                                  (browsers, sandboxes)
                            |
                    Object storage (Supabase Storage): screenshots, session recordings, thumbnails
```

Rules that follow from this:

- **Only `apps/worker` talks to Solari.** The API never opens a browser. This keeps sessions in one process with one registry and one budget guard.
- **`apps/web` and `apps/api` are on Cloudflare's free plan; `apps/worker` is a scheduled GitHub Actions job.** The deciding limit is CPU, not duration: free Workers allow 10 ms of CPU per invocation, which a thin API can meet and a parser cannot. See ADR-0014.
- **`apps/api` must stay genuinely thin**, and the platform now enforces that rather than leaving it to discipline. P0.5 measures CPU per request and records the number. The fallback if it does not fit is Supabase Edge Functions, not a paid plan.
- **The queue is a Postgres table, not Redis.** A queue exists to hand work to an always-on consumer; once the consumer wakes on a schedule and exits, the table is enough.
- **Every job is idempotent and resumable.** A scheduled runner can be cancelled mid-flight. Jobs claim rows under a lease, and an expired lease is reclaimable. This is stricter than BullMQ needed, and it is the real cost of ADR-0014.
- **Every Solari session gets a row in `sessions`** with purpose, owner (user or system), started/ended, minutes, cost estimate. This is how we know what the OS is doing and what it costs.

### 2.3 Solari usage patterns (from the cookbook, verified)

Two packages: `@solarisdk/browser` (cloud browser, Playwright-compatible pages) and `@solarisdk/sdk` (`SolariClient`, sandboxes, desktops).

```ts
// Browser: stealth is required for proxy and captcha.
const browser = await solari.launch({
  stealth: true,
  proxy: { country: "th" },                       // or { country: "th", tier: "mobile" }
  // proxy: { country: "th", session: "bkk-p01" } // sticky IP for a persona
  // captcha: true,
  profileId,                                       // optional persisted persona
})
// Profiles persist cookies + localStorage server-side. Saving is explicit:
const state = await page.context().storageState()
await solari.profiles.save(profile.id, state)
// Always: browser.close() in finally; solari.close() at process shutdown.

// Sandbox: argv, not shell. kill(), not close().
const sb = await pt.sandboxes.create({ template: "base", timeoutMs: 5 * 60_000 })
await sb.commands.run("sh", { args: ["-c", "..."] })
await sb.kill()
```

Gotchas the executor must encode in `@samsara/kernel`:

- `timeoutMs` is a rolling idle window, not a deadline. The kernel enforces its own hard deadline per session purpose (default 4 minutes for harvest, 90 seconds for a price probe).
- Session recording is opt-in per session (`recording: true`). Turn it on for the first N runs of any new adapter, off by default in production.
- `proxy` and `captcha` both require `stealth: true`. The kernel should refuse a config that violates this rather than let Solari reject it.
- Pin `@solarisdk/browser` to a known version. Check the changelog (changelog.getsolari.com) before bumping.

### 2.4 The kernel (`@samsara/kernel`)

Responsibilities, in priority order:

1. **Session registry.** In-memory map plus a DB row per session. On worker boot, reconcile: any session marked open in the DB with no live handle gets logged as orphaned.
2. **Budget guard. Three meters, not one.** Solari minutes are the cheapest thing this system spends; LLM tokens and geocoding calls are the two that can actually overrun the ceiling. A guard that counts only minutes is theatre. Each meter has a hard ceiling expressed as a **count, not dollars** — no FX or rate-drift guesswork at runtime — and exhausting any one refuses the operation that would spend it, loudly, with the meter named in the error. Within the minutes meter the three windows still apply: global per day, per-user per day, per-purpose per run. Counters are rows in Postgres, keyed by meter and window — ADR-0014 removed Redis, and a budget guard that forgets what it spent when a runner exits is not a guard. The ceilings are constants in one file, each carrying the rate it was derived from in a comment beside it (see section 8). All three meters appear on the `/kernel` screen from the day that screen exists.
3. **Hard deadline.** `withSession(purpose, opts, fn)` wraps every launch with a timeout that force-closes the browser. `fn` never gets a raw browser without this wrapper.
4. **Retry policy.** Retry on network/launch errors up to 2 times with jitter. Never retry on block/captcha-failed; surface as a `Blocked` result so the adapter can try its next strategy.
5. **Structured logs.** One JSON line per session lifecycle event with purpose, persona, country, duration, outcome, bytes.

Interface sketch:

```ts
type SessionPurpose = "persona.seed" | "persona.keepalive" | "harvest" | "probe" | "agent"
withBrowser<T>(purpose, { country, personaId?, recording?, deadlineMs? }, fn: (page) => Promise<T>): Promise<Result<T, Blocked | Timeout | Error>>
withSandbox<T>(purpose, { template, deadlineMs }, fn): Promise<Result<T>>
```

Note `SessionPurpose` is a closed union of *engine* purposes. It does not gain a member when a vertical is added; a vertical's work is a `harvest` or a `probe`, tagged with its `domainId` in the session row.

---

### 2.5 The domain pack (`@samsara/refine`)

This is the contract that makes Samsara agnostic, and the single most important interface in the repo. The pipeline machinery — batching, LLM calls, retry, caching, merge, explanation capture, job chaining — is generic and lives in `@samsara/refine`. Everything that knows what an entity *is* lives in a pack.

```ts
// @samsara/refine — the contract. No travel words appear in this file.
export interface DomainPack<TMention, TEntity> {
  id: string                      // "travel". Stamped on every Mention, Evidence, and Session row.
  version: string                 // Bump when prompts or weights change; stored with each Evidence row.

  extract: {
    mentionSchema: ZodType<TMention>          // what the LLM must return per raw item
    prompt: PromptRef                         // versioned prompt file, lives in the pack
    batchBy: (item: RawItem) => string        // e.g. group by detected language
  }

  entity: {
    schema: ZodType<TEntity>
    repo: EntityRepo<TEntity>                 // pack owns its own table; engine never writes it directly
  }

  resolve(m: TMention, ctx: ResolveCtx): Promise<Resolution<TEntity>>   // mention -> real-world entity
  dedupKeys(e: TEntity): DedupKey[]                                     // ordered: strongest key first
  score(e: TEntity, ev: Evidence[]): ScoreSet                           // named scores, each explainable
  sources: SourceId[]                                                   // which @samsara/sources adapters to run
  queries(ctx: QueryCtx): HarvestQuery[]                                // what to ask, from which personas
}

type DedupKey  = { kind: "exact" | "fuzzy" | "geo" | "embedding"; value: string; radiusM?: number }
type ScoreSet  = Record<string, { value: number; because: Explanation[] }>
type Explanation = { factor: string; contribution: number; evidenceIds: string[] }
```

Design notes the executor must honour:

- **A pack is a plain object, not a plugin system.** No dynamic loading, no manifest format, no sandbox. It is imported and passed to the pipeline at worker boot. Registration is a `Map<string, DomainPack>` in `apps/worker`.
- **`ScoreSet` carries its own explanation.** Product principle 3 ("show the algorithm") is therefore satisfied generically: any UI can render why a score is what it is, for any vertical, without the engine knowing what the score means. `localScore` is a travel word; `scores.local` is a key in a generic map.
- **`repo` inverts ownership.** The engine calls `repo.upsert`, `repo.findByKeys`, `repo.merge`. The `places` table is defined in `@dt/db` and the engine never imports it.
- **Anything a pack needs that the engine can't give it is a missing engine capability,** not a reason to reach across the seam. Write it in QUESTIONS.md.

---

## 3. Data model

Entities are listed with the fields that matter for design. Executors add timestamps, ids, and indexes as standard.

One Postgres, one migration history, two schema modules. **An engine table never holds a foreign key to a travel table.** Where the engine must point at a domain entity it stores an opaque pair `(domainId, entityId)` with no FK constraint, and the pack's `repo` resolves it. Travel tables may point at engine tables freely.

### 3.1 Engine tables (`@samsara/core` + `@samsara/db`)

No travel vocabulary appears in this subsection. That is the test.

**Persona**: id, name, locality (free text: the city or region this identity reads as being in), country (proxy country), locale, tier (`anon` | `seeded`), solariProfileId?, proxySession? (sticky IP key), health (`healthy` | `degraded` | `banned` | `retired`), seedPlanId?, lastAliveAt, stats (sessions, minutes, blocks).

**SeedPlan**: id, locality, steps[] (ordered: visit URL, dwell seconds, scroll, search term). Versioned so we can compare persona drift across plans.

**Session**: id, purpose, ownerId? (opaque; the engine does not know what a user is), domainId?, personaId?, country, startedAt, endedAt, minutes, outcome, recordingRef?.

**HarvestRun**: id, domainId, personaId, sourceId, query, startedAt, endedAt, outcome, itemCount, sessionId.

**RawItem**: id, harvestRunId, sourceId, url, title, text, languageGuess, mediaRefs[], engagement (views, likes, comments, nullable), capturedAt, rawRef (object storage key). The unit a source adapter produces; the unit `extract` consumes.

**Mention**: id, rawItemId, domainId, packVersion, payload (JSON, validated against the pack's `mentionSchema`), entityId? (null until resolved), resolution (`pending` | `resolved` | `unresolvable`), confidence.

**Evidence**: id, domainId, entityId (opaque, no FK — see section 3 preamble), rawItemId, sourceId, sourceUrl, personaId, language, capturedAt, extract (JSON, pack-shaped), rawRef, engagement.

**ProbeTarget**: id, ownerId?, sourceId, url, parsed (JSON, shape declared by the source adapter), watch (boolean), cadence.

**Observation**: id, targetId, country, personaId?, capturedAt, payload (JSON, shape declared by the source adapter), screenshotRef, sessionId, notes. Generic on purpose: a price is one payload shape, a ranked SERP is another, a rendered ad slot is a third. The probe engine does not know which.

**BudgetCounter**: id, meter (`solari.minutes` | `llm.input.tokens` | `llm.output.tokens` | `geocode.calls`), window (`global.day` | `owner.day` | `purpose.run`), windowKey (the day, owner, or run the count belongs to), amount. Unique on (meter, window, windowKey), incremented atomically. Added in P0.4 rather than listed here from the start: section 2.4 describes a three-metered guard, and a guard that holds its counts in memory is a guard that forgets them between a Worker invocation and the next. Four counters, three meters — LLM input and output are priced differently and so are counted separately.

### 3.2 Travel tables (`@dt/core` + `@dt/db`)

**User**: id, email, plan (`free` | `pro`), locale, budget overrides. Auth and billing are app concerns; the engine only ever sees `ownerId: string`.

**Trip**: id, userId, title, destinationCity (canonical), startDate, endDate, status (`dreaming` | `planning` | `travelling` | `done`).

**Document**: id, tripId, content (Tiptap/ProseMirror JSON), version. One document per trip in v1.

**Postcard**: id, tripId, kind (`place` | `price` | `note` | `photo` | `link` | `checklist`), placeId?, payload (kind-specific JSON), geo (lat/lng, nullable), time (date or range, nullable), sourceRefs (Evidence ids), state (`fresh` | `stale` | `pinned`). A Postcard is the only thing that appears on the map. If it has no geo, it doesn't.

**Place**: id, canonicalName, localName (native script), city, geo, externalRef? (`{ source: 'osm' | 'geocoder' | 'artifact', id: string }` — ADR-0017 replaced `googlePlaceId` with a source-tagged reference, because the resolver is now tiered and the winning tier has to be recoverable), resolvedTier? (0-3), category (`food` | `drink` | `market` | `temple` | `nature` | `nightlife` | `shop` | `other`), tags[], scores (JSON `ScoreSet`: `local` and `tourist`, each with a value 0 to 1 and its `because` explanations), firstSeenAt, lastSeenAt, evidenceCount. Written only through `@dt/travel-pack`'s `EntityRepo`.

There is no `PriceTarget` or `PriceObservation` table. Travel reads `ProbeTarget` and `Observation` filtered to `sourceId in (booking, agoda)` and renders them as Price Postcards. If that proves awkward in Phase 3, a travel-side view is acceptable; a duplicate table is not.

---

## 4. Stack decisions (ADR-0001 through ADR-0014, executor records these on Phase 0)

| # | Decision | Choice | Reason | Swap point |
|---|---|---|---|---|
| 0001 | Language | TypeScript everywhere | One language for executors, Solari's primary SDK is TS | None |
| 0002 | Web | React + Vite, TanStack Router/Query, Tailwind | Aswin's existing fluency (Solitary Reaper stack). No SSR needed for an app behind auth. | Next.js if SEO landing pages need to live in the same app; they don't, landing goes on Astro |
| 0003 | API | Hono on Node 22 | Small, typed, fast, runs anywhere | Fastify if plugin ecosystem needed |
| 0004 | Jobs | ~~BullMQ on Redis~~ — superseded by ADR-0014. A `jobs` table in Postgres, claimed with `FOR UPDATE SKIP LOCKED` by a scheduled GitHub Actions runner. | A queue serves an always-on consumer. ADR-0014 removed the always-on consumer, so the queue went with it — one fewer vendor, one fewer line item | BullMQ on Upstash if a job ever needs sub-minute latency or fan-out that a scheduled drain cannot give |
| 0005 | DB | Postgres on Supabase with Drizzle | Auth + Postgres + storage from one vendor cuts Phase 0 time; Drizzle keeps schema in TS | Neon + Clerk if Supabase auth chafes |
| 0006 | LLM | Provider-agnostic `@samsara/llm`. Superseded in part by ADR-0012: the default route is OpenRouter, not a direct Anthropic key. | Extraction is high-volume, so cost dominates model preference | Any provider behind the interface |
| 0007 | Geocoding | ~~Google Places API (Text Search + Details) with Nominatim fallback~~ — superseded by ADR-0017 | Premise was a discovery problem; discovery happens in the harvest | — |
| 0008 | Maps (UI) | MapLibre GL with a styled vector basemap. Tile source settled by ADR-0018 | Free, styleable to the brand palette, no Google Maps branding in the UI | Leaflet if MapLibre is overkill (Aswin has Leaflet experience from the ARG) |
| 0009 | Layer split | Two scopes in one repo: `@samsara/*` service layer, `@dt/*` travel vertical, seam enforced by `pnpm check:seam` | Keeps the second vertical cheap without paying two-repo tax before there is a second vertical | Extract `packages/samsara/` to its own repo when a paying non-travel use case exists. Directory layout is chosen so this is a `git filter-repo`, not a refactor |
| 0010 | Verticals | Domain pack: a plain TS object implementing `DomainPack` (section 2.5), registered in a Map at worker boot | Plugin systems are a tax paid up front for flexibility we don't need yet; a typed object gets 90% of the benefit for none of the cost | A real plugin host with dynamic loading, if third parties ever write packs |
| 0011 | Naming | "OS" is product-facing language for Doen Thang only. Code, schemas, logs, and docs say service layer, orchestrator, pipeline | Honest architecture beats a flattering metaphor in the place where correctness matters; the metaphor still earns its keep in the UI | Drop the metaphor from the product too, if the daemons stop being real |
| 0014 | Hosting | Cloudflare Workers (free) for `apps/web` and `apps/api`; GitHub Actions scheduled workflow for `apps/worker`; no Redis | Free Workers meter CPU, not wall clock, at 10 ms per invocation — fine for a thin API, impossible for a parser. A free runner beats $5/month out of a $20 budget | Workers Paid ($5/mo) for a 30s cron CPU ceiling, or Fly.io, if the demo becomes a product with revenue |
| 0013 | Auth | Supabase Auth. `apps/api` verifies the JWT and uses `sub` as `ownerId`; the travel `users` table keys on that id. No RLS in v1 — authorisation lives in the API layer, because the worker writes for users who are not present. | One vendor already holds Postgres and storage; a second auth vendor buys better components at the cost of a second id space, for a requirement that is "email in, JWT out" | Neon + Clerk, per ADR-0005's swap point. The seam keeps auth entirely above the engine, so the move stays cheap |
| 0012 | LLM routing | OpenRouter as the single LLM gateway. One key, many models. The model for each task is an env var, never a literal in code. | Under a $20 ceiling the extraction model must be chosen by measurement, not by preference — and swapping it must cost nothing. Replaying stored RawItems is free on the Solari meter, so the bake-off is cheap. | A direct provider key, if OpenRouter's markup or a rate limit ever exceeds the cost of the vendor sprawl it removes |
| 0015 | Viewpoint | A session's viewpoint (locale, timezone, geolocation) is set by us and is independent of the proxy country. The kernel builds its own browser context; the provider sets neither | Platforms rank local content from a signal stack in which the egress IP is the last and weakest term. Solari carries no `th` egress and has none planned, so the viewpoint has to carry the weight | Residential `th` egress, if a provider ever offers it — it would strengthen the stack, not replace it |
| 0018 | Basemap | A single Protomaps `.pmtiles` extract on Cloudflare static assets or R2, read by MapLibre over range requests. Amends ADR-0008 | Removes the last map vendor: no tile server, no key, no quota a public demo can exhaust | MapTiler or Stadia free tiers, if hosting the extract proves fiddlier than it looks |
| 0017 | Place resolution | Tiered and Google-free: coordinates already in the harvested artifact, then an OSM named-POI extract in our own Postgres, then a free-tier hosted geocoder, then `unresolvable`. Supersedes ADR-0007 | The resolve stage is handed a place the harvest already chose, so it needs a coordinate, not an index — and Places was the only vendor that could bill the card by default | Mapbox or Places behind a hard quota cap, if Tier 0 and Tier 1 miss more than P2.3's acceptance allows |
| 0016 | Progress + dispatch | Progress is pushed on state change with a bounded, backing-off stream; foreground jobs are dispatched via `workflow_dispatch` rather than waiting for cron. Amends ADR-0014 | A once-per-second poll behind SSE spends 86,400 of the free plan's 100,000 daily Hyperdrive queries per open tab, and the 5-minute cron floor makes a foreground progress bar look dead | Durable Objects or Cloudflare Queues, if the demo ever justifies a paid Workers plan |

Approved dependency list beyond the above: zod, drizzle-orm, hono, @tiptap/core and extensions, maplibre-gl, date-fns, ~~pino~~, vitest, playwright (types only; runtime comes from Solari). **pino went unused:** the repository is public, so the Actions log is public, and P0.4's logger is a closed union of typed events with no free-form field — a library whose whole affordance is `.info(anyObject)` is the wrong shape for a log nobody can take back. For LLM calls, OpenRouter speaks the OpenAI wire format, so `openai` is the client — pointed at OpenRouter's base URL, never at OpenAI.

---

## 5. Phase plan

Each phase has a goal, tasks sized to one executor session (roughly 1 to 3 hours of agent work), acceptance criteria, and a gate. Do not start a phase until the previous gate is met. Estimates assume one executor session per day; adjust freely, but keep the order.

### Phase 0: Foundation (about 1 week)

**Goal:** a repo where any future task can be done without setup work. Nothing user-facing.

Tasks:
- **P0.1** Scaffold monorepo per section 2.1, both scopes, empty packages. pnpm, Turborepo, Biome, Vitest, tsconfig base. `pnpm typecheck && pnpm test` green. Move cookbook examples to `examples/` untouched.
- **P0.2** `@samsara/core`: Zod schemas for every entity in section 3.1. `@dt/core`: section 3.2. Export inferred types. Tests: each schema parses a fixture, and `@samsara/core` has no `@dt/*` import.
- **P0.3** `@samsara/db`: Drizzle tables for 3.1, exported as a schema object, no migrations. `@dt/db`: travel tables for 3.2, composes the Samsara schema, owns `migrations/`. Local Postgres via docker-compose, seed script with one user and one trip.
- **P0.4** `@samsara/kernel`: `withBrowser` and `withSandbox` with registry, hard deadline, retry policy, structured logs. **The budget guard is three-metered from this task, not later** (section 2.4): minutes, LLM tokens, geocoding calls, each with a hard ceiling from section 8, each refusing its operation when exhausted and naming the meter in the error. Acceptance: a unit test drives each of the three meters past its ceiling and asserts the refusal; the `@live` test opens a proxied browser, hits ipify, asserts a real egress address, and closes. **Amended 11 September 2026:** the live test was specified against `th` and `th` turned out not to exist in the provider's pool (see section 1.4), so it runs against `sg`. Done: 62 unit tests green, live run 0.042 minutes for a probe session — the first real number for the minutes meter. Record ADRs 0001 to 0014.
- **P0.5** `apps/worker`: a scheduled-runner entry point (claim, drain, exit) against a `jobs` table with `FOR UPDATE SKIP LOCKED`, one no-op job type, a `Map<string, DomainPack>` registry with zero packs registered, and a shutdown path that closes every kernel session on SIGTERM — a runner can be cancelled mid-flight (ADR-0014). `apps/api`: Hono on Cloudflare Workers with a health endpoint, Supabase JWT middleware (ADR-0013), and Postgres through Hyperdrive. Acceptance includes a **measured CPU-per-request number against the free plan's 10 ms ceiling**, recorded in STATUS. If it does not fit, the fallback is Supabase Edge Functions, not a paid plan.
- **P0.6** Dev ergonomics: `pnpm dev` runs api + worker + web with hot reload. `.env.example`. `docs/STATUS.md` initialised.
- **P0.7** `tools/check-seam.ts` and `pnpm check:seam`: the lexicon check and the dependency-direction check from section 1.6, plus the `// seam:allow` counter. Wire into the Turbo task graph so `pnpm check` runs it, and into CI. Test it both ways: a fixture file with a forbidden word fails, the real tree passes. Record ADR-0009.
- **P0.8** *(added by the executor, 12 September 2026)* **Run the acceptance criteria below, literally, from a cold clone.** Not a review — an execution: clone into an empty directory, follow the README as written, time it; run the `@live` test and read the session row back out of Postgres with SQL; plant a travel word and watch `check:seam` fail. This was not a task in the original plan, and it should have been. Two of the three criteria were false when first executed and had been for days without producing a symptom. **The general lesson, for every phase after this one: an acceptance criterion that has never been executed is a claim, not a test, and the phase it belongs to is not finished.** Done: 31 s to a green check against a 10-minute budget; two silent-green defects and one real timezone-aliasing bug found and fixed. See STATUS.

Acceptance: a fresh clone reaches `pnpm dev` in under 10 minutes following README. The `@live` kernel test passes and its session row appears in Postgres. `pnpm check:seam` passes and demonstrably fails when a travel word is planted under `packages/samsara/`.

Gate: Aswin reviews the kernel interface, the `DomainPack` contract, and ADRs 0009 to 0014. Nothing else.

### Phase 1: Persona Lab (about 2 weeks)

**Goal:** create a persona in Bangkok, read what it sees on logged-out surfaces, and visualise how that differs from a US persona. This is the demo and the science experiment.

Tasks:
- **P1.0** **Signal-matrix experiment** (ADR-0015). One query, run across a matrix of viewpoints:
  egress country (`sg`, `us`) x locale (`th-TH`, `en-US`) x query language (Thai, English) x stored
  region preference (set, unset). Measure pairwise URL overlap in the top 20. Output: a table of
  which signals actually move the result and by how much, which sets the priority order for every
  adapter after it — and is the honest answer to "how do you get local content without a local IP".
  Budget: 16 cells x ~0.5 minutes, under 10 browser-minutes, well inside the per-task 30-minute cap.
  Do this **before** P1.3 to P1.6, so the adapters are built against measured signal weights rather
  than assumed ones.
  *Designed 12 September 2026 and corrected in four ways while being designed: the sixteen cells
  carry two replicates, because without a repeated cell the table cannot tell a signal from the
  surface's own minute-to-minute drift; the replicates are forced to span the whole run rather than
  sit next to their originals, so the noise floor is measured over the same timescale as the
  contrasts it calibrates; the run order is shuffled from a recorded seed, so ten minutes of drift
  does not land on the slowest-varying factor and get reported as its effect; and overlap divides by
  what could have been shared rather than by k, so a thin page is not read as a changed one.
  Eighteen sessions, ~9.0 minutes. The arithmetic is in `@samsara/harvest`, the query strings and
  the surface in `@dt/lab`, and the whole zero-cost half is tested with no network.*
  **Run 12 September 2026 — 20 sessions, 4.79 minutes, zero refusals. Query language 100% (zero
  shared results of twenty), egress 31%, locale 23%, stored region 20%, against a 21% noise floor.
  One dominant signal and a flat remainder, not a graded stack. The answer to "how do you get local
  content without a local IP" is that you ask in the local language; the proxy country is worth
  about as much as waiting five minutes. This reorders P1.3–P1.6 around query construction rather
  than proxy geography — see gate question 4 in STATUS and
  `casestudy_and_thinking/sessions/2026-09-12-p10b-the-result.md`.**
- **P1.1** ✅ **Done.** `@samsara/personas`: create persona (row + optional Solari profile + sticky proxy session key), health state machine, `keepalive` job (launch, visit two neutral local pages, save profile, update lastAliveAt). Ban detection heuristic: consecutive `Blocked` results flip health to `degraded`, three in a row to `banned`.
  **Shipped with four departures from the line above, each for a stated reason.**
  (1) The **health streak is derived from `sessions`, not stored** — a stored counter makes a
  threshold change un-retroactive, leaving personas banned under a rule no longer in the codebase.
  Only `ok` and `blocked` count as evidence; a timeout is our clock and an error is our code, so
  neither may ban an identity.
  (2) **`timezone_id` is a stored column** on `personas`, not derived from country or locale —
  P1.0 measured those axes apart and an identity whose clock is computed from its IP cannot
  express the result. `Viewpoint` is now `{country, locale, timezoneId}` in the row, which
  answers gate question 1 by building it.
  (3) The **pages are a job-payload argument**, never a constant: the moment `@samsara/personas`
  knows which pages are ordinary, it holds a vertical's vocabulary and `pnpm check:seam` fails.
  The `persona.keepalive` handler lives in `apps/worker`, on the travel side of the seam.
  (4) **`403` had to be fixed in the kernel first.** Playwright's `goto` does not throw on a
  refusal — it returns a response carrying the status — so every real block classified as
  `internal`, which `retry.ts` retries. The ban detector could not have detected a ban. New
  `Blocked` error class in `@samsara/kernel`, recognised by `classify` before any string match.
  Also new: `ProfileStore` port, `withBrowser`'s `onSession`/`SessionSpend` callback (which
  retires the log-scraping that under-reported P1.0's bill by 32%), three `persona.*` log events,
  migration `0006_persona_timezone`. 54 tests, **0 browser minutes spent**, seam allowances still
  0 of 5. See `casestudy_and_thinking/sessions/2026-09-12-p11-the-identity.md`.
- **P1.2** `@samsara/sources` adapter interface: `harvest(ctx, query): Promise<RawItem[]>` where ctx carries persona, page, logger. Plus `@samsara/harvest`: run orchestration (persona x source x query), rate limiting, `HarvestRun` rows. Fixture-based tests for parsers, separated from fetching. **The adapter interface takes a query string and returns RawItems. It does not know what the caller will do with them.**
  ✅ **Done.** Four departures from the line above.
  (1) **The adapter is two methods, not one.** `capture(ctx, query)` spends; `parse(capture)` does
  not. `parse` is synchronous and receives a `Capture`, never a context — no page, no signal, no
  clock — so an adapter *physically cannot* fetch while parsing. The plan's own justification for
  this phase ("parser iteration opens no browsers … the single largest saving available") is not
  deliverable by a single `harvest()`, which permits the separation without creating it. The
  convenience wrapper `harvest(adapter, ctx, query)` remains, for callers who want both halves.
  (2) **`parse` returns `ItemDraft`, not `RawItem`.** No `id`, no `harvestRunId`, no `rawRef`, no
  `capturedAt`. A parser that minted ids would produce different rows on every re-parse of the
  same archived capture, converting the re-parse saving into a duplicate-insert problem. The
  parser reports what the page said; `runHarvest` decides what the row is.
  (3) **A refusal is carried, not thrown.** `Capture.refusedBy` keeps the consent wall / captcha /
  empty-200 body as evidence; `runHarvest` converts it to `Blocked` inside the kernel callback so
  `classify` sees it and `retry.ts` declines to retry. (4) **An archive failure is fatal to the
  run.** First written as non-fatal; a test caught the result — a run marked `ok` with zero items
  behind it. An item without a `rawRef` looks like evidence and can never be re-read. Accepted
  cost: a bucket outage re-spends browser minutes on retry.
  Also: `MemoryPacer` (per-source minimum interval, slot reserved before the sleep, honest about
  not spanning a process exit), three storage ports (`HarvestRunStore`, `RawItemStore`,
  `CaptureArchive`) rather than one, and a third tier in `tools/check-seam.ts` —
  `FORBIDDEN_SUBSTRINGS` — after `"ที่เที่ยวกรุงเทพ"` passed a green seam check because
  `segments()` erases every script it cannot spell. 43 new tests, **0 browser minutes spent**,
  seam allowances still 0 of 5 across 92 files.
  **Not done here, deliberately:** no `harvest.run` job type is registered in `apps/worker`.
  `runHarvest` takes an adapter, and there is no adapter until P1.3; a registry with no entries
  would be a job type that always fails. Wiring lands with the first real source.
  See `casestudy_and_thinking/sessions/2026-09-12-p12-the-split-and-the-blind-checker.md`.
- **P1.3** Adapter: **YouTube regional trending + search** (logged-out, region param). Most stable target; proves the shape.
  ✅ **Done, with one step deliberately not taken.** `youtube.search` and `youtube.trending` are
  **two** adapters sharing one parser: `sourceId` is the column a stored row is grouped and
  re-parsed by, and a search result is not the same kind of evidence as a trending slot.
  Departures worth knowing about:
  1. **The parser searches the tree, it does not walk a path.** Five renderer names
     (`videoRenderer`, `gridVideoRenderer`, `compactVideoRenderer`, `playlistVideoRenderer`,
     `reelItemRenderer`) at a depth cap of 40. Renderer names are the stable part of YouTube's
     response; the containers around them are not. Encounter order is preserved because encounter
     order is rank order, which P1.8's overlap measurement depends on.
  2. **Redaction is a key-name list (11 keys), not a narrowing of the payload.** Storing only
     `contents.twoColumnSearchResultsRenderer` would be smaller and would move parsing into the
     half that spends — after which every layout change needs a browser session instead of a
     parser. The split does not die in one bad decision; it dies one helpful refactor at a time.
  3. **`counts.ts` returns `null` rather than guess.** 12 scale words across 3 languages; Thai
     counts in powers of ten thousand; `,` is a thousands separator in one language and a decimal
     point in another. A mis-scaled view count ranks content while looking reasonable; a missing
     one is visibly missing. `Engagement` is nullable for exactly this.
  4. **Zero results is not `refusedBy`.** The orchestrator has an `empty` outcome; folding empty
     into blocked would degrade a persona's health over a typo and make a real region block
     indistinguishable from an honest zero.
  5. **`/// <reference lib="dom" />` is file-scoped in `inpage.ts`**, not a package-wide `lib`
     widening as in the lab, because `@samsara/sources` may have to compile for Workers.
  Also: `harvest.run` is now registered in `apps/worker` (7 handler tests), `FilesystemCaptureArchive`
  lands at `@samsara/harvest/node` as an explicit stand-in with a bucket-shaped relative key so the
  Supabase swap is a copy rather than a rewrite of every stored ref, and `apps/worker` gains
  `record:plan` / `record` for fixture capture.
  **Not done, needs a decision:** no live capture has been recorded, so
  `youtube.fixture.test.ts` does not exist and no test in this package has seen YouTube. Recording
  spends a browser session through a paid provider and writes the bytes into a **public** repo,
  where the only protection is an 11-key denylist. `parse.test.ts` says so in its own header.
  **Also fixed here, unrelated:** three packages truncating the same tables concurrently under
  Turbo produced five moving `.pg.test.ts` failures. Now serialised with a Postgres advisory lock
  (`@samsara/db/testing`) rather than `--concurrency=1`; parallel suite 9.6s vs 26.7s serial.
  44 tests in `@samsara/sources`, **0 browser minutes spent**, seam allowances 0 of 5 across 103 files.
  See `casestudy_and_thinking/sessions/2026-09-13-p13-the-first-real-source.md`.
- **P1.4** Adapter: **TikTok logged-out search/discover** with stealth + the P1.0 viewpoint (Thai query, `th-TH` locale, `Asia/Bangkok`, `sg` egress — there is no `th` egress, see ADR-0015). TikTok is the surface most likely to gate on IP geolocation, so this is where the gap shows up if it shows up; report it as a gap rather than working around it. Two strategies: rendered page scrape, then intercepted XHR JSON. Record sessions for first 20 runs.

  ✅ **Done, same one step outstanding.** `tiktok.search` and `tiktok.explore`, two adapters over
  one parser. The brief — "report the gap rather than working around it" — rules out more than it
  rules in: there is no captcha solving, no signature forging, no rotating personas until one gets
  through. The refusal *is* the measurement, and P1.0's result was measured on a surface that
  honours `gl` and `hl`; whether it survives a surface that enforces geography is the open question.
  1. **Three named refusals, not one.** `region-block` is the finding; `captcha` is a judgement
     about this session and feeds persona health; `login-wall` applies to every logged-out visitor
     and degrades a persona that did nothing wrong — an admitted cost, taken because a harvest that
     silently returns nothing from behind a wall is worse. Collapsing them would make the
     interesting one unrecoverable from the row.
  2. **Both strategies always run.** The embedded state (`__UNIVERSAL_DATA_FOR_REHYDRATION__` or
     `SIGI_STATE`) and the intercepted item-list API bodies fail on different days and cost nothing
     to collect together. Choosing between them at capture time means choosing with the least
     information anyone will ever have, inside the half that spends. The parser deduplicates them
     by item id, state first, because state is the page as rendered.
  3. **Recognition is structural, because TikTok does not name its items.** A digit-string `id`, a
     `desc` that is a string, and an `author` or `stats`. Strict on purpose: a loose predicate
     returns music tracks and hashtags as videos, and those get stored as evidence and scored.
     `desc` is tested with `typeof`, not truthiness — an empty caption is a real video.
  4. **`lang` is the only viewpoint parameter TikTok takes.** No `gl`. Region comes from the egress
     IP alone, which is exactly why this adapter and not YouTube's tests ADR-0015's compromise.
  5. **Two redaction entries removed for destroying content.** `signature` on a TikTok author is
     the account bio — content, not a request signature. `userInfo` is the viewer in `SIGI_STATE`
     and a result in the search API, and key-name redaction cannot tell them apart.
  Also: `recording` is now a `harvest.run` payload field rather than an adapter property, because
  "this adapter is new" is a fact about the calendar and encoding it in code means a deploy to turn
  it off; `counts.ts` and `guessLanguage` moved to `src/` (TikTok returns counts as numbers from the
  API and abbreviated strings from the rendered state); the recorder takes `--source` and writes
  next to the adapter it belongs to.
  **One correction worth carrying:** `guessLanguage`'s doc comment claimed Vietnamese diacritics
  are "present in almost any real Vietnamese sentence". True of sentences, false of the four-word
  captions it will actually be handed — `bánh mì ngon quá` contains nothing outside Latin-1. Not
  fixed by widening the class, which would report Spanish as Vietnamese; fixed by correcting the
  claim, asserting the limitation, and preferring the source's own language field.
  **Not done, same decision as P1.3:** no live capture, so `tiktok.fixture.test.ts` does not exist
  and nothing here has run against a real page. 77 tests in `@samsara/sources`, **0 browser minutes
  spent**, seam allowances 0 of 5 across 111 files.
  See `casestudy_and_thinking/sessions/2026-09-13-p14-the-surface-that-says-no.md`.

- **P1.5** Adapter: **Google Maps reviews** for a caller-supplied list of areas; Phase 1 runs it on Thai-language areas (Ari, Charoenkrung, Talat Noi, Yaowarat), but the area list is a parameter, not a constant in the adapter. Extract review text in native script, reviewer language.
- **P1.6** Adapter: **Pantip** (Thai forum) boards; board ids are a parameter. Plain HTML, good signal.
- **P1.7** Persona Lab UI (`apps/web`, internal route `/lab`): list personas, create one for a locality/country, trigger a harvest, view RawItems side by side for two personas on the same query. This is the "tourist vs local" split screen. Rough UI is fine; correctness of the comparison is not. The Lab is an engine-facing tool that happens to live in the travel app: it talks about personas, sources, and queries, not about places.
- **P1.8** Drift experiment: run the same query daily for 7 days from a `us` persona and a `th` persona. Store results. Plot overlap percentage over time in the Lab.
  ✅ **Built, and running: day 0 of seven is in, at 60.0%.** `drift_experiments` plus `experiment_id` /
  `experiment_day` on `harvest_runs` (paired by a CHECK, because half a pairing key is a run that
  can never be put opposite anything); an experiment queues its whole week up front — fourteen rows,
  day-major, anchored to `startedAt` — rather than chaining one job to the next, so a runner that
  dies produces late days instead of days that no longer exist. `MAX_DAYS = 14` is derived from the
  free plan's 50 subrequests (`3 + 2d`), not chosen. A day is one of four states and only
  `compared` carries a number: `overlapAt` returns 0 when nothing was comparable, and on this chart
  a zero is the finding, so the other three states plot as a gap in the line. Stopping is a refusal
  at claim time in the worker, since the remaining days are already queued and there is nothing to
  cancel. `GET /lab/drift/:id` costs 0.539 ms of CPU over a fortnight at the widest k, in two
  queries.
  **One of the seven days has run.** Experiment `f60fb262` on hosted Postgres, `youtube.search`,
  "Bangkok street food", `sg`/`th-TH`/`Asia/Bangkok` against `us`/`en-US`/`America/New_York`, all
  fourteen payloads carrying `recording: true`. **Day 0: 60.0% — twelve of twenty URLs shared, mean
  rank shift 5.2 on the twelve, both sessions `ok` with a `recording_ref`, 0.2388 billed minutes.**
  That is the gate's number to the decimal, from a single day, with `country` deliberately held
  wrong — so it is not yet an answer to anything, and reading it as one would be the compressed-day
  mistake in a different costume. Six days remain queued. They will only run if `DATABASE_URL` and
  `SOLARI_API_KEY` exist as repository secrets; day 0 was drained by hand and that does not repeat
  six times. P0.8's lesson still applies to the other six sevenths: an acceptance criterion that has
  not finished executing is not yet a test.
  See `casestudy_and_thinking/sessions/2026-09-16-p18-a-zero-and-a-gap.md`.

Acceptance: for the query "Bangkok street food", the th persona's top 20 items across adapters share less than 40% URL overlap with the us persona's. Recorded sessions show no captcha loops.

Gate: the split-screen comparison is convincing to Aswin as a demo. If overlap is above 60%, stop and redesign adapters before building the refine pipeline on top of noise.

### Phase 2: Harvest to Postcard pipeline (about 2 weeks)

**Goal:** RawItems become deduplicated, geocoded Places with evidence and a local score, and the first Place Postcards render. Equally: the pipeline that does it contains no travel code.

The split for every task below is the same. The **stage** is generic and lives in `@samsara/refine`. The **knowledge** is travel-specific and lives in `@dt/travel-pack`. If a task tempts you to put a place name, a dish, or a city in `@samsara/`, the pack is missing a hook — write it in QUESTIONS.md.

Tasks:
- **P2.1** `@samsara/llm`: interface `complete(prompt, schema)` with structured output, Anthropic + Gemini implementations, prompt files with versions, token/cost logging per call. Prompts are passed in as `PromptRef`; the pack owns its prompt text. **Amended 17 September 2026:** "Anthropic + Gemini implementations" is ADR-0006's shape and ADR-0012 superseded it — OpenRouter is the single gateway and "for now, only implementation", so one route is built behind `ports.ts` and a second SDK adapter would be written in order to be deleted. Done: 51 tests, zero tokens spent, per-attempt metering on both token meters and an `llm.call` kernel event per attempt. **The model choice was deferred to P2.2 and is now settled.** ADR-0012 assigns the bake-off here, but its quality bar needed the extraction prompt and the 50 labelled items, both of which are P2.2's and belong to the pack; `compare.ts` was built and not run. **Closed 18 September 2026:** `tools/bake-off.ts` measured five routes for $0.16 and `LLM_MODEL_EXTRACT=deepseek/deepseek-v4-flash` — 86.5% recall, the only candidate over the bar, tying `claude-haiku-4.5` on recall exactly at a ninth of the cost. See STATUS.
- **P2.2** `@samsara/refine` **extract stage** + the `DomainPack` contract from section 2.5: batch RawItems by `pack.extract.batchBy`, call the LLM with `pack.extract.prompt` and `mentionSchema`, write `Mention` rows. Then `@dt/travel-pack`'s mention schema and prompt (place name in native + roman script, dish, category, price hint, one supporting quote under 15 words, sentiment, whether the creator reads as local). Golden-set tests live with the pack: 50 hand-labelled Thai items, target 80% place-name recall. **Amended 17 September 2026:** "one supporting quote under 15 words" is not a bound in Thai, which puts no spaces between words — a smoke run obeyed it while stitching a quote from two halves of a sentence. The cap is 200 characters, in the prompt and in the schema, deliberately the same number. Done: the engine, the schema, the prompt, and a golden set of 50 items in which **31 name nowhere** — recall alone is a target reachable by answering every item, so precision and a separate `inventedOnNegatives` are reported beside it, and the 80% recall bar is read against the 19 place-bearing items and their 74 places. The corpus is checked in; the 2.9MB of captures behind it is not, and `tools/harvest-golden.ts` rebuilds it. **Amended 18 September 2026:** the ten flagged labels have been audited by a human one at a time, because the same author wrote the prompt and the answer key. Four moved and four prompt rules changed with them: a place the writer has not been to now counts, since `sentiment` and `creatorReads` already carry that; a place the item says is gone, moved or not yet built does not, since nothing in the schema can say so; a generic noun counts where the item names the locality and the locality has only one of the thing; and a place named to describe something else is not a mention. The audit also found two names the key was grading too narrowly, neither of them reachable by any test. **P2.1's model debt is paid:** the bake-off ran against this golden set on 18 September 2026 and set `LLM_MODEL_EXTRACT=deepseek/deepseek-v4-flash` (86.5% recall, 88.9% precision, 3 invented, $0.009 per 50 items). **Closed 18 September 2026:** the `refine.extract` job handler is written, so the stage now runs in the runner and not only in a test — one handler for every domain, taking the pack from `ctx.packs` by the payload's `domainId`. It refuses rather than half-finishes in four situations: no provider key, an unregistered domain, a run belonging to another domain, and a run larger than the `ITEM_LIST_LIMIT` read bound. The last one is the sharp one: extracting the first hundred items would leave the run looking done, because the skip query is keyed per item. It also throws when `extract()` reports failures, which that function otherwise swallows into an ordinary-looking report.
- **P2.3** **resolve stage**: generic — take pending Mentions, call `pack.resolve`, cache by `(domainId, normalised key)`, mark `unresolvable` after N attempts. Then the travel resolver, tiered per ADR-0017: Tier 0 reads coordinates already present in the harvested artifact (geo tags, map links, addresses in captions and bios) — free, exact, and the primary path; Tier 1 matches against an OSM named-POI extract loaded into our own Postgres, trigram over `name` and `name:th`, biased to the city bbox; Tier 2 calls a free-tier hosted geocoder (LocationIQ or Geoapify, chosen here by measurement, never the public Nominatim server); Tier 3 is `unresolvable`. Every resolution records which tier won and a confidence score. Unresolved mentions still produce a `Place` with `geo: null`, flagged. Acceptance: on real harvested mentions, record the share resolved at each tier — if Tier 2 carries more than a fifth of them, Tiers 0 and 1 are underbuilt and that is the bug to fix, not the meter to raise.
- **P2.4** **dedup stage**: generic — walk `pack.dedupKeys(entity)` strongest-first, ask `repo.findByKeys`, call `repo.merge` on a hit. Merge preserves all Evidence. Then travel's keys: `externalRef` (exact, and only within the same source — two tiers agreeing is a merge, an OSM id and a geocoder id colliding numerically is not), normalised name + 150m radius (geo), embedding similarity above threshold (embedding).
- **P2.5** **score stage**: generic weighted scorer producing a `ScoreSet` with `because` explanations attached, from factor functions the pack supplies. Then travel's factors: `scores.local` from evidence mix (native-language share, creator-local share, source diversity, engagement ratio), `scores.tourist` from a keyword and source list (English-only, "top 10", listicle domains). Both explainable: the UI must be able to show why, and the generic `Explanation[]` is what it renders.
- **P2.6** Pipeline job: `harvest.run -> refine.run` chained through the `jobs` table with idempotency keys, both carrying `domainId`. Register the travel pack in `apps/worker`. Backfill from Phase 1 data. **Amended 18 September 2026:** two of these are already done and P2.6 is correspondingly smaller. The travel pack is registered — one line in `packs.ts`, which is the whole claim that file was written to make — and `refine.extract` exists as a job type, scoped to one harvest run precisely so that this task is the chaining and the backfill is N of these jobs rather than one job that gets further each time it is killed. **Closed 18 September 2026**, except for the one step that is an operator action rather than code. `harvest.run` now enqueues `refine.extract` for the run it just wrote, so the pipeline feeds itself and the six queued acceptance-week days will extract themselves rather than needing a sweep afterwards. The idempotency key is `refine.extract:<domainId>:<packVersion>:<runId>` — the pack version is in it because `jobs.idempotency_key` is a permanent unique index that collides against succeeded rows, so a key without the version would mean a run could be extracted exactly once ever, and the one recovery `pack.version` exists to provide would be the one the queue forbids. The chaining is deliberately **not** fatal when the enqueue fails: the harvest has already spent a browser session, and re-running it to repair an INSERT costs more than the gap it repairs. That is only honest because `tools/backfill-refine.ts` reads the runs table rather than a list of regrets, so a missed chain is recoverable without anyone knowing it was missed. **Still owed:** the Phase 1 backfill has not been *run* — it queues spend against hosted data, so it takes `--commit` and a human. `./tools/with-hosted-env.sh npx tsx tools/backfill-refine.ts travel` prints the item count and the estimated cost without queueing anything.
- **P2.7** Place Postcard v0 in `@dt/ui`: local name + roman name, category, one evidence quote with source icon, local/tourist meter, map thumb. Render a grid of them at `/lab/places` sorted by `scores.local`.
- **P2.8** **Seam proof.** Write a throwaway second pack (target: under 60 lines, in `packages/samsara/refine/__fixtures__/`, never shipped) for a non-travel entity — a sensible one is "creator": resolve by channel URL, dedup by handle, score by posting cadence. Run the same pipeline over the same Phase 1 RawItems with `domainId: "creator"`. **Acceptance is that this required zero edits under `packages/samsara/` other than adding the fixture.** If it required more, the contract is wrong and P2.2 to P2.5 get revised before Phase 3. This task is cheap now and unaffordable later; do not skip it.

Acceptance: from 7 days of Bangkok harvests, at least 100 unique Places with geo, at least 30 with `scores.local` above 0.7, and Aswin can find 5 he has never heard of that check out on inspection. Plus P2.8 green.

Gate: quality review of the top 30. If more than a third are wrong (wrong place, closed, hallucinated), fix extract/resolve before Phase 3.

### Phase 3: Hundred Eyes (about 1 week)

**Goal:** paste a hotel URL, get a table of prices by country. Observation only.

Tasks:
- **P3.1** `@samsara/probe` fan-out engine: given a `ProbeTarget` and a country list, launch N sessions under the kernel's per-run budget, call the source adapter's `probe(page, target)`, write `Observation` rows. Generic: the engine never reads the payload it stores. Countries for v1: th, us, gb, in, jp, de, au, sg, run as a fan-out of 8.
- **P3.2** `@samsara/sources` Booking and Agoda adapters: URL -> canonical `parsed` target (property, dates, guests), and `probe()` returning a payload of displayed price, currency, and caveat text (member rate, taxes) plus a screenshot. Reject unsupported URLs cleanly. These are price-source adapters, not travel code: a geo-pricing customer would use the same two files unchanged.
- **P3.3** Normalisation: FX to USD via a daily-cached rate source, as a payload post-processor declared by the adapter. Observations keep both the raw and normalised figure, and their screenshot refs.
- **P3.4** Price Postcard v0 in `@dt/ui`: property name, cheapest locale highlighted, sparkline if watch enabled, "why prices differ" note (short, honest, no promise of savings).
- **P3.5** Watch mode: repeatable job per `ProbeTarget` with `watch: true`, daily cadence, notification row when cheapest drops more than 5%. Threshold and notification copy are travel-side; the scheduler is not.
- **P3.6** Flights spike (timeboxed to one session): try Google Flights rendered scrape. If blocked after two strategies, park it in the backlog and say so in STATUS.md. Hotels ship without it.

Acceptance: for 10 hotel URLs, all 8 countries return a price or an explicit `Blocked`/`NoPrice` in under 90 seconds per probe. Screenshots attached.

Gate: none beyond acceptance; this pillar is deliberately small.

### Phase 4: Trip Document and Postcards (about 3 weeks)

**Goal:** the product surface. A trip is a document you type into; Postcards are blocks; map and timeline are views.

Tasks:
- **P4.1** Tiptap editor with a custom `postcard` node that references a Postcard id and renders the matching component from `@dt/ui`. Persist document JSON on debounce. Version column for optimistic concurrency.
- **P4.2** Slash menu: `/place`, `/price`, `/note`, `/photo`, `/checklist`, `/link`. `/place` opens a search over the city's Places ranked by localScore, with the local/tourist meter visible in results.
- **P4.3** Intent parsing: on document save, extract dates, city, and interests from prose via `@samsara/llm` and update Trip fields. Non-destructive; user can override.
- **P4.4** Map view: MapLibre, all geo Postcards from the document, clustered, click to scroll the document to that block. Brand palette basemap.
- **P4.5** Timeline view: Postcards with time, grouped by day. Drag to reassign day writes back to the Postcard.
- **P4.6** Photo Postcard: upload to storage, EXIF geo/time extracted, becomes a mappable block. No AI segmentation in v1.
- **P4.7** Link Postcard: paste any URL; if it's a Booking/Agoda URL, offer to convert to a Price Postcard; if it's a TikTok/YouTube URL, run extract on it and offer a Place Postcard.
- **P4.8** Share link: read-only render of the document with map. This is the scrapbook export. Includes a small "Made with Doen Thang" mark.
- **P4.9** Design pass with `frontend-design` skill: type scale, palette (off-white and charcoal surfaces; neon pink, midnight blue, temple gold accents), Postcard as a physical object (slight rotation on hover, stamp-like source badges). Dry, confident copy. No glassmorphism.

Acceptance: Aswin plans a real 4-day Bangkok trip start to finish in the document without leaving it, and shares the link to one person who understands it without explanation.

Gate: usability session with 3 outside people. Record where they get stuck. Fix the top 3 before Phase 5.

### Phase 5: Daemons and seeded personas (about 1 week, plus legal check)

**Goal:** the OS runs when you're not looking, safely.

Tasks:
- **P5.1** Persona keepalive schedule: every persona `healthy` runs keepalive every 36 to 72 hours with jitter. Budget-guarded.
- **P5.2** Trip-driven harvest: when a Trip enters `planning` with a supported city, enqueue a nightly harvest for the trip's interests. New high-score Places surface in the document as a collapsed "The OS found 6 new places" block the user expands.
- **P5.3** Notifications: email digest (Resend or Supabase SMTP) for price drops and new places. No push in v1.
- **P5.4** Seeded persona spike, gated: one `seeded` TikTok persona for Bangkok with a written SeedPlan (watch local creators, dwell, search in Thai). Measure feed drift vs the anon persona over 10 days. Report to Aswin with ban events. **Do not scale beyond one persona per platform without architect sign-off and a ToS/legal read.**
- **P5.5** Ops dashboard at `/lab/kernel`: live sessions, minutes today by purpose and domain, budget remaining, blocked rate per adapter, persona health board. The design canvas's KERNEL screen is the reference.

Acceptance: worker runs 72 hours unattended with zero orphaned sessions and spend inside budget.

### Phase 6: Alpha launch (about 2 weeks)

**Goal:** 25 invited users, one city, a way to pay.

Tasks:
- **P6.1** Auth + onboarding: Supabase auth, first-run flow that creates a Trip from three questions (where, when, what do you care about).
- **P6.2** Plans: free (3 Places per day surfaced, 1 price target, no watch), pro (unlimited surfaced, 10 targets with watch, priority harvest). Stripe checkout. Budget guard reads plan.
- **P6.3** Landing page on Astro (separate repo or `apps/landing`), built around the split-screen demo video: same query, tourist feed vs local feed, 30 seconds, no voiceover needed.
- **P6.4** Tokyo adapters: Tabelog + YouTube region jp + Google Maps reviews in Japanese. Proves the adapter model with a second script.
- **P6.5** Legal and trust: privacy policy, data retention (raw HTML 30 days, screenshots 90 days, Evidence indefinitely), robots and rate-limit policy per adapter written down, "how this works" page that is honest about what personas are.
- **P6.6** Instrumentation: PostHog or similar for activation (document created, first Postcard, share link opened), retention cohorts, harvest quality feedback (thumbs on Place Postcards feeds back into scoring).

Acceptance: 25 users, 10 with a shared document, at least 3 paying. Day-30 retention measured (industry baseline is 3 to 5%; anything above 15% for people with a trip in the window means the OS thesis is holding).

### Phase 7 and beyond (backlog, not planned)

- Agent Postcards: sandbox agent executes a bounded action (hold a booking on a site with a legit local flow), with a human confirm step and full session recording.
- Remote localized desktop: VNC desktop in-country for the rare site that needs it. Pro feature, metered.
- Visual extract: crop a region of a screenshot, reverse image search, generate a Place Postcard.
- Multiplayer documents via Yjs.
- Flights in Hundred Eyes if the Phase 3 spike found a viable path.
- Persona marketplace: localities as packs, community-contributed SeedPlans.
- **Vertical two on Samsara.** Not planned, deliberately. When a real buyer appears, the candidates in rough order of fit to what will already be built: algorithm auditing (what a given demographic in a given country is shown, for researchers, journalists, regulators), geo-pricing intelligence for SaaS and e-commerce, localised SERP and ad monitoring, in-language market and brand research, diaspora feeds. Each is a domain pack plus a UI; none should need an engine change. If one does, that is the signal the seam is in the wrong place — fix it then, with a paying customer telling you where.

---

## 6. Product design principles (for anyone touching `apps/web` or `@dt/ui`)

1. **The document is the product.** Every feature is reachable from inside the trip document. Views (map, timeline, lab) are derived from it, never a second source of truth.
2. **Postcards are objects, not widgets.** They have provenance (evidence), a place in time and space, and a state. They can be stale. Show staleness; never silently refresh what a user pinned.
3. **Show the algorithm.** The local/tourist meter is explainable on click. If we claim something is a hidden gem, we show who said so, in what language, when.
4. **Honest hooks.** Hundred Eyes says "this is what each country is shown", not "save $400". Users are smart; the screenshot speaks.
5. **Bangkok is the brand, not the theme.** Palette and type from the moodboard; no Thai pattern wallpaper, no tuk-tuk illustrations. The energy comes from motion and density, not decoration.
6. **Dry over cute.** Copy is short and confident. Loading states describe what the kernel is doing ("Reading Yaowarat from a Thai IP") because that is the actual magic.

---

## 7. Guardrails (executors enforce these in code, not in comments)

- **Rate limits per adapter**, configured in one file, defaulting to polite (1 request per 3 to 5 seconds per persona per site).
- **Robots awareness**: adapters log robots.txt status for the paths they touch. Logged-out surfaces only in Phases 1 to 4.
- **No interaction on real users' content** from personas: no likes, follows, comments, DMs. Personas read.
- **No PII from harvested content** stored beyond creator handle and public engagement numbers. Reviews stored as extracts, not full text, after 30 days.
- **Kill switch**: a `kernel:halt` row in the `jobs`-adjacent control table that makes `withBrowser` refuse to launch. Checked on every launch, not cached. Ops dashboard button. Test it in Phase 5.
- **User credential rule**: v1 never asks for or stores a user's third-party social login.
- **Seam**: `pnpm check:seam` is part of `pnpm check` and part of CI. A red seam check is a broken build, not a warning. The `// seam:allow` escape hatch is counted and printed on every run; above five, the architect redesigns the seam rather than the executor adding a sixth.

---

## 8. Cost model and budgets

**The demo runs under a hard $20 ceiling** (Aswin, 11 September 2026). That is a constraint on the architecture, not a note to act on later: the kernel's budget guard enforces it from P0.4, and section 2.4 defines the shape. Do not hardcode prices anywhere in code — read current rates from console.getsolari.com and openrouter.ai/models, derive a count, and put the count in the constants file with the rate in a comment.

Three meters, each with an allocation and a hard ceiling:

| Meter | Allocation | Ceiling, as a count | Where the number comes from |
|---|---|---|---|
| Solari runtime | ~$8 | 4,000 browser-minutes | ~$0.002/min from the Starter calculator. A disciplined demo needs about 1,000; the ceiling is loose on purpose because this is the cheap meter. |
| LLM extraction | ~$3 | 20M input + 4M output tokens | Rate depends on the routed model (ADR-0012) and must be read at P2.1, not assumed. A Flash-class model on OpenRouter is roughly an order of magnitude under a frontier model; the ceiling is set so that even a bad model choice cannot exhaust it silently. |
| Geocoding | $0 | 800 hosted calls | **No longer a spend** (ADR-0017). Tier 0 reads coordinates out of the harvested artifact and Tier 1 queries an OSM extract in our own Postgres; both are free. The count now guards a free tier's daily quota and, more usefully, guards us — a resolver needing more than a few hundred hosted calls a day is failing at Tiers 0 and 1. |

About $9 stays unallocated as headroom — up from $4, because ADR-0017 returned the geocoding allocation to it. It is reserve against undercount, not budget that became available to spend.

Standing rules, every one of which is cheaper than raising a ceiling:

- **Parser iteration opens no browsers.** P1.2 separates fetching from parsing precisely so adapter work runs against stored fixtures. This is the single largest saving available and it is already in the plan.
- **Refine runs cost zero Solari minutes.** They replay stored RawItems. Phase 2 can iterate as much as it likes on the cheapest meter — which is also what makes the ADR-0012 model bake-off affordable.
- **Batch roughly 20 RawItems per LLM call.** The extraction prompt is identical every time; sending it once per item is pure waste. This belongs in P2.1's design, not bolted on afterwards.
- **Keep the mention schema tight.** Output tokens dominate the LLM bill. "One supporting quote under 15 words" is already doing budget work.
- **Cache resolutions permanently**, keyed by normalised name. Coordinates do not change. Tier 0 (coordinates already in the artifact) first, then the local OSM extract, then a hosted geocoder — ADR-0017. Not the public Nominatim server: its usage policy caps recurring scripts at 4 requests/minute and names systematic querying as grounds for a ban.
- **Recording off by default.** On for the first 20 runs of a new adapter (P1.4), then off.
- **Per-task dev budget: 30 browser-minutes.** Above that, stop and write to QUESTIONS.md.
- **`kernel:halt`** (section 7) is the manual override for when a meter misbehaves faster than a counter catches it.

**Answered 11 September 2026 (Aswin): the $20 *is* the usage credit. There is no month of free
runtime underneath it.** Spending past it bills a credit card, and Aswin does not want that. So the
table above is the real exposure, and three things follow, all of them load-bearing:

- **The ceiling is a stop, not a warning.** The guard refuses at `used >= ceiling` and names the
  meter. There is no soft mode, no "log and continue". This is why `BudgetGuard.check` treats a
  meter sitting exactly on its ceiling as exhausted even for a `requested: 0` caller.
- **Ceilings sit below the credit line, because our counter undercounts.** We meter what we observe;
  the provider meters what it ran. A runner killed mid-session leaves a row `running` and a VM
  billing until its idle window expires — ADR-0014 makes that routine, not an edge case — and
  rounding runs the same direction. The allocations above total ~$16 of $20, and the ~$4 left over
  is **reserve against undercount**, not spare budget. Do not allocate it.
- **Nothing here can bill the card any more.** Solari stops when its credit is gone. OpenRouter is
  prepaid, so it also stops. Google Places was the one exception — it bills by default once its free
  credit is exhausted — and **ADR-0017 removed it from the system entirely** rather than containing
  it behind a quota cap. No Google API key is created, so there is nothing left to cap. The standing
  obligation this section carried into Phase 2 is closed by deletion.

Measured, not estimated: a probe session — open a residential-proxied browser, load one page, read
it, close — cost **0.057 minutes** on 11 September 2026. About 0.0014% of the minutes ceiling.

Unit economics sanity check to run at Phase 6: cost per active user per month vs $8 pro price. If harvest alone costs more than $3 per user per month, cut cadence before cutting features.

---

## 9. Metrics that decide the next phase

| Phase | Metric | Threshold to proceed |
|---|---|---|
| 1 | URL overlap between th and us personas, same query | under 40% |
| 2 | Top-30 Places manually verified as real, open, correctly located | above 66% |
| 2 | Engine files edited to run the P2.8 non-travel pack through the same pipeline | 0 |
| 3 | Probes returning price or explicit non-price in under 90s | above 90% |
| 4 | Outsiders who understand a shared document unaided | 2 of 3 |
| 5 | Orphaned sessions in 72h soak | 0 |
| 6 | Day-30 retention among users with a trip in window | above 15% |

---

## 10. Decisions and open questions

### Decided 11 September 2026 (recorded as ADRs 0009 to 0014)

- The layer is a **service layer**, not an operating system. "OS" survives as product-facing language for Doen Thang only.
- The service layer is **domain-agnostic and named Samsara**. Two package scopes in one repo, seam enforced by `pnpm check:seam`.
- A vertical is a **domain pack**: a plain TS object implementing `DomainPack`. The engine owns the whole extract/resolve/dedup/score pipeline; travel supplies the knowledge.
- The engine does **not** get a generic `Entity` table. Each pack owns its own table behind an `EntityRepo`. Reconsider only if a third vertical wants cross-domain queries.
- **The demo has a hard $20 ceiling.** The kernel's budget guard is three-metered from P0.4 — minutes, LLM tokens, geocoding calls — with ceilings expressed as counts. Section 8 holds the numbers.
- **OpenRouter is the LLM gateway** and the model for each task is an env var, not a literal (ADR-0012). The extraction model is chosen at P2.1 by measurement against stored RawItems, which cost nothing to replay.
- **Supabase Auth**, not Clerk (ADR-0013). The API verifies the JWT and passes `sub` down as an opaque `ownerId`. No RLS in v1.
- **Cloudflare free plan for `apps/web` and `apps/api`; GitHub Actions for `apps/worker`; no Redis, no BullMQ** (ADR-0014). Section 2.2 is rewritten around this. P0.5 is unblocked.

### Still open for Aswin (answer in QUESTIONS.md before Phase 0 ends)

1. *Answered 11 September 2026 — **Cloudflare free plan for web and api, GitHub Actions for the worker, no Redis**. See ADR-0014. Left numbered in place so references to later questions still resolve.* Fully closed: the repository is **public** (`AswinBehera/solari-TravelOS`), so Actions minutes are unmetered and section 8 stays at three meters. The cost of public is that the Actions log is public — see ADR-0014's logging rule, enforced in P0.4.
2. *Answered 11 September 2026 — **the $20 is the usage credit itself**; anything beyond it bills Aswin's card, which is not acceptable. Section 8 rewritten: the ceiling is a hard stop, the unallocated ~$4 is reserve against our own undercount rather than spare budget, and the remaining card exposure is Google Places, which needs a quota cap before Phase 2.*
3. *Answered 11 September 2026 — **Supabase Auth**. See ADR-0013. Left numbered in place so references to questions 4 to 8 elsewhere still resolve.*
4. Does the landing page live in this monorepo (`apps/landing`, Astro) or in the solitaryfunc.fyi Astro setup?
5. Name lock: "Doen Thang" as product name, or working title? Affects domain and mark in Phase 4.8.
6. Should the Persona Lab be user-visible at alpha (as a "how it works" flex) or stay internal?
7. Does "Samsara" get a public identity at some point (its own page, its own domain), or does it stay an internal name until a second vertical has a buyer? (Architect lean: internal. Naming a platform publicly before it has two customers invites you to build for the imaginary second one.)
8. `@dt/*` is a placeholder scope for the travel packages and is tied to the "Doen Thang" name lock in question 5. Confirm both together.
9. *Answered 11 September 2026 — **ADR-0015**: keep Bangkok, treat the viewpoint as a stack of signals rather than an IP, and measure which of them actually move the result (new task P1.0). Option (c) in substance, with (a)'s Singapore egress as the weakest ingredient rather than the premise. Asked: **`th` is not on Solari's near-term roadmap** (Aswin, 11 September 2026), so nothing waits for it and the signal stack is the design rather than an interim measure.* Original framing kept below because P1.4's acceptance criterion depends on it:
   **Bangkok, without a Thai IP.** Solari's residential pool has no `th` (section 1.4, found in P0.4). Three ways forward, and they are not equivalent: (a) run Bangkok personas through `sg` and say so in the Persona Lab, accepting that "what a local sees" becomes "what a regional neighbour sees"; (b) make Tokyo the first city, since `jp` is in the pool and section 1.4 already names it second; (c) keep `th` as the target and shape the persona through account locale, language, and search terms rather than IP, treating egress country as one signal of several. (a) keeps the brand and weakens the claim; (b) keeps the claim and costs the brand; (c) is the most honest about how these platforms actually localise, and the most work. Worth asking Solari whether `th` is on their roadmap before choosing.

  **Answered 2026-09-16 by Aswin (architect): (c).** The Phase 1 drift experiment runs
  `sg` / `th-TH` / `Asia/Bangkok` against `us` / `en-US` / `America/New_York`. This is what
  ADR-0015 already committed the code to — a `Viewpoint` is `{country, locale, timezoneId}`, not
  an IP — so the experiment measures the thing the system actually models rather than the thing
  the provider happens to sell. **What the number will and will not mean:** one of the three
  signals is held wrong on purpose, because `sg` is not `th`. A *low* overlap is therefore a
  strong result (locale and timezone moved the surface despite a neighbouring egress), and a
  *high* overlap is ambiguous — it could be a surface that does not personalise, or it could be
  one that keys on IP alone, and this run cannot tell those apart. That ambiguity has to be
  carried into the gate: above 60% the instruction is "redesign adapters", and the first thing
  to check instead is whether `th` egress has become available, because a week that failed for
  want of an IP is not evidence about the adapters.

---

## Appendix A: Task index (copy into STATUS.md as the checklist)

```
P0.1 P0.2 P0.3 P0.4 P0.5 P0.6 P0.7 P0.8
P1.0 P1.1 P1.2 P1.3 P1.4 P1.5 P1.6 P1.7 P1.8
P2.1 P2.2 P2.3 P2.4 P2.5 P2.6 P2.7 P2.8
P3.1 P3.2 P3.3 P3.4 P3.5 P3.6
P4.1 P4.2 P4.3 P4.4 P4.5 P4.6 P4.7 P4.8 P4.9
P5.1 P5.2 P5.3 P5.4 P5.5
P6.1 P6.2 P6.3 P6.4 P6.5 P6.6
```

## Appendix B: STATUS.md template

```
# STATUS
Phase: 0
Last completed: (none)
NEXT: P0.1
Branch: main
Known breakage: none
Last session notes:
- 
```

## Appendix C: Glossary

- **Samsara**: the domain-agnostic service layer over Solari. Personas are incarnations; Samsara is the machinery that runs them, remembers them, and reports what each one saw. Package scope `@samsara/*`.
- **Doen Thang**: the travel product built on Samsara. Vertical one. Package scope `@dt/*`.
- **Situated observation**: the horizontal primitive. What a specific identity, in a specific place, was actually shown — captured repeatably, on a schedule, with evidence.
- **Domain pack**: the object a vertical implements to drive the generic pipeline. Entity schema, prompts, resolver, dedup keys, scoring factors, sources, queries. Section 2.5.
- **The seam**: the enforced boundary between `packages/samsara/` and `packages/travel/`. Section 1.6.
- **Persona**: a Solari browser profile plus a proxy country and sticky IP, treated as a long-lived identity that reads local feeds.
- **Harvest**: one adapter run by one persona for one query, producing RawItems.
- **Refine**: the pipeline from RawItems to Places with Evidence and scores.
- **Postcard**: a typed block in a trip document with optional geo and time. The only unit the map and timeline understand.
- **Hundred Eyes**: the price observatory.
- **Kernel**: the Solari session wrapper with registry, budgets, and deadlines. Nothing touches Solari without it. An orchestrator, not a kernel; the name is kept because the ops screen is called `/kernel` and the metaphor is load-bearing in the product.
