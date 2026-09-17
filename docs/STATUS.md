# STATUS

Phase: 2 — in progress. Phase 1's acceptance week is **still draining** (six of seven days queued,
day 0 at 60.0%), and Phase 0 is **complete, pending the gate** (below; the gate is a human review
and does not block buildable work).
Last completed: **P2.2 — the extract stage, and fifty items somebody had to read**.
859 tests across the repo, seam allowances **0 of 5** across 166 files. The count is measured
rather than carried forward, and the basis is written down here so the next session does not have
to re-derive it: **834 passing under `turbo run test` plus 25 under `test:tools`, with one live
test skipped.** P2.2's 46 are 19 in `@samsara/refine`, 24 in `@dt/travel-pack` and 3 in
`@samsara/sources` for the TikTok login wall below.

**Sixteen billed sessions, about 7.8 minutes of 4,000.** P2.2 spent three of them harvesting the
golden corpus — roughly 3.4 minutes, and that figure is softer than the ones below it: it is
wall-clock measured by the harvest script across launch and dispose, not a number read back off
the meter, and it is recorded that way rather than given a false fifth decimal place. The three
were one listing pass that also carried the TikTok queries, one that returned zero prose items
because it skipped the topic chaining, and one that worked. The middle one is waste and is
counted as such, for the same reason the `tail` session below is.

P1.8 spent one proving the schedule against
local Postgres (0.10068, one `youtube.search` run, 20 items, day 0 of a three-day experiment at a
one-minute interval), then two more on the real thing: **day 0 of the acceptance week, on hosted
Postgres, 0.2388 minutes, 60.0% overlap.** Six days of it are still queued. Seven for P1.6.1 below, three for P1.6.2, and two of those
ten produced nothing. P1.6.1's seven: five `pantip.forum` (0.4584, 0.4584, 0.4587,
0.44775, 0.5466), one `maps.search` (0.21265), one `maps.reviews` (0.40665). **One of the five
Pantip sessions was waste and is counted as such**: the first run was piped to `tail`, which does
not stop the capture — it had already opened the browser and billed — and it was then re-run to see
the head of the output. The pipe cost 0.4584 minutes and produced nothing. Reading a recorder's
output through `tail` is not free, because the spend happens before the bytes reach the pipe.

## P2.2 — the extract stage, and fifty items somebody had to read

`@samsara/refine` has its extract stage and `@dt/travel-pack` has the schema, the prompt and a
golden set: 19 tests in the engine, 24 in the pack, and the `DomainPack` contract from section
2.5 is now a thing two packages agree about rather than a paragraph. The engine batches
`RawItem`s, renders them, calls `complete()` with the pack's prompt and `mentionSchema`, and
returns mentions keyed back to the items they came from. It knows nothing about places, which
`check:seam` confirms across 166 files at 0 allowances of 5.

**The five real items are the whole reason this task produced anything worth reading.** The
plan's shape for P2.2 is engine, schema, prompt, golden set — all of which can be built, tested
and made green against a fake client that returns whatever the test hands it. One smoke run
against one real model, five real Thai items and about a third of a cent found three defects
that no fake could have found, because in each case the fake's answer was the test's own answer.

