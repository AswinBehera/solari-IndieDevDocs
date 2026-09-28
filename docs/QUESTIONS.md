# QUESTIONS

Executor writes a question here and stops. Architect answers inline under it, then the executor
resumes. Keep answered questions; they are the cheapest archaeology we have.

Format:

```
## Q<n> — <one-line question>  [OPEN | ANSWERED]
**Asked by:** <executor> on <date>, while doing <task id>
**Why it blocks:** <what you cannot do until this is answered>
**Options you see:** <a, b, c — with your lean>

**Answer (architect, <date>):**
```

---

## Q1 — (none yet)

No questions raised. The plan's section 10 lists eight decisions the architect owes before
Phase 0 closes; those live there, not here. This file is for gaps the executor finds while
building.

## Q9 — a contributor's own contact details, in a fixture, in a public repo

Raised 2026-09-14 (Claude Code), during the P1.6.1 audit.

`packages/samsara/sources/src/tiktok/__fixtures__/tiktok-search-vi-VN-2026-09-13.capture.json`
carries two creators' email addresses and one phone number. All three are inside
`signature` — the profile bio — where their authors put them, on public profiles,
for the purpose of being contacted.

This is not the avatar case. An avatar is a photograph and is evidence of nothing;
excluding it costs nothing. `signature` is **content**, it is **read** by the
parser, and the P1.5 commit says in as many words that over-redacting it once
already "destroyed an author's bio". So the rule that fixed the avatars does not
transfer, and `redact.ts`'s own licence — "admissible because nothing reads the two
fields it guards" — explicitly does not cover this one.

Options, none obviously right:

1. **Leave them.** The field is the item; a bio is what its author chose to
   publish; redacting it makes the fixture a worse record of the surface.
2. **Redact contact shapes in `signature` only.** An email and a phone number have
   recognisable shapes. Cost: a denylist on a field that is read, which is the
   trade-off this repo has twice called the wrong one, and a false positive here is
   silent data loss inside the evidence.
3. **Stop storing `signature`.** Cleanest privately, worst as evidence: bio text is
   one of the few strong locality signals a TikTok item carries, and P1.8's overlap
   measurement may want it.

What tips it either way is a question I cannot answer from the code: is the fixture
corpus a **research record** (argues for 1) or an **artifact the demo ships**
(argues for 2 or 3)? And does "public repository" here mean public today, or public
at alpha?

Nothing is blocked. It wants deciding while there are six fixtures rather than
sixty, because the answer is retroactive either way.

### Answered 2026-09-16 — option 3, and the question contained two errors of fact

The architect's ruling: *"Do we really want to use real people? We should be
creating artificial personas based on data, but not the real people. We may not
have permission for that."*

Both premises this question was built on turned out to be wrong, and checking them
is what made the decision easy rather than close.

**"`signature` is read by the parser" was false.** `tiktok/parse.ts` reads
`author.uniqueId` — with `author.unique_id` as a fallback — and nothing else off an
author object. No other file in the repository mentions the field. Across two
captures the bio was collected by us, published by us, and read by nobody. The
sentence in the P1.5 commit was about an intention for the field, and it was
repeated in this question as though it described the code.

**"An email and a phone number have recognisable shapes" was half false.** Shape
redaction was written first and tried on the corpus before this was decided. It
caught two of the four contact details. It missed
`𝐲𝐭𝐚𝐝𝐨𝐚𝐧.𝐛𝐨𝐨𝐤𝐢𝐧𝐠@𝐠𝐦𝐚𝐢𝐥.𝐜𝐨𝐦` — a real address in Mathematical Bold, which `[A-Za-z]`
does not match — and `0844.ll.OO.ll`, a mobile number with the letter `l` for one
and the letter `O` for zero. Both are perfectly legible to the person the author
wanted to be reached by. A bio is prose its author controls, so a pattern that has
to recognise every way a person might write their own phone number is a pattern
that will be wrong quietly and forever. The fold for Unicode compatibility forms
was written anyway and kept, because it is principled and prose fields elsewhere
need it; the homoglyph case is recorded as a stated limit with a test asserting the
miss.

**The asymmetry settles what the premises left open.** An uncollected bio costs one
browser session to collect again — roughly half a minute against a 4,000-minute
ceiling. A stranger's address in a public git history cannot be taken back at any
price. So the field goes, and P1.8 may ask for it back on the record if it turns
out to want a bio as a locality signal.

