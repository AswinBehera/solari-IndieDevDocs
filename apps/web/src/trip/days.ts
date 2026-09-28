import { POSTCARD_ATTR, POSTCARD_NODE, type Postcard } from "@dt/core"

/**
 * Which day of the trip something belongs to — the timeline's whole question
 * (P4.5), and the "SUN 15" beside a "Day 2" heading.
 *
 * Two sources, in order of authority:
 *
 * 1. **The card's own time.** Set by a photo's EXIF or by dragging it on the
 *    timeline, and stored on the Postcard. It wins, because someone decided it.
 * 2. **The heading it sits under.** A card written under "Day 2" is on day two of
 *    the trip. Derived, never stored, and shown as derived: it moves when the
 *    text above it does, which is what writing a plan in a document means.
 *
 * Anything else is unscheduled, which is a real answer and not a gap.
 * Every date here is a UTC calendar day, like the trip's own dates.
 */

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
const DAY_MS = 86_400_000

/** "Day 2", "day 2 — Ari", "DAY 12:" → 2 or 12. Anything else → null. */
export function dayNumber(heading: string): number | null {
  const m = heading.trim().match(/^day\s+(\d{1,2})\b/i)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 ? n : null
}

/** Midnight UTC of a date's calendar day. */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

export function nthDay(start: Date, n: number): Date {
  return new Date(utcDay(start).getTime() + (n - 1) * DAY_MS)
}

/** "SUN 15" for "Day 2" of a trip starting Saturday the 14th; null without dates. */
export function dayLabel(heading: string, start: Date | null): string | null {
  const n = dayNumber(heading)
  if (n === null || !start) return null
  const d = nthDay(start, n)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`
}

/** "SAT 14 NOV" — a timeline group's heading. */
export function dayHeading(d: Date): string {
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

export interface Placed {
  id: string
  /** Midnight UTC of the day, or null for unscheduled. */
  day: Date | null
  /** True when the day came from a heading rather than the card's own time. */
  derived: boolean
}

interface DocNode {
  type?: unknown
  attrs?: Record<string, unknown>
  content?: unknown
  text?: unknown
}

const textOf = (node: DocNode): string => {
  if (typeof node.text === "string") return node.text
  return Array.isArray(node.content) ? node.content.map((c) => textOf(c as DocNode)).join("") : ""
}

/** Every referenced card, in document order, with the day it belongs to. */
export function placeCards(
  doc: unknown,
  cards: ReadonlyMap<string, Pick<Postcard, "time">>,
  start: Date | null,
): Placed[] {
  const out: Placed[] = []
  const seen = new Set<string>()
  let heading: number | null = null
  const walk = (node: DocNode) => {
    if (node.type === "heading") {
      heading = dayNumber(textOf(node))
      return
    }
    if (node.type === POSTCARD_NODE) {
      const id = node.attrs?.[POSTCARD_ATTR]
      if (typeof id !== "string" || seen.has(id)) return
      seen.add(id)
      const card = cards.get(id)
      if (!card) return
      if (card.time) out.push({ id, day: utcDay(card.time.start), derived: false })
      else if (heading !== null && start)
        out.push({ id, day: nthDay(start, heading), derived: true })
      else out.push({ id, day: null, derived: false })
      return
    }
    if (Array.isArray(node.content)) for (const child of node.content) walk(child as DocNode)
  }
  walk(doc as DocNode)
  return out
}

export interface DayGroup {
  /** Null is the "unscheduled" group, which always comes last. */
  day: Date | null
  items: Placed[]
}

/** Grouped by day, earliest first, document order within a day. */
export function groupByDay(placed: readonly Placed[]): DayGroup[] {
  const groups = new Map<number | null, Placed[]>()
  for (const p of placed) {
    const key = p.day ? p.day.getTime() : null
    const list = groups.get(key) ?? []
    list.push(p)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([key, items]) => ({ day: key === null ? null : new Date(key), items }))
}

/** The trip's days, first to last, so an empty day still has somewhere to drop onto. */
export function tripDays(start: Date | null, end: Date | null): Date[] {
  if (!start || !end || end < start) return start ? [utcDay(start)] : []
  const days: Date[] = []
  for (
    let t = utcDay(start).getTime();
    t <= utcDay(end).getTime() && days.length < 60;
    t += DAY_MS
  ) {
    days.push(new Date(t))
  }
  return days
}
