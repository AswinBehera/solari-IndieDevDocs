import { documentText } from "@dt/core"
import type { TripStore } from "@dt/db/trips"
import type { LlmClient } from "@samsara/llm"
import { definePrompt } from "@samsara/llm"
import { z } from "zod"
import type { JobHandler } from "./handlers.js"

/**
 * `trip.intent` (P4.3): the dates a traveller wrote in prose, copied onto the Trip.
 *
 * **Non-destructive by construction.** It fills a date only where the Trip's own
 * field is empty, and it never touches the city, which is required at creation and
 * therefore always something the traveller chose. A date they typed into the
 * header stays theirs. The cost is that clearing a date on purpose lets the next
 * pass refill it from the prose; the alternative, remembering an override, needs a
 * column nothing else wants yet.
 *
 * **Interests have no column.** Onboarding writes them into the document's first
 * line (STATUS, P6.1), so they already live where the traveller can edit them.
 *
 * **Skips before spending.** A trip with both dates set, or with no prose, never
 * reaches the model.
 *
 * Scoped to an owner in the payload because the store is: a job that named only a
 * trip id would be a way to read anyone's document.
 */

export const intentJobKey = (tripId: string, window: string): string =>
  `trip.intent:${tripId}:${window}`

/** An hour: the API windows its key by this, so a burst of autosaves is one job. */
export const INTENT_WINDOW_MS = 60 * 60 * 1000

export const intentWindow = (at: Date): string =>
  String(Math.floor(at.getTime() / INTENT_WINDOW_MS))

export interface IntentPayload {
  tripId: string
  ownerId: string
}

function parsePayload(raw: unknown): IntentPayload {
  const p = (raw ?? {}) as Partial<IntentPayload>
  for (const key of ["tripId", "ownerId"] as const) {
    if (typeof p[key] !== "string" || (p[key] as string).trim().length === 0) {
      throw new Error(`trip.intent: payload.${key} must be a non-empty string`)
    }
  }
  return { tripId: p.tripId as string, ownerId: p.ownerId as string }
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const answer = z.object({ startDate: isoDay.nullable(), endDate: isoDay.nullable() })

const prompt = definePrompt({
  id: "travel/trip.intent",
  version: "1",
  system:
    "You read a traveller's trip notes and report only the dates they state. " +
    'Reply with JSON: {"startDate": "YYYY-MM-DD" or null, "endDate": "YYYY-MM-DD" or null}. ' +
    "Use null for anything not stated. Never guess: a month with no day is null. " +
    "If a date has no year, use the next occurrence on or after today's date.",
  template: "Today is {{today}}.\n\nNotes:\n{{notes}}",
})

/** A calendar day as midnight UTC, the way trip dates are stored (HANDOFF decision 6). */
const day = (iso: string): Date | null => {
  const d = new Date(`${iso}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : d
}

export interface IntentHandlerDeps {
  trips: Pick<TripStore, "get" | "update">
  /** Absent when the runner booted without `OPENROUTER_API_KEY`; the handler then refuses by name. */
  llm?: LlmClient | undefined
  clock?: () => Date
}

/** The prose sent to the model is capped: a trip note is short, and tokens are metered. */
const MAX_NOTES_CHARS = 6_000

export function createIntentHandler(deps: IntentHandlerDeps): JobHandler {
  return async (ctx) => {
    const { tripId, ownerId } = parsePayload(ctx.job.payload)
    if (!deps.llm) {
      throw new Error("trip.intent: no LLM configured (OPENROUTER_API_KEY is not set)")
    }
    const record = await deps.trips.get(ownerId, tripId)
    if (!record) {
      await ctx.heartbeat("trip is gone, nothing to do")
      return
    }
    const { startDate, endDate } = record.trip
    if (startDate && endDate) return
    const notes = documentText(record.document.content).slice(0, MAX_NOTES_CHARS)
    if (notes.trim().length === 0) return

    const now = (deps.clock ?? (() => new Date()))()
    const result = await deps.llm.complete(prompt, answer, {
      task: "extract",
      vars: { today: now.toISOString().slice(0, 10), notes },
      maxOutputTokens: 100,
      scope: { ownerId, purpose: "trip.intent", runId: tripId },
      domainId: "travel",
      signal: ctx.signal,
    })
    if (!result.ok) throw new Error(`trip.intent: ${result.error.message}`)

    const said = result.value.value
    const start = startDate ?? (said.startDate ? day(said.startDate) : null)
    const end = endDate ?? (said.endDate ? day(said.endDate) : null)
    // A range that runs backwards is a misread, and half a misread is worse than none.
    if (start && end && end < start) return
    const patch: { startDate?: Date; endDate?: Date } = {}
    if (!startDate && start) patch.startDate = start
    if (!endDate && end) patch.endDate = end
    if (Object.keys(patch).length === 0) return
    await deps.trips.update(ownerId, tripId, patch)
    await ctx.heartbeat(`filled ${Object.keys(patch).join(", ")}`)
  }
}