Done: `signature` is on `REDACTED_KEYS`; the fixture is re-scrubbed and holds no
bio; the two `capture.test.ts` tests that asserted the opposite are inverted with
the reasoning attached rather than deleted; `fixture.test.ts` gained a folded
contact-shape audit; the contact rules landed in `redact.ts` where the prose fields
of Maps and Pantip now use them.

**Not settled, and not this question:** TikTok and YouTube apply no shape rules at
all — they redact by key name only, so neither runs `BASE_REDACTIONS`, and the rule
that caught our own egress address inside Pantip's page would not fire on theirs.
Measured at fourteen hits on the current TikTok fixture, five of which are a
version string the address rule mistakes for an address. That false-positive rate
is why it is a question rather than a commit. Raised as Q10.

## Q10 — two adapters do not run the shared shape rules

Raised 2026-09-16 (Claude Code), out of the Q9 work.

`redact.ts` says the base rules "belong in one file that every adapter imports",
because the egress address Pantip handed back was ours and any site can do that.
Two adapters do not import it. TikTok and YouTube narrow by key name only.

Applying `BASE_REDACTIONS` to the TikTok fixture today fires fourteen times: nine
opaque base64 runs, five addresses. The five are not addresses. They are
`cookieBanner.resource.version` and four bundle paths, where four dotted numbers
mean a version. Rule 2 cannot tell those apart and does not need to — the fix is a
field split like the one Maps and Pantip now have, not a weaker pattern — but that
is a change to two adapters and six fixtures, and it is not what this session was
for.

Nothing is leaking through the gap today; this is about the next capture, not the
recorded ones.

## Q11 — which fields count as something somebody wrote

Raised 2026-09-16 (Claude Code), out of the first `pantip.topic` capture.

The contact rules run on the fields listed as prose. On Pantip that was `excerpt` and
`text`, and the first topic capture showed the list was short by one: a sidebar topic
titled "มีเบอร์ 027009089 โทรเข้ามาค่ะ" — *a number 027009089 called me* — kept the
number in `title` and lost it in `excerpt`, which is the same sentence twice with two
different answers. `title` and `pageTitle` are now prose; that part is settled and
committed.

**`authorName` is not, and is deliberately left out.** A display name is written by a
person and spam accounts do put numbers in them. But it is also where Pantip writes
`สมาชิกหมายเลข 4268252`, the name it gives a member who has none, and where this
capture found `13800 ล้านปี` — *13.8 billion years*. Today's rule does not match
either (seven digits, no separator; a space before a four-digit run is not how a
person writes a phone number), so the question is not whether it would fire now but
whether a name field should be under a rule at all, given that the cost of a wrong
redaction there is the identity of the row rather than a word in the middle of one.
Unmeasured: no capture so far contains a display name with a contact detail in it.

**The related false positive, recorded rather than fixed.** The opening post's star
widget renders `<a title="0.5">0.5</a>` ten times, and `textContent` concatenates
them into `0.51.1.52.2.5…`, which rule 2 reads as two IPv4 addresses. Nothing legible
is lost — the run was already a widget flattened into one string — and
`fixture.test.ts` pins it with that reasoning, so the day the rating is worth parsing
the parser is told where it went. Same family as Q10: a dotted number means a version
on TikTok, a rating here, and an address only in a field that could hold one.

## Q12 — a week nothing can wake up for, and what a compressed day would prove  [ANSWERED]

Raised 2026-09-16 (Claude Code), out of P1.8.

Phase 1's acceptance criterion is a seven-day measurement, and there is nothing in
this system that stays awake for seven days. The worker is a GitHub Actions workflow
whose schedule has been commented out since P1.7 [**not true — see the correction in
the answer below**], because it needs `DATABASE_URL`, because there is no hosted
Postgres, because ADR-0013's Supabase project does not exist yet. An experiment therefore queues fourteen jobs that come due and stay due.

The instrument is finished and honest about this — six `missing` points and no line —
so the question is not what to build, it is which of three things to spend:

1. **Restore the cron in the same commit that sets the secret.** Needs the hosted
   database, which is blocked on a decision nobody has made. This is the only option
   that measures drift as the plan defines it: seven real days, seven real diurnal
   cycles of a ranked surface.