**The first version of the item header was ambiguous, and the failure was silent.** `renderItem`
packed the reference, source and language onto one line — `--- 1 maps.reviews th` — and the
first real model to see it answered with `"ref": "maps.reviews th"` on all five items. From the
engine's side that is indistinguishable from an invented reference, so the run reported `calls:
1`, `failures: []`, `invalid: 0` and `mentions: 0`: a clean, green, entirely wrong result. The
ref now gets its own labelled line and the envelope instruction says to copy the value on it and
nothing else from the header. A fake client echoes the ref the test gave it and would have
passed either version forever.

**A word count is not a bound in a language without spaces.** The quote was capped at fifteen
words by §8 and by the schema's docstring, and Thai does not put spaces between words. The smoke
run obeyed that cap while returning a quote stitched from two halves of a sentence — the exact
thing the rule forbids — because a limit that cannot be counted cannot be violated either. The
cap is now 200 characters in the prompt and `max(200)` in the schema, deliberately the same
number, so the instructions and the validator refuse the same thing instead of two adjacent
things.

**The dangerous failure was not an invented place but a generic noun in place of a name.** The
run returned `ร้านกาแฟ` ("coffee shop"), `คาเฟ่` ("café") and `สาขานี้` ("this branch") as three
of four mentions. Each passes the "could someone go to this at an address" test the prompt was
built around, and each is worthless: it cannot be geocoded, cannot be deduped, and would resolve
to whichever café the geocoder preferred. The prompt now names those three strings and says that
an item which never names the place yields no mention rather than the noun.

**The golden set is 50 Thai items, and 32 of them name nowhere.** That ratio is the task's main
judgement call. The plan asks for "50 hand-labelled Thai items, target 80% place-name recall",
and recall alone is a target a model can hit by answering every item with something. A food
board is mostly people talking, so the negatives are the honest majority and they are also where
the measurement lives: 18 items carry 70 places between them, and `inventedOnNegatives` is
reported separately from precision because a model can be precise on the items that do name
somewhere and still answer every negative with `คาเฟ่`.

The negatives that are hard rather than empty are the ones worth having. A 2.5k-character news
article about how Google Maps computes busy times — fluent, on-topic, naming no restaurant. A
five-dish review whose author elides the shop name as `ร้าน ดี....` on purpose. A shop the
writer ate at for years and is now asking what happened to, which the prompt disqualifies as a
place that no longer exists. A comment naming two real attractions the writer wants to see and
has not been to. Each is a sentence in the prompt's disqualification list, met in the wild.

**I wrote the prompt and the answer key both, and ten items are flagged so that loop can be
broken.** Eight are the judgement calls I know I made — whether a named rock formation inside a
national park is its own place, whether a farmstay the writer drives to for coffee counts when
lodging does not, whether a stall called `ร้านก๋วยจั๊บญวนอุบล` is named or merely described —
and each says in its note what is being asked. Two were drawn from the rest by a seeded sample,
so the audit is not only the questions I already knew to ask. **This is the open ask of the next
human session**, and it is small: read ten items, agree or disagree with ten labels.

Two invariants keep the key from rotting, asserted in `golden.test.ts` rather than trusted.
Every label has to name something the item actually says — at least one accepted spelling must
appear verbatim — which caught the one name I had normalised from memory: the source misspells
the Sirindhorn dam as `เขื่อนสิรินธน`, and both spellings now count, because a model that
silently corrects it has helped P2.3 rather than hurt it. And the counts — 50 items, 18
place-bearing, 70 places, 10 flagged — are written as assertions, so re-running the harvest
without revisiting the labels fails loudly instead of quietly changing what every score means.

**The corpus is checked in and the 2.9MB it came from is not.** `tools/harvest-golden.ts`
rebuilds it from Pantip in one session, which is what makes that a trade rather than a loss: the
provenance is a program you can read. It takes its output path as an argument with no default,
because a second harvest does not refresh the golden set, it invalidates a key that is written
by hand against specific text.

**A refusal recorded as an honest zero is worse than a refusal.** The first Thai harvest sent
three TikTok queries and got three captures with no tiles, no intercepted bodies and
`refusedBy: null` — which would have entered the corpus as "TikTok has nothing to say about
Yaowarat street food". TikTok serves its logged-out shell from a bundle whose name is in every
request path it makes, and that signal is structural rather than textual, which matters here
more than anywhere: this project never browses in English, a `th-TH` viewpoint gets a Thai login
wall, and `/log in to continue/i` does not match it. `capture.ts` now refuses on the
conjunction — nothing rendered, nothing answered, every asset from the login bundle — and the
three captures were deleted rather than kept, because a fixture asserting `refusedBy: null` on a
page that was never served is a trap for whoever reads it next. Nothing here works around the
wall; the refusal is the measurement.

**The debt P2.1 recorded is now unblocked and still unpaid.** `LLM_MODEL_EXTRACT` is still
empty and `compare()` has still not been run. It could not be before today, because its quality
bar needed the golden set; the instrument and the answer key now both exist, and the bake-off is
the first thing P2.3 should not start without. It costs nothing on the meter that is scarce —
refine replays stored items and opens no browsers — and something on the meter that is not.

One question came out of the harvest and is open: `Q14`, a `pantip.topic` capture returns other
threads' "related topics" teasers as items. Measured at over a third of what twelve topic
captures returned. It is filtered in the harvest tool, which is the wrong place for it, and the
right fix changes what a parser returns.

## P2.1 — the LLM interface, and the model it deliberately did not choose

`@samsara/llm` is real: `complete(prompt, schema)` over OpenRouter, metered on both token
meters, logging one `llm.call` event per attempt, 51 tests, **zero tokens spent**. The package
opens no network connection in its own test suite, for the same reason the kernel's does not —
a path you can only exercise by paying for it is a path nobody exercises.

**The task description is out of date and was not followed.** PLAN §P2.1 says "Anthropic +
Gemini implementations"; ADR-0012 supersedes that and says OpenRouter "becomes its default and,
for now, only implementation". One route is built. Writing two SDK adapters against a decision
that removed them would have been work performed in order to be deleted. PLAN is amended in
place rather than left to contradict its own ADR table.

**The bake-off is an instrument, not an answer, and this is the deviation worth overruling if
it is wrong.** ADR-0012 gives P2.1 the job of picking the extraction model "by measurement"
against Phase 2's quality bar — 66% of the top 30 verified. That bar cannot be measured yet: it
needs the extraction prompt and the fifty hand-labelled items, and both are P2.2's and belong to
the pack, not the engine. So `compare.ts` is built and was not run. It takes candidates, a
prompt, a schema, cases and optional per-case graders, shuffles from a recorded seed as P1.0's
signal matrix did, and reports schema-valid rate, tokens, latency percentiles and — only when a
rate is supplied with the date it was read — dollars. `LLM_MODEL_EXTRACT` stays empty and a call
to an unset task refuses by name. **The debt is explicit: P2.2 owes a comparison run before it
sets that variable**, and running it then costs nothing on the meter that is scarce, because
refine replays stored raw items and opens no browsers (§8).

Four things were found by building it, and three of them are about cost rather than quality.

**Every attempt has to meter itself, and the obvious implementation gets this backwards.** The
tidy version wraps the retry loop in `BudgetGuard.spend` and records once. But ADR-0012 requires
a schema-invalid response to be *retryable*, so the characteristic failure of a cheap model is
three complete round trips that each burn input and output tokens and return nothing. Metering
only the attempt that succeeded would report that model as the cheapest in the comparison while
it was quietly spending triple — the harness would recommend the worst candidate, with numbers.
So the check and the record sit *inside* the attempt, in a `finally`, and the comparison totals
are aggregated from `llm.call` events rather than from the returned value, because a returned
`Completion` cannot see the attempts that failed. `spend` is also single-meter and the LLM has
two, priced an order of magnitude apart, so the two-meter check-and-record is written out.

**A truncated answer is `config`, not `upstream`, and that one word saves two thirds of the
spend.** `finish_reason: "length"` means the JSON was cut mid-object. It parses as invalid, so
the natural classification is the retryable one — and the identical request is then cut in the
identical position, twice more. It is our request that is wrong, not the provider's answer, so
it is `config`, which the retry policy does not retry, and the message names `maxOutputTokens`
because raising it or batching fewer items is the only thing that fixes it.

**"Characters ÷ 4" is the wrong token estimate for the text this system actually harvests, and
wrong in the dangerous direction.** The guard's pre-check is only exact if someone estimates the
input up front. The standard ratio comes from English prose in a BPE vocabulary; Thai and other
unsegmented scripts land near one token per character. Feeding 4:1 into a pre-check on
native-language content would wave through roughly four times the input it believed it was
approving — the precise failure the pre-check exists to prevent, arriving silently. The estimate
counts ASCII at 4:1 and everything else at 1:1. It is a floor for safety; the number recorded
after the call is the provider's own, and when a provider returns no usage block the call is
recorded from the estimate and flagged `metered: false`, because a missing receipt is not a free
call.

**The free-tier rule is now mechanical.** ADR-0012 says `:free` routes are fine for harvested
public content and not for anything derived from a user's private data, and that the config
"must not quietly send the latter to a free tier". `complete` takes a `sensitivity` that
defaults to `private` and refuses a `:free` model. The high-volume public path therefore has to
opt in at its call site — one word a reviewer can see. A default of `public` would be convenient
exactly once and would then apply itself to every call written afterwards.

Smaller, and worth knowing before P2.2 writes a prompt: `definePrompt` derives a **fingerprint**
from the text alongside the pack's declared `version`. Nothing forces a bump — the engine cannot
know whether an edit was meaningful — but two rows claiming version `3` with different
fingerprints are now a bug with a receipt, where before they were two identical-looking rows
that came from different prompts. `render` throws on a variable the template does not use, which
is the quiet bug: passing `items` to a template reading `{{item}}` sends a prompt with no data
in it and gets back a confident, empty answer, on every batch, until somebody reads the output.

`strict: false` on the json_schema block is deliberate and is the one place a reader may expect
more: strict structured output needs every property required and `additionalProperties: false`
throughout, which a Zod schema with an optional field does not produce. Conforming one means
rewriting optionals as required-and-nullable — changing what the model is asked for, behind the
caller's back, in a package that must hold no opinion about a pack's schema. The guarantee comes
from the Zod validation above, which ADR-0012 requires on every response regardless.

**Not done, and not pretended otherwise:** no live call has been made, no model has been chosen,
`compare.ts` has never seen a real provider, and the `json`-vs-`schema` fallback is written
against the documented wire format rather than against a route that refused one. The first real
OpenRouter call happens in P2.2.

## P1.8 — the drift experiment, and the difference between a zero and a gap

The task is one line: "run the same query daily for 7 days from a `us` persona and a `th` persona.
Store results. Plot overlap percentage over time in the Lab." P1.7 built the comparison; this is
the same comparison with a schedule attached, and almost everything decided here is about the
seven-day part rather than the overlap part.

**An experiment is fourteen queued rows, written up front.** The obvious design is a job that does
today's pair and enqueues tomorrow's. It is one row instead of fourteen and it is wrong under
ADR-0014: a scheduled runner can be cancelled between any two statements, and a chain that breaks
on day 3 loses days 4 to 7 *silently* — there is no row left that was ever going to ask. Queueing
the whole plan makes a dead runner produce late days rather than missing ones, because
`jobs.run_after` is already the column that holds work until its time. The cost is that a plan
cannot be edited once queued, only stopped, which is the right way round for something that spends
browser minutes. Each day is anchored to `startedAt + day × interval`, never to the previous run,
so a day that fires six hours late does not push the rest of the week six hours later; the plot
still draws the time the run *actually* started, and the two are allowed to differ visibly.

**Day-major, with the pair adjacent.** The runner drains one job at a time, so the two identities
are asked minutes apart. Interleaving by identity — all of A's week, then all of B's — would make
every point on the chart a comparison between two different days, and a ranked surface reshuffles
itself through the day.

**`MAX_DAYS` is 14, and the number comes from subrequests.** Creating an experiment is two persona
reads, one insert and `days × 2` enqueues: `3 + 2d` against the free plan's 50 (ADR-0014). Fourteen
days is 31; thirty days would be 63 — a limit that would be hit in production and nowhere else,
halfway through queueing a month of work, leaving an experiment whose second half does not exist.
`intervalMinutes` has a floor of one minute, settable so the mechanism can be demonstrated in ten
minutes rather than being provable only by waiting a week or faking a clock.

**Four states for a day, because three of them are not measurements.** `pending` (not due),
`missing` (due, one or both sides have no run), `empty` (both ran, one came back with nothing, so
`comparable` is 0), `compared` (the number means what it says). `overlapAt` returns `overlap: 0`
when `comparable` is 0, and on a chart that is indistinguishable from *the two identities agreed on
nothing* — which is the single most interesting finding this experiment can produce. So `overlap`
is `null` in all three non-measured states, the plot draws a marker only for `compared`, the line
breaks across the rest, and the table prints "—". This is the P1.7 rule about `comparable` again,
extended from one number to a series.

**The stop button cannot unqueue anything, so it refuses instead.** A stopped experiment's
remaining days are already rows in the queue. `POST /lab/drift/:id/stop` sets the state; the
*worker* reads `drift_experiments` before a browser opens and heartbeats "was stopped; not spending
on day N" without launching. That is the only thing the button does, and if the check lived in the
API it would do nothing at all.

**One implementation of the arithmetic, still.** `driftSeries` calls the same `overlapAt` the split
screen and P1.0's offline matrix call; the browser computes no percentages. `meanRankShift` is
carried beside the overlap because the headline cannot tell "the same twenty, reordered" from "the
same twenty" — a week at 0.95 overlap with a mean shift of 8 is a surface reshuffling itself daily,
and reads nothing like the same week with a shift of 0. It is in the table and never on the plot:
two measures of different scale on one chart is a dual axis, which this repo does not draw.

**The summary carries spread, not just a mean.** A mean of 0.3 across seven days that ranged
0.28–0.32 is a stable effect; the same mean across days that ranged 0.05–0.62 is a surface that
happens to average to an effect. The plan's 40% threshold reads identically in both cases, so
`max - min` sits next to the mean.

**The chart, and three defects that only rendering found.** The palette was validated with the
dataviz skill's script rather than by eye, and the first draft failed: a green acceptance line
against a red gate line is ΔE 4.1 under deuteranopia. The design uses one status colour (the red
gate) and a neutral rule for acceptance. Then rendering the SVG and looking at it caught what
reasoning had not — unmeasured days drawn as hollow ticks *on the 0% line*, which is exactly the
lie the four states exist to prevent (they moved into the axis band below the baseline); a 40% rule
indistinguishable from the 50% gridline (the interior gridlines went, so every horizontal line on
the plot is now a decision); and the endpoint label colliding with the rule labels (which moved to
the left edge). Hit targets are an HTML `<button>` overlay rather than SVG rects — Biome was right
that a `tabIndex` on a `<rect>` is a lie about what is focusable — so hover, keyboard focus and a
click-to-pin readout are the same code path, and the `<details>` table twin means no value is
reachable only by pointing at it.

**What it costs per request.** `GET /lab/drift/:id` over a full fortnight at the widest k measures
**0.539 ms of CPU** against the 10 ms ceiling — half of `/lab/compare`'s 1.012, because it compares
short lists many times rather than long lists once. Reading a series is two queries, not fourteen:
one for the runs, one for the ranked urls of all of them.

**A defect this run paid to find, twice.** Day 0's second persona failed with
`internal: unhandled kernel error` and nothing else — the diagnosis was on `Failure.cause` the
whole time and was dropped one line before it reached `jobs.last_error`. `record-capture.ts`
carries a comment saying a session had already been spent on exactly this, in almost those words;
`harvest.ts` had the same line and the same defect. Both now append the cause, and a worker test
pins it. Separately, the local capture archive (`.captures/`, `FilesystemCaptureArchive`'s default)
had been landing raw provider JSON inside the repo where `biome check` read it as an unformatted
source file; it is ignored now, with the reason written down.

**Verified end to end against local Postgres through Hyperdrive**, with a three-day experiment at a
one-minute interval: six jobs queued day-major with staggered `run_after` and keys of the form
`drift:<experiment>:<day>:<persona>`; day 0 side A produced a real `harvest_runs` row with
`experiment_id` and `experiment_day` set, outcome ok, 20 items, **0.10068 billed minutes**; `/stop`
returned `stopped`; the series then read day 0 as `missing` with `overlap: null` (one side only),
days 1–2 as `pending`, and `meanOverlap: null`. Day 1's two jobs reached the runner afterwards and
logged the refusal without opening a browser. The stop path is the only part of this feature that
has been proved on real infrastructure end to end.

**What P1.8 has not produced is the acceptance number.** The instrument exists; one day of seven
has run. Until 2026-09-16 nothing drained the queue at all — not because the cron was off, as this
file said for four days, but because it was failing on a `DATABASE_URL` that did not exist (see the
correction below). A seven-day experiment's days therefore came due and stayed due, and the plot
honestly showed `missing` points and no line. Phase 1's acceptance — "Bangkok street food", th top 20
under 40% URL overlap with the us persona's, no captcha loops in the recordings — is therefore
still unmeasured, and so is the 60% gate. That is a scheduling dependency, not missing code: the
first thing that turns it into a number is a runner that wakes up for seven days.

761 tests across the repo, seam allowances **0 of 5** across 148 files.
See `casestudy_and_thinking/sessions/2026-09-16-p18-a-zero-and-a-gap.md`.

## P1.7 — the Persona Lab, and the column the split screen could not be built without

The task was "list personas, create one, trigger a harvest, view RawItems side by side for two
personas on the same query", with "rough UI is fine; correctness of the comparison is not". The
first hour was spent discovering that the comparison could not be computed at all.

**`raw_items` had no rank.** The acceptance criterion is written in terms of "the top twenty
items", and nothing in the row could reconstruct which twenty those were: `id` is a random uuid,
`created_at` defaults to `now()` and is identical across a batch insert, and `captured_at` is one
timestamp for the whole capture. Insertion order in Postgres is not a promise, and the day it
stops being true is the day a batch is written twice. An arbitrary twenty compared against another
arbitrary twenty produces a number that looks like a measurement. So `rank integer not null` was
added to the table, to the canonical `rawItem` schema in `@samsara/core`, and to `RawItemRow`, and
`run.ts` sets it from the draft's array index — the last place in the pipeline where the order the
surface chose still exists. Migration `0007_add_raw_item_rank`, which also swaps
`raw_items_run_idx` for `(harvest_run_id, rank)`: every read of a run's items is a read in rank
order, and the index that answers it is the one that carries the order. A second index,
`harvest_runs_persona_started_idx`, answers the Lab's actual question — what did *this* identity
get back, most recent first — which was otherwise a scan of every run anybody had ever done.

**One implementation of the comparison, on the server.** `/lab/compare` calls `overlapAt` from
`@samsara/harvest/overlap`, the same function the offline signal matrix uses, and `lab.test.ts`
asserts the route's figure `toEqual` the primitive's output rather than recomputing the arithmetic
in the test. The browser never computes the intersection: it marks shared rows for reading, and
`Compare.tsx` says in its header that if the mark and the headline ever disagree, the mark is the
one that is wrong. A second implementation in the client would be the convincing one on screen.

**Three refusals, each of which would otherwise produce a plausible wrong number.**

1. `a === b` is a 400. `overlapAt(x, x, k)` is a perfectly good 1.0, and a split screen showing
   100% because both columns are the same identity is the most convincing wrong answer this tool
   could produce.
2. The route takes the **newest** matching run per side, whatever its outcome — `blocked` with zero
   items included — and never falls back to an older successful one. A silent time-shift would put
   the two columns on different days and label it a persona effect.
3. `shared / comparable`, never `shared / k`, and `comparable` is on screen beside the percentage.
   A side with no matching run comes back as `harvest: null, items: []`, and `comparable === 0` is
   the field that separates "nothing in common" from "nothing to compare". The UI prints "—" rather
   than 0% for that case, because a 0% that means missing data is worse than no number.

**Subpath exports, again.** `apps/api` is compiled with `types: ["@cloudflare/workers-types"]`, and
`@samsara/harvest`'s barrel reaches `run.ts`, `@samsara/sources` and Playwright while `store.ts`
reaches `node:crypto`. The ports were split out into `ports.ts` — types only, no value imports —
and `./overlap`, `./ports`, `./store`, `./postgres`, `./node` are now separate entry points, as
`@samsara/kernel/jobs` has been since P0.5. The rule is the same one: it should be a compile error
here rather than a deploy-day surprise. Seam count moves 143 → 145 (`ports.ts`, `store.test.ts`).

**`.dev.vars`, and which way a mistake fails.** Every Lab route is authenticated, ADR-0013 puts
authentication in Supabase, and there is no Supabase project — so without something the internal
tool is a tool nobody can open, which is how internal tools grow their own unauthenticated side
door. `devVerifier` answers with one fixed owner and is selected by the **presence** of
`DEV_OWNER_ID` in `apps/api/.dev.vars`, a file `wrangler dev` reads and `wrangler deploy` does not
upload. The first draft selected it on the *absence* of `SUPABASE_URL`, which fails open: a
deployment that forgot a secret would have accepted every request. Written this way, absence falls
through to the real verifier and 401s. The file is committed on purpose and contains nothing
secret, the same call as `localConnectionString` in `wrangler.toml`.

**No second door for starting a harvest.** The Lab's form POSTs `harvest.run` to the existing
`/jobs`, which already has the owner from the verified token, the enqueue-then-dispatch order and
the double-dispatch refusal of ADR-0016. It sends **no idempotency key**, deliberately: a key
derived from the question would make the Lab unable to ask the same question twice, which is
exactly what P1.8's drift experiment does. A double-click is held off by disabling the button.

**What it cost per request.** `GET /lab/compare` at the widest k it allows measures **0.933 ms of
CPU** (1.063 on a later run) against a 10 ms ceiling and a 5 ms assertion budget — thirteen times
the next-heaviest route, and the only handler in the app that is not trivially cheap. `cpu.test.ts`
now drives it with 100 items a side and says in the test that if this ever approaches the ceiling
the fix is a smaller `MAX_K`, not a bigger budget. `POST /lab/personas`, the only route that runs a
schema, costs 0.035 ms.

**The web app still has no router.** Two pages, one string comparison in `main.tsx`. A router is a
dependency, a bundle and a set of conventions bought with one decision that `startsWith` already
makes; Phase 2's real navigation can bring a real one. The Lab talks only about personas, sources,
queries and items — the seam rule applied by hand, since `apps/` is allowed travel vocabulary and
`check:seam` would not have caught a "places found" column.

**The one lint suppression that was not added.** Biome's `noLabelWithoutControl` cannot see through
a component boundary, and the repo has zero `biome-ignore` comments. Rather than make it one, the
`Field` helper now generates an id with `useId` and hands it to the control through a render prop,
which is a real association rather than an incidental one.

**Verified end to end, without a browser.** `wrangler dev` against local Postgres through
Hyperdrive: a persona created (`country: "TH"` refused, and the 400 does not echo the input), two
personas with four seeded items each compared through real SQL at `1 of 4 shared, 25%`, `/lab`
served by Vite's SPA fallback and the `/api` proxy reaching the Worker. The React tree was
render-checked with `renderToString`; there is no Playwright in this repo (the browser is remote,
and remote browsers cost minutes), so nothing clicked a button. 15 tests in `lab.test.ts`,
9 in a new `store.test.ts`, and 5 new Postgres tests covering rank ordering, the bounded read, and
engagement coming back as an absence rather than three zeroes.

## P1.6.2 — `pantip.topic`, and five defects in one page

**Three sessions on 2026-09-16; the day's meter reads 1.087 minutes.** One of them is a
`page.goto` timeout that produced nothing and billed 0.521 — the navigation failed, the browser had
already opened, and a failed capture is a capture that was paid for. The re-record cost 0.5.

`pantip.topic` shares a parser with two boards that had been measured, and shared nothing else: the
posts path had never seen a post. The first capture came back with 96 of them and five separate
defects, none of which any test in the suite could have found, and all five visible to a person
reading the file.

1. **The opening post began with a jQuery call.** Pantip closes a consumer review with an inline
   `$(document).ready(…)` that turns the star widget read-only, and `textContent` returns the source
   of a script as though the author had typed it. Prose fields now strip `script, style, noscript`
   before reading — the same removal, with the same list, that stored fragments already did.
2. **Fifty of the ninety-six posts said "ตอบกลับ … 0"** — the page's word for *reply*, and the vote
   count beside it. `[class*="story"]` also matches `display-post-story-footer`, the action bar,
   which is a **sibling** of the story rather than a child of it; when a comment is only an emoticon
   its story box is empty, the loop walked on, and the footer answered. Half a thread recorded as a
   button. The selector now says what it must not be, and an empty body box is treated as an answer
   rather than a miss: 45 comments come back with `text: null` and the emoticon in `mediaRefs`, and
   a test asserts every one of the 45 has media, because a null with nothing beside it would be a
   selector that missed.
3. **Five posts were furniture**: the "46 ความคิดเห็น" heading, a jsrender template whose body is a
   literal `{{if count}}`, the deleted-comment tally, the "leave a comment" heading and the prompt
   to log in. A comment is numbered — `comment-120277350`, `reply-40463805` — and page furniture is
   not, so a reply must now carry a number or a `data-cid`. Counted in `nodeCounts`, not silently
   dropped.
4. **A count was redacted as a phone number.** `123456789 คห. ถูกลบ` is *123456789 comments
   deleted*, and the contact rule written hours earlier ate it. The rule now carries two conditions
   rather than one: nine digits minimum, **and** the run has to be written the way a person writes a
   number. Verified against 11 probe cases and all 111 prose strings in the corpus.
5. **A title was not redacted at all.** The sidebar carried a real topic — "มีเบอร์ 027009089
   โทรเข้ามาค่ะ", *a number 027009089 called me* — whose `excerpt` came back redacted and whose
   `title` did not, because `title` was not on the list of fields somebody wrote. The same sentence,
   in two fields, got two answers. **A guard covers a representation, not a subject** — the sixth
   instance, and the first where the two representations were three lines apart in the same object.

Defects 1 to 3 are `inpage.ts` and had to be re-recorded, which is what the second session bought.
Defects 4 and 5 are redaction and were re-run over bytes already on disk by `tools/scrub-fixture.ts`
at no cost. The fixture in the repository is the second capture: 189 KB, 91 posts, 11 sidebar rows,
101 parsed items, `reply with no comment number: 6`.

**What the shape rules still get wrong, recorded rather than fixed.** The star widget renders
`<a title="0.5">0.5</a>` ten times and `textContent` concatenates them into `0.51.1.52.2.5…`, which
rule 2 reads as two IPv4 addresses. Nothing legible is lost and a test pins it with the reasoning.
Raised with the `authorName` question as Q11; same family as Q10.

**Eleven defects, nine of which would have shipped silently**, and the eleventh was found by
re-auditing the fix for the tenth. Five on Pantip (wrong row scope, 259
rows x 6 null fields; fragments cropped to the wrong scope and therefore unable to diagnose the
nulls; timestamps in a `title` attribute no selector read; counts contaminated by Material Icons
ligature text, `parseCount("thumb_up_2 12")` -> 212; a `gtm-voted-topic` decoy that filed four
headlines as vote counts). Five on Maps, across the first `maps.reviews` capture ever taken and the
first `maps.search` capture to be given a query that lists rather than resolves — the reviews capture
was chained off the search capture's entity URL, which exercised the two-surface split end to end.

The two on the search surface are the Pantip decoy in different clothes. `span + span[aria-label]` is
positional and constrains nothing, so three of six cards filed
`ไม่มีทางเข้าที่รองรับเก้าอี้รถเข็น` — *no wheelchair accessible entrance* — as a review count;
`parseCount` refused it and no wrong number reached `engagement`, which is downstream luck rather
than a guard, and the guard now exists (a digit must be present — only that, because a Maps
aria-label does not put the number first the way a Thai listing does). And `detailLines` read a
wrapper and its children both, storing every fact twice and welding an address to an opening time
with no separator, because the DOM had none either; leaves only now.

**The finding that outlived the session: the same photographs were in a fourth place, and the
test that said otherwise was looking at the wrong representation.** Auditing the reviews fixture
once more before committing it, six contributor profile photos were still in the file — in
`observedPaths`, which is built from network responses, while the avatar guard runs in the DOM.
`fixture.test.ts` certified the file "carries no photograph of a contributor" by matching
`googleusercontent.com/a-?/` over the whole document, and passed, because `pathOf` strips the
hostname before the path is stored. A guard, a second guard, and an assertion, all three about
contributor photographs, and the photographs sat in a field none of them looked at. `capture.ts`
now drops them at the response handler and reports `observedAvatarsSkipped`; the six in the
recorded file are `[redacted-avatar]` rather than deleted, so the count stays legible. **A guard
covers a representation, not a subject** — and the representation is the part nobody writes down.

**The Maps finding that led to it: a broken selector silently disabled a privacy exclusion.**
`authorHref` used `a[href*="/contrib/"]`; Google stopped wrapping reviewers' names in that link, so
it matched nothing. The avatar filter twenty lines below was written against the *same* selector, so
it stopped excluding and said nothing — five photographs of five named people went into a capture
bound for a public repository, underneath a comment asserting they were filtered out. Fixed with a
second guard by URL shape and, more to the point, `nodeCounts.avatarsSkipped`. The shape rule is the
weak instrument shape rules always are; the counter is the part that matters. **An exclusion that
cannot report its own count is a comment, not a control** — the same shape as the redaction lesson
(a denylist cannot catch a first instance), arriving from the other side.

`maps.reviews` filled seven of nine plans 5/5. `helpfulLabel` and `ownerReply` are recorded as
**unmeasured, not fixed**: there was no `fragment` on `MapsReviewNode`, so the bytes cannot tell
"this cafe never replies" from "the selector is stale", and a selector edited on no evidence looks
exactly like a fix until the next billed session. `fragment` now exists, so the next capture settles
them for free. Related: `button[aria-label*='Helpful']` is **English**, in a system whose purpose is
non-English viewpoints — a design defect independent of whether it caused the null.

Fixture redaction now states its own boundary. The blanket assertion "no pattern in
`SHAPE_REDACTIONS` appears anywhere in the file" is wrong and passed on the search fixture only by
luck: the opaque rule's 120-character threshold legitimately matches googleusercontent photo IDs,
which `scrub` does not cover and should not. Named credential shapes are forbidden file-wide; the
opaque rule is asserted only over the fields `scrub` covers; a third test asserts the long photo IDs
are **still present**, so "clean" can never be reached by widening the scrubber until the evidence
goes with it.

Before that: **P1.6 — the Pantip adapter**. `pantip.forum`, `pantip.tag` and `pantip.topic`,
registered in `apps/worker` alongside the YouTube, TikTok and Maps pairs — nine source ids in the
recorder. 264 tests in `@samsara/sources` (55 new), **0 browser minutes spent**, seam allowances
**0 of 5** across 135 files.

**The design answers the question P1.5 left open: what a wrong selector costs.** On Maps it costs a
browser session, because every field is read inside `page.evaluate` and the bytes that come back are
only what the selectors found. Pantip is server-rendered plain HTML, so the capture stores the
extracted fields **and the markup each one came from** — a wrong selector becomes a re-parse of
bytes already held. Capped at 30 fragments of 3,000 characters (~90 KB) against `fixture.ts`'s
standing warning that a 2 MB fixture is one nobody reviews, with scripts, styles and frames stripped
*in the page* before the fragment is taken: the markup around a post is content, and an inline
script inside it is where a token would be.

**Shape redaction again, and the licence for it is written into the constant.** A pattern list is a
denylist, which this file has called the problem twice. It is admissible here only because nothing
reads the two fields it guards — the state blob and the fragments are write-only today, so a false
positive costs nothing. A test asserts the weakness on purpose: an unnamed `sessionid=…` passes
straight through. The day something parses a fragment, the argument has to be made again.

**It clicks nothing, and navigates nowhere that is not Pantip.** A selector loose enough to find an
unseen "more comments" control is loose enough to press something else, so the candidates are
counted into `nodeCounts` instead — one step more cautious than the Maps tab index. `pantip.topic`
takes its query as an address and that query arrives from a previous capture, so a board id must
match a slug and a topic must be a number or an `https://` Pantip URL, query string dropped.

