/**
 * The model comparison ADR-0012 asks for, run against the golden set.
 *
 * P2.1 built `compare()` and left `LLM_MODEL_EXTRACT` empty, because the ADR says
 * the model is chosen by measurement and the measurement needed labels that were
 * P2.2's. The labels now exist and have been audited, so this is the run that
 * closes that debt.
 *
 * **Why this calls `extract()` rather than `compare()`.** `compare()` is the right
 * instrument for the half it was built for — schema-validity, retries, cost per
 * attempt — and it grades through a per-case `grade(value)`. But the golden scorer
 * does not grade a case, it grades a *corpus*: precision and `inventedOnNegatives`
 * are ratios over all fifty items, and one batch's share of them is not a number.
 * `compare()` also cannot hand back the mentions, and reaching them would mean
 * re-implementing `renderItem` out here — the one function in the engine that has
 * already had a subtle bug in it, where a packed header line taught a real model to
 * answer `"ref": "maps.reviews th"` on every item. Forking it to measure it would
 * measure the fork. `extract()` is the production path, and its `ExtractReport`
 * carries the reliability numbers `compare()` would have reported anyway.
 *
 * **It spends real money.** Not much — the whole slate is well under a dollar — but
 * it is a network run against five paid routes, so the output path is an argument
 * with no default, and `--dry` prints the token estimate and the slate without
 * opening a connection.
 *
 * **Why there are timeouts in a measuring tool.** The first run of this file had to
 * be killed. `qwen3-235b-a22b-2507` had been sitting on one open socket for seven
 * and a half minutes, and the honest thing to say is that nobody could tell whether
 * it was hung or merely slow — `CompleteOptions.signal` is optional, neither this
 * tool nor `extract()` filled it in, and a request with no deadline makes those two
 * states indistinguishable. That indistinguishability is the defect, not the seven
 * minutes. So the bound is installed here: a per-request deadline, and a per-model
 * one so that a route which really is just slow cannot eat the slate either. That
 * the engine has no default of its own is a production problem rather than a quirk
 * of this tool — a provider that stops answering mid-call in the worker would burn
 * all of `WORKER_BUDGET_MS` waiting — and it is written up as its own question
 * rather than quietly patched here.
 *
 * Usage:
 *   npx tsx --env-file=.env tools/bake-off.ts <out.json> [--dry]
 *
 * `--env-file` is not optional: tsx does not read `.env` on its own, and the config
 * loader throws by name rather than falling back when the key is missing.
 */
import { writeFileSync } from "node:fs"
import type { MeterId } from "../packages/samsara/core/src/index.js"
import {
  BudgetGuard,
  keysFor,
  MemoryCounterStore,
  MemoryLogger,
} from "../packages/samsara/kernel/src/index.js"
import type { ChatClient, ChatRequest } from "../packages/samsara/llm/src/index.js"
import { LlmClient, loadLlmConfig } from "../packages/samsara/llm/src/index.js"
import { createOpenRouterClient } from "../packages/samsara/llm/src/openrouter.js"
import { extract, MemoryMentionSink } from "../packages/samsara/refine/src/index.js"
import { goldenCorpus, scoreGolden } from "../packages/travel/pack/src/golden/golden.js"
import { travelPack } from "../packages/travel/pack/src/index.js"
import type { PlaceMention } from "../packages/travel/pack/src/mention.js"

const out = process.argv[2]
const dry = process.argv.includes("--dry")
if (!out || out.startsWith("--")) {
  console.error("usage: npx tsx --env-file=.env tools/bake-off.ts <out.json> [--dry]")
  process.exit(1)
}

/**
 * The slate, with prices read from OpenRouter's own `/api/v1/models` on the date
 * below rather than from memory. `readOn` is mandatory in `ModelRate` for exactly
 * this reason: a price in code with no date on it is indistinguishable from a
 * price that has since moved.
 *
 * Chosen low-cost-first, because §8's ceiling is $20 and output tokens dominate
 * the bill. Thai is the binding constraint on quality — the corpus is fifty Thai
 * forum items — so the slate is weighted towards routes that are known to be
 * decent multilingually rather than towards the raw bottom of the price list.
 * Qwen is over-represented on purpose: it is the family that trains hardest on
 * non-Latin scripts, and two of its cheap instruct routes are worth more than one
 * cheap route from a family that has never advertised Thai.
 *
 * **Every candidate here is a non-reasoning instruct route, and that is the
 * lesson of the first run.** `gpt-5-nano` was on the original slate on price
 * — $0.05/$0.40 — and it is excluded now on measurement: see `EXCLUDED`. The
 * short version is that a reasoning model bills its thinking as output tokens,
 * which is the meter §8 says dominates, so its real cost was ten times its quoted
 * one. A `-thinking` variant is the wrong instrument for a task whose whole job
 * is to copy names out of a document.
 *
 * `claude-haiku-4.5` is a reference, not a candidate. It costs roughly forty
 * times the cheapest route on output and will not be chosen on price. It is here
 * so that a bad result is attributable: if all four cheap routes land at 40%
 * recall and Haiku lands at 85%, the prompt is fine and the routes are not; if
 * Haiku lands at 45% too, the prompt is the problem and no amount of model
 * shopping fixes it. That is worth about twenty cents to know.
 */
