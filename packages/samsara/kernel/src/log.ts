import type { MeterId, SessionOutcome, SessionPurpose } from "@samsara/core"
import type { FailureKind } from "./result.js"

/**
 * Structured logs (plan section 2.4, item 5). One JSON line per event.
 *
 * The repository is public, which means the GitHub Actions log is public
 * (ADR-0014). So the defence against logging a secret is not a redaction denylist
 * — those are only ever as good as their last update — it is that **the event
 * types have nowhere to put one**. There is no `payload`, no `meta`, no
 * `Record<string, unknown>` anywhere below. Adding a field is a reviewed diff in
 * this file, which is the only place where "should this be public?" gets asked.
 *
 * Consequently: no request bodies, no harvested text, no URLs with query strings,
 * no values read from `process.env`. Counts, durations, ids, and error classes.
 */

interface Base {
  /** Monotonic-ish wall clock. Every run records its own time because a scheduled
   *  workflow cannot assume it ran on the schedule it was meant to (ADR-0014). */
  at: string
}

export type KernelEvent = Base &
  (
    | {
        event: "session.open"
        sessionId: string
        purpose: SessionPurpose
        /** Where the packets came from. */
        country: string
        /** What the browser claimed to be. Divergence from `country` is deliberate
         *  and is the thing a Persona Lab reading these logs needs to see. */
        locale: string | null
        timezoneId: string | null
        personaId: string | null
        domainId: string | null
        recording: boolean
      }
    | {
        event: "session.close"
        sessionId: string
        purpose: SessionPurpose
        country: string
        personaId: string | null
        outcome: SessionOutcome
        durationMs: number
        minutes: number
        /** Bytes read through the session, when the caller can report it. */
        bytes: number | null
      }
    | {
        event: "session.orphaned"
        sessionId: string
        purpose: SessionPurpose
        /** How long the row sat open with no live handle. */
        ageMs: number
      }
    | {
        event: "persona.created"
        personaId: string
        country: string
        locale: string
        /** `anon` or `seeded`. The locality is caller text and stays out of here. */
        tier: string
        /** Whether a provider profile was attached. Never the profile's id. */
        profile: boolean
      }
    | {
        event: "persona.health"
        personaId: string
        from: string
        to: string
        /** Kernel-authored. The evidence in counts, never the pages that produced it. */
        reason: string
      }
    | {
        event: "persona.keepalive"
        personaId: string
        /** How many pages were visited. Not which: a URL can carry a query string. */
        visited: number
        /** False when the accumulated state was thrown away. See `ProfileStore`. */
        saved: boolean
        savedBytes: number | null
      }
    | {
        event: "job.claimed"
        jobId: string
        /** The handler key, e.g. `harvest.run`. Never the payload. */
        type: string
        domainId: string | null
        attempt: number
        of: number
      }
    | {
        event: "job.finished"
        jobId: string
        type: string
        /** `succeeded`, `failed`, or `cancelled` — the row's terminal state. */
        outcome: string
        durationMs: number
        attempts: number
        /** Present only on failure, and only ever a class. */
        kind: FailureKind | null
        willRetry: boolean
      }
    | {
        event: "runner.drained"
        /** The Actions run that held the leases, for tracing a cancellation back. */
        runId: string
        claimed: number
        succeeded: number
        failed: number
        /** Rows whose lease had expired and which this run took back. */
        reclaimed: number
        durationMs: number
      }
    | {
        event: "budget.refused"
        meter: MeterId
        window: string
        ceiling: number
        used: number
        requested: number
      }
    | {
        event: "budget.spent"
        meter: MeterId
        amount: number
        purpose: SessionPurpose | null
      }
    | {
        event: "llm.call"
        /** The engine task, e.g. `extract`. Never a model preference in code. */
        task: string
        /** The routed model id, which is config (ADR-0012) and therefore worth logging. */
        model: string
        /** Identity of the prompt, never its text. Both halves stamp Evidence rows. */
        promptId: string
        promptVersion: string
        /** Which pack's prompt this was, when the caller said. */
        domainId: string | null
        attempt: number
        inputTokens: number
        outputTokens: number
        /**
         * False when the provider returned no usage block and these numbers are our
         * own estimate. A meter fed by an estimate is still a meter, but a reader
         * comparing two models' costs needs to know which of them was measured.
         */
        metered: boolean
        durationMs: number
        /** `ok`, `invalid` (spent tokens, unusable answer), or `failed`. */
        outcome: string
        kind: FailureKind | null
      }
    | {
        event: "attempt.retry"
        purpose: SessionPurpose
        attempt: number
        of: number
        delayMs: number
        /** The class only. Never the message, which can quote a page. */
        because: FailureKind
      }
    | {
        event: "attempt.failed"
        purpose: SessionPurpose
        kind: FailureKind
        /** Safe by construction: kernel-authored strings, never provider text. */
        message: string
        attempts: number
      }
  )

export interface Logger {
  emit(event: KernelEvent): void
}

// `jsonLogger` used to live here and now lives in `log.node.ts`, reachable as
// `@samsara/kernel/node`. It was the only thing in this file that touched
// `process`, and packages are source-only (no build step, P0.1), so its presence
// made every module that imports a `Logger` uncompilable against the Workers
// runtime — which `apps/api` is. The split is the same move as `./solari`: the
// thing a runtime cannot load is reachable, but never on the default path.

/** Collects events instead of printing them. For assertions in tests. */
export class MemoryLogger implements Logger {
  readonly events: KernelEvent[] = []
  emit(event: KernelEvent): void {
    this.events.push(event)
  }
}

export const silentLogger: Logger = { emit() {} }

export const now = (): string => new Date().toISOString()