2. **Run it locally at a short interval** — `intervalMinutes` exists exactly so the
   mechanism can be demonstrated in ten minutes — and say plainly that a day was ten
   minutes. This proves the machinery and produces a number that looks like the
   acceptance number and is not it. A surface's results at 14:00 and 14:10 are far
   more alike than at 14:00 on Monday and Tuesday, so a compressed run is
   **biased toward high overlap**: it would fail the 40% acceptance and could trip
   the 60% gate for a reason that has nothing to do with the adapters. That failure
   mode is the dangerous one, because the gate's instruction is "stop and redesign
   adapters", and redesigning adapters in response to a clock is pure waste.
3. **Leave a local runner draining for a week.** Free, uses the daily interval, and
   depends on a laptop staying awake — which will produce late days, which the plot
   is designed to show rather than hide. Not obviously worse than (1) for a
   measurement whose whole subject is that schedules slip.

My inclination is (3) for the acceptance number and (2) only ever as a demo that is
labelled as one, never as the figure the gate reads. What I want from an architect is
whether the Phase 1 gate may be answered by (3) at all, or whether "seven days" in the
plan means seven days on the infrastructure Phase 2 will run on.

**Also unmeasured, and part of the same question:** the acceptance sentence says
"recorded sessions show no captcha loops", and recordings are off by default (section
8: on for the first 20 runs of a new adapter). A drift experiment does not currently
turn them on for its own runs. Fourteen recorded sessions is the cheapest evidence
this project will ever have for the captcha half of the criterion, and the flag is
already a payload field.

**Answered 2026-09-16 by Aswin (architect): (1).** The hosted database was the thing
blocking it and it is no longer blocking: a Supabase project in `ap-southeast-1`, nine
migrations applied, eighteen tables, reached through the **session pooler** rather than
the direct host, because the direct host resolves to AAAA only and GitHub's runners are
IPv4-only — a string that would have been green on a laptop and red in Actions. The
cron is restored at `*/15` rather than `*/5`, for the arithmetic in `worker.yml`: the
jobs this schedule carries come due once a day.

Option (2) was not used for anything, not even as a labelled demo, so there is no
compressed number anywhere near the gate to be mistaken for the real one.

**The recording half is settled too.** `POST /lab/drift` now takes `recording`, off by
default and on for this run, so all fourteen payloads carry it — a create-time body
field rather than a column on `drift_experiments`, because what a recording *is* already
lives on `sessions.recording_ref`, one row per session, and a flag on the experiment
would be a second place for the same fact to be wrong. Day 0's two sessions both came
back with a `recording_ref`.

**Both secrets were set on 2026-09-16 and the schedule is green** — three scheduled
drains succeeded overnight, after 22 consecutive failures. Day 0 was drained by hand;
days 1 to 6 are the queue's own problem now, which is the point.

**And the premise above was wrong.** The schedule was never commented out where it
mattered. `4e95b89` commented it out locally and was never pushed, so the remote kept
the `*/5` from `3ee2a66` and failed every tick it was not dropped for — 22 runs between
2026-09-13 and 2026-09-16, all red, while three documents said the trigger was off. The
lesson is not about YAML: **a fact about deployed behaviour cannot be established by
reading the working tree**, and every one of those documents was written by reading the
working tree. `git show origin/main:<path>` is the cheap version of asking the question
properly.

**One live caveat.** GitHub is dropping most ticks — three scheduled runs in the nine
hours after the fix, not the thirty-six a `*/15` cron implies, because dropping is what
it does on a repository with little recent activity. Day 1 can therefore start hours
after it comes due. That is survivable by construction: the chart's x-axis is the time
the run actually happened, not the time it was scheduled for, so a late day is drawn
late rather than drawn wrong. It does mean the seven days will not be seven neat
24-hour spacings, and the `meanRankShift` column is the place that would show it.

## Q13 — a persona with no identity, and the number we are about to read off it  [OPEN]

Raised 2026-09-17 (Claude Code), out of reading 54 upstream commits in
`solari-sdk/solari-cookbook` against our own kernel.

There are two ways to create a persona in this repo and they do not produce the same
thing. `createPersona()` in `@samsara/personas` allocates a sticky proxy key and warms
a profile. `POST /lab/personas` builds the row itself and writes `solariProfileId:
null, proxySession: null`, never calling it. The Lab route is the one a human uses, so
it is the one that made the two personas in the drift experiment now running.

