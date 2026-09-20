import { describe, expect, it } from "vitest"
import {
  asExternalRefKey,
  asGeoKey,
  boxAround,
  EXTERNAL_REF_KEY,
  GEO_KEY,
  MERGE_RADIUS_M,
  matchesDedupKey,
  metresBetween,
  placeDedupKeys,
} from "./dedup.js"
import type { PlaceEntity } from "./entity.js"

/**
 * The travel half of P2.4.
 *
 * The engine's tests prove the stage walks keys and moves pointers without
 * knowing what a key means. These prove what travel's two keys mean, which is
 * where every wrong merge in this vertical would actually come from: a merge is
 * not reversible once the evidence has moved, so a key that fires too eagerly
 * costs a row that no later run can separate again.
 */

const BANGKOK = { lat: 13.7563, lng: 100.5018 }

/** One degree of latitude, on the radius `dedup.ts` uses. Distances below are in these. */
const DEGREE_M = 111_195

const place = (over: Partial<PlaceEntity> = {}): PlaceEntity => ({
  canonicalName: "Jay Fai",
  localName: "เจ๊ไฝ",
  city: "Bangkok",
  geo: BANGKOK,
  externalRef: { source: "osm", id: "node/1234" },
  resolvedTier: 1,
  category: "food",
  tags: [],
  ...over,
})

describe("placeDedupKeys", () => {
  it("puts the external reference first and the coordinate second", () => {
    const keys = placeDedupKeys(place())

    // The order is the whole contract between this file and the repo: the first
    // key is one indexed equality, the second is a box scan over everything
    // nearby. Reversed, every merge in the country pays for the expensive one.
    expect(keys.map((key) => key.kind)).toEqual([EXTERNAL_REF_KEY, GEO_KEY])
  })

  it("carries the source in the key, not just the id", () => {
    const keys = placeDedupKeys(place({ externalRef: { source: "geocoder", id: "42" } }))

    expect(keys[0]?.value).toEqual({ source: "geocoder", id: "42" })
  })

  it("offers both spellings, because sources use whichever they use", () => {
    const keys = placeDedupKeys(place({ canonicalName: "Jay Fai", localName: "เจ๊ไฝ" }))

    // Normalised, not raw — and note what `normaliseName` does to Thai. It keeps
    // letters and digits, and Thai tone marks are neither (Unicode Mn), so the
    // mai tri on เจ๊ไฝ is gone. Recorded here rather than worked around: the same
    // normaliser decides Tier 0 matching and has its own golden set, so changing
    // it is a change to resolution, not to dedup. See STATUS.
    expect(asGeoKey(keys[1]?.value).names).toEqual(["เจไฝ", "jayfai"])
  })

  it("says nothing about an entity with nothing to compare", () => {
    // The answer the stage counts as `keyless`. A name on its own is not a key
    // here: there is more than one Jay Fai in Thailand and the string cannot
    // tell them apart.
    expect(placeDedupKeys(place({ externalRef: null, geo: null }))).toEqual([])
  })

  it("drops the coordinate key when normalisation leaves no name at all", () => {
    // `normaliseName` keeps letters and digits. A name that is entirely
    // punctuation normalises to the empty string, and an empty string matches
    // every other empty string — so the key has to not exist rather than exist
    // and be broad.
    const keys = placeDedupKeys(
      place({ canonicalName: "***", localName: "!!!", externalRef: null }),
    )

    expect(keys).toEqual([])
  })

  it("still offers the coordinate key when only one spelling survives", () => {
    const keys = placeDedupKeys(place({ canonicalName: "Jay Fai", localName: "!!!" }))

    expect(asGeoKey(keys[1]?.value).names).toEqual(["jayfai"])
  })
})

describe("matchesDedupKey, on the external reference", () => {
  const key = { kind: EXTERNAL_REF_KEY, value: { source: "osm", id: "node/1234" } }

  it("matches the same id from the same source", () => {
    expect(matchesDedupKey(key, place())).toBe(true)
  })

  it("refuses the same id from a different source", () => {
    // Section 2.4 names this case: two tiers agreeing on an OSM node is a merge,
    // an OSM id and a geocoder id colliding numerically is not. Nothing about
    // the strings distinguishes them, which is why the source is in the value.
    expect(
      matchesDedupKey(key, place({ externalRef: { source: "geocoder", id: "node/1234" } })),
    ).toBe(false)
  })

  it("refuses an entity that has no reference of its own", () => {
    expect(matchesDedupKey(key, place({ externalRef: null }))).toBe(false)
  })

  it("ignores how far apart the two are", () => {
    // An identifier is an identifier. If two rows claim the same OSM node and
    // sit a kilometre apart, one of them has the wrong coordinate, and merging
    // is how that gets noticed rather than a reason not to.
    const faraway = place({ geo: { lat: BANGKOK.lat + 0.01, lng: BANGKOK.lng } })
    expect(matchesDedupKey(key, faraway)).toBe(true)
  })
})

