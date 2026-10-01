import { z } from "zod"
import { id, timestamps } from "./primitives.js"

/**
 * The budget guard's state, as stored. Ceilings
 * expressed as counts rather than dollars, counters living in Postgres because a
 * guard that forgets what it spent when a runner exits is not a guard (ADR-0014).
 */

/**
 * What is being counted. One meter today: Solari minutes, browser and sandbox alike.
 *
 * Ceilings are not stored here. They are constants in `@samsara/kernel`, each with
 * the rate it was derived from in a comment beside it.
 */
export const meterId = z.enum(["solari.minutes"])
export type MeterId = z.infer<typeof meterId>

/**
 * Which slice of spend a counter covers. The three windows:
 *
 * - `global.day`  — everything the system spent today. The ceiling that matters.
 * - `owner.day`   — one caller's spend today, so one caller cannot exhaust the rest.
 * - `purpose.run` — one unit of work, so a runaway loop is caught inside a run
 *                   rather than at the end of a day.
 * - `global.total` — everything ever spent. The day windows reset at midnight; a
 *                   prepaid balance does not, so this is the one that protects it.
 */
export const budgetWindow = z.enum(["global.day", "owner.day", "purpose.run", "global.total"])
export type BudgetWindow = z.infer<typeof budgetWindow>

/**
 * One counter. Unique on `(meter, window, windowKey)`.
 *
 * `windowKey` is the value the window is sliced by, already rendered to a string:
 * an ISO date for `global.day`, `<ownerId>:<date>` for `owner.day`, and
 * `<purpose>:<runId>` for `purpose.run`. It is a string rather than a set of
 * nullable columns because the engine only ever looks a counter up by exact key.
 */
export const budgetCounter = z
  .object({
    id,
    meter: meterId,
    window: budgetWindow,
    windowKey: z.string().min(1),
    amount: z.number().nonnegative(),
  })
  .extend(timestamps.shape)
export type BudgetCounter = z.infer<typeof budgetCounter>
