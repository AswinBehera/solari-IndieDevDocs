import type { ClaimedJob, JobStore, Kernel, Logger } from "@samsara/kernel"
import { classify, failure, now, silentLogger } from "@samsara/kernel"
import type { HandlerLookup, JobContext } from "./handlers.js"

/**
 * Claim, drain, exit (ADR-0014).
 *
 * The loop is short and the constraints around it are not. A scheduled runner has
 * no steady state to return to: it wakes, it should do as much useful work as it
 * can, and then it must *leave*, because a process that lingers is a process
 * GitHub eventually kills in the middle of something. So the loop has three exits,
 * all of them ordinary — the queue is empty, the wall-clock budget is spent, or a
 * cancellation arrived — and none of them is an error.
 */

export interface DrainDeps {
  jobs: JobStore
  kernel: Kernel
  handlers: HandlerLookup
  logger?: Logger
}

export interface DrainOptions {
  /** The GitHub Actions run id in production; any stable string in tests. */
  runId: string
  /**
   * How long the whole drain may take. Sized under the workflow's own timeout so
   * that the runner stops itself rather than being stopped — a self-stop releases
   * its claims, a kill does not.
   */
  budgetMs: number
  /**
   * How long a claim is held before another runner may take the row. Must exceed
   * the slowest handler's honest duration, and handlers longer than it must
   * heartbeat. Too short duplicates work; too long strands it after a cancellation.
   */
  leaseMs: number
  /** Rows per claim. Small on purpose: see `ClaimOptions.limit`. */
  batchSize?: number
  signal: AbortSignal
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Pause between empty claims before giving up on the drain. */
  idleDelayMs?: number
}

export interface DrainSummary {
  claimed: number
  succeeded: number
  failed: number
  reclaimed: number
  /** Claims given back on cancellation, having consumed no attempt. */
  released: number
  durationMs: number
  stoppedBecause: "empty" | "budget" | "cancelled"
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function drain(deps: DrainDeps, opts: DrainOptions): Promise<DrainSummary> {
  const logger = deps.logger ?? silentLogger
  const clock = opts.clock ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const startedAt = clock()
  const batchSize = opts.batchSize ?? 1
  const idleDelayMs = opts.idleDelayMs ?? 0

  const summary: DrainSummary = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    reclaimed: 0,
    released: 0,
    durationMs: 0,
    stoppedBecause: "empty",
  }

  // Rows this run currently holds. Kept so that a cancellation can hand them back
  // rather than leaving them to time out: a released row is claimable immediately,
  // a leased one waits out `leaseMs` doing nothing.
  const held = new Set<string>()

  const finish = (because: DrainSummary["stoppedBecause"]): DrainSummary => {
    summary.stoppedBecause = because
    summary.durationMs = clock() - startedAt
    logger.emit({
      at: now(),
      event: "runner.drained",
      runId: opts.runId,
      claimed: summary.claimed,
      succeeded: summary.succeeded,
      failed: summary.failed,
      reclaimed: summary.reclaimed,
      durationMs: summary.durationMs,
    })
    return summary
  }

  try {
    while (true) {
      if (opts.signal.aborted) return finish("cancelled")
      if (clock() - startedAt >= opts.budgetMs) return finish("budget")

      const { jobs: claimed, reclaimed } = await deps.jobs.claim({
        runId: opts.runId,
        limit: batchSize,
        leaseMs: opts.leaseMs,
        types: deps.handlers.types(),
      })
      summary.reclaimed += reclaimed

      if (claimed.length === 0) {
        // Nothing due. Under ADR-0016 a foreground job arrives by
        // `workflow_dispatch` rather than by this run noticing it, so waiting here
        // buys very little — but a short idle pass absorbs the case where a job was
        // enqueued microseconds after the claim, which a dispatched run makes
        // likely rather than theoretical.
        if (idleDelayMs <= 0) return finish("empty")
        await sleep(idleDelayMs)
        const { jobs: second } = await deps.jobs.claim({
          runId: opts.runId,
          limit: batchSize,
          leaseMs: opts.leaseMs,
          types: deps.handlers.types(),
        })
        if (second.length === 0) return finish("empty")
        claimed.push(...second)
      }

      // Every row in the batch is held from the instant it is claimed. Adding
      // them one at a time as each is about to run would leave rows 2..n of an
      // aborted batch leased and untouched — claimed by a runner that has already
      // gone, waiting out `leaseMs` for nothing.
      for (const job of claimed) held.add(job.id)

      for (const job of claimed) {
        summary.claimed += 1
        const outcome = await runOne(deps, opts, job, logger)
        held.delete(job.id)
        if (outcome === "succeeded") summary.succeeded += 1
        else if (outcome === "failed") summary.failed += 1
        else summary.released += 1

        if (opts.signal.aborted) return finish("cancelled")
      }
    }
  } finally {
    if (held.size > 0) {
      await deps.jobs.release([...held])
      summary.released += held.size
    }
  }
}

