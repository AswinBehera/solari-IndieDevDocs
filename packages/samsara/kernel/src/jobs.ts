import type { JobState } from "@samsara/core"
import type { Failure } from "./result.js"

/**
 * The queue's port (ADR-0004 as amended by ADR-0014), alongside the session and
 * counter ports in `ports.ts` and for the same reason: every test above this line
 * runs without Postgres, and the real implementation lives in `stores/postgres.ts`.
 *
 * It sits in `@samsara/kernel` rather than in a package of its own because
 * ADR-0019 keeps the engine's package count fixed and both `apps/api` (which enqueues
 * and reads) and `apps/worker` (which claims and drains) need it. The kernel
 * already owns the other two pieces of runtime plumbing those apps share — the
 * budget counters and the session registry — and a queue whose rows outlive the
 * process is the same kind of thing. Recorded as an executor decision in STATUS.
 */

export interface EnqueueInput {
  type: string
  domainId?: string | null
  ownerId?: string | null
  payload?: unknown
  /** Collides deliberately. See `deduped` on the result. */
  idempotencyKey?: string | null
  priority?: number
  maxAttempts?: number
  runAfter?: Date
}

export interface EnqueueResult {
  id: string
  /**
   * True when an existing row carried this idempotency key and nothing was
   * inserted. The API turns this into a 200 pointing at the live job rather than a
   * 409 — a user who double-clicks meant to start the work once, and telling them
   * it "already exists" is a worse answer than showing them the one that is running.
   */
  deduped: boolean
}

/** What a handler receives. Deliberately not the whole row. */
export interface ClaimedJob {
  id: string
  type: string
  domainId: string | null
  ownerId: string | null
  payload: unknown
  /** This attempt's number, 1-based, and the ceiling it is counting towards. */
  attempt: number
  maxAttempts: number
}

export interface ClaimOptions {
  /** Identifies the holder of the lease. The GitHub Actions run id in production. */
  runId: string
  /** How many rows to take in one claim. Keep small: an unclaimed row is free,
   *  a claimed row a cancelled runner is holding is not. */
  limit: number
  leaseMs: number
  /** Restrict to handlers this runner has registered. Empty means all of them. */
  types?: readonly string[]
  now?: Date
}

export interface ClaimResult {
  jobs: ClaimedJob[]
  /** How many of them were `running` rows whose lease had expired. */
  reclaimed: number
}

export interface StoredJobEvent {
  seq: number
  state: JobState
  note: string | null
  at: Date
}

export interface JobStore {
  enqueue(input: EnqueueInput): Promise<EnqueueResult>
  /** One statement, `FOR UPDATE SKIP LOCKED`. Never a select followed by an update. */
  claim(opts: ClaimOptions): Promise<ClaimResult>
  /** Extends the lease of a job still being worked. Called by long handlers only. */
  heartbeat(id: string, leaseMs: number, note?: string): Promise<void>
  succeed(id: string, note?: string): Promise<void>
  /**
   * Records the failure and decides, from `attempts` against `maxAttempts`, whether
   * the row returns to `queued` with `runAfter` pushed out or goes terminal.
   * Returns what it chose, so the runner can log it rather than infer it.
   */
  fail(id: string, failure: Failure, opts?: { now?: Date }): Promise<{ willRetry: boolean }>
  /** Releases claims without consuming an attempt. The SIGTERM path. */
  release(ids: readonly string[]): Promise<void>
  /** The SSE cursor read (ADR-0016). One round trip, `seq > after`, newest last. */
  eventsAfter(jobId: string, after: number, limit: number): Promise<StoredJobEvent[]>
}

/**
 * Retry backoff for a *job*, which is a different question from the retry inside a
 * single operation (`retry.ts`). That one is measured in seconds because it is
 * riding out a provider blip while holding a browser open. This one is measured in
 * minutes because the row is on disk and nothing is being paid for while it waits
 * — and because under ADR-0014 the next runner may not wake for five minutes
 * anyway, so a sub-minute job backoff would be a number with no effect.
 */
export const jobRetryDelayMs = (attempt: number, random: () => number = Math.random): number => {
  const base = Math.min(60_000 * 2 ** (attempt - 1), 15 * 60_000)
  // Full jitter. Two runners that failed on the same upstream outage must not come
  // back at the same instant and reproduce it together.
  return Math.round(base * (0.5 + random() * 0.5))
}

/**
 * The SSE poll schedule from ADR-0016, as a pure function of elapsed time.
 *
 * The shape matters more than the numbers. A fixed one-second poll costs 86,400
 * queries a day *per open tab* against an account-wide free ceiling of 100,000, so
 * one forgotten tab takes down the API for everyone. Backing off converts that into
 * roughly 240 queries an hour, and the bounded lifetime below converts an abandoned
 * tab into a closed stream rather than a permanent one.
 *
 * It is fast where a human is actually watching — the first ten seconds after they
 * pressed the button — and slow everywhere else, which is exactly where the
 * attention is.
 */
export const streamPollIntervalMs = (elapsedMs: number): number => {
  if (elapsedMs < 10_000) return 1_000
  if (elapsedMs < 60_000) return 5_000
  return 15_000
}

/**
 * How long a stream may live regardless of what the job is doing. A stream that
 * outlives its job is spending a shared quota on nobody's behalf; the client
 * reconnects if the human is still there, and does not if they are not.
 */
export const STREAM_MAX_LIFETIME_MS = 15 * 60_000

/**
 * The bound P0.5's acceptance test asserts (ADR-0016). Derived from the schedule
 * above rather than written down independently, so the test cannot silently pass
 * after someone edits the intervals.
 */
export const maxStreamQueries = (lifetimeMs: number = STREAM_MAX_LIFETIME_MS): number => {
  let elapsed = 0
  let queries = 0
  while (elapsed < lifetimeMs) {
    queries += 1
    elapsed += streamPollIntervalMs(elapsed)
  }
  return queries
}
