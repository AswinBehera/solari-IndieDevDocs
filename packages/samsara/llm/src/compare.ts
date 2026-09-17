import type { BudgetGuard, FailureKind, KernelEvent, Logger, SpendScope } from "@samsara/kernel"
import { MemoryLogger } from "@samsara/kernel"
import type { z } from "zod"
import { LlmClient } from "./complete.js"
import type { LlmConfig, LlmTask, Sensitivity } from "./config.js"
import type { ChatClient } from "./ports.js"
import type { PromptRef } from "./prompt.js"

/**
 * The model comparison ADR-0012 asks for, as a harness rather than as an answer.
 *
 * The ADR gives P2.1 the job of picking "the cheapest model that clears Phase 2's
 * quality bar — 66% of top-30 entities verified — by measurement". That bar is not
 * measurable yet: it needs the extraction prompt and the fifty hand-labelled items,
 * and both of those are P2.2's, owned by the pack. What *is* buildable now is the
 * instrument, and building it now is what keeps the eventual choice cheap —
 * §8 notes that replaying stored raw items opens no browsers, so re-running this
 * costs nothing on the meter that is actually scarce.
 *
 * So this file measures the half that does not need labels:
 *
 * - **how often a model returns something the schema accepts**, which ADR-0012
 *   predicts is where the cheap routes fail, and
 * - **what it costs to find out**, counted across *every* attempt rather than the
 *   one that worked.
 *
 * That second point is the reason the totals come from the log rather than from
 * the returned `Completion`. A `Completion` carries the usage of the attempt that
 * succeeded; a model that fails its schema twice and succeeds on the third try
 * spent three calls, and a comparison that credits it with one would rank the
 * least reliable model as the cheapest. Every attempt emits an `llm.call` event
 * with its own usage, so aggregating events counts the retries that a returned
 * value cannot see.
 *
 * Quality, when labels exist, arrives through `grade`. This file does not know
 * what a good answer is and must not: the labels belong to whoever owns the
 * entity, which is never the engine.
 */

export interface ModelRate {
  /** USD per million tokens. */
  inputPerMTok: number
  outputPerMTok: number
  /**
   * When the rate was read, and from where. Required, because a price in code
   * with no date on it is indistinguishable from a price that is now wrong —
   * `ceilings.ts` carries the same discipline for the same reason.
   */
  readOn: string
}

export interface ModelCandidate {
  model: string
  /** Optional. Without it the report has tokens and no dollars, which is still a ranking. */
  rate?: ModelRate
}

export interface ComparisonCase<T> {
  id: string
  vars?: Readonly<Record<string, string>>
  /**
   * 0 to 1, from whoever owns the labels. Absent for a case that only tests
   * whether a model can produce the shape at all.
   */
  grade?: (value: T) => number
}

export interface CompareOptions<T> {
  chat: ChatClient
  config: LlmConfig
  budget: BudgetGuard
  task: LlmTask
  prompt: PromptRef
  schema: z.ZodType<T>
  candidates: readonly ModelCandidate[]
  cases: readonly ComparisonCase<T>[]
  /** Recorded in the report so a run can be repeated exactly. */
  seed?: number
  scope?: SpendScope
  sensitivity?: Sensitivity
  maxOutputTokens?: number
  attempts?: number
  /** Receives every event as well as the internal collector. */
  logger?: Logger
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface ModelReport {
  model: string
  cases: number
  /** Cases that produced a schema-valid answer. */
  valid: number
  validRate: number
  /** Calls actually made, retries included. Above `cases` is the reliability tax. */
  attempts: number
  inputTokens: number
  outputTokens: number
  /** Calls whose usage came from the provider rather than from our estimate. */
  meteredCalls: number
  estimatedCalls: number
  durationMs: { mean: number; p50: number; p95: number }
  /** Present only when every candidate carried a rate. */
  usd?: number
  /** Present only when at least one case carried a grader. */
  grade?: { mean: number; graded: number }
  /** Why the failures failed, by class. Empty on a clean sweep. */
  failures: { kind: FailureKind; count: number }[]
}

export interface ComparisonReport {
  task: LlmTask
  promptId: string
  promptVersion: string
  promptFingerprint: string
  seed: number
  startedAt: string
  /** Sorted by `validRate` descending, then by cost ascending where known. */
  models: ModelReport[]
}

/**
 * Deterministic from a seed, so a comparison can be repeated exactly.
 *
 * Order matters and is not a nuisance to be averaged away: a provider warms a
 * route, a rate limit lands on whoever asks fourth, and a fixed candidate order
 * hands the same candidate the same position every time. P1.0's signal matrix
 * shuffled for this reason and recorded its seed; this does the same.
 */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}