**Three real bugs, all found by laying the fixture HTML out the way the page actually is.** The
opening post's byline sits *beside* its body, not inside it — so every field but `text` came back
null and the stored fragment was cropped too small to repair it, which is a cap that defeats the
thing it caps. Fixing that exposed the second: the opening post's wrapper is called
`display-post-wrapper-inner` and a reply is `display-post-wrapper`, so the looser reply selector
matched the opening post's own box and stored it twice; the nesting guard checked only one
direction, and overlap in *either* direction is one post. Third, a class-substring selector has
decoys — `[class*="view"]` matches `pt-preview` — and requiring a digit then skipping to the next
*selector* rather than the next *match* lost the field entirely.

**Posts are emitted before listing rows, and that ordering is not cosmetic.** A topic page links
itself, so a row and the opening post resolve to the same URL — which is the point of building
identity from the topic number. First draft wins the id, and the row (a title and an excerpt) was
displacing the post (the writing and the images). Nothing failed; the evidence was just quietly the
worse of the two.

**The seam check fired on `Asia/Bangkok` in a test persona, and the right fix was to notice the
field was not needed.** Assembling the string at runtime would defeat our own tripwire; a
`seam:allow` would spend one of five on a file with no need of it. Pantip takes **no viewpoint
parameter at all** — no `hl`, no `gl`, no `lang` — so the persona reaches this source only through
the egress address and the browser's own headers. That makes it the cleanest test in the set of
whether a rented egress is worth anything alone, and the one source where P1.0's "query language
dominates" finding cannot apply, since every query and every answer is in one language.

