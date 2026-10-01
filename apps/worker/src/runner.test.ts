import {
  BudgetGuard,
  DEFAULT_CEILINGS,
  Kernel,
  MemoryCounterStore,
  MemoryJobStore,
  MemoryLogger,
  MemorySessionStore,
  SessionRegistry,
} from "@samsara/kernel"
import { PackRegistry } from "@samsara/refine"
import { describe, expect, it } from "vitest"
import { type HandlerLookup, HandlerRegistry, type JobHandler, noopHandler } from "./handlers.js"
import { drain } from "./runner.js"

/**
 * The claim/drain/exit cycle (P0.5), against the in-memory queue.
 *
 * What these tests can prove is the *policy*: what happens to a job that fails,
 * what a cancellation costs, what a runner does with work it cannot perform.
 * What they cannot prove is `SKIP LOCKED`, because nothing here is concurrent —
 * that is `jobs.pg.test.ts`, which needs a real database, and the split is
 * deliberate rather than an accident of convenience.
 */

const deps = (handlers: HandlerLookup, jobs = new MemoryJobStore()) => {
  const registry = new SessionRegistry(new MemorySessionStore())
  const guard = new BudgetGuard({ store: new MemoryCounterStore(), ceilings: DEFAULT_CEILINGS })
  return {
    jobs,
    kernel: new Kernel({ registry, guard }),
    packs: new PackRegistry(),
    handlers,
    logger: new MemoryLogger(),
  }
}

const opts = (signal = new AbortController().signal) => ({
  runId: "run-1",
  budgetMs: 5_000,
  leaseMs: 60_000,
  batchSize: 1,
  signal,
  idleDelayMs: 0,
})

describe("the drain loop", () => {
  it("claims a queued job, runs it, and marks it succeeded", async () => {
    const handlers = new HandlerRegistry()
    handlers.register("noop", noopHandler)
    const d = deps(handlers)
    const { id } = await d.jobs.enqueue({ type: "noop" })

    const summary = await drain(d, opts())

    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, stoppedBecause: "empty" })
    expect(d.jobs.rows.get(id)?.state).toBe("succeeded")
  })

  it("exits cleanly on an empty queue rather than waiting for work", async () => {
    // The whole shape of ADR-0014: there is no steady state to return to. A runner
    // with nothing to do must leave, so that the next one starts from a known place.
    const handlers = new HandlerRegistry()
    handlers.register("noop", noopHandler)
    const summary = await drain(deps(handlers), opts())
    expect(summary).toMatchObject({ claimed: 0, stoppedBecause: "empty" })
  })

  it("requeues a retryable failure with its attempt consumed and a backoff", async () => {
    const handlers = new HandlerRegistry()
    handlers.register("noop", noopHandler)
    const d = deps(handlers)
    const { id } = await d.jobs.enqueue({ type: "noop", payload: { fail: "boom" } })

    const summary = await drain(d, opts())

    expect(summary.failed).toBe(1)
    const row = d.jobs.rows.get(id)
    expect(row?.state).toBe("queued")
    expect(row?.attempts).toBe(1)
    // Pushed into the future, so the same drain does not immediately re-claim it
    // and spend all three attempts inside one run on one transient fault.
    expect(row?.runAfter.getTime()).toBeGreaterThan(Date.now())
  })

  it("gives up after maxAttempts and records the class, not the provider's text", async () => {
    const handlers = new HandlerRegistry()
    handlers.register("noop", noopHandler)
    const d = deps(handlers)
    const { id } = await d.jobs.enqueue({ type: "noop", payload: { fail: "boom" }, maxAttempts: 1 })

    await drain(d, opts())

    const row = d.jobs.rows.get(id)
    expect(row?.state).toBe("failed")
    // Not "internal: boom". `classify` replaces the thrown message with a fixed
    // kernel-authored one, because this column is read back by the API and
    // rendered in a browser out of a public repository — and a thrown Error can
    // quote a page, a URL, or a connection string.
    expect(row?.lastError).toBe("internal: unhandled kernel error")
    // The thrown text is kept, but only in the column nothing serves.
    expect(row?.lastCause).toContain("boom")
  })

  it("fails terminally when a claimable type has no handler behind it", async () => {
    // Only reachable when `types()` and `get()` disagree — the registry changing
    // under a running drain. `config` is not retryable (retry.ts): a runner that
    // shipped without the handler will not grow one before the next attempt, so
    // the row waits for a deploy, which is a thing a human does rather than a
    // thing a backoff fixes.
    const inconsistent: HandlerLookup = {
      types: () => ["harvest.run"],
      get: () => undefined,
    }
    const d = deps(inconsistent)
    const { id } = await d.jobs.enqueue({ type: "harvest.run" })

    await drain(d, opts())

    const row = d.jobs.rows.get(id)
    expect(row?.state).toBe("failed")
    expect(row?.lastError).toContain("no handler registered")
  })

  it("never claims work it has no handler for", async () => {
    const handlers = new HandlerRegistry()
    handlers.register("noop", noopHandler)
    const d = deps(handlers)
    await d.jobs.enqueue({ type: "harvest.run" })

    const summary = await drain(d, opts())

    expect(summary.claimed).toBe(0)
  })

  it("releases a claim on cancellation and gives the attempt back", async () => {
    // The SIGTERM path's cheapest half. A cancelled runner did not fail; charging
    // it an attempt would let three cancellations retire a job nobody ever tried,
    // and under ADR-0014 cancellation is routine.
    const controller = new AbortController()
    const handlers = new HandlerRegistry()
    // Aborts and then keeps awaiting, which is what SIGTERM does to a real
    // handler: the signal fires while it is mid-flight and its await rejects.
    const slow: JobHandler = async (ctx) => {
      setTimeout(() => controller.abort(), 0)
      await noopHandler({ ...ctx, job: { ...ctx.job, payload: { sleepMs: 5_000 } } })
    }
    handlers.register("noop", slow)
    const d = deps(handlers)
    const { id } = await d.jobs.enqueue({ type: "noop" })

    const summary = await drain(d, opts(controller.signal))

    expect(summary.stoppedBecause).toBe("cancelled")
    expect(summary.released).toBe(1)
    expect(summary.failed).toBe(0)
    const row = d.jobs.rows.get(id)
    expect(row?.state).toBe("queued")
    expect(row?.attempts).toBe(0)
    expect(row?.leaseUntil).toBeNull()
  })

  it("stops when its wall-clock budget is spent, before the workflow's own timeout", async () => {
    const handlers = new HandlerRegistry()
    handlers.register("noop", noopHandler)
    const d = deps(handlers)
    for (let i = 0; i < 5; i++) await d.jobs.enqueue({ type: "noop" })

    let t = 0
    const summary = await drain(d, { ...opts(), budgetMs: 100, clock: () => (t += 60) })

    expect(summary.stoppedBecause).toBe("budget")
    expect(summary.claimed).toBeLessThan(5)
  })

  it("deduplicates on the idempotency key so a double-click is one job", async () => {
    const d = deps(new HandlerRegistry())
    const first = await d.jobs.enqueue({ type: "noop", idempotencyKey: "trip-42" })
    const second = await d.jobs.enqueue({ type: "noop", idempotencyKey: "trip-42" })

    expect(second.id).toBe(first.id)
    expect(second.deduped).toBe(true)
    expect(d.jobs.rows.size).toBe(1)
  })
})