describe("matchesDedupKey, on the coordinate", () => {
  const keyAt = (over: Partial<{ names: string[]; lat: number; lng: number }> = {}) => ({
    kind: GEO_KEY,
    value: { names: ["jayfai"], ...BANGKOK, radiusM: MERGE_RADIUS_M, ...over },
  })

  it("matches the same name a hundred metres away", () => {
    const near = place({ geo: { lat: BANGKOK.lat + 0.001, lng: BANGKOK.lng }, externalRef: null })

    expect(metresBetween(BANGKOK, near.geo ?? BANGKOK)).toBeLessThan(MERGE_RADIUS_M)
    expect(matchesDedupKey(keyAt(), near)).toBe(true)
  })

  it("refuses the same name two hundred metres away", () => {
    const far = place({ geo: { lat: BANGKOK.lat + 0.002, lng: BANGKOK.lng } })

    expect(metresBetween(BANGKOK, far.geo ?? BANGKOK)).toBeGreaterThan(MERGE_RADIUS_M)
    expect(matchesDedupKey(keyAt(), far)).toBe(false)
  })

  it("collapses two spellings that differ only by a mark", () => {
    // The consequence of the normaliser being mark-blind, stated as a test so it
    // is a decision rather than a surprise. In this direction it is what the key
    // is for: one caption typed the tone mark, the other did not.
    const key = keyAt({ names: ["เจไฝ"] })

    expect(matchesDedupKey(key, place({ localName: "เจ๊ไฝ", canonicalName: "-" }))).toBe(true)
  })

  it("refuses a different name at the same coordinate", () => {
    // The reason the radius can be as loose as 150m. One Bangkok corner holds a
    // dozen stalls; the name is what keeps them apart, and the radius only says
    // how far apart two spellings of one name are allowed to be.
    const neighbour = place({ canonicalName: "Thip Samai", localName: "ทิพย์สมัย" })

    expect(matchesDedupKey(keyAt(), neighbour)).toBe(false)
  })

  it("matches a local spelling against a roman one", () => {
    // Either spelling on either side counts, which is the point of `names` being
    // a list. This entity's roman name is unrelated; its Thai one is the match.
    const key = keyAt({ names: ["เจไฝ"] })

    expect(matchesDedupKey(key, place({ canonicalName: "Raan Jay Fai" }))).toBe(true)
  })

  it("matches across the punctuation and case that two captions differ by", () => {
    expect(matchesDedupKey(keyAt(), place({ canonicalName: "JAY-FAI", localName: null }))).toBe(
      true,
    )
  })

  it("refuses an entity with no coordinate", () => {
    // ADR-0008's rule, in the one place a merge could quietly break it: a place
    // without geo is not a marker, and it is not a duplicate of one either.
    expect(matchesDedupKey(keyAt(), place({ geo: null }))).toBe(false)
  })
})

describe("the distance the radius is measured with", () => {
  it("agrees with a degree of latitude", () => {
    expect(metresBetween({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(DEGREE_M, -1)
  })

  it("is zero for a point and itself", () => {
    // Not a tautology in a haversine: `asin(sqrt(h))` on a rounding-negative `h`
    // is NaN, and a NaN distance passes no `>` test, so every key would fire.
    expect(metresBetween(BANGKOK, BANGKOK)).toBe(0)
  })

  it("narrows longitude towards the poles", () => {
    const equator = metresBetween({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })
    const north = metresBetween({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })

    expect(north).toBeCloseTo(equator / 2, -3)
  })
})

describe("the box the database is asked for", () => {
  it("contains the circle, so the SQL never misses what the maths would have kept", () => {
    // The only property that matters: false positives are thrown away by
    // `metresBetween`, false negatives are duplicates nobody ever looks at
    // again. Both edges of the box must therefore be at least the radius away.
    const { dLat, dLng } = boxAround(BANGKOK.lat, MERGE_RADIUS_M)

    const north = metresBetween(BANGKOK, { lat: BANGKOK.lat + dLat, lng: BANGKOK.lng })
    const east = metresBetween(BANGKOK, { lat: BANGKOK.lat, lng: BANGKOK.lng + dLng })

    // A nanometre of slack: `boxAround` and `metresBetween` invert each other
    // through different floating-point paths and the north edge lands a few
    // parts in 10^13 short. Asserting exact containment would be asserting that
    // two transcendental round trips agree bit for bit.
    expect(north).toBeGreaterThan(MERGE_RADIUS_M - 1e-6)
    expect(east).toBeGreaterThan(MERGE_RADIUS_M - 1e-6)
  })

  it("widens the longitude half-width with latitude", () => {
    // A constant written against Bangkok's 2.7% would work here and quietly
    // under-read in any city further north — the kind of bug that surfaces when
    // a second city is added, long after the code was reviewed.
    const bangkok = boxAround(13.75, MERGE_RADIUS_M)
    const north = boxAround(60, MERGE_RADIUS_M)

    expect(bangkok.dLat).toBeCloseTo(north.dLat, 12)
    expect(north.dLng).toBeGreaterThan(bangkok.dLng * 1.9)
  })

  it("does not divide by zero at the pole", () => {
    const { dLng } = boxAround(90, MERGE_RADIUS_M)

    expect(Number.isFinite(dLng)).toBe(true)
  })
})

describe("narrowing an opaque key value", () => {
  // `DedupKey.value` is `unknown` and that is the seam working. The repo is in
  // the same package as the builder, which is a reason these always pass and not
  // a reason to cast: a third key added here and not taught to the repo would,
  // with a cast, become a query built out of `undefined`.
  it("refuses a reference with a missing half", () => {
    expect(() => asExternalRefKey({ id: "node/1234" })).toThrow(/externalRef/)
    expect(() => asExternalRefKey(null)).toThrow(/externalRef/)
  })

  it("refuses a coordinate key whose names are not strings", () => {
    expect(() => asGeoKey({ names: [7], ...BANGKOK, radiusM: 150 })).toThrow(/geo/)
    expect(() => asGeoKey({ names: ["a"], lat: "13.7", lng: 100.5, radiusM: 150 })).toThrow(/geo/)
  })

  it("refuses a kind this pack never built", () => {
    expect(() => matchesDedupKey({ kind: "embedding", value: [0.1] }, place())).toThrow(/embedding/)
  })
})