const READ_ON = "2026-09-18"
const SLATE = [
  { model: "qwen/qwen3.7-flash", inputPerMTok: 0.03, outputPerMTok: 0.13 },
  { model: "qwen/qwen3-30b-a3b-instruct-2507", inputPerMTok: 0.048, outputPerMTok: 0.193 },
  { model: "deepseek/deepseek-v4-flash", inputPerMTok: 0.089, outputPerMTok: 0.177 },
  { model: "google/gemini-2.5-flash-lite", inputPerMTok: 0.1, outputPerMTok: 0.4 },
  { model: "anthropic/claude-haiku-4.5", inputPerMTok: 1.0, outputPerMTok: 5.0, reference: true },
] as const

/**
 * Measured, then dropped. Kept in the output rather than deleted, because "we
 * tried it and it was bad" is a finding and an empty slate slot is not.
 */
const EXCLUDED = [
  {
    model: "openai/gpt-5-nano",
    measuredOn: "2026-09-18",
    recall: 0.162,
    precision: 0.8,
    inventedOnNegatives: 1,
    usd: 0.0822,
    seconds: 1984,
    why:
      "Reasoning route. 33 minutes for five batches, and $0.0822 against a $0.0081 estimate — " +
      "the 10x is thinking tokens, billed as output. 16.2% recall (12 of 74) at 80% precision: " +
      "it answers sparsely rather than wrongly. Slow, dear, and quiet is three reasons.",
  },
] as const

/** P2.2's bar, from PLAN §P2.2: 80% place-name recall, read against the labelled places. */
const RECALL_BAR = 0.8

/**
 * Deadlines. Both exist because the first run proved a request can hang forever.
 *
 * **Both numbers are second attempts, and the first ones corrupted a measurement.**
 * `MODEL_MS` was 900s. `qwen3.7-flash` came in at 907s, which is not a coincidence:
 * the cap fired, every remaining call aborted instantly, and the run reported 48.6%
 * recall with ten items that had never been answered at all. A deadline that is
 * close to the honest running time does not measure a model, it measures itself. So
 * `MODEL_MS` is now far above anything a working route should need, and its job is
 * reduced to what it should always have been: catching a route that is broken, not
 * one that is busy.
 *
 * `REQUEST_MS` is per HTTP call and matches `deadlineFor("agent")`, which is the
 * kernel's own answer to this question and the number `complete()` would inherit if
 * it adopted `withDeadline` (Q16). Agreeing with it deliberately.
 */
const REQUEST_MS = 240_000
const MODEL_MS = 2_400_000

const items = goldenCorpus.map((i) => ({
  id: i.id,
  sourceId: i.sourceId,
  url: i.url,
  title: i.title,
  text: i.text,
  languageGuess: i.languageGuess,
}))

const chars = items.reduce((n, i) => n + i.text.length + (i.title?.length ?? 0), 0)
// Optional in the `DomainPack` contract — a pack that does not say gets the
// engine's own default, and this is only used to estimate, never to batch.
const batchSize = travelPack.extract.batchSize ?? 20
console.log(`${items.length} items, ${chars.toLocaleString()} characters of Thai`)
console.log(`batchSize ${batchSize}, prompt version ${travelPack.version}\n`)

if (dry) {
  // Thai runs at roughly one token per character on every tokeniser we have seen,
  // which is the same assumption `pack.ts` uses to justify a batch of ten.
  const inTok = chars + 2_000 * Math.ceil(items.length / batchSize)
  const outTok = 12_000
  console.log("estimate per model (~1 token/char for Thai, + prompt per batch):")
  let total = 0
  for (const c of SLATE) {
    const usd = (inTok / 1e6) * c.inputPerMTok + (outTok / 1e6) * c.outputPerMTok
    total += usd
    console.log(`  ${c.model.padEnd(36)} ~$${usd.toFixed(4)}`)
  }
  console.log(`\n  ${"whole slate".padEnd(36)} ~$${total.toFixed(4)}  (dry run, nothing spent)`)
  console.log("\nnote: a reasoning route bills thinking as output and will exceed this by ~10x.")
  process.exit(0)
}