**What that means for the week in flight.** Experiment `f60fb262` compares two
cookie-less, profile-less browsers on rotating residential IPs, differing in exactly
three things: proxy country, locale and timezone. The country signal is real —
`proxy: { country }` does pin egress to `sg` and `us`. But there is no accumulated
identity on either side, and an anonymous browser is the case a ranked surface
personalises *least*. Day 0's 60.0% is therefore the no-identity baseline, not a
measurement of the persona system, and the 60% gate says "stop and redesign adapters"
— which would be the wrong fix for a number produced this way. The week is worth
finishing (about 1.5 minutes) precisely because a baseline is worth having; what it
must not do is answer the gate on its own.

**The question for the architect** is not whether to fix the two paths — one of them
produces a half-persona and that is a defect either way — but whether Phase 1's
acceptance number is allowed to come from viewpoint-only personas, or whether it has
to come from a second week run with warmed profiles and sticky egress. They measure
different claims. The first is "does a Singaporean Thai-locale browser see different
results from a New York English-locale one". The second is "does this system's notion
of an identity hold up over a week", which is the thing Phase 3 is built on.

### Three SDK facts the cookbook established, and what we do with them

1. **Sticky egress lapses on a clock, not on completion.** `proxy: { session,
   sessionDuration }` takes 1 to 30 minutes, default 10. `create.ts` said the key
   exists "so one identity keeps one egress address across sessions"; across sessions
   a day apart that is false, and the docstring is now corrected. Nothing in the SDK
   offers day-to-day IP stability. If a persona's continuity has to survive a week,
   it survives in the *profile*, not the address — which makes the null
   `solariProfileId` above the more serious half of this entry.

2. **A self-built context does not inherit the pool's timezone pin.**
   `browser.proxy?.timezoneId` carries the timezone the egress IP implies. We override
   it with the persona's own timezone on purpose (ADR-0015: a viewpoint is declared,
   not derived), so this is not a bug to fix — but we can now *read* both and notice
   when they disagree. A persona whose `Intl` timezone contradicts its egress IP is a
   self-inconsistent fingerprint, and right now nothing would tell us. Cheap: one
   comparison at launch, logged once.

3. **A profile only restores if its state reaches the context you build.**
   `launch({ profileId })` delivers to `session.storageState` and stops; upstream shipped
   three runs printing "visit #1" while saving v2, v3 and v4. `solari.ts` already does
   this correctly — but only when a viewpoint is present, because the context is built
   `vp ? … : undefined` and otherwise `newPage()` falls back to the anonymous pool
   context. Every call site passes a viewpoint today, so it is unreachable; it is one
   call site away from being a silent profile loss, and the failure mode is a session
   that opens, loads and looks fine.

Upstream is fetched as a read-only `upstream` remote and deliberately not merged: it is
a cookbook of standalone examples, not a tree we share. The rest of what landed there
(Ruby and Python quickstarts, EU consent evidence, a Playwright-suite runner, raw CDP on
Workers, a security posture review) is not ours to use. `browser-login-handoff-ts`
becomes relevant the day we build a logged-in persona tier.

## Q14 — a topic capture returns other threads' sidebars as items  [OPEN]

Raised 2026-09-17 (Claude Code), out of the P2.2 golden corpus harvest.

`parsePantip` on a `pantip.topic` capture returns the posts in the thread *and* the
"related topics" teasers Pantip renders beside them. It is not wrong to: they are
items, with their own urls and their own titles, and nothing in `ItemDraft` says an
item has to belong to the page it was found on. But their text is tag-list
boilerplate rather than prose, and they belong to threads nobody asked for.

Measured, not estimated: filtering the corpus on whether the item's own url contains
the topic id being harvested dropped it from 60 items to 36. Over a third of what
twelve topic captures returned was other people's sidebars. Two of the survivors of
an earlier pass — `pt-43696090-3` and `-4` as they then were — were teasers from
topics 44221084 and 39734763, which had nothing to do with the thread.

The filter lives in `tools/harvest-golden.ts`, which is the wrong place for it. A
harvest tool putting it there keeps the golden set clean and leaves the production
path ingesting sidebars into `RawItem` for P2.3 to geocode.

**Options I see:**

