import type { JobStore } from "@samsara/kernel/jobs"
import type { ProbeTargetStore } from "@samsara/probe"
import type { JobHandler } from "./handlers.js"
import { probeJobKey } from "./probe.js"

/**
 * `probe.sweep` (P3.5): once a day, queue a `probe.run` for every watched target.
 *
 * Like `trip.sweep` it queues and spends nothing itself; each probe is an ordinary
 * `probe.run`, so the budget guard and the per-run fan-out apply. Capped per day
 * because a watched target is seven billed sessions: at the default of five that is
 * about thirty-five sessions, roughly twenty minutes of the ceiling's four thousand.
 * Keyed by target and UTC day, so a re-run of the sweep queues nothing new.
 *
 * What it does *not* do is notice a price drop. That needs somewhere to write the
 * notice, and the notification table (P5.3) is not built; the observations are
 * kept, so a drop is computable the day it is.
 */
export const probeSweepJobKey = (day: string): string => `probe.sweep:${day}`

export interface ProbeSweepDeps {
  targets: Pick<ProbeTargetStore, "listWatched">
  queue: Pick<JobStore, "enqueue">
  maxTargets?: number
  clock?: () => Date
}

export function createProbeSweepHandler(deps: ProbeSweepDeps): JobHandler {
  return async (ctx) => {
    const day = (deps.clock ?? (() => new Date()))().toISOString().slice(0, 10)
    const watched = (await deps.targets.listWatched()).slice(0, deps.maxTargets ?? 5)
    let queued = 0
    for (const t of watched) {
      const r = await deps.queue.enqueue({
        type: "probe.run",
        domainId: "travel",
        ownerId: t.ownerId,
        payload: { targetId: t.id },
        idempotencyKey: probeJobKey(t.id, day),
      })
      if (!r.deduped) queued++
    }
    await ctx.heartbeat(`${queued} probe(s) queued for ${watched.length} watched target(s)`)
  }
}