/**
 * A local ceiling, not §8's. The store is in-memory, so this does not read or
 * write the real meter — its job is to stop a retry loop turning a twenty-cent
 * run into a twenty-dollar one while nobody is watching.
 */
const CEILINGS: Record<MeterId, number> = {
  "solari.minutes": 0,
  "llm.input.tokens": 1_500_000,
  "llm.output.tokens": 200_000,
  "geocode.calls": 0,
}

/**
 * Put a deadline on a request the engine would otherwise let run forever.
 *
 * `extract()` never sets `signal`, so in practice this always supplies it; the
 * `??` is there so that wrapping stays correct if it ever starts to.
 */
const deadlined = (inner: ChatClient, until: AbortSignal): ChatClient => ({
  chat: (req: ChatRequest) =>
    inner.chat({
      ...req,
      signal: req.signal ?? AbortSignal.any([until, AbortSignal.timeout(REQUEST_MS)]),
    }),
})

type Row = {
  model: string
  reference: boolean
  recall: number
  precision: number
  inventedOnNegatives: number
  matched: number
  expected: number
  predicted: number
  mentions: number
  invalid: number
  unknownRefs: number
  duplicateRefs: number
  calls: number
  batches: number
  failures: { kind: string; count: number }[]
  inputTokens: number
  outputTokens: number
  usd: number
  seconds: number
  /**
   * One line per `llm.call` event, folded by how it ended.
   *
   * Without this a failure is a bare `{kind, count}` and there is no way to tell a
   * provider that refused in 200ms from our own deadline firing at 180s — which is
   * the first thing anyone reading a bad row wants to know. Every field here is a
   * count, a class or a duration, so ADR-0014 has nothing to object to.
   */
  attempts: {
    outcome: string
    kind: string | null
    count: number
    medianMs: number
    maxMs: number
  }[]
  /** Set when the model did not finish: the slate continues without it. */
  error?: string
}

/** Fold `llm.call` events into one line per (outcome, kind), with durations. */
const foldCalls = (logger: MemoryLogger): Row["attempts"] => {
  const by = new Map<string, { outcome: string; kind: string | null; ms: number[] }>()
  for (const e of logger.events) {
    if (e.event !== "llm.call") continue
    const key = `${e.outcome}/${e.kind ?? ""}`
    const bucket = by.get(key) ?? { outcome: e.outcome, kind: e.kind ?? null, ms: [] }
    bucket.ms.push(e.durationMs)
    by.set(key, bucket)
  }
  return [...by.values()]
    .map((b) => {
      const sorted = [...b.ms].sort((x, y) => x - y)
      return {
        outcome: b.outcome,
        kind: b.kind,
        count: sorted.length,
        medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
        maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
      }
    })
    .sort((a, b) => b.count - a.count)
}

const rows: Row[] = []
const base = loadLlmConfig()

