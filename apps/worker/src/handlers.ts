import type { ClaimedJob, Kernel, Logger } from "@samsara/kernel"

/**
 * What a job handler is given, and nothing more.
 *
 * The two interesting members are `signal` and `heartbeat`, and both exist because
 * of ADR-0014's central fact: this process is a scheduled or dispatched GitHub
 * Actions run, and it can be cancelled at any instant. A handler that ignores
 * `signal` will be killed mid-browser-session and leave a `sessions` row the next
 * boot has to reconcile as `orphaned`; a handler that runs longer than its lease
 * without calling `heartbeat` will have its job claimed out from under it by the
 * next runner and do the work twice.
 */
export interface JobContext {
  job: ClaimedJob
  kernel: Kernel
  logger: Logger
  /** Aborted on SIGTERM. Pass it to every await that can take one. */
  signal: AbortSignal
  /** Extends the lease and, with a note, pushes a line to anyone watching (ADR-0016). */
  heartbeat(note?: string): Promise<void>
}

export type JobHandler = (ctx: JobContext) => Promise<void>

/**
 * `Map<string, JobHandler>`, keyed by job type.
 */
/**
 * What the runner actually needs, which is less than the registry provides.
 *
 * The narrower type is not ceremony: the one branch in `runner.ts` that is hard to
 * reach — a job whose type was claimable but whose handler is gone, i.e. the
 * registry changing under a drain — is only testable against something that can be
 * made inconsistent on purpose. A concrete class that keeps `types()` and `get()`
 * in sync by construction cannot express the failure it is supposed to handle.
 */
export interface HandlerLookup {
  get(type: string): JobHandler | undefined
  types(): string[]
}

export class HandlerRegistry implements HandlerLookup {
  private readonly handlers = new Map<string, JobHandler>()

  register(type: string, handler: JobHandler): void {
    if (this.handlers.has(type)) throw new Error(`handler already registered: ${type}`)
    this.handlers.set(type, handler)
  }

  get(type: string): JobHandler | undefined {
    return this.handlers.get(type)
  }

  /** The claim filter. A runner must never claim work it cannot perform. */
  types(): string[] {
    return [...this.handlers.keys()]
  }
}

/**
 * The one job type Phase 0 ships (P0.5).
 *
 * It does nothing on purpose. Its value is that it exercises every edge of the
 * cycle that is hard to test with real work in it — claim, lease, heartbeat,
 * event append, terminal transition, and the SIGTERM path — without opening a
 * browser or spending a minute. It stays in the tree after real
 * handlers arrive, because it is also the cheapest possible end-to-end check that
 * a deployed runner is alive at all.
 */
export const noopHandler: JobHandler = async (ctx) => {
  const payload = (ctx.job.payload ?? {}) as { sleepMs?: number; fail?: string }

  if (typeof payload.sleepMs === "number" && payload.sleepMs > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, payload.sleepMs)
      // Without this, SIGTERM waits out the sleep and the grace period expires
      // holding a lease nobody is using.
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          reject(new Error("aborted"))
        },
        { once: true },
      )
    })
  }

  // A test affordance, and deliberately a string the handler throws rather than a
  // flag the runner interprets: the failure has to travel the same path a real
  // one would, through `classify` and into `fail`.
  if (payload.fail) throw new Error(payload.fail)

  await ctx.heartbeat("noop complete")
}
