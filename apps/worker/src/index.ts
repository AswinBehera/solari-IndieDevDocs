// @dt/worker — the scheduled runner (ADR-0014). Wakes, claims, drains, exits.
//
// All Solari sessions in this system are opened from this process and no other.

import { now } from "@samsara/kernel"
import { boot } from "./boot.js"
import { personaSweepJobKey } from "./persona-sweep.js"
import { probeSweepJobKey } from "./probe-sweep.js"
import { drain } from "./runner.js"
import { dayOf, sweepJobKey } from "./sweep.js"

export * from "./boot.js"
export * from "./handlers.js"
export * from "./packs.js"
export * from "./runner.js"

export const PACKAGE = "@dt/worker" as const

/**
 * The lifecycle, and specifically the shutdown path P0.5 exists to get right.
 *
 * GitHub cancels a workflow with SIGTERM and then waits a short, finite grace
 * period before SIGKILL. Three things must happen inside it, in this order, and
 * the order is the whole design:
 *
 * 1. **Stop taking new work.** The abort signal reaches the drain loop between
 *    jobs and the handlers inside them.
 * 2. **Close every live browser session.** Until this happens the provider is
 *    still billing minutes for sessions nobody is attached to — the single most
 *    expensive way to fail, against a $20 ceiling.
 * 3. **Give the claims back.** A released row is claimable by the next runner
 *    immediately and has not been charged an attempt; a row left leased waits out
 *    `leaseMs` first. Step 3 is last because it is the cheapest to lose: the lease
 *    expiry is a correct, if slower, fallback for it, and there is no fallback at
 *    all for step 2.
 *
 * The grace period is not ours to choose, so nothing here waits on anything it
 * does not have to. A second SIGTERM exits immediately — an operator sending it
 * twice means "now", and arguing with that is how a process becomes unkillable.
 */
export async function main(): Promise<number> {
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`
  const controller = new AbortController()
  const app = boot()

  let signalled = false
  const onSignal = (sig: NodeJS.Signals) => {
    if (signalled) process.exit(130)
    signalled = true
    app.logger.emit({
      at: now(),
      event: "attempt.failed",
      purpose: "agent",
      kind: "internal",
      message: `received ${sig}; draining stops and live sessions close`,
      attempts: 0,
    })
    controller.abort()
    // Step 2, started immediately rather than after the loop unwinds: a handler
    // may be awaiting something that will not settle inside the grace period, and
    // the sessions must not wait for it.
    void app.kernel.shutdown()
  }
  process.once("SIGTERM", onSignal)
  process.once("SIGINT", onSignal)

  try {
    // Rows the *previous* run left open. Under ADR-0014 a cancelled runner is
    // routine, so this is a normal startup step, not recovery.
    await app.registry.reconcile()
    // One sweep a day: the key is the UTC date, so the every-15-minute cron queues it
    // once and every later tick is a no-op. Opt-out, not opt-in, but `TRIP_SWEEP_MAX=0`
    // makes it queue nothing.
    await app.jobs.enqueue({
      type: "persona.sweep",
      idempotencyKey: personaSweepJobKey(dayOf(new Date())),
    })
    await app.jobs.enqueue({
      type: "probe.sweep",
      domainId: "travel",
      idempotencyKey: probeSweepJobKey(dayOf(new Date())),
    })
    await app.jobs.enqueue({
      type: "trip.sweep",
      domainId: "travel",
      idempotencyKey: sweepJobKey(dayOf(new Date())),
    })

    const summary = await drain(
      {
        jobs: app.jobs,
        kernel: app.kernel,
        packs: app.packs,
        handlers: app.handlers,
        logger: app.logger,
      },
      {
        runId,
        budgetMs: Number(process.env.WORKER_BUDGET_MS ?? 4 * 60_000),
        leaseMs: Number(process.env.WORKER_LEASE_MS ?? 5 * 60_000),
        batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 1),
        signal: controller.signal,
        idleDelayMs: Number(process.env.WORKER_IDLE_DELAY_MS ?? 250),
      },
    )

    // A cancelled drain is not a failed one. Exiting non-zero would paint the
    // Actions run red for doing exactly what it was asked to do, and a red run
    // nobody should act on is how real failures stop being noticed.
    return summary.failed > 0 ? 1 : 0
  } finally {
    // Removed explicitly, because `once` only unregisters a listener that actually
    // fired. `main()` is called repeatedly by `dev.ts` and by tests, and a handler
    // left behind per call is a leak that announces itself as a
    // MaxListenersExceededWarning on the eleventh drain.
    process.off("SIGTERM", onSignal)
    process.off("SIGINT", onSignal)
    if (!signalled) await app.kernel.shutdown()
    await app.close()
  }
}

// `import.meta.main` is Node 22's; this file is also imported by tests, which must
// not start a runner by importing it.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    })
}
