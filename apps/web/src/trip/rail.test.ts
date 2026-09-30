import { describe, expect, it } from "vitest"
import { boundsOf, clusterPoints } from "./cluster"
import { cardTitle, clockOf } from "./labels"

describe("clusterPoints", () => {
  it("draws pins within the radius as one, and far ones apart", () => {
    const clusters = clusterPoints(
      [
        { id: "a", x: 100, y: 100 },
        { id: "b", x: 110, y: 104 },
        { id: "c", x: 300, y: 300 },
      ],
      28,
    )
    expect(clusters.map((c) => c.ids)).toEqual([["a", "b"], ["c"]])
    // A cluster sits on its first member, so a lone pin is exactly on its place.
    expect(clusters[1]).toMatchObject({ x: 300, y: 300 })
  })

  it("has nothing to draw for no pins", () => {
    expect(clusterPoints([])).toEqual([])
  })
})

describe("boundsOf", () => {
  it("gives a single pin a box with some size", () => {
    const b = boundsOf([{ lat: 13.73, lng: 100.51 }])
    expect(b).not.toBeNull()
    const [[w, s], [e, n]] = b as [[number, number], [number, number]]
    expect(e - w).toBeGreaterThan(0)
    expect(n - s).toBeGreaterThan(0)
  })

  it("has no box for no pins", () => {
    expect(boundsOf([])).toBeNull()
  })
})

describe("cardTitle", () => {
  const place = {
    place: {
      id: "p1",
      canonicalName: "Jok Prince",
      localName: "โจ๊กปรินซ์",
      city: "Bangkok",
      geo: null,
      externalRef: null,
      resolvedTier: null,
      category: "food",
      tags: [],
      scores: {},
      firstSeenAt: "2026-09-20T00:00:00Z",
      lastSeenAt: "2026-09-20T00:00:00Z",
      evidenceCount: 0,
      createdAt: "2026-09-20T00:00:00Z",
      updatedAt: "2026-09-20T00:00:00Z",
    },
    evidence: null,
    readAt: "2026-09-28T00:00:00Z",
  }

  it("names a place by its roman name, for a small rail read while orienting", () => {
    expect(cardTitle({ kind: "place", payload: place })).toBe("Jok Prince")
  })

  it("names a note by its first line, cut short", () => {
    expect(cardTitle({ kind: "note", payload: { text: "Cash only\nclosed Mondays" } })).toBe(
      "Cash only",
    )
    expect(cardTitle({ kind: "note", payload: { text: "x".repeat(60) } })).toHaveLength(40)
    expect(cardTitle({ kind: "note", payload: {} })).toBe("Note")
  })

  it("names a link by its site and a price card by how many sites it compares", () => {
    expect(cardTitle({ kind: "link", payload: { url: "https://www.tiktok.com/@x/video/1" } })).toBe(
      "Link · tiktok.com",
    )
    const offers = [{ url: "https://www.agoda.com/h" }, { url: "https://www.booking.com/h" }]
    expect(cardTitle({ kind: "price", payload: { offers } })).toBe("Prices · 2 sites")
    // A card saved before offers existed is one site.
    expect(cardTitle({ kind: "price", payload: { url: "https://www.agoda.com/h" } })).toBe(
      "Prices · 1 site",
    )
  })

  it("counts a checklist", () => {
    expect(cardTitle({ kind: "checklist", payload: { items: [{ text: "a", done: true }] } })).toBe(
      "Checklist · 1 OF 1",
    )
  })
})

describe("clockOf", () => {
  it("shows a time of day and hides a bare date", () => {
    expect(clockOf({ time: { start: new Date("2026-11-15T09:40:00Z"), end: null } })).toBe("09:40")
    expect(clockOf({ time: { start: new Date("2026-11-15T00:00:00Z"), end: null } })).toBe("")
    expect(clockOf({ time: null })).toBe("")
  })
})