**One surface beyond the plan's letter.** `PLAN.md` says "boards; board ids are a parameter"; there
is also `pantip.tag`, because Phase 1's inputs are Thai area names and an area on Pantip is a tag —
the boards are named after streets in the capital. It costs one URL builder and shares the listing
parser. `pantip.topic` is split from the listings for the reason the Maps pair is split: one
`capture()` that listed a board and opened every topic on it is a session of unbounded length.

**A fourth bug, in the wiring rather than the adapter, and it is the one worth a guard.** The three
adapters went into `record-capture.ts` and not into `boot.ts` — two hand-written lists of the same
thing, neither derivable from the other, and an adapter in one and not the other is not a type
error. `pnpm check` stayed green at 26/26 and it was caught by eye. The registry now lives in
`apps/worker/src/sources.ts` with `sources.test.ts` comparing it against the recorder's list and
against a written-down set of ids, because a deployment that quietly stops being able to run a
source reports no error and produces no evidence.

**What it did not buy**: nothing here has run against Pantip's real markup, so every selector is
still a guess. The difference from P1.5 is what the first capture costs to correct. See
`casestudy_and_thinking/sessions/2026-09-13-p16-the-fragment-that-pays-for-the-next-wrong-guess.md`.

Before that: **P1.5 — the Google Maps adapter**, plus **one live capture that came back
refused**. `maps.search` and `maps.reviews`, registered in `apps/worker` alongside the YouTube and
TikTok pairs. 209 tests in `@samsara/sources` (84 new), **0.270 browser minutes spent**, seam
allowances **0 of 5** across 127 files.

**The one capture found a third outcome, and it was not the one I was watching for.** Asking
`อารีย์` from a `th-TH` persona did not return a result list: Maps decided a one-word Thai area name
was unambiguous, resolved it to the street that names the area, and navigated to that entity's own
page. No result cards, and on that build no state blob either — every structural signal the refusal
rule had said *blocked*, and nothing had gone wrong. The rule is now *a search with no cards and no
blob is a refusal **unless** the landing address carries a feature id*, and `parse` emits one draft
for the resolved entity. That draft's real value is not the item: it is a **valid input to
`maps.reviews`**, which is the whole reason the search surface is a separate adapter. A session that
produced zero usable outputs now produces the one output the chain consumes.

**The identity mechanism proved out on real bytes, in a use it was not designed for.** The `0x…:0x…`
→ `cid` conversion was built for P1.8's overlap measurement; it is also the only part of a Maps
address readable without understanding the rest of it, which is what makes "resolved" legible at
all. `https://maps.google.com/?cid=7848097478468591393`, from the live URL, first try.

**All three names for the state blob were wrong** — `stateKeys` came back empty. The diagnostic did
its job and then stopped one question short: it reports which guesses were present, not what is
actually there. Added `stateCandidates`, which reports `window` key *names* matching a state-global
shape, sorted and capped, values never leaving the page. Third time this shape has come up, so it is
worth stating as a rule: **a diagnostic that reports whether you were right is worth one session; a
diagnostic that reports what the right answer is, is worth all of them.**

**`gl` did not survive the navigation** — sent, absent from the landing URL, while `hl` came through.
P1.3's `persist_gl` finding on a different source. Not acted on (region plausibly comes from the
egress IP, as on TikTok) but now asserted, so the day it changes something fails and says so.

**What the capture did not buy**: no review and no result card has ever been read by this parser, so
every selector in `inpage.ts` is still a guess. `fixture.test.ts` says so in its own header. See
`casestudy_and_thinking/sessions/2026-09-13-p15b-the-answer-was-in-the-address-bar.md`.

**Maps has no names, so the strategy that made the last two adapters writable blind does not
transfer.** YouTube tags its results with renderer names and TikTok's items are at least keyed
objects; `APP_INITIALIZATION_STATE` is anonymous nested arrays, and a tree search by key name has
nothing to search for. This surface is read from the **DOM** instead, which moves field extraction
inside `page.evaluate` — into the half that spends. The line that survives the move is narrower than
"parse does the parsing": *the in-page half selects and copies strings; it does not interpret them.*
The practical test is whether changing our mind about what a rating means costs a browser session.
It does not — that work is still in `parse`. What a **selector** change now costs is a session, and
saying so here is cheaper than discovering it later; it is also why `jsdom` is now a test-only
dependency, declared per file with `/** @vitest-environment jsdom */` rather than package-wide.

**Two adapters, because one would spend an unbounded amount.** "Search an area, then open each
result" is a single billed session whose length is a function of a page nobody has loaded yet —
invisible to the kernel's per-session meters until it ends. Split instead: `maps.search` takes an
area or a category, `maps.reviews` takes **an entity URL as its query**, and the chaining is the
caller's, on the P1.1 precedent that a list of areas is a job-payload argument and never a constant
inside the engine. Second dividend: a failure at the eighth entity of ten loses one capture, not
ten. `buildReviewsUrl` refuses any host that is not Google's — an adapter that will navigate
anywhere on request is a proxy with our egress address on it.

**The diagnostics are the design.** Three things about Maps cannot be known without paying: which
tab is the reviews tab (localised, so matched by position), whether `data-review-id` still anchors a
review, and whether the blob is still called `APP_INITIALIZATION_STATE`. Every capture records what
it saw — `tabLabels`, `nodeCounts`, `stateKeys`, `observedPaths`, `strategies` — so **one** capture
answers all three, including a capture that failed. Generalises P1.4's `observedPaths`.

**Redaction by shape, not by key name — and only because nothing reads the field.** Every other
adapter redacts a keyed tree by name; Maps' one opaque field is a *string*, so the only available
filter is a pattern (JWTs, `AIza…` keys, `ya29.` tokens, `SAPISIDHASH`). That is a denylist, which
this file has twice called the problem. It is acceptable here for one reason that inverts the
trade-off: nothing parses the blob, so over-redaction costs nothing, where over-redacting TikTok's
`signature` destroyed an author's bio.

**Identity comes from the feature id, and that was an accident worth keeping.** `place` is in the
seam's `FORBIDDEN_IN_CODE` tier and is also Google's own noun. Neither escape was acceptable — a
`seam:allow` would burn two of five on a word that is not the engine knowing about travel, and
assembling the string at runtime is evading your own checker. Looking for an identifier that avoided
the word instead found the hex pair `0x…:0x…`, which is regex-extractable without understanding the
blob and converts to `https://maps.google.com/?cid=<decimal>` with one `BigInt`. The raw Maps URL
carries a viewport and a session-shaped `data=` segment, so it **differs between two captures of the
same entity** — which would not have failed loudly in P1.8's URL-overlap measurement. It would have
reported zero overlap and read like a finding.

**A real bug in `counts.ts`, found by a realistic Vietnamese string.** `parseCount("231 bài đánh
giá")` returned 231,000,000,000: `b` is a complete scale word in the table and `bài` starts with it.
Fixed where the bug was rather than in the Maps parser — a Latin-script scale word must not be
immediately followed by another Latin-script letter — with Thai deliberately exempt, because Thai is
written without spaces and `1.2 ล้านครั้ง` has a letter directly after the scale word. Third session
running in which the bug surfaced because the test string was realistic rather than convenient. See
`casestudy_and_thinking/sessions/2026-09-13-p15-the-surface-with-no-names.md`.

Before that: **P1.4 — the TikTok adapter.** `tiktok.search` and `tiktok.explore`, registered in
`apps/worker` alongside the YouTube pair. 77 tests in `@samsara/sources`, **0 browser minutes
spent**, seam allowances **0 of 5** across 111 files.

**The brief ruled out more than it ruled in.** The plan names TikTok as the surface most likely to
gate on IP geolocation and says to report the gap rather than work around it — so there is no
captcha solving, no signature forging, no rotating personas until one is let through. The refusal
*is* the measurement: P1.0's finding (query language dominant, egress worth about as much as waiting
five minutes) was measured on a surface that honours `gl` and `hl` as URL parameters, and whether it
survives a surface that enforces geography is the open question. TikTok takes exactly one viewpoint
parameter in a URL — `lang` — and region comes from the egress IP alone, which is why this adapter
and not YouTube's is the one that actually tests ADR-0015's `sg`-for-`th` compromise.

`refusedBy` distinguishes **three** walls. `region-block` is the finding. `captcha` is a judgement
about this session and feeds persona health. `login-wall` applies to every logged-out visitor and
degrades a persona that did nothing wrong — an admitted cost, taken because a harvest that silently
returns nothing from behind a wall is worse. And both strategies coming back empty is *not* `empty`:
it means we could not read what TikTok sent, which is a different row and a different thing to fix.

**Recognition is structural, because TikTok does not name its items.** YouTube tags results with
renderer names; TikTok's items are anonymous objects in arrays whose names change per endpoint. The
predicate is a digit-string `id`, a `desc` that is a string, and an `author` or `stats` — strict on
purpose, because a loose one returns music tracks and hashtags as videos and every one of those gets
stored as evidence and scored.

**Two entries came off the redaction denylist for destroying content.** `signature` on a TikTok
author is the account bio — free text in the local language, exactly what this project harvests.
`userInfo` is the viewer in `SIGI_STATE` and a *result* in the search API, and key-name redaction
cannot tell them apart. This is the second time in three sessions a denylist has been the problem;
it survives only because there is no type-level alternative for bytes a third party sent us.

**A doc comment of mine was false and a test proved it.** `guessLanguage` claimed Vietnamese
diacritics are "present in almost any real Vietnamese sentence" — true of sentences, false of the
four-word captions it will actually be handed. `bánh mì ngon quá` contains nothing outside Latin-1.
Not fixed by widening the character class, which would report Spanish as Vietnamese; fixed by
correcting the claim, asserting the limitation in a test, and preferring the source's own language
field. The mechanism is worth keeping: the bug was in prose, and it surfaced only because the test
string was realistic rather than convenient. See
`casestudy_and_thinking/sessions/2026-09-13-p14-the-surface-that-says-no.md`.

Before that: **P1.3 — the YouTube adapter.** `youtube.search` and `youtube.trending` are two
adapters sharing one parser, `harvest.run` is wired into `apps/worker`, and 44 tests in
`@samsara/sources` pass without a single one of them having seen YouTube. **0 browser minutes
spent**, seam allowances still **0 of 5** across 103 files.

**The one step not taken, which needs a decision.** No live capture has been recorded, so
`youtube.fixture.test.ts` does not exist. Recording it opens a browser session through a paid
provider — about a cent against a 4,000-minute ceiling, trivial as money and not trivial as a
precedent — and writes the resulting bytes into a **public** repository, where the only protection
is an 11-key redaction denylist. The recorder is built and its dry run is correct; the command is
`pnpm --filter @dt/worker record -- --query="…" --country=sg --locale=vi-VN`. Until then
`parse.test.ts` states in its own header that its hand-built trees test the parser's behaviour and
do **not** establish that the shape is right.

Three shapes worth carrying forward: **two adapters, one parser** (`sourceId` is what a stored row
is grouped and re-parsed by, and a search result is not the same evidence as a trending slot);
**the parser searches for five renderer names rather than walking a path**, because names are the
stable part of YouTube's response and containers are not, while preserving encounter order because
encounter order is rank order; and **redaction is a key-name list, not a narrowing of the payload**
— storing only the results container would move parsing into the half that spends, after which
every layout change costs a browser session instead of a parser edit.

`counts.ts` returns `null` rather than guess: 12 scale words across 3 languages, Thai counting in
powers of ten thousand, and `,` meaning a thousands separator in one language and a decimal point
in another. A mis-scaled view count ranks content while looking entirely reasonable; a missing one
is visibly missing.

**A known hazard stopped being theoretical.** The shared test-database note below had sat unacted
on since P1.1. Adding a third package that truncates the same four tables turned it into five
`.pg.test.ts` failures under `pnpm check` that passed individually and were not the same five
twice. Fixed with a Postgres advisory lock held for the length of each pg test file
(`@samsara/db/testing`) rather than `--concurrency=1`, which would have serialised twenty-six
tasks to resolve a conflict between three and re-introduced the bug silently on the next package
to open a connection. Parallel suite: **9.6s green** against 26.7s for the serial workaround, four
consecutive runs at 26/26. See
`casestudy_and_thinking/sessions/2026-09-13-p13-the-first-real-source.md`.

Before that: **P1.2 — `@samsara/sources` + `@samsara/harvest`.** The adapter contract and the
orchestration around it. 43 new tests, **zero browser minutes spent** building either, seam
allowances still **0 of 5** across 92 files.

