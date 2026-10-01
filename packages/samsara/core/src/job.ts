import { z } from "zod"
import { domainId, id, timestamps } from "./primitives.js"

/**
 * The queue (ADR-0004 as amended by ADR-0014). A row, not a message.
 *
 * The distinction is load-bearing rather than pedantic. A message is handed to a
 * listener; a row is claimed by whoever wakes up next. Under ADR-0014 there is no
 * listener — `apps/worker` is a scheduled or dispatched GitHub Actions run that
 * wakes, claims, drains and exits — so every field below exists to make that
 * cycle survivable: a runner can be cancelled between any two statements, and the
 * next runner has to be able to tell the difference between work in progress and
 * work abandoned.
 */

/**
 * Five states, three of them terminal.
 *
 * There is deliberately no `claimed` distinct from `running`. A claim that has not
 * begun running is indistinguishable, from outside the process, from a claim whose
 * process died — and the only thing that resolves either is the lease expiring. A
 * state nobody can act on differently is not a state, it is a comment.
 */
export const jobState = z.enum(["queued", "running", "succeeded", "failed", "cancelled"])
export type JobState = z.infer<typeof jobState>

export const terminalJobStates = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly JobState[]
export const isTerminal = (s: JobState): boolean =>
  (terminalJobStates as readonly string[]).includes(s)

/**
 * What kind of work this is: `block.run`, `prototype.stop`.
 *
 * Free text, not an enum. The worker registers the handlers it has at boot, so a
 * closed union here would mean editing the kernel every time the product learned
 * to do something new.
 */
export const jobType = z.string().min(1)
export type JobType = z.infer<typeof jobType>

export const job = z
  .object({
    id,
    type: jobType,
    /** Which part of the product the work belongs to. `null` for kernel housekeeping. */
    domainId: domainId.nullable(),
    /** Opaque to the engine, exactly as on Session. `null` means the system asked. */
    ownerId: z.string().min(1).nullable(),
    /** The handler's input. The engine never reads inside it. */
    payload: z.unknown(),
    /**
     * The idempotency key from the rule that every job is idempotent and
     * resumable. Unique where present: enqueuing the same logical work twice — a
     * double-clicked button, a cron overlapping its own previous run — yields one
     * row, not two runners spending two sets of browser minutes on it.
     */
    idempotencyKey: z.string().min(1).nullable(),
    state: jobState,
    /** Higher runs first. Ties break by `runAfter`, then by age. */
    priority: z.number().int(),
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    /** Not before this instant. Retry backoff is expressed by moving it forward. */
    runAfter: z.date(),
    /**
     * The claim's expiry. A `running` row whose lease is in the past is not
     * running — its runner was cancelled mid-flight, which ADR-0014 makes a routine
     * event rather than an incident — and the next runner may take it.
     */
    leaseUntil: z.date().nullable(),
    /** Which run holds the lease. The GitHub Actions run id, for tracing a failure back. */
    claimedBy: z.string().min(1).nullable(),
    /** Last failure, already classified by the kernel. Never a raw provider blob. */
    lastError: z.string().nullable(),
    startedAt: z.date().nullable(),
    finishedAt: z.date().nullable(),
  })
  .extend(timestamps.shape)
export type Job = z.infer<typeof job>

/**
 * One row per state change, appended by the runner as it happens (ADR-0016).
 *
 * This table is why progress can be *pushed* rather than polled for. The API's SSE
 * stream reads events after a cursor instead of re-reading the job row on a timer,
 * so a stream that sees nothing new costs one query per tick and a stream watching
 * a busy job costs the same — which is the whole point, given that Hyperdrive's
 * free quota is 100,000 queries per day across the entire account.
 */
export const jobEvent = z.object({
  id,
  jobId: id,
  /** Monotonic per job. The SSE cursor, and the reason this is not keyed on time. */
  seq: z.number().int().nonnegative(),
  state: jobState,
  /**
   * Human-facing progress, shown in the editor. Deliberately a short string and not
   * a free-form object: the repository is public and this table is streamed to a
   * browser, so the same rule that shaped the kernel's logger applies — there is no
   * field here into which a secret can be accidentally poured.
   */
  note: z.string().max(200).nullable(),
  at: z.date(),
})
export type JobEvent = z.infer<typeof jobEvent>