a. `parsePantip` drops nodes whose canonical topic url is not the captured topic.
   Cheapest, and it makes the parser's output mean "this thread", which is what
   every caller so far has assumed. Costs the one case where a related topic is
   genuinely the answer — but that case is a query, not a parse.
b. Keep returning them and add a field to `ItemDraft` saying which container the
   item came from, so the caller can decide. Honest, and it widens a type in the
   kernel for one source's layout quirk.
c. Leave it, and require every caller to filter. This is today's behaviour and it
   is only survivable because today there is one caller.

My lean is (a), and it wants the architect's word because it changes what a parser
returns and there are fixtures asserting the current counts.

## Q15 — a mention cannot say the place is closed  [OPEN]

Raised 2026-09-18 (Claude Code), out of the human audit of the P2.2 golden set.

`pt-44226724-5` is a comment about `ร้านโรจน์` in Bangsaen: the writer lived there,
ate there repeatedly, names a dish, and rates it the best of anywhere. Then
`ร้านหายไปแล้ว` — it is gone, and they are asking whether it closed or moved.

Everything `mentionSchema` wants is in that item except one thing it has no field
for. `sentiment` is about the food, `creatorReads` is about the writer, and neither
can carry "this place is not there any more". The audit ruled the mention out for
that reason, and the asymmetry is deliberate: the same audit *struck* the rule
disqualifying a place the writer had not visited, because there `sentiment` and
`creatorReads` still carried the fact. Here nothing does, so counting it would emit
`ร้านโรจน์` indistinguishable from a shop you can walk into tonight, and P2.3 would
either fail to geocode it or resolve it to a stale entry with nobody in it.

That is the right call for the golden set and a silent one for production. The
extractor now drops closed places on the floor, so the pack cannot tell a user "this
was recommended but has since shut", which is a thing a traveller wants to know, and
it cannot feed P2.3 the fact that a geocode failure was *expected*.

It is one item in fifty, which is why it did not force a schema change today.

**Options I see:**

a. Leave it. The prompt's rule is stated, the behaviour is documented here, and the
   case is rare enough that paying an output field on every mention to carry it is a
   bad trade against §8's token budget.
b. Add a nullable `stillOpen: boolean | null` to `mentionSchema`. Fixes the cause,
   and costs a field on every mention in every call for a case that is 2% of items.
c. Widen `sentiment` or add a value to `creatorReads`. Cheapest in tokens and the
   worst of the three: it overloads a field whose meaning `scores.local` depends on.

My lean is (a) until P2.3 reports how often geocoding fails on places that turn out
to be closed — that measurement would tell us whether (b) pays for itself, and it is
free to collect.

## Q16 — an LLM call has no deadline, so slow and hung are the same state  [OPEN]

Raised 2026-09-18 (Claude Code), out of the first run of `tools/bake-off.ts`.

`CompleteOptions.signal` is optional (`complete.ts:105`), nothing supplies a default,
and `extract()` has no `signal` in it at all — the word does not appear in the file.
So a batch call goes out with no deadline on it. The first bake-off run sat on one
open socket to `qwen3-235b-a22b-2507` for seven and a half minutes and was killed,
and the point is not the seven minutes: it is that **there was no way to tell a slow
route from a dead one**, then or ever. A request that cannot time out has no failure
mode short of the process being killed by hand.

The bake-off now installs its own deadlines, because a measuring tool that can hang
measures nothing. That fixes the tool and not the cause.

In production the cause is worse than it is in a tool. ADR-0014 gives the worker
`WORKER_BUDGET_MS=240000` and a `WORKER_LEASE_MS=300000` lease, both sized so a
cancelled run has time to close browser sessions and hand its claims back. A provider
that accepts a connection and then stops answering spends the entire budget waiting,
returns nothing, closes nothing, and the lease expires rather than being released —
the one path those two numbers were chosen to prevent.

It is also invisible. `llm.call` is logged per attempt, so a call that never returns
never logs, and the run's own telemetry shows a gap rather than a failure.

**Options I see:**