The shape that matters: **the adapter is two methods, and the split is a type rather than a
convention.** `capture(ctx, query)` spends browser minutes; `parse(capture)` is synchronous and is
handed only bytes — no page, no signal, no clock — so an adapter cannot fetch while parsing even
by accident. The plan's justification for this whole phase ("parser iteration opens no browsers …
the single largest saving available") is not deliverable by the single `harvest()` the plan
specified: that signature *permits* the separation without creating it. The stored fixture is a
recorded `Capture`, byte for byte identical to what the archive holds, so a parser test and a
re-parse of a real run execute the same code on the same bytes and cannot drift apart.

Two findings from the session:

**One design bug, mine, caught by a test.** An archive failure was first written as non-fatal:
log it, skip the items, carry on. That produced a run marked `ok` with zero items behind it —
forty items parsed, nothing written, a `harvest_runs` row that reads like a good day. Archive
failure is now fatal to the run. An item with no `rawRef` looks like evidence and can never be
re-read when the extraction model changes; a loud outage that re-spends minutes beats a quiet
corruption that does not.

**The seam checker was blind in both of the languages this product is for.** `"ที่เที่ยวกรุงเทพ"`
sat in an engine test through a green `check:seam` — `กรุงเทพ` is Bangkok, which is in the tier
scanned *everywhere*. `segments()` splits on `[^A-Za-z0-9]+`, so Thai text is erased before the
comparison rather than failing it; Vietnamese breaks into `kh`, `ch`, `s`, `n`. Caught by a human
reading a diff, which is the failure mode the file exists to eliminate. Fixed with a third tier,
`FORBIDDEN_SUBSTRINGS`, matched as lowercased substrings because Thai has no word boundaries to
match on, plus three regression tests — one of them asserting an ordinary Thai greeting still
passes, so the tier does not degrade into "non-Latin text is suspicious". The general form is
worth keeping: **every mechanical guard has an undocumented domain of applicability, and the leak
goes exactly there.**

No `harvest.run` job type is registered in `apps/worker`, deliberately: `runHarvest` takes an
adapter and there is none until P1.3, so a registry with no entries would be a job type that
always fails. Wiring lands with the first real source. See
`casestudy_and_thinking/sessions/2026-09-12-p12-the-split-and-the-blind-checker.md`.

Before that: **P1.1 — `@samsara/personas`.** The identity package: create, health state
machine, ban detection, `keepalive`. 54 tests, **zero browser minutes spent** building it, seam
allowances still **0 of 5** across 82 files.

The session's finding is that four separate defects here would each have produced a **perfectly
green run** — no failing test, no alert, no symptom:

| silence | what it looks like when it happens |
|---|---|
| profile never `save`d | session opens, pages load, row says `ok`, identity accumulates nothing |
| `403` classified as `internal` | refusal is **retried** against the surface that just refused; nothing ever recorded `blocked` |
| `seeded` silently downgraded to `anon` | persona counts as seeded in every listing for weeks |
| read-modify-write on the minute counter | two concurrent runners lose an update, always *downward*, under a hard ceiling |

The second is the serious one and it was found by a test failing for the wrong reason:
**the ban detector could not have detected a ban.** Playwright's `goto` does not throw on a
refusal — it returns a response carrying the status — so every real block classified as `internal`,
and `internal` is the one `retry.ts` retries. Fixed in the kernel with a `Blocked` error class that
`classify` recognises by instance, before any string matching.

Two decisions worth carrying forward: the **health streak is derived from `sessions` rows, not
stored** (so a threshold change is retroactive rather than leaving personas banned under a rule
nobody can reconstruct), and **`timezone_id` is a stored column** rather than derived from country
or locale — P1.0 measured those apart, and an identity whose clock is computed from its IP cannot
express that result. That makes `Viewpoint` `{country, locale, timezoneId}` in the persona row,
which answers gate question 1 by building it. See
`casestudy_and_thinking/sessions/2026-09-12-p11-the-identity.md`.

Before that: **P1.0 — the signal-matrix experiment, run.** 18 cells, 4.79 browser-minutes of
4,000, and a result that changes the priority order for P1.3–P1.6:

| factor | effect | vs a 21% noise floor |
|---|---:|---|
| **query language** | **100%** (0 shared results of 20) | **dominant** |
| egress country | 31% | weak |
| browser locale + clock | 23% | weak |
| stored region preference | 20% | **noise** |

**Asking in Thai and asking in English return completely disjoint lists** — same IP, same browser,
same second. Everything else is at or barely above what repeating a single cell produces. The
honest answer to "how do you get local content without a local IP" is: *you ask in the local
language*. ADR-0015 described a graded stack; the measurement shows a cliff, and mildly disagrees
about the ordering below it (egress sits at the top of the weak cluster, not the bottom) — see
`casestudy_and_thinking/sessions/2026-09-12-p10b-the-result.md`, which also records that the run
found a 32% under-report in its own billing and what was done about it. One surface, one query,
one day; the `Surface` interface exists so a second costs a file.

Before that: **P1.0, the zero-cost half.** The signal-matrix experiment is designed, built and
tested without opening a single session: the factorial machinery, pairwise overlap, factor effects,
noise floor and seeded run order live in `@samsara/harvest` (29 tests, no network); the two query
strings, the locale-to-clock map, the region hints and the YouTube surface live in a new `@dt/lab`
package (15 tests). Writing the design down found four flaws in the plan's one-sentence version of
the experiment, none of which needed a session to discover — see
`casestudy_and_thinking/sessions/2026-09-12-p10-designing-the-experiment.md`.
Before that: **P0.8** (the acceptance run): Phase 0's own three acceptance criteria executed
literally for the first time. Criterion 3 held. **Criteria 1 and 2 were both false and had been
for days, with no symptoms.** A fresh clone following the README produced `67 passed | 14
skipped`, exit 0, testing none of the job store; and the `@live` test had never written a
session row to Postgres at all, because it used a memory store for both session and counters.
Both fixed, both re-verified from a clean clone: **31 seconds** to a green `pnpm check` against
a 10-minute budget, 148 tests including all 13 Postgres ones, `pnpm dev` verified end to end in
the clone, `@live` green with row `e9330835` in `sessions`, seam ok at 65 files with **zero
allows of five**. A third finding fell out of the live run — `Asia/Ho_Chi_Minh` and
`Asia/Saigon` are one zone under two spellings and ICU answers with the older one, so the
viewpoint check was reporting a false negative. Before that, **P0.7** (the seam check),
**P0.6** (dev ergonomics) and **P0.5** (the queue and the two runtimes); all three were
committed this session, having lived only in the working tree until now.
NEXT: **wait.** The week is running and there is nothing left to do to it. Supabase
(`ap-southeast-1`) exists, nine migrations are applied, the two personas are seeded —
`sg`/`th-TH`/`Asia/Bangkok` and `us`/`en-US`/`America/New_York`, PLAN's option (c) — and experiment
`f60fb262` queued fourteen `harvest.run` jobs on "Bangkok street food" against `youtube.search`,
one pair a day, `recording: true` on all fourteen. Both repository secrets are set, the schedule is
`*/15`, and scheduled drains have been green since 2026-09-16 17:47 after 22 consecutive failures.

**Day 0 came in at 60.0%** — twelve of twenty URLs shared, mean rank shift 5.2, two `ok` sessions
with recordings, 0.2388 billed minutes. That is exactly the gate: Phase 1 wants the week under 40%
and says "stop and redesign adapters" above 60%. One day is not the series, and the ambiguity PLAN
wrote down applies — with `country` held at `sg` rather than `th`, a high number cannot distinguish
a surface that barely personalises from one that keys on an IP neither persona has.

**What to watch, and it is not the code.** GitHub drops scheduled runs on a quiet repository: three
ticks landed in the nine hours after the fix, not the thirty-six a `*/15` cron implies. A day can
start hours after it comes due, which the chart draws honestly because its x-axis is the time the
run happened. If a day goes `missing` rather than late, the cause is almost certainly a dropped
schedule and the fix is a `workflow_dispatch`, not a change to anything here.

**Single source, on purpose.** The acceptance criterion says "across adapters" and an experiment
carries one `sourceId`; `youtube.search` is the only adapter this phase has run end to end against
a live page, and it genuinely personalises. Adding `maps.search` or Pantip would not have measured
more — a forum that does not personalise contributes a flat line near 100% that drags a
cross-adapter average toward the gate for a reason that has nothing to do with the personas. A
second source means a second seven-day week, started on its own day 0.

**P2.1 (`@samsara/llm`) is buildable in parallel** and does not depend on the number — but the 60%
gate does, and the gate is what says whether the refine pipeline is being built on signal or noise.

Closed since: **the two creators' contact details in `tiktok-search-vi-VN-2026-09-13.capture.json`
are gone.** The question assumed the bio was a field we read and that shape redaction would catch a
contact detail in it; both were false. `parse.ts` reads `uniqueId` and nothing else, and shape
redaction caught two of the four details — it missed an address written in Mathematical Bold and a
number written `0844.ll.OO.ll`. Half a browser minute buys the bio back if P1.8 turns out to want
it; a stranger's address in a public git history cannot be taken back at any price. `signature` is
on `REDACTED_KEYS`, the fixture is re-scrubbed, and the two tests that asserted the opposite are
**inverted with the reasoning attached** rather than deleted. Written up as Q9.

And **the Phase 0 gate** (see below), whose fourth question — P1.0 measured the signal stack and it
does not match ADR-0015's ordering — is still open. Gate question 1 (`Viewpoint`'s shape) is now
answered in code: `{country, locale, timezoneId}`, stored on the persona row and read straight
through by `CapturePersona`.
Half-resolved: `jobs.pg.test.ts`, `personas.pg.test.ts` and `harvest.pg.test.ts` no longer
truncate *each other* — a Postgres advisory lock in `@samsara/db/testing` serialises them across
processes. They still truncate the same database `pnpm dev` drains, which remains an architect's
call: harmless while the dev data is disposable, and not the day it is not. The lock makes the
suite correct; it does not make the choice of database correct.
Resolved since: `@samsara/sources` now has seven recorded fixtures across four sources, and
`pantip.topic` — the one with real selector risk left — is one of them. `maps.search`-that-resolves
remains unrecorded and is the last surface never measured.
Still unresolved: the `CaptureArchive` decision (no Supabase credentials), with
`FilesystemCaptureArchive` an explicit stand-in that does not survive an Actions runner.
Branch: main
Known breakage: none. (The 0003/0004 gap from last session is closed — Docker was started, all six
migrations are recorded, and `places.external_ref`/`resolved_tier` are live.)

