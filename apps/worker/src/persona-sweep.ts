import type { JobStore } from "@samsara/kernel/jobs"
import type { PersonaStore } from "@samsara/personas"
import type { JobHandler } from "./handlers.js"

/**
 * `persona.sweep` (P5.1): once a day, queue a keepalive for every healthy persona
 * that has not been seen alive lately.
 *
 * "Lately" is 36 to 72 hours, the plan's window, with the jitter derived from the
 * persona's id rather than a random draw: a keepalive at a fixed interval is a
 * pattern a site can learn, but a coin flip made inside a sweep that re-runs every
 * fifteen minutes would be re-flipped each time. A hash gives every persona its own
 * stable offset. Keyed by persona and UTC day, so a re-run queues nothing new.
 *
 * The pages come from here, not the engine: the engine cannot know what an identity
 * ordinarily reads without learning a vertical's vocabulary (`personas.ts`).
 */
export const KEEPALIVE_URLS = ["https://www.youtube.com/"]

const HOUR_MS = 3_600_000

/** 36 to 72 hours, stable per persona. */
export function keepaliveAfterMs(personaId: string): number {
  let h = 0
  for (const ch of personaId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (36 + (h % 37)) * HOUR_MS
}

export interface PersonaSweepDeps {
  personas: Pick<PersonaStore, "list">
  queue: Pick<JobStore, "enqueue">
  clock?: () => Date
}

export const personaSweepJobKey = (day: string): string => `persona.sweep:${day}`

export function createPersonaSweepHandler(deps: PersonaSweepDeps): JobHandler {
  return async (ctx) => {
    const now = (deps.clock ?? (() => new Date()))()
    const day = now.toISOString().slice(0, 10)
    let queued = 0
    const healthy = await deps.personas.list({ health: "healthy" })
    for (const p of healthy) {
      const idleMs = p.lastAliveAt
        ? now.getTime() - p.lastAliveAt.getTime()
        : Number.POSITIVE_INFINITY
      if (idleMs < keepaliveAfterMs(p.id)) continue
      const r = await deps.queue.enqueue({
        type: "persona.keepalive",
        payload: { personaId: p.id, urls: KEEPALIVE_URLS },
        idempotencyKey: `persona.keepalive:${p.id}:${day}`,
      })
      if (!r.deduped) queued++
    }
    await ctx.heartbeat(`${queued} keepalive(s) queued for ${healthy.length} healthy persona(s)`)
  }
}