/** Nearest-rank. On fewer than twenty samples a p95 is the maximum, and says so. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number
}

export async function compare<T>(opts: CompareOptions<T>): Promise<ComparisonReport> {
  const seed = opts.seed ?? 1
  const startedAt = new Date().toISOString()
  const reports: ModelReport[] = []

  // Candidate-major with the cases shuffled inside, rather than one interleaved
  // sequence: a route that rate-limits should do it to one candidate's numbers,
  // where it is visible as that candidate's failure count, instead of being
  // smeared across whichever candidates happened to be adjacent to it.
  for (const candidate of shuffled(opts.candidates, seed)) {
    const collector = new MemoryLogger()
    const logger: Logger = {
      emit(event: KernelEvent) {
        collector.emit(event)
        opts.logger?.emit(event)
      },
    }

    const client = new LlmClient({
      chat: opts.chat,
      // The one place a model id is chosen in code, and it is chosen from the
      // caller's candidate list rather than from a preference.
      config: { ...opts.config, models: { ...opts.config.models, [opts.task]: candidate.model } },
      budget: opts.budget,
      logger,
      ...(opts.clock === undefined ? {} : { clock: opts.clock }),
      ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
    })

    let valid = 0
    let graded = 0
    let gradeTotal = 0
    const durations: number[] = []
    const failures = new Map<FailureKind, number>()

    for (const testCase of shuffled(opts.cases, seed + 1)) {
      const result = await client.complete(opts.prompt, opts.schema, {
        task: opts.task,
        ...(testCase.vars === undefined ? {} : { vars: testCase.vars }),
        ...(opts.scope === undefined ? {} : { scope: opts.scope }),
        ...(opts.sensitivity === undefined ? {} : { sensitivity: opts.sensitivity }),
        ...(opts.maxOutputTokens === undefined ? {} : { maxOutputTokens: opts.maxOutputTokens }),
        ...(opts.attempts === undefined ? {} : { attempts: opts.attempts }),
      })

      if (result.ok) {
        valid++
        durations.push(result.value.durationMs)
        if (testCase.grade) {
          graded++
          gradeTotal += testCase.grade(result.value.value)
        }
      } else {
        failures.set(result.error.kind, (failures.get(result.error.kind) ?? 0) + 1)
      }
    }

    const calls = collector.events.filter(
      (event): event is Extract<KernelEvent, { event: "llm.call" }> => event.event === "llm.call",
    )
    const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0)
    const outputTokens = calls.reduce((sum, call) => sum + call.outputTokens, 0)
    const sortedDurations = [...durations].sort((a, b) => a - b)

    reports.push({
      model: candidate.model,
      cases: opts.cases.length,
      valid,
      validRate: opts.cases.length === 0 ? 0 : valid / opts.cases.length,
      attempts: calls.length,
      inputTokens,
      outputTokens,
      meteredCalls: calls.filter((call) => call.metered).length,
      estimatedCalls: calls.filter((call) => !call.metered).length,
      durationMs: {
        mean: durations.length === 0 ? 0 : durations.reduce((a, b) => a + b, 0) / durations.length,
        p50: percentile(sortedDurations, 50),
        p95: percentile(sortedDurations, 95),
      },
      ...(candidate.rate
        ? {
            usd:
              (inputTokens / 1_000_000) * candidate.rate.inputPerMTok +
              (outputTokens / 1_000_000) * candidate.rate.outputPerMTok,
          }
        : {}),
      ...(graded > 0 ? { grade: { mean: gradeTotal / graded, graded } } : {}),
      failures: [...failures.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count),
    })
  }

  // Reliability first, then cost. The other order picks the model that is cheap
  // because it answers badly, which is the mistake this whole harness exists to
  // stop somebody making from a price list alone.
  reports.sort(
    (a, b) =>
      b.validRate - a.validRate ||
      (a.usd ?? Number.POSITIVE_INFINITY) - (b.usd ?? Number.POSITIVE_INFINITY),
  )

  return {
    task: opts.task,
    promptId: opts.prompt.id,
    promptVersion: opts.prompt.version,
    promptFingerprint: opts.prompt.fingerprint,
    seed,
    startedAt,
    models: reports,
  }
}