Last session notes:
- 2026-09-11 (Claude Code) — session 2
  - **Budget.** Aswin set a hard **$20 ceiling** for the whole demo. Section 8 rewritten around it:
    three meters (Solari minutes, LLM tokens, geocoding calls), each with a ceiling expressed as a
    **count** rather than dollars, because rates drift and counts do not. Section 2.4's budget guard
    is now three-metered, and P0.4 gained an acceptance criterion that drives each meter past its
    ceiling and asserts the refusal. The guard is no longer a Phase 8 concern.
  - **ADR-0012: OpenRouter is the LLM gateway.** Amends ADR-0006. One key, many models; the model
    for each task is an env var, never a literal. The point is not the markup — it is that the
    extraction model gets chosen at P2.1 by measurement, and replaying stored RawItems costs
    nothing on the Solari meter, so the bake-off is affordable. Known cost: the Anthropic Batch
    API's 50% discount is not reachable through OpenRouter. Accepted.
  - **P0.1 done.** pnpm workspaces + Turborepo 2 + Biome 2 + Vitest 3 + TS 5.9. 16 workspace
    projects: 9 under `packages/samsara/`, 4 under `packages/travel/`, 3 apps. Every package is a
    stub exporting its own name. `pnpm check` (lint, typecheck, test) is green.
  - `.env` holds a real `SOLARI_API_KEY`, is gitignored (verified with `git check-ignore`), and was
    written with `umask 077`. `.env.example` created with every variable the plan implies so far,
    including the four budget ceilings.
  - Cookbook `examples/` untouched, as P0.1 requires. Biome explicitly excludes them.

  - **P0.2 done.** `@samsara/core` has schemas for all nine engine entities; `@dt/core` has the
    five travel ones. 25 tests: every schema parses a fixture, plus the constraints that are
    actually load-bearing (country must be lowercase, `SessionPurpose` stays closed, confidence is
    bounded, every score carries its `because`). `@samsara/core` depends on zod and nothing else.
  - **The seam bit back immediately, which is a good sign.** The first draft of the engine's
    fixtures used travel vocabulary — Bangkok, a restaurant query, agoda as a source — to make the
    examples readable. That would have failed P0.7's lexicon check, correctly: if the engine's own
    fixtures need a vertical's words to be legible, the schemas are not agnostic. Rewritten around
    a made-up domain called `atlas`. Worth knowing before P0.7 lands, because it means the check
    will find real things, not just typos.
  - `packages/samsara/core/src/seam.test.ts` is a narrow, package-local version of the seam check:
    no `@dt/*` import statement, no `@dt/*` dependency, and nothing but zod in `dependencies`.
    P0.7 generalises it; this one stays, because it fails in the package that broke the rule.

  - **Q3 answered: Supabase Auth** (ADR-0013). The API verifies the JWT and passes `sub` down as an
    opaque `ownerId`; the travel `users` table keys on that id rather than generating its own. No
    RLS in v1 — the worker writes rows for users who are not present, which RLS fights, and
    authorisation lives in the API layer, the only place that has the request identity. This
    decision touched nothing under `packages/samsara/`, which is a small test of the seam passing.
  - **P0.3 done, verified against a live Postgres.** 14 tables (9 engine, 5 travel), 12 enum types,
    one migration (`0000_lying_menace.sql`), seed runs and is idempotent. `docker-compose.yml` at
    the root brings up Postgres 17 and Redis 7 with healthchecks; `pnpm db:up`, `db:migrate`,
    `db:seed`, `db:reset` wrap it.
  - **The seam holds at the database level, and this is now checked two ways.** Queried live:
    zero foreign keys from any engine table into any travel table. Also asserted structurally in
    `packages/travel/db/src/schema.test.ts`, so CI catches a regression without needing Postgres.
    The check is not vacuous — the same logic finds all 14 real foreign keys.

  - **Q1 answered: Cloudflare** (ADR-0014) — and it forced a bigger change than the question asked.
    Free Workers meter **CPU, not wall clock**, at 10 ms per invocation. `apps/web` and `apps/api`
    fit; `apps/worker` cannot, because parsing a harvested page is computation, not I/O. So the
    worker is a **scheduled GitHub Actions job**, and once the consumer is a job that wakes,
    drains, and exits, the queue is a Postgres table — **BullMQ and Redis are both gone**, along
    with the always-on box and its monthly fee. Section 2.2 rewritten; ADR-0004 superseded; Redis
    removed from `docker-compose.yml` and `.env.example`.
  - The kernel's budget counters move from Redis keys to Postgres rows keyed by meter and window.
    This is more correct regardless: a guard that forgets what it spent when a runner exits is not
    a guard.

- 2026-09-11 (Claude Code) — session 3
  - **P0.4 done, and a live session actually opened.** `@samsara/kernel` is nine source files plus
    two store backends. `withBrowser` refuses on the guard, opens, registers, races a hard deadline,
    force-closes on overrun, closes in a `finally`, and meters the minutes the session really took.
    62 tests, none of which need a key or spend anything: `ports.ts` defines `BrowserLauncher` and
    `SandboxLauncher`, and `solari.ts` is the only file in the repository that imports the SDK.
  - **First real number for the minutes meter: 0.042 minutes** for a probe session that opened a
    residential-proxied browser, loaded ipify, and closed. Against a 4,000-minute ceiling, a probe
    costs about 0.001% of the demo's Solari budget. Solari is up, not in maintenance.
  - **The live test found a product blocker, not a bug: Solari has no Thai residential egress.**
    `country: "th"` returns `400 Unsupported proxy country` with the pool inlined — 15 countries,
    no `th`. Section 1.4 names Bangkok as the first city. Recorded in
    `packages/samsara/kernel/src/countries.ts`, flagged in section 1.4, and asked as section 10
    question 9. The kernel refuses `th` locally and names `sg` as the nearest available, but does
    not substitute it: a silent country swap changes what a persona sees, which is the one variable
    the Persona Lab exists to hold still. **This needs Aswin's call before P1.**
  - The same 400 exposed a real defect on the way: `classify` had no 4xx branch, so it called the
    provider's "you asked for something that does not exist" `internal` and then retried it twice.
    Now 4xx is `config`, and `config` is not retryable.
  - **Q1's answer changed the logger's type, not just a config value.** The repository is public, so
    the Actions log is public. `KernelEvent` is a closed discriminated union with **no free-form
    `payload` or `meta` field anywhere** — logging a secret does not typecheck. `registry.test.ts`
    asserts every emitted key against an allowlist, so adding one fails the build. A redaction
    denylist would have been the obvious design and the wrong one; denylists leak by omission.

  - **Q2 answered, and it tightens everything: the $20 IS the usage credit.** No free runtime
    underneath it; overage bills Aswin's card, which is not acceptable. Section 8 rewritten. Three
    consequences, all in code: the ceiling is a stop and not a warning; the ~$4 unallocated is
    **reserve against our own undercount** (a killed runner leaves a VM billing while our counter
    records nothing — routine under ADR-0014) and must not be allocated; and **the one remaining
    card exposure is Google Places**, which auto-bills once its free credit runs out. Places needs a
    hard daily **quota cap** (not a budget alert — alerts only send mail) before Phase 2. Until then
    geocoding runs on Nominatim only.
  - **ADR-0015: a viewpoint is a stack of signals, and the IP is the weakest one.** This answers
    question 9 and keeps Bangkok as the first city. Platforms rank by account region, query
    language, stored region preference, browser locale/timezone, engagement history, and only then
    egress IP. A Thai IP asking in English gets the global viral feed; a `th-TH` browser on
    `Asia/Bangkok` asking in Thai does not.
  - **A real bug fell out of writing that down: Solari sets neither locale nor timezone.**
    `browser.newPage()` returns the pool's default context — `en-US` on UTC. Every session the
    kernel had opened was claiming to be an American on a Singapore IP: wrong for the product and a
    conspicuous mismatch for the anti-bot surfaces. The kernel now builds its own context, carrying
    the profile's `storageState` across by hand (`newContext()` opens an *empty* one — losing a
    warmed profile that way would have been silent).
  - **Verified live:** egress `121.7.135.149` (Singapore residential), page reports
    `navigator.language = th-TH`, `Intl` zone `Asia/Bangkok`, offset −420. 0.057 minutes.
  - **`sessions` records both halves** (`locale`, `timezone_id`, migration 0002), and so does the
    `session.open` log event. An Observation cannot be read without the viewpoint that produced it,
    and "which signals were present" is the independent variable of every Phase 1 experiment.
  - **New task P1.0, ahead of the adapters:** a signal-matrix experiment — one query across egress x
    locale x query-language x stored-preference, measuring pairwise URL overlap. Under 10 browser
    minutes. It turns "we can't get a Thai IP" into a measured table of what actually matters, and
    the adapters get built against measured weights instead of assumed ones.
  - ADRs 0001 to 0008 written, so 0001 to 0015 all exist.

- 2026-09-12 (Claude Code) — session 4
  - **Migrations 0003/0004 applied**, plus a new **0005** for the queue. Six recorded, `places` has
    `external_ref` and `resolved_tier`, `places_google_id_idx` and `google_place_id` are gone.
  - **P0.5 done.** The queue is `jobs` + `job_events`. The claim is **one statement** — a CTE that
    selects `FOR UPDATE SKIP LOCKED` and updates in the same round trip — never a select followed by
    an update, which is the shape that hands one row to two runners.
  - **The design decision underneath it: a cancelled runner is routine, not an incident.** GitHub can
    cancel a scheduled run at any moment, so every claim carries a `lease_until`. An expired lease is
    reclaimable by the next runner, which means the *default* recovery path needs no operator and no
    dead-letter queue. Shutdown is the fast path on top of that, not the only path.
  - **A real bug that came out of writing the shutdown path:** `runOne` was routing a SIGTERM-aborted
    handler through `classify()` into `fail()`, so a cancelled job consumed an attempt and got backoff
    applied. Three unlucky cancellations would retire a job that had never actually been tried. Also,
    with `batchSize > 1`, rows 2..n of an aborted batch were claimed but never released. Both fixed:
    every claimed row is held from the instant it is claimed, and cancellation returns `"released"`,
    a third outcome next to succeeded and failed. **Cancellation is not failure** is now a type.
  - **ADR-0016 acceptance criterion 1 — CPU per request.** Measured with `process.cpuUsage()` over 500
    real requests through the real handlers (`apps/api/src/cpu.test.ts`), against the free plan's
    **10 ms** ceiling:

    | route                      | CPU per request | share of ceiling |
    | -------------------------- | --------------- | ---------------- |
    | `POST /jobs`               | **0.067 ms**    | 0.7%             |
    | `GET /jobs/:id/events` (1 tick) | **0.057 ms** | 0.6%            |
    | `GET /health`              | **0.016 ms**    | 0.2%             |

    Stated honestly: this is a **proxy**. Workers meters CPU rather than wall clock, and it freezes
    `Date.now()`/`performance.now()` between I/O precisely so that a Worker cannot time itself — so
    the authoritative number comes from the Cloudflare dashboard after deploy. This test's job is to
    catch a regression in CI two orders of magnitude before the ceiling. The assertion is set at half
    the ceiling, not at it.
  - **ADR-0016 acceptance criterion 2 — bounded stream queries.** A stream held its entire 15-minute
    lifetime across a job that never finishes costs **76 Hyperdrive queries**, against **900** for the
    flat one-second poll ADR-0016 rejected. The bound is asserted against `maxStreamQueries()`, which
    is computed by walking `streamPollIntervalMs` — the same function the handler calls — so editing
    the schedule cannot leave the test passing against a number that is no longer true. A finished job
    costs exactly one query.
  - `wrangler.toml` (Hyperdrive binding, `nodejs_compat`), `.github/workflows/worker.yml`
    (`schedule` + `workflow_dispatch` with a `jobId` input, `concurrency: worker`,
    `cancel-in-progress: false`), and the new `.env.example` entries — names only, no values.
  - **ADR-0019** records this session's two structural decisions and why the alternatives lose.

  - **P0.6 done, and the dev loop was verified end to end rather than assumed.** `pnpm dev` brings
    up Postgres, then three persistent turbo tasks: Vite on :5173, `wrangler dev` on :8788, and the
    runner on a 3-second timer. Checked by hand: `/health` through Vite's proxy into workerd returns
    `{"ok":true,"service":"api"}`, and the runner picked up and drained a leftover `noop` row
    (attempt 2, `reclaimed: 1` — lease expiry reclaiming a row in reality, not in a test).
  - **Verified the risky unknown: postgres-js works inside workerd.** A throwaway probe worker
    enqueued a job through Hyperdrive's local connection string and read its event back. The whole
    chain — workerd → `nodejs_compat` → postgres-js → drizzle → Postgres 17 — is confirmed locally,
    which is the part that would otherwise have been discovered on deploy day.
  - **A real defect the first `wrangler dev` found:** workerd refuses to start if the entrypoint
    module has a named export that is not a handler (`Incorrect type for map entry 'PACKAGE'`). P0.1's
    "every package exports its own name" convention is correct for libraries and wrong for an
    entrypoint. `apps/api/src/index.ts` now exports only the default handler; the other modules are
    reachable through subpath exports, with the reason written above the code.
  - **Second defect, found by reasoning rather than by a crash:** the Supabase verifier was built at
    isolate boot, so `SUPABASE_URL` was required before `/health` — an unauthenticated route — could
    answer. Now built on first authenticated use. A clean checkout with nothing but Docker running is
    enough for `pnpm dev`.
  - **Third, small and real:** `main()` registered SIGTERM/SIGINT handlers with `once` and never
    removed them. `once` only unregisters a listener that fires, so calling `main()` repeatedly (the
    dev loop; tests) leaked one per call and would have announced itself as a
    MaxListenersExceededWarning on the eleventh drain. Removed in the `finally`.
  - **The dev worker is a loop around the real `main()`, not a daemon.** Production has no long-lived
    worker, so dev must not invent one — a persistent dev worker hides every bug that only appears
    because the process *ends* between jobs.
  - `apps/web` is now a real Vite app (React 19, Tailwind v4, TanStack Query). One page, which calls
    `/health` and shows a dot. It is deliberately not a hello-world: a page that renders without
    touching the proxy, the Worker and the database would let the whole chain break and still look
    green, which is the failure P0.6 exists to remove.