a. Adopt `withDeadline` in `complete()`, overridable per call, and have `extract()`
   pass one derived from the remaining worker budget. Fixes the cause at the layer
   that owns the request — and it is a smaller change than it first looks, because
   **the kernel already has this**. `kernel/src/deadline.ts` exports `withDeadline`
   and a `DEFAULT_DEADLINE_MS` table, it is written against precisely this bug — "the
   provider's `timeoutMs` is a **rolling idle window**, not a deadline: it resets on
   every use" — and harvest already runs on it. `@samsara/llm` is simply not in the
   list of files that import it. There is even a number already: `complete()` passes
   `purpose: "agent"` to its retry logger, and `deadlineFor("agent")` is 4 minutes.
b. Default in `createOpenRouterClient` only. Cheapest change, one place. Wrong layer:
   it is the port that would own the policy, so the fake client and any second
   provider would each have to remember it, which is how the seam grows holes.
c. Leave it to the caller and document it. What we have now. It has already produced
   one silent hang in the only two real runs this repo has done.

My lean is (a), taking `deadlineFor("agent")`'s existing 4 minutes rather than
inventing a number, and having `extract()` shrink it as the worker budget runs down
so the last call in a run cannot outlive the run.

Two things need ruling at the same time:

- **A timeout classifies as `internal`.** `classify()` calls anything it cannot
  positively identify the provider's fault `internal`, and an `AbortError` carries no
  `status` and no code in `TRANSPORT_CODES`. `internal` is retried, so a dead route
  would be retried rather than abandoned. `upstream` is the honest class for "we gave
  up waiting on them", and it is retryable too — so the fix is the retry *budget*,
  not the label.
- **`withDeadline`'s own docstring says the timeout stops the waiting, not the work.**
  It takes an `onTimeout` for exactly that reason, and for a browser that is a
  force-close. The LLM equivalent is aborting the request so the socket closes; if it
  is left to garbage collection, a timed-out call keeps streaming tokens we are still
  billed for and the meter under-reads.

## Q17 — dedup does not merge "X" and "ร้านX" at the same coordinate  [OPEN]

Raised 2026-09-28 (Claude Code), out of the first end-to-end run of the refine chain
against local Postgres.

Three pending mentions from three items, two of them the same shop: one caption named
`ก๋วยเตี๋ยวเรือทองหล่อ`, the other `ร้านก๋วยเตี๋ยวเรือทองหล่อ` — the same name with
`ร้าน` ("shop") in front — and each carried a Google Maps link. Tier 0 pinned both,
5.5 metres apart. The resolve cache keys them separately (the keys are normalised
names, and `ร้าน` survives normalisation), so resolve wrote two places. Dedup then
examined both and merged neither: `0 merged of 3 (3 examined, 1 keyless)`.

The reason is `placeDedupKeys`' geo key. It compares *normalised* spellings for exact
equality within 150m, and the opener is part of the normalised string. Tier 0 already
knows these are the same name — `nameAgreement` in `tier0.ts` strips the same openers
and scores the pair 0.9 — but dedup does not use that rule.

For the Phase 2 gate this matters more than its size suggests. The gate is a human
reading the top thirty, and two cards for one shop, both near the top because the same
local evidence made them both, is exactly what a reader flags as "the pipeline is
wrong".

**Options I see:**

a. Add the opener-stripped form to both sides of the geo key — `spellings()` in
   `dedup.ts` and the row names in `PostgresPlaceRepo.byGeo`, through one exported
   function so the two cannot drift. Small, and it reuses a rule the resolver already
   applies. **The catch is in `OPENERS` itself:** it runs on text with spaces already
   removed, and it contains `the`, `cafe`, `restaurant` and `โรงแรม` ("hotel"). So
   "Thep Thai" normalises to `thepthai` and strips to `pthai`; a hotel and its
   restaurant with the same name 100m apart would merge. Taken as-is, (a) trades one
   visible duplicate for rare invisible welds, and a weld is the unrecoverable kind.
b. (a), restricted to the Thai openers (`ร้านอาหาร`, `ร้านกาแฟ`, `ร้าน`, `คาเฟ่`) and
   without `โรงแรม`. Catches the case this run produced, and every excluded opener
   is one whose false positive is worse than its miss.
c. Strip openers in the resolve cache key instead, so the two mentions share a key
   and never become two places. Cheaper per run, but it changes resolution for every
   key already cached, and P2.4's write-up is explicit that a change to how names
   normalise is a change to resolution with its own golden set.
d. Leave it and let the gate review count the duplicates first.

My lean is (b). It is not done in this session because which names are "the same
place" is the merge policy, and a merge moves evidence irreversibly.
