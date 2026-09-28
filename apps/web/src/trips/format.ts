import type { TripStatus } from "@dt/core"

/**
 * The words a trip is shown in, as plain functions so they can be held by tests.
 *
 * **Trip dates are calendar days, and they are read in UTC.** The API stores a
 * day as midnight UTC; reading it in the browser's zone would show the 14th as
 * the 13th to anyone west of Greenwich. Every function here formats with
 * `timeZone: "UTC"` for that reason and no other.
 */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

const parts = (d: Date) => ({
  day: d.getUTCDate(),
  month: MONTHS[d.getUTCMonth()] as string,
  year: d.getUTCFullYear(),
})

/** "14 → 17 NOV 2026", widening only as far as the two ends actually differ. */
export function dateRange(start: Date | null, end: Date | null): string {
  if (!start) return "NO DATES YET"
  const a = parts(start)
  if (!end) return `FROM ${a.day} ${a.month} ${a.year}`
  const b = parts(end)
  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year} → ${b.day} ${b.month} ${b.year}`
  if (a.month !== b.month) return `${a.day} ${a.month} → ${b.day} ${b.month} ${b.year}`
  if (a.day === b.day) return `${a.day} ${a.month} ${a.year}`
  return `${a.day} → ${b.day} ${b.month} ${b.year}`
}

/** Inclusive: the 14th to the 17th is four days on the ground. */
export function dayCount(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
}

const NUMBERS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]

/**
 * The title a new trip starts with, in the canvas's voice: "Four days in Bangkok."
 * or "Tokyo, undated." It is the first line of the document and meant to be
 * rewritten; its job is to be a sentence rather than a slug.
 */
export function tripTitle(city: string, start: Date | null, end: Date | null): string {
  if (!start || !end || end < start) return `${city}, undated.`
  const n = dayCount(start, end)
  if (n === 1) return `A day in ${city}.`
  const word = NUMBERS[n]
  return word ? `${word} days in ${city}.` : `${n} days in ${city}.`
}

/** "food, markets and coffee" — the list a person would say out loud. */
export function spokenList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

export interface StatusTag {
  label: string
  /** Utility classes for the tag's border and ink. */
  className: string
}

/**
 * The tag on a trip card. The real status, not the canvas's "DRAFT" and
 * "SHARED": the first is not a status the schema has and the second is a fact
 * about a link, not about where the traveller is.
 */
export function statusTag(status: TripStatus): StatusTag {
  switch (status) {
    case "planning":
      return { label: "PLANNING", className: "border-accent-pink text-accent-pink" }
    case "travelling":
      return { label: "TRAVELLING", className: "border-accent-blue text-accent-blue" }
    case "done":
      return { label: "DONE", className: "border-accent-gold text-accent-gold" }
    default:
      return { label: "DREAMING", className: "border-rule text-ink-faint" }
  }
}

/**
 * The line at the foot of a trip card, which on the canvas is what the OS is
 * doing for the trip. Nothing runs on a trip's behalf yet (P5.2), so it says
 * what is true instead: how long since it was touched, or what it is waiting for.
 */
export function tripLine(start: Date | null, updatedAt: Date, now: Date): string {
  if (!start) return "Waiting for dates"
  return `Edited ${ago(updatedAt, now)}`
}

export function ago(then: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? "yesterday" : `${days} days ago`
}
