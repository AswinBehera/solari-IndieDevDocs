import type { Place } from "@dt/core"
import { placeFixture } from "@dt/core/fixtures"
import { describe, expect, it } from "vitest"
import { byLocalScore, locate, meters, names, provenance } from "./place-card.js"

/**
 * These are the card's opinions, written down so they can be disagreed with.
 *
 * Not coverage of every branch: each test below is a decision someone could
 * reasonably have made the other way, and the assertion is the record of which
 * way it went and why.
 */

const place = (over: Partial<Place> = {}): Place => ({ ...placeFixture, ...over })

/** Bangkok, wide enough for Nonthaburi and Samut Prakan — as `tier0.ts` draws it. */
const BANGKOK: readonly [number, number, number, number] = [100.3, 13.5, 100.95, 14.0]

describe("names", () => {
  it("leads with the Thai spelling, not the romanisation", () => {
    const pair = names(place({ localName: "เจ๊ไฝ", canonicalName: "Jay Fai" }))
    expect(pair).toEqual({ primary: "เจ๊ไฝ", secondary: "Jay Fai", primaryIsLocal: true })
  })

  it("drops the second line rather than printing the same name twice", () => {
    const pair = names(place({ localName: "Ruanjan Nam Nao", canonicalName: "Ruanjan Nam Nao" }))
    expect(pair.secondary).toBeNull()
  })

  it("falls back to the roman name when there is no local one", () => {
    const pair = names(place({ localName: null, canonicalName: "Jay Fai" }))
    expect(pair).toEqual({ primary: "Jay Fai", secondary: null, primaryIsLocal: false })
  })

  it("treats a whitespace-only local name as absent", () => {
    expect(names(place({ localName: "   ", canonicalName: "Jay Fai" })).primary).toBe("Jay Fai")
  })
})

describe("meters", () => {
  it("returns local first, then tourist", () => {
    expect(meters(place()).map((m) => m.key)).toEqual(["local", "tourist"])
  })

  it("carries the explanations, because the card shows the algorithm", () => {
    const [local] = meters(place())
    expect(local.because.map((b) => b.factor)).toEqual([
      "mentioned by th personas",
      "thai-language evidence",
    ])
  })

  it("renders a missing score as an empty bar rather than omitting it", () => {
    // A card with no tourist bar reads as "no tourist signal". A card with an
    // empty one reads as "nothing scored it". Only the second is true here.
    const [, tourist] = meters(place({ scores: { local: { value: 0.4, because: [] } } }))
    expect(tourist).toMatchObject({ fraction: 0, reading: "0.00", because: [] })
  })

  it("clamps a score outside 0..1 instead of drawing a wider bar", () => {
    const [local] = meters(place({ scores: { local: { value: 1.7, because: [] } } }))
    expect(local.fraction).toBe(1)
  })
})

describe("provenance", () => {
  it("distinguishes a pin the author dropped from a name we matched", () => {
    expect(provenance(place({ resolvedTier: 0 }))).toBe("Pinned in the post")
    expect(provenance(place({ resolvedTier: 1 }))).toBe("Matched in OpenStreetMap")
    expect(provenance(place({ resolvedTier: 2 }))).toBe("Looked up by geocoder")
  })

  it("says so plainly when there is no coordinate at all", () => {
    expect(provenance(place({ geo: null }))).toBe("No coordinate")
  })

  it("does not invent a tier for a coordinate that arrived without one", () => {
    const stray = place({ resolvedTier: null, externalRef: { source: "osm", id: "node/1" } })
    expect(provenance(stray)).toBe("From osm")
  })
})

describe("locate", () => {
  it("puts north at the top, which is the opposite of the latitude axis", () => {
    const north = locate({ lat: 13.95, lng: 100.625 }, BANGKOK)
    const south = locate({ lat: 13.55, lng: 100.625 }, BANGKOK)
    expect(north.y).toBeLessThan(south.y)
  })

  it("places Jay Fai a little west of centre and north of the middle", () => {
    const at = locate({ lat: 13.7527, lng: 100.5063 }, BANGKOK)
    expect(at.x).toBeCloseTo(0.317, 3)
    expect(at.y).toBeCloseTo(0.495, 3)
    expect(at.outside).toBe(false)
  })

  it("reports a coordinate outside the frame instead of pinning it to the edge", () => {
    // ภูผาเทิบ, which Tier 1 returned for ภูผาม่าน at 0.64 similarity — 290km out.
    // Clamping alone would draw this as an ordinary place near the boundary.
    const wrong = locate({ lat: 16.435, lng: 104.805 }, BANGKOK)
    expect(wrong.outside).toBe(true)
    expect(wrong.x).toBe(1)
  })
})

describe("byLocalScore", () => {
  it("sorts the strongest local signal first", () => {
    const low = place({ id: "a", scores: { local: { value: 0.2, because: [] } } })
    const high = place({ id: "b", scores: { local: { value: 0.9, because: [] } } })
    expect([low, high].sort(byLocalScore).map((p) => p.id)).toEqual(["b", "a"])
  })

  it("breaks a tie on evidence, so the grid does not reshuffle between refetches", () => {
    const scores = { local: { value: 0.5, because: [] } }
    const thin = place({ id: "a", scores, evidenceCount: 1 })
    const thick = place({ id: "b", scores, evidenceCount: 9 })
    expect([thin, thick].sort(byLocalScore).map((p) => p.id)).toEqual(["b", "a"])
  })

  it("falls back to the id, which is arbitrary but never changes", () => {
    const same = { scores: { local: { value: 0.5, because: [] } }, evidenceCount: 1 }
    const b = place({ id: "b", ...same })
    const a = place({ id: "a", ...same })
    expect([b, a].sort(byLocalScore).map((p) => p.id)).toEqual(["a", "b"])
  })

  it("treats an unscored place as zero rather than dropping it out of the grid", () => {
    const unscored = place({ id: "a", scores: {} })
    const scored = place({ id: "b", scores: { local: { value: 0.1, because: [] } } })
    expect([unscored, scored].sort(byLocalScore).map((p) => p.id)).toEqual(["b", "a"])
  })
})