- 2026-09-12 (Claude Code) — session 5

  - **P0.8 is not in the plan.** Phase 0's task list ends at P0.7. What was left was the phase's
    own **acceptance criteria and gate**, which is what this session did. Worth recording
    because the result argues for making that a numbered task everywhere: two of the three
    criteria were false, both had been false for days, and neither had produced a symptom.

  - **P0.5, P0.6 and P0.7 are committed.** They had lived only in the working tree — 69 files,
    HEAD still at P0.4. Four commits, scoped by concern, plus the P0.8 fixes. They were split
    out of one tree at the end, so each is coherent but was not built in isolation; the commit
    that says so says so.

  - **Criterion 1 — a fresh clone reaches `pnpm dev` in under 10 minutes. Now true: 31 seconds.**
    Measured by cloning into an empty directory and following the README verbatim. install 4 s
    (17 s with a cold pnpm store, measured separately), `db:up` 4 s, migrate+seed 5 s, `pnpm
    check` 18 s. 148 tests. Then `pnpm dev` in the clone: `/api/health` through Vite's proxy
    into workerd returned `{"ok":true,"service":"api"}` and the runner logged
    `claimed:1 succeeded:1 reclaimed:1`. The one unmeasured piece is the `postgres:17-alpine`
    pull on a machine that has never had it; labelled rather than estimated.

  - **The first run of that criterion failed, and it is the same bug P0.7 already fixed.**
    Following the README exactly produced **`67 passed | 14 skipped`, exit 0** — none of the
    job store tested. P0.7 found Turbo 2's strict env mode filtering `DATABASE_URL` and declared
    it on the `test` task. That was correct and insufficient: turbo forwards a variable it can
    see, and **nothing ever put this one in turbo's environment, because nothing loads `.env`.**
    Every layer behaved correctly and the run tested nothing. I had never seen it because I
    always ran `DATABASE_URL=... pnpm check` out of habit.
    - Root `test` script now loads `.env` via `node --env-file-if-exists`, which moves the Node
      floor to **22.9** — cheaper than a dotenv dependency in a repo that has refused every
      gratuitous one.
    - **The durable half: `jobs.pg.test.ts` now fails without a database rather than skipping**,
      unless `SAMSARA_NO_DB=1` says the omission is deliberate. Plumbing fixes hold until the
      next layer appears above them; the actual defect is the silent skip, because a green run
      that means nothing never gets investigated. The opt-out stays, because forbidding it just
      moves people to commenting the test out — it only has to be said out loud, which is the
      bargain `// seam:allow` already strikes.

  - **Criterion 2 — `@live` passes and its session row appears in Postgres. The row half had
    never been implemented.** The test used `MemorySessionStore` *and* `MemoryCounterStore` and
    asserted against the in-memory logger; no row had ever appeared, and it had passed since
    P0.4. The reason it was written that way is good and was applied one noun too far: counters
    must stay in memory or CI spends the demo's allowance on itself, but **a counter is money
    already spent and a session row is a record of something that happened.** The test now
    writes to Postgres when `DATABASE_URL` is set and reads the row back **through SQL**, not
    through the store that wrote it — a store asserting its own return value proves nothing
    about what landed. Budget stays isolated either way.

  - **A real defect the live run found: `Asia/Ho_Chi_Minh` and `Asia/Saigon` are one zone.**
    The test failed on `expected 'Asia/Saigon' to be 'Asia/Ho_Chi_Minh'`. The first is IANA's
    canonical id since 2016, the second the older name kept as a link, and **ICU — what every
    browser and every Node build resolves through — answers with the older one.** The viewpoint
    had landed perfectly: egress `103.252.202.21`, `navigator.language` `vi-VN`, offset −420.
    The assertion was wrong.
    - Not a test nit. **"Did the viewpoint reach the page" is a check every adapter after P1.0
      has to make**, and it decides whether an Observation is interpretable. A false negative is
      the expensive direction — it discards good data and sends someone hunting a proxy bug that
      does not exist. `Asia/Calcutta`/`Asia/Kolkata` is the same trap.
    - `packages/samsara/kernel/src/timezone.ts`: `canonicalTimezoneId` and `sameTimezone`,
      canonicalising **through `Intl` rather than a table we maintain** — aliases move with the
      tzdb and a hand-written map goes stale in silence. 4 tests, including that two zones
      sharing an offset (`Asia/Singapore` vs `Australia/Perth`) stay distinct.
    - **The `sessions` row still stores what we asked for**, which is correct: it records the
      viewpoint requested. What the page reported is a separate fact, and **P1.1 is where a
      persona starts carrying both** — the gap between them is why an Observation can be read.
    - Note the chain: P0.7 moved the engine's fixtures off `Asia/Bangkok` (no alias) onto
      `Asia/Ho_Chi_Minh` (has one) to get the product's first city out of the engine's
      vocabulary. **The seam fix is what exposed this bug.**

  - **Criterion 3 — held, verified both ways again.** Clean tree: `seam ok — 65 files under
    packages/samsara, no travel vocabulary, no travel dependencies.` With `export const
    hotelName` planted in `@samsara/core`: exit 1, naming file, line, the matched word, and the
    three remedies. **Zero allows of five.**

  - **Live spend: 0.1048 minutes across two sessions** (`6596664d` 0.0549, the run that failed
    on the assertion; `e9330835` 0.0499, green). Cumulative across the project: **0.204 of
    4,000 minutes**, 0.005%.

  - **One placeholder closed, one deliberately not.** `GITHUB_REPOSITORY` is now
    `AswinBehera/solari-TravelOS`. The Hyperdrive id is issued by `wrangler hyperdrive create`
    and cannot be invented, so it stays — now with a comment saying it is the one line that must
    change on deploy day, and that nothing local needs it.

  - **Not fixed, recorded: the Postgres tests share a database with `pnpm dev`.**
    `jobs.pg.test.ts` truncates `jobs` before each test, against the same
    `localhost:5432/doen_thang` the dev runner drains. Running `pnpm test` while `pnpm dev` is up
    truncates the dev queue out from under a live worker. Harmless today (the only job type is
    `noop`) and the fix is a separate test database, which is more moving parts than P0.8 should
    add. **Architect's call before P1.2, when harvest jobs start carrying state worth keeping.**

Decisions taken by the executor, for the architect to overrule if wrong:
- Packages are **source-only**: `exports` points at `./src/index.ts`, there is no build step, and
  consumers compile through Vite/tsx. Removes a whole class of stale-dist bug. Revisit if a package
  is ever published.
