import { describe, expect, it } from "vitest"
import { dayHeading, dayLabel, dayNumber, groupByDay, placeCards, tripDays } from "./days"

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const START = day("2026-11-14") // a Saturday

const h = (text: string) => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
})
const card = (id: string) => ({ type: "postcard", attrs: { postcardId: id } })

describe("dayNumber and dayLabel", () => {
  it("reads the day out of a heading however it is written", () => {
    expect(dayNumber("Day 2")).toBe(2)
    expect(dayNumber("day 12 — Yaowarat")).toBe(12)
    expect(dayNumber("Dayton")).toBeNull()
    expect(dayNumber("Day 0")).toBeNull()
    expect(dayNumber("The last day")).toBeNull()
  })

  it("labels a day heading with its date, as the canvas does", () => {
    expect(dayLabel("Day 1", START)).toBe("SAT 14")
    expect(dayLabel("Day 2", START)).toBe("SUN 15")
    expect(dayLabel("Day 2", null)).toBeNull()
    expect(dayHeading(day("2026-11-15"))).toBe("SUN 15 NOV")
  })
})

describe("placeCards", () => {
  const doc = {
    type: "doc",
    content: [
      card("before"),
      h("Day 1"),
      card("a"),
      h("Day 2"),
      card("b"),
      card("timed"),
      h("Notes"),
      card("after"),
    ],
  }
  const cards = new Map([
    ["before", { time: null }],
    ["a", { time: null }],
    ["b", { time: null }],
    ["timed", { time: { start: new Date("2026-11-16T09:00:00Z"), end: null } }],
    ["after", { time: null }],
  ])

  it("puts a card under the day heading above it, and says it was derived", () => {
    const placed = placeCards(doc, cards, START)
    expect(placed.find((p) => p.id === "a")).toEqual({
      id: "a",
      day: day("2026-11-14"),
      derived: true,
    })
    expect(placed.find((p) => p.id === "b")?.day).toEqual(day("2026-11-15"))
  })

  it("lets a card's own time win over the heading it sits under", () => {
    const placed = placeCards(doc, cards, START)
    expect(placed.find((p) => p.id === "timed")).toEqual({
      id: "timed",
      day: day("2026-11-16"),
      derived: false,
    })
  })

  it("leaves a card unscheduled before any day heading or after a heading that is not one", () => {
    const placed = placeCards(doc, cards, START)
    expect(placed.find((p) => p.id === "before")?.day).toBeNull()
    expect(placed.find((p) => p.id === "after")?.day).toBeNull()
  })

  it("schedules nothing from headings when the trip has no dates", () => {
    expect(
      placeCards(doc, cards, null)
        .filter((p) => p.day !== null)
        .map((p) => p.id),
    ).toEqual(["timed"])
  })

  it("skips a reference whose card is not loaded", () => {
    expect(placeCards({ type: "doc", content: [card("ghost")] }, cards, START)).toEqual([])
  })
})

describe("groupByDay and tripDays", () => {
  it("groups earliest first with the unscheduled last", () => {
    const groups = groupByDay([
      { id: "x", day: null, derived: false },
      { id: "b", day: day("2026-11-15"), derived: true },
      { id: "a", day: day("2026-11-14"), derived: true },
    ])
    expect(groups.map((g) => g.day?.toISOString() ?? null)).toEqual([
      day("2026-11-14").toISOString(),
      day("2026-11-15").toISOString(),
      null,
    ])
  })

  it("lists every day of the trip, inclusively", () => {
    expect(tripDays(START, day("2026-11-17")).map((d) => d.getUTCDate())).toEqual([14, 15, 16, 17])
    expect(tripDays(null, null)).toEqual([])
  })
})
