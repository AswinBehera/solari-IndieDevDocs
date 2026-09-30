import { dayToIso, type NewTripInput } from "../trips/api"
import { spokenList, tripTitle } from "../trips/format"

/**
 * The three answers, turned into the trip they describe (P6.1).
 *
 * A plain function so a test can hold it. The interests have no column on
 * `trips`, and deliberately so: they go into the document as its first line, in
 * the traveller's own sentence, because the document is the product (§6.1) and
 * P4.3's intent parsing reads prose — a column would be a second place the same
 * fact lives, and the two would drift the first time somebody edited the line.
 */

/** The cities onboarding offers. */
export const CITIES = ["Bangkok", "Tokyo"] as const

export interface Answers {
  city: string
  /** `YYYY-MM-DD`, from a date input, or null for "not sure yet". */
  start: string | null
  end: string | null
  interests: readonly string[]
}

/** The one date problem that is the last day's fault, so its input is the one marked. */
export const DATE_ORDER = "The last day is before the first day."

/**
 * What is wrong with the dates, in the traveller's words, or null.
 *
 * Said before the trip is made rather than quietly repaired after: `newTripFrom`
 * drops an end that cannot be one, and a trip that silently came out "undated"
 * after someone typed two dates reads as the app losing them.
 */
export function dateProblem(a: Pick<Answers, "start" | "end">, today: string): string | null {
  if (a.end && !a.start) return "Add a first day too, or clear the last one."
  if (a.start && a.start < today) return "That first day has already passed."
  if (a.start && a.end && a.end < a.start) return DATE_ORDER
  return null
}

export function newTripFrom(a: Answers): NewTripInput {
  const start = a.start ? dayToIso(a.start) : null
  // An end without a start, or before it, is not a range the trip can have.
  const end = start && a.end && a.end >= (a.start as string) ? dayToIso(a.end) : null
  const title = tripTitle(a.city, start ? new Date(start) : null, end ? new Date(end) : null)
  const firstLine = a.interests.length > 0 ? `I care about ${spokenList(a.interests)}.` : null
  return {
    title,
    destinationCity: a.city,
    startDate: start,
    endDate: end,
    // Dates are what turn a daydream into a plan; the schema says so too.
    status: start ? "planning" : "dreaming",
    content: {
      type: "doc",
      content: [
        firstLine
          ? { type: "paragraph", content: [{ type: "text", text: firstLine }] }
          : { type: "paragraph" },
      ],
    },
  }
}
