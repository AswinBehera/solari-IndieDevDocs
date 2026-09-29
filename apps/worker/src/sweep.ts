import { documentText } from "@dt/core"
import type { TripStore } from "@dt/db/trips"
import type { JobStore } from "@samsara/kernel/jobs"
import type { PersonaStore } from "@samsara/personas"
import type { JobHandler } from "./handlers.js"

/**
 * `trip.sweep` (P5.2): once a day, queue a harvest for each trip being planned.
 *
 * **It queues; it does not harvest.** Each trip becomes an ordinary `harvest.run`
 * job, so the budget guard, the pacer, the persona's health and the refine chain
 * all apply exactly as they do to a hand-queued harvest. This job spends nothing.
 *
 * **Bounded three ways.** At most `maxTrips` trips a day (oldest-updated first, so a
 * long list is worked through over several nights rather than starved); one harvest
 * per trip per day by idempotency key, so a re-run of the sweep is a no-op; and only
 * cities the pipeline covers, because harvesting Tokyo before its extract is loaded
 * would bill minutes for nothing the chain can resolve (HANDOFF decision 13).
 *
 * **The query is the traveller's own first line.** Interests live in the document
 * as prose (onboarding writes them there), so the query is the city plus that line,
 * capped. It is a crude reading and says so: a smarter one is `trip.intent`'s job.
 */

/** Cities the pipeline can resolve today. Lower-case; matched as a substring of the trip's city. */
export const SWEEP_CITIES = ["bangkok"] as const

/** Source a sweep harvests from: the one whose surface is search-by-query. */
export const SWEEP_SOURCE = "youtube.search"

const MAX_QUERY_CHARS = 80

export const sweepJobKey = (day: string): string => `trip.sweep:${day}`
export const sweepHarvestKey = (tripId: string, day: string): string =>
  `trip.sweep.harvest:${tripId}:${day}`

export const dayOf = (at: Date): string => at.toISOString().slice(0, 10)

/** City plus the document's first line of prose, capped. Null when the city is not covered. */
export function sweepQuery(city: string, firstLine: string): string | null {
  const lower = city.toLowerCase()
  if (!SWEEP_CITIES.some((c) => lower.includes(c))) return null
  return `${city.trim()} ${firstLine.trim()}`.trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_CHARS)
}

export interface SweepDeps {
  trips: Pick<TripStore, "listByStatus" | "get">
  personas: Pick<PersonaStore, "list">
  queue: Pick<JobStore, "enqueue">
  maxTrips?: number
  clock?: () => Date
}

export function createSweepHandler(deps: SweepDeps): JobHandler {
  return async (ctx) => {
    const day = dayOf((deps.clock ?? (() => new Date()))())
    const persona = (await deps.personas.list({ health: "healthy" }))[0]
    if (!persona) {
      await ctx.heartbeat("no healthy persona, nothing queued")
      return
    }
    const planning = await deps.trips.listByStatus("planning", deps.maxTrips ?? 3)
    let queued = 0
    for (const trip of planning) {
      const record = await deps.trips.get(trip.userId, trip.id)
      const firstLine = documentText(record?.document.content).split("\n")[0] ?? ""
      const query = sweepQuery(trip.destinationCity, firstLine)
      if (!query) continue
      const result = await deps.queue.enqueue({
        type: "harvest.run",
        domainId: "travel",
        ownerId: trip.userId,
        payload: { personaId: persona.id, sourceId: SWEEP_SOURCE, query, domainId: "travel" },
        idempotencyKey: sweepHarvestKey(trip.id, day),
      })
      if (!result.deduped) queued++
    }
    await ctx.heartbeat(`${queued} harvest(s) queued for ${planning.length} planning trip(s)`)
  }
}