/** Written after every model, so a crash on model four does not discard models one to three. */
const save = (ranked: readonly Row[]) =>
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        readOn: READ_ON,
        promptVersion: travelPack.version,
        recallBar: RECALL_BAR,
        items: items.length,
        requestMs: REQUEST_MS,
        modelMs: MODEL_MS,
        rows: ranked,
        excluded: EXCLUDED,
      },
      null,
      2,
    )}\n`,
  )

for (const candidate of SLATE) {
  const config = { ...base, models: { extract: candidate.model } }
  const store = new MemoryCounterStore()
  const clock = AbortSignal.timeout(MODEL_MS)
  const logger = new MemoryLogger()
  const llm = new LlmClient({
    chat: deadlined(createOpenRouterClient(config as never), clock),
    config: config as never,
    budget: new BudgetGuard({ store, ceilings: CEILINGS }),
    logger,
  })

  const sink = new MemoryMentionSink()
  let n = 0
  const startedAt = Date.now()
  process.stdout.write(`${candidate.model} … `)

  const spent = async (meter: MeterId) =>
    (await store.read(keysFor(meter, {}, new Date()))).values().next().value ?? 0

  // One bad route must not cost the other four. A model that throws, hangs past
  // its deadline, or is refused records a row saying so and the slate moves on.
  try {
    const report = await extract({
      pack: travelPack,
      llm,
      sink,
      items,
      // ADR-0012's explicit allowance: these are harvested public forum posts, not
      // anything derived from a user's own trip. The opt-in is stated at the call
      // site on purpose, so a reviewer can see it.
      sensitivity: "public",
      newId: () => `m${++n}`,
    })

    const seconds = (Date.now() - startedAt) / 1000

    // `extract()` catches its own call failures and returns a report either way, so
    // a fired model clock arrives here looking like a finished run with a bad score
    // — which is how the first attempt published 48.6% for a route that was cut off
    // mid-corpus. The clock is the only thing that knows, so it is asked directly.
    const truncated = clock.aborted

    const predictions = new Map<string, PlaceMention[]>()
    for (const row of sink.rows) {
      const list = predictions.get(row.rawItemId) ?? []
      list.push(row.payload as PlaceMention)
      predictions.set(row.rawItemId, list)
    }
    const score = scoreGolden(predictions)

    const inputTokens = await spent("llm.input.tokens")
    const outputTokens = await spent("llm.output.tokens")

    rows.push({
      model: candidate.model,
      reference: "reference" in candidate,
      recall: score.recall,
      precision: score.precision,
      inventedOnNegatives: score.inventedOnNegatives,
      matched: score.matched,
      expected: score.expected,
      predicted: score.predicted,
      mentions: report.mentions,
      invalid: report.invalid,
      unknownRefs: report.unknownRefs,
      duplicateRefs: report.duplicateRefs,
      calls: report.calls,
      batches: report.batches,
      failures: report.failures,
      attempts: foldCalls(logger),
      inputTokens,
      outputTokens,
      usd:
        (inputTokens / 1e6) * candidate.inputPerMTok +
        (outputTokens / 1e6) * candidate.outputPerMTok,
      seconds,
      ...(truncated ? { error: `cut off by the ${MODEL_MS / 1000}s model deadline` } : {}),
    })

    const last = rows[rows.length - 1] as Row
    console.log(
      (truncated ? "CUT OFF — " : "") +
        `recall ${(last.recall * 100).toFixed(1)}%  precision ${(last.precision * 100).toFixed(1)}%  ` +
        `invented ${last.inventedOnNegatives}  $${last.usd.toFixed(4)}  ${last.seconds.toFixed(0)}s`,
    )
  } catch (cause) {
    const inputTokens = await spent("llm.input.tokens")
    const outputTokens = await spent("llm.output.tokens")
    const error = clock.aborted
      ? `exceeded ${MODEL_MS / 1000}s model deadline`
      : cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : String(cause)
    rows.push({
      model: candidate.model,
      reference: "reference" in candidate,
      recall: 0,
      precision: 0,
      inventedOnNegatives: 0,
      matched: 0,
      expected: 0,
      predicted: 0,
      mentions: 0,
      invalid: 0,
      unknownRefs: 0,
      duplicateRefs: 0,
      calls: 0,
      batches: 0,
      failures: [],
      attempts: foldCalls(logger),
      inputTokens,
      outputTokens,
      usd:
        (inputTokens / 1e6) * candidate.inputPerMTok +
        (outputTokens / 1e6) * candidate.outputPerMTok,
      seconds: (Date.now() - startedAt) / 1000,
      error,
    })
    console.log(`FAILED — ${error}`)
  }

  save(rows)
}

// Clears the bar first, then cheapest. The other order picks the model that is
// cheap because it answers badly, which is the mistake the harness exists to stop.
// A row that never finished sorts last on both keys and cannot win by being cheap.
const ranked = [...rows].sort(
  (a, b) =>
    Number(Boolean(a.error)) - Number(Boolean(b.error)) ||
    Number(b.recall >= RECALL_BAR) - Number(a.recall >= RECALL_BAR) ||
    a.usd - b.usd ||
    b.recall - a.recall,
)

console.log(`\n${"model".padEnd(36)} ${"recall".padEnd(8)} ${"prec".padEnd(8)} inv   $`)
for (const r of ranked) {
  console.log(
    `${(r.reference ? `${r.model} (ref)` : r.model).padEnd(36)} ` +
      (r.error
        ? `— did not finish: ${r.error}`
        : `${`${(r.recall * 100).toFixed(1)}%`.padEnd(8)} ${`${(r.precision * 100).toFixed(1)}%`.padEnd(8)} ` +
          `${String(r.inventedOnNegatives).padEnd(5)} $${r.usd.toFixed(4)}`),
  )
}

const winner = ranked.find((r) => !r.reference && !r.error && r.recall >= RECALL_BAR)
console.log(
  winner
    ? `\nLLM_MODEL_EXTRACT=${winner.model}  — cheapest route clearing ${RECALL_BAR * 100}% recall`
    : `\nNo candidate cleared ${RECALL_BAR * 100}% recall. LLM_MODEL_EXTRACT stays empty.`,
)

save(ranked)
console.log(`\n→ ${out}`)
console.log(`$${rows.reduce((s, r) => s + r.usd, 0).toFixed(4)} spent across the slate`)