- `moduleResolution: "Bundler"` with `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, and
  `noUncheckedIndexedAccess` on. The strict flags are cheap now and expensive to add later.
- **`ScoreSet` and `Explanation` live in `@samsara/core`, not `@samsara/refine`.** Section 2.5 puts
  them with the `DomainPack` contract, but `@dt/core`'s `Place.scores` needs them, and making a
  schema package depend on a pipeline package is the wrong shape. `@samsara/refine` will re-export
  them as part of the contract. Flagging because it is a small, deliberate deviation from the plan.
- Nullable over optional throughout, to match what Drizzle returns from Postgres and to keep
  `exactOptionalPropertyTypes` from turning every row read into a conditional.
- **Postgres enums are derived from the Zod enums**, not retyped: `pgEnum("persona_tier",
  personaTier.options)`. A schema and its database type cannot drift if only one of them is
  written down. Costs one `as unknown as` cast at each site, which is worth it.
- **Nested objects are flattened into columns**, not stored as JSON: `stats` becomes
  `stat_sessions`/`stat_minutes`/`stat_blocks`, `engagement` becomes three nullable integers, `geo`
  becomes `lat`/`lng`. These are queried and aggregated; JSON columns would make the budget
  dashboard and the map slower for no gain. Genuinely opaque payloads stay `jsonb`.
- **`@dt/db/src/schema.ts` star-re-exports the engine tables.** Not stylistic: drizzle-kit reads a
  schema file's top-level exports, so exporting only the composed object generated an empty
  migration. Worth knowing before someone "tidies" it.
- **No RLS policies in the migration**, per ADR-0013.
- **No logging library.** pino is the default choice and would have brought a free-form `.info(obj)`
  with it. The logger is ~60 lines of typed events instead, and the public Actions log is the reason.
- **`budget_counters` is a tenth engine table**, not in section 3.1 as written. Section 3.1 has been
  amended. A guard whose counts live in memory forgets them between Worker invocations.
- **The ports pattern**: the kernel depends on `BrowserLauncher`/`SandboxLauncher` interfaces, and
  the SDK is behind `@samsara/kernel/solari`. Every test but the live one runs without a key.
- **Ceilings carry their derivation rate in a comment, never in code** (section 8's rule). Four
  counters for three meters: LLM input and output are priced differently, so they are counted apart.

- **The queue port lives in `@samsara/kernel`** rather than a tenth package, because section 2.1 fixes
  the nine and both apps need it from opposite ends. ADR-0019.
- **The kernel is subdivided by runtime, not by layer**: `./node` holds the only `process`-touching
  file, `./jobs` is runtime-free, and `apps/api` imports those subpaths and never the barrel. Found
  the hard way — source-only packages mean the Workers typechecker compiles the kernel's Node source.
  ADR-0019.
- **`apps/api` typechecks twice** (`tsconfig.json` with `@cloudflare/workers-types` over the source,
  `tsconfig.test.json` with Node's types over the tests), because the source runs on Workers and the
  tests must run on Node to measure CPU at all.
- **`workerd`'s postinstall is allowed to run** (`allowBuilds` in `pnpm-workspace.yaml`). It is
  Cloudflare's own runtime binary and wrangler cannot start without it. Flagging it because allowing a
  postinstall script is a supply-chain decision, not a config tweak.
- **There is no `claimed` state.** A state nobody can act on differently is not a state, it is a
  comment. `running` plus `lease_until` carries the same information and is self-healing.
- **`jobs.type` is free text, not an enum.** An enum here would mean the engine's queue knows the
  product's job names, which is the seam.

- **The API listens on 8788, not wrangler's default 8787**, which is commonly occupied by other local
  tooling. Vite's proxy targets `127.0.0.1` rather than `localhost`, because on macOS `localhost`
  resolves to `::1` first, Vite listens on `::1`, and wrangler listens on IPv4 — naming the family
  turns an intermittent proxy failure into a non-event.
- **`apps/api`'s entrypoint exports only its default handler.** A workerd startup rule, not a style
  choice. See the session note above.
- **`apps/web` has no router yet.** ADR-0002 names TanStack Router and it will land with the second
  route (P1.7, the Persona Lab). A router over one route is a dependency with no decision behind it.
- **Hyperdrive's `localConnectionString` is committed in `wrangler.toml`**, pointing at the
  docker-compose database. Those are throwaway credentials, and a dev setup that needs a secret
  before it will start is a dev setup people work around.

- 2026-09-12 (Claude Code) — session 4c

  - **P0.7 done. `tools/check-seam.ts` + `pnpm check:seam` + `.github/workflows/ci.yml`.** 20 tests
    for the tool itself; the real tree passes; a planted `export const hotelName` fails it end to
    end. `turbo run check:seam test:tools` are root tasks with declared `inputs`, so the check
    re-runs only when the engine or the checker changes. `pnpm check` now runs lint, typecheck
    (which gained `tsc -p tools/tsconfig.json`), seam, tool tests, then the workspace tests.

  - **The check found 44 breaches on its first run, against an allowance ceiling of five.** That is
    the finding, not a detail: ADR-0009's ceiling was set before anyone tried to enforce it. Fixing
    it by writing forty `seam:allow` comments would have been switching the check off with extra
    steps. So the rule changed as well as the code — see the P0.7 amendment appended to ADR-0009.

  - **Executor decision: the lexicon is split by ambiguity, not by comment-versus-code.**
    `bangkok`, `tokyo`, `postcard`, `itinerary`, `tourist`, `hotel`, `restaurant` are scanned
    everywhere including comments; `travel`, `trip`, `place`, `flight`, `booking` are scanned in
    code and string literals only. Blanking comments wholesale was the obvious design and it is
    wrong: the worst breach found was `countries.ts` quoting *"plan section 1.4 names Bangkok as the
    first city"* in a comment. String literals stay in scope for both tiers because a prompt is
    code.

  - **Executor decision: a third check the plan did not specify.** The lexicon cannot see
    `import { db } from "@dt/db"` (no forbidden word), and the `package.json` check cannot either
    (source-only packages resolve workspace imports that were never declared). `check-seam.ts`
    scans engine source for `@dt/*` import statements directly. Without it the engine could import
    the whole product with a clean report.

  - **Executor decision: matching is by identifier segment, not word boundary.** `\btravel\b`
    misses `travelPack` and `Asia/Bangkok`; substring matching flags `replace`. Identifiers split
    on case changes and separators, one plural fold, deliberately not a stemmer.

  - **Executor decision: an unused `seam:allow` is an error, and a reason is mandatory.** Otherwise
    allows survive the rename that made them unnecessary and the count against the ceiling stops
    describing anything.

  - **Engine fixtures moved off the product's first city.** `country: "sg"` / `locale: "th-TH"` /
    `timezoneId: "Asia/Bangkok"` became `vn` / `vi-VN` / `Asia/Ho_Chi_Minh` across
    `core/src/fixtures.ts`, `kernel/src/{kernel,registry,live}.test.ts`. Chosen because
    `countries.ts` maps `vn` to the same substitute egress (`sg`) as `th`, so the
    unsupported-country path, the substitution and the viewpoint/egress disagreement are all still
    under test. `idempotencyKey: "trip-42"` -> `"dupe-42"`; the IANA example in `kernel.ts`'s error
    message is no longer a product city; engine comments now name markets by ISO code. 80 kernel
    tests pass against a real Postgres 17 after the rewrite.

  - **The per-package `seam.test.ts` files stay.** They check things the central tool does not
    (exact dependency lists, the provider SDK reachable from exactly one file), and they fail in the
    package that broke the rule. Their `importsTravelScope` identifier was itself a lexicon breach
    and is now `importsProductScope`.

  - **Latent bug found while writing CI: `pnpm test` was silently skipping every Postgres test.**
    Turbo 2 runs tasks in strict env mode, so `DATABASE_URL` never reached vitest no matter what
    the shell exported, and `jobs.pg.test.ts` skipped itself and reported green — 67 passed, 13
    skipped, exit 0. The CI workflow written this session would have claimed to test the job
    store, which is the one component with real concurrency in it, while testing none of it.
    Fixed by declaring `"env": ["DATABASE_URL", "SOLARI_LIVE"]` on the `test` task in
    `turbo.json`. `pnpm test` now runs 80 kernel tests, not 67.

  - **First CI workflow.** `ci.yml`: Postgres 17 service, `pnpm db:migrate`, then lint / typecheck /
    seam / tool tests / tests as **separate named steps**, because the step name is what the PR page
    shows — "seam" failing tells a reader the engine learned a travel word.

  - **Supabase credentials were not needed for P0.7.** They are needed for two things only: running
    an authenticated request against the real JWT path locally (`SUPABASE_URL`), and deploy.

Open for architect before P0.8:
- **Closed 11 September 2026 — ADR-0017. Google is out of the stack.** The quota-cap obligation is
  closed by deletion rather than by doing it: no Google API key is created, so there is nothing to
  cap, and **no vendor in the system can now bill Aswin's card without someone deciding to spend.**
  Resolution is tiered instead — coordinates already in the harvested artifact, then an OSM
  named-POI extract in our own Postgres, then a free-tier hosted geocoder (LocationIQ or Geoapify),
  then `unresolvable`. Not the public Nominatim server: its usage policy caps recurring scripts at
  4 req/min and names systematic querying as grounds for a ban, so the interim plan section 8 was
  carrying was never a safe harbour. Geocoding's ~$5 allocation returns to the reserve, which grows
  to ~$9 and stays reserve. ADR-0018 finishes the job on the map side: the basemap is a Protomaps
  `.pmtiles` extract we host, so there is no tile vendor either.
- **Worth asking Solari: is `th` residential egress on the roadmap?** ADR-0015 works without it, but
  the answer turns a design question back into a scheduling one.
- Section 10 questions 4, 5, 6, 7, 8 are unanswered. None of them block P0.5.
- **P0.5 is unblocked.** Questions 1 and 3 are both answered.
- **Answered: the repository is public.** So Actions minutes are unmetered, section 8 stays at
  three meters, and the Actions log is public — which is why the kernel's logger has no free-form
  field. Question 1 is fully closed.
- **Solari is not under maintenance.** The live call reached them and came back with a structured
  400, which is a healthy provider disagreeing with us.
- **Closed 11 September 2026 — ADR-0016.** The demo topology proposal (GitHub Actions cron + inline
  SSE, deleting BullMQ/Redis/the always-on box) was reviewed cold by Gemini 3.1 Pro via `agy` and
  two holes survived verification: a once-per-second poll behind SSE spends 86,400 of the free
  plan's 100,000 daily Hyperdrive queries **per open tab, account-wide**, and the 5-minute cron
  floor leaves a user-triggered harvest looking dead. Progress is now pushed on state change with a
  bounded backing-off stream; foreground jobs are dispatched via `workflow_dispatch`. Consequence
  for P0.5: the API gains an `actions:write` GitHub token as a Worker secret, and acceptance gains
  a case asserting a bounded query count for a stream held open across a real harvest.

---

## The P1.0 live run — done

Ran 12 September 2026. 18 cells, 20 sessions, **4.790 browser-minutes of 4,000**, zero refusals.
Results in `packages/travel/lab/results/2026-09-12T101036-youtube.search.json`; the table is at the
top of this file and the reading is in
`casestudy_and_thinking/sessions/2026-09-12-p10b-the-result.md`.

```
pnpm --filter @dt/lab signal-matrix:plan            # prints all 18 cells, opens nothing
pnpm --filter @dt/lab signal-matrix:run             # spends browser-minutes
pnpm --filter @dt/lab signal-matrix:report          # the table, from the latest results file
pnpm --filter @dt/lab exec tsx src/signal-matrix/report.ts --k=10   # re-read at another depth
```

Re-reading costs nothing, which was the point of keeping the arithmetic in a package with no
network in it.

| | |
|---|---|
| Sessions | 20 (16 design cells + 2 replicates, 2 of them retried) |
| Estimated beforehand | ~9.0 browser-minutes |
| **Actually spent** | **4.790 minutes of 4,000** — 0.12% of the ceiling |
| Clean cell / failed attempt | 0.16 min / **0.77 min** — a failure costs 5x, the deadline must expire |
| Cumulative to date | 4.895 minutes |
| Surface | YouTube search, logged out, top 20 |
| Run order | shuffled, seed `20260912`, recorded in the results file |
| Counters | the real Postgres ones; the run refuses to start without `DATABASE_URL` |
| Output | a JSON results file in `packages/travel/lab/results/`, read by a network-free reporter |

Three things to carry with the number:

1. **The two replicates earned their minute.** The noise floor came back at 21% — repeating one
   cell changes a fifth of its own list. Three of the four factors land within ten points of that,
   so without the control the table would have read as four findings instead of one.
2. **The answer is YouTube's answer.** One surface, one query, one day. The `Surface` interface
   exists so a second surface costs a file rather than a rewrite.
3. **Nothing was refused** — no consent wall, no captcha, from either egress. Two cells failed
   `internal` and recovered on retry. The refusal path is written and untested against a real
   refusal, which is worth remembering when P1.4 points this at TikTok.

## The Phase 0 gate

Per PLAN §5: *"Aswin reviews the kernel interface, the `DomainPack` contract, and ADRs 0009 to
0014. Nothing else."* All three acceptance criteria are met and measured above. What follows is
what the gate needs to look at, and the three places where the executor deviated or stopped
short on purpose.

**1. The kernel interface** — `packages/samsara/kernel/src/{ports,kernel,result}.ts`.
`withBrowser(purpose, viewpoint, fn)` refuses on the budget guard before anything opens, races a
hard deadline, force-closes on overrun, closes in a `finally`, and meters the minutes actually
taken whether or not the operation succeeded. Failures are classified
`budget | blocked | timeout | upstream | config | internal`; only `upstream` and `internal`
retry. `ports.ts` defines `BrowserLauncher`/`SandboxLauncher` and `solari.ts` is the only file
in the repository that imports the provider SDK. **The question for the gate:** the viewpoint is
`{ country, locale, timezoneId }` today. P1.1 adds stored preferences and a warmed profile.
Is `Viewpoint` the right name and the right shape to grow, or should it be a persona reference
from the start?

**2. The `DomainPack` contract** — `packages/samsara/refine/src/pack.ts`. **Only the identity
half exists** (`id`, `version`) plus `PackRegistry`, and this is the deviation most worth
overruling if it is wrong. PLAN §2.5 specifies `extract`, `entity`, `resolve`, `dedupKeys`,
`score`, `sources`, `queries`; writing those now would mean inventing `RawItem` batching,
`EntityRepo` and `ScoreSet` plumbing against no caller, and the first real pack would be shaped
by guesses rather than correcting them. What P0.5 needed was narrower and is real: a typed
registry the worker holds at boot with **zero packs in it** — the assertion that the runner has
no vertical compiled into it. `DomainPack` is already the exported name, so widening it at P2.2
is one file rather than every consumer. **The question:** accept the deferral, or is there a
member whose shape must be fixed now because something in P1 will otherwise be built against
the wrong assumption?

**4. ADR-0015's signal ordering, now that it has been measured** — new, and the only gate item
with data behind it. The ADR orders the stack: account region, query language, stored preferences,
browser locale and clock, engagement history, egress IP last. P1.0 measured the middle four of
those on a logged-out surface and found **a cliff, not a list**: query language at 100%, then
egress 31%, locale 23%, stored region 20%, against a noise floor of 21%. Three of the four are
within ten points of noise, and egress — which the ADR puts last — sits at the *top* of that weak
cluster rather than the bottom. **The question:** amend ADR-0015 to say the stack is one dominant
signal plus a flat remainder (which makes the missing Thai egress a non-issue and reshapes
P1.3–P1.6 around query construction), or treat one surface on one day as too thin to amend a
decision on and re-run against a second surface first? A second surface costs a file and about
five minutes.

**5. ADRs 0009 to 0014**, plus the four written since:
- **0009 seam** — with the P0.7 amendment: the allowance ceiling was set before anyone tried to
  enforce it; 44 breaches, all fixed by rewriting, zero allows used.
- **0010 domain pack** — see the deferral above.
- **0011 OS is product language**, **0012 OpenRouter**, **0013 Supabase Auth** (no RLS in v1),
  **0014 Cloudflare + GitHub Actions** (the one that deleted BullMQ, Redis and the always-on box).
- Since: **0015 viewpoint over egress**, **0016 progress streaming and job dispatch**,
  **0017 place resolution without Google**, **0018 Protomaps basemap**, **0019 kernel owns the
  queue and splits by runtime**.

**Open questions**, unchanged from last session. None of them blocked P1.0 and none block P1.1:
- Section 10 questions 4, 5, 6, 7, 8 are unanswered.
- Whether to ask Solari about `th` residential egress on their roadmap. ADR-0015 works without
  it; the answer turns a design question back into a scheduling one.
- The shared test/dev database, noted above.

**Nothing is deployed, and nothing can be until two things exist:** a Cloudflare account (for the
Hyperdrive id) and Supabase credentials (`SUPABASE_URL` for the real JWT path). Neither blocks
any local work.

**The worker's cron is commented out, and is part of that deploy.** `.github/workflows/worker.yml`
scheduled a drain every five minutes from the day it landed, and every one of those runs failed on
the runner's refusal to start without `DATABASE_URL` — a secret that does not exist because there is
no deployed database. Twenty-one consecutive red runs is not a signal, it is wallpaper, so the
`schedule:` trigger is commented out and `workflow_dispatch` is left alone. **Restoring those two
lines belongs in the same commit that sets the `DATABASE_URL` secret**; until then a dispatch still
fails loudly, which is the correct answer to a human who pressed the button.

> **Corrected 2026-09-17.** Two of those sentences were false and stayed false for four days.
> Commenting the trigger out was `4e95b89`, and `4e95b89` was never pushed — Actions reads the
> workflow from the default branch *on the remote*, so a local commit that stops a cron stops
> nothing. The remote kept the `*/5` and kept failing: **22 scheduled runs, 22 failures, from
> 2026-09-13 09:43 to 2026-09-16 16:59.** It was not thousands only because GitHub drops scheduled
> runs on a repository with no recent activity, which is the part worth keeping: a broken cron on an
> idle repo neither works nor announces itself, and this document recorded it as switched off while
> it was quietly red. Fixed in `e4c34a0`, which shipped the stop and the restart together, at
> `*/15`, with both secrets set.
