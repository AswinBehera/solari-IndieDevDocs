import { describe, expect, it } from "vitest"
import { fromWire, type PlacesResponse } from "./queries"

const wire = (id: string, quoted: boolean): PlacesResponse["places"][number] => ({
  place: {
    id,
    canonicalName: "Rung Rueang Pork Noodle",
    localName: "ก๋วยเตี๋ยวหมูรุ่งเรือง",
    city: "Bangkok",
    geo: { lat: 13.7304, lng: 100.5707 },
    externalRef: { source: "osm", id: "node/1" },
    resolvedTier: 1,
    category: "food",
    tags: [],
    scores: {},
    firstSeenAt: "2026-09-20T01:02:03.456Z",
    lastSeenAt: "2026-09-21T00:00:00.000Z",
    evidenceCount: 2,
    createdAt: "2026-09-20T01:02:03.456Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  },
  evidence: quoted
    ? {
        quote: "อร่อยมาก",
        sourceId: "pantip.forum",
        sourceUrl: "https://pantip.com/topic/1",
        language: "th",
      }
    : null,
})

describe("fromWire", () => {
  it("turns every timestamp back into a Date, to the millisecond", () => {
    const { places } = fromWire({ places: [wire("a", true)] })
    const [place] = places
    expect(place?.firstSeenAt).toBeInstanceOf(Date)
    expect(place?.firstSeenAt.toISOString()).toBe("2026-09-20T01:02:03.456Z")
    expect(place?.lastSeenAt).toBeInstanceOf(Date)
    expect(place?.createdAt).toBeInstanceOf(Date)
    expect(place?.updatedAt).toBeInstanceOf(Date)
  })

  it("keys each quote by its place and leaves an unquoted place out", () => {
    const { evidence } = fromWire({ places: [wire("a", true), wire("b", false)] })
    expect(Object.keys(evidence)).toEqual(["a"])
    expect(evidence.a?.quote).toBe("อร่อยมาก")
  })

  it("carries the summary through, or null from an API that sends none", () => {
    const summary = { total: 9, withGeo: 8, strong: 7 }
    expect(fromWire({ places: [], summary }).summary).toEqual(summary)
    expect(fromWire({ places: [] }).summary).toBeNull()
  })

  it("keeps the order it was given, which the grid re-sorts anyway", () => {
    const { places } = fromWire({ places: [wire("b", false), wire("a", true)] })
    expect(places.map((p) => p.id)).toEqual(["b", "a"])
  })
})