type JobOutcome = "succeeded" | "failed" | "released"

async function runOne(
  deps: DrainDeps,
  opts: DrainOptions,
  job: ClaimedJob,
  logger: Logger,
): Promise<JobOutcome> {
  const clock = opts.clock ?? Date.now
  const startedAt = clock()

  logger.emit({
    at: now(),
    event: "job.claimed",
    jobId: job.id,
    type: job.type,
    domainId: job.domainId,
    attempt: job.attempt,
    of: job.maxAttempts,
  })

  const handler = deps.handlers.get(job.type)
  if (!handler) {
    // The claim filters on registered types, so reaching here means the registry
    // changed under us mid-drain. Terminal rather than retried: a runner that
    // cannot do this work will not be able to do it on the next attempt either,
    // and the row should wait for a deploy, not burn its attempts.
    const outcome = await deps.jobs.fail(
      job.id,
      failure("config", `no handler registered for job type "${job.type}"`),
    )
    logger.emit({
      at: now(),
      event: "job.finished",
      jobId: job.id,
      type: job.type,
      outcome: "failed",
      durationMs: clock() - startedAt,
      attempts: job.attempt,
      kind: "config",
      willRetry: outcome.willRetry,
    })
    return "failed"
  }

  const ctx: JobContext = {
    job,
    kernel: deps.kernel,
    logger,
    signal: opts.signal,
    heartbeat: (note) => deps.jobs.heartbeat(job.id, opts.leaseMs, note),
  }

  try {
    await handler(ctx)
    await deps.jobs.succeed(job.id)
    logger.emit({
      at: now(),
      event: "job.finished",
      jobId: job.id,
      type: job.type,
      outcome: "succeeded",
      durationMs: clock() - startedAt,
      attempts: job.attempt,
      kind: null,
      willRetry: false,
    })
    return "succeeded"
  } catch (thrown) {
    // A cancellation is not a failure, and this branch is the difference between
    // those two words meaning different things. SIGTERM makes the handler's awaits
    // reject; routing that through `classify` would call it `internal`, charge the
    // job an attempt and push it behind a backoff — so three cancelled runs would
    // retire a job that has never actually been tried, which under ADR-0014 is an
    // ordinary week rather than a pathological one.
    if (opts.signal.aborted) {
      await deps.jobs.release([job.id])
      logger.emit({
        at: now(),
        event: "job.finished",
        jobId: job.id,
        type: job.type,
        outcome: "queued",
        durationMs: clock() - startedAt,
        attempts: job.attempt,
        kind: null,
        willRetry: true,
      })
      return "released"
    }

    // `classify` is the kernel's, not a local try/catch's. It is the single place
    // that decides whether something is the provider's fault, ours, or the budget
    // guard's, and the job's retry decision has to agree with the one a session
    // retry would have made — otherwise a `blocked` page gets retried at the job
    // level after being correctly refused at the session level.
    const failure = classify(thrown)
    const outcome = await deps.jobs.fail(job.id, failure)
    logger.emit({
      at: now(),
      event: "job.finished",
      jobId: job.id,
      type: job.type,
      outcome: outcome.willRetry ? "queued" : "failed",
      durationMs: clock() - startedAt,
      attempts: job.attempt,
      kind: failure.kind,
      willRetry: outcome.willRetry,
    })
    return "failed"
  }
}
