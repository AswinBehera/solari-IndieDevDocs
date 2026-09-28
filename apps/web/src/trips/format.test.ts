import { describe, expect, it } from "vitest"
import { ago, dateRange, dayCount, spokenList, statusTag, tripLine, tripTitle } from "./format"

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

describe("dateRange", () => {
  it("names the month once when both ends share it", () => {
    expect(dateRange(day("2026-11-14"), day("2026-11-17"))).toBe("14 → 17 NOV 2026")
  })

  it("names both months across a month boundary", () => {
    expect(dateRange(day("2026-11-28"), day("2026-12-02"))).toBe("28 NOV → 2 DEC 2026")
  })

  it("names both years across new year", () => {
    expect(dateRange(day("2026-12-30"), day("2027-01-02"))).toBe("30 DEC 2026 → 2 JAN 2027")
  })

  it("says so when there are no dates, or only a start", () => {
    expect(dateRange(null, null)).toBe("NO DATES YET")
    expect(dateRange(day("2026-11-14"), null)).toBe("FROM 14 NOV 2026")
  })

  it("reads a day in UTC, so the 14th is the 14th everywhere", () => {
    // Midnight UTC is still the 13th in New York; the trip is not.
    expect(dateRange(day("2026-11-14"), day("2026-11-14"))).toBe("14 NOV 2026")
  })
})

describe("tripTitle", () => {
  it("counts days on the ground, inclusively, in words", () => {
    expect(dayCount(day("2026-11-14"), day("2026-11-17"))).toBe(4)
    expect(tripTitle("Bangkok", day("2026-11-14"), day("2026-11-17"))).toBe("Four days in Bangkok.")
  })

  it("has a sentence for one day and a number past ten", () => {
    expect(tripTitle("Bangkok", day("2026-11-14"), day("2026-11-14"))).toBe("A day in Bangkok.")
    expect(tripTitle("Tokyo", day("2026-11-01"), day("2026-11-14"))).toBe("14 days in Tokyo.")
  })

  it("calls a trip with no dates undated, as the canvas does", () => {
    expect(tripTitle("Tokyo", null, null)).toBe("Tokyo, undated.")
    // An end before the start is not a trip length.
    expect(tripTitle("Tokyo", day("2026-11-17"), day("2026-11-14"))).toBe("Tokyo, undated.")
  })
})

describe("spokenList", () => {
  it("joins with commas and a final and", () => {
    expect(spokenList(["food", "markets", "coffee"])).toBe("food, markets and coffee")
    expect(spokenList(["food", "markets"])).toBe("food and markets")
    expect(spokenList(["food"])).toBe("food")
    expect(spokenList([])).toBe("")
  })
})

describe("statusTag", () => {
  it("labels every status the schema has", () => {
    for (const s of ["dreaming", "planning", "travelling", "done"] as const) {
      expect(statusTag(s).label).toBe(s.toUpperCase())
    }
  })
})

describe("tripLine and ago", () => {
  const now = new Date("2026-09-28T12:00:00Z")

  it("says a dateless trip is waiting, rather than claiming work nobody does", () => {
    expect(tripLine(null, now, now)).toBe("Waiting for dates")
  })

  it("says how long since a dated trip was touched", () => {
    expect(tripLine(day("2026-11-14"), new Date("2026-09-28T09:00:00Z"), now)).toBe(
      "Edited 3 h ago",
    )
  })

  it("steps from minutes to hours to days", () => {
    expect(ago(new Date("2026-09-28T11:59:40Z"), now)).toBe("just now")
    expect(ago(new Date("2026-09-28T11:48:00Z"), now)).toBe("12 min ago")
    expect(ago(new Date("2026-09-27T12:00:00Z"), now)).toBe("yesterday")
    expect(ago(new Date("2026-09-24T12:00:00Z"), now)).toBe("4 days ago")
  })
})
