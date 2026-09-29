import { describe, expect, it } from "vitest"
import { categoryOf, type OverpassElement, rowOf } from "./osm-tags.js"

/**
 * The judgements, asserted where they can be disagreed with.
 *
 * `osm-tags.ts` is the one part of the extract pipeline with an opinion in it,
 * and the point of keeping it pure was that the opinion could be argued about in
 * a test rather than in a database. So these are not coverage: each one is a
 * decision written down, and a test that fails here is a proposal to categorise
 * Bangkok differently, not a regression.
 */
describe("categoryOf", () => {
  it("splits drink from nightlife on when you would go, not on what you drink", () => {
    // The decision the module's docstring argues for. A คาเฟ่ is an afternoon;
    // a bar is an evening. Both serve drinks and that is not the distinction.
    expect(categoryOf({ amenity: "cafe" })).toBe("drink")
    expect(categoryOf({ amenity: "juice_bar" })).toBe("drink")
    expect(categoryOf({ amenity: "bar" })).toBe("nightlife")
    expect(categoryOf({ amenity: "pub" })).toBe("nightlife")
    expect(categoryOf({ amenity: "nightclub" })).toBe("nightlife")
  })

  it("reads a bakery as somewhere you ate, not as retail", () => {
    expect(categoryOf({ shop: "bakery" })).toBe("food")
    expect(categoryOf({ shop: "coffee" })).toBe("drink")
  })

  it("falls back to `shop` for a shop tag it has no opinion about", () => {
    // The one place the fallback is inside a family rather than at the end: an
    // unlisted `shop=*` is still a shop, and answering `other` would lose that.
    expect(categoryOf({ shop: "hairdresser" })).toBe("shop")
  })

  it("takes the first family that matches rather than the most specific", () => {
    // `amenity` before `shop`, and this element carries both. The orderings that
    // matter are agreements — here both routes say `drink` — so the ordering is
    // only load-bearing for elements nobody has argued about yet.
    expect(categoryOf({ amenity: "cafe", shop: "coffee" })).toBe("drink")
    // Where they disagree, `amenity` still wins: a marketplace that also sells
    // bread is a market.
    expect(categoryOf({ amenity: "marketplace", shop: "bakery" })).toBe("market")
  })

  it("reads leisure and natural as the same thing", () => {
    expect(categoryOf({ leisure: "park" })).toBe("nature")
    expect(categoryOf({ natural: "beach" })).toBe("nature")
  })

  it("answers `other` rather than dropping a POI it cannot place", () => {
    // `historic` and `tourism` have no category of their own, and the row still
    // has to reach the extract — Tier 1 matches names, and a name it never
    // loaded is recall it cannot get back.
    expect(categoryOf({ historic: "monument" })).toBe("other")
    expect(categoryOf({ tourism: "attraction" })).toBe("other")
    expect(categoryOf({})).toBe("other")
  })
})

/**
 * A node with a name and a position, which is the ordinary case.
 *
 * The cases where a field has to be *absent* rather than overridden are written
 * as literals below instead of going through here: `exactOptionalPropertyTypes`
 * is on, and `{ lat: undefined }` is a different thing from a missing `lat` —
 * which is the distinction `rowOf` is being asked about in those tests.
 */
const node = (tags: Record<string, string>): OverpassElement => ({
  type: "node",
  id: 1,
  lat: 13.75,
  lon: 100.5,
  tags,
})

const FOOD = { name: "ร้านลุงไสว", amenity: "restaurant" }

describe("rowOf", () => {
  it("carries OSM's own identity, so a reload is an upsert", () => {
    const way: OverpassElement = {
      type: "way",
      id: 42,
      center: { lat: 13.75, lon: 100.5 },
      tags: FOOD,
    }
    expect(rowOf(way, "Bangkok")?.id).toBe("way/42")
  })

  it("takes a way's centroid when it has no position of its own", () => {
    const way: OverpassElement = {
      type: "way",
      id: 7,
      center: { lat: 13.7, lon: 100.6 },
      tags: FOOD,
    }
    expect(rowOf(way, "Bangkok")).toMatchObject({ lat: 13.7, lng: 100.6 })
  })

  it("keeps both spellings apart, which is the whole point of the tier", () => {
    const row = rowOf(
      node({ name: "ร้านลุงไสว", "name:th": "ร้านลุงไสว", "name:en": "Lung Sawai" }),
      "Bangkok",
    )
    expect(row).toMatchObject({ name: "ร้านลุงไสว", nameLocal: "ร้านลุงไสว", nameEn: "Lung Sawai" })
  })

  it("leaves a missing or blank alternate spelling null rather than empty", () => {
    // `PostgresOsmSearch` coalesces nulls to '' for scoring but its `%` predicate
    // runs on the raw column, so the difference between null and "" is only
    // storage. Null is the honest one, and `''` would claim a spelling exists.
    const row = rowOf(node({ name: "Som Tam Jeh Aoi", "name:en": "   " }), "Bangkok")
    expect(row).toMatchObject({ nameLocal: null, nameEn: null })
  })

  it("keeps the name people say apart from the formal one OSM files it under", () => {
    // Wat Pho's own tags, trimmed.
    const row = rowOf(
      node({
        name: "วัดพระเชตุพนวิมลมังคลารามราชวรมหาวิหาร",
        "name:th": "วัดพระเชตุพนวิมลมังคลารามราชวรมหาวิหาร",
        "name:en": "Wat Phra Chettuphon Wimon Mangkhalaram Ratchaworamahawihan",
        loc_name: "วัดโพธิ์",
        "loc_name:en": "Wat Pho",
        "alt_name:en": "Temple of the Reclining Buddha",
        "alt_name:ja": "ワット・ポー",
      }),
      "Bangkok",
    )
    expect(row).toMatchObject({
      commonName: "Wat Pho",
      commonLocal: "วัดโพธิ์",
      altNames: ["Wat Pho", "วัดโพธิ์", "Temple of the Reclining Buddha"],
    })
  })

  it("takes a roman loc_name as no Thai common name, and repeats no primary name", () => {
    const row = rowOf(
      node({
        name: "ICONSIAM",
        "name:en": "ICONSIAM",
        loc_name: "Iconsiam",
        alt_name: "ICONSIAM;ไอคอนสยาม",
      }),
      "Bangkok",
    )
    expect(row).toMatchObject({
      commonName: null,
      commonLocal: null,
      altNames: ["Iconsiam", "ไอคอนสยาม"],
    })
  })

  it("splits Overpass's multi-values, because each half is a thing people search", () => {
    const row = rowOf(
      node({ name: "Boat Noodle", amenity: "restaurant", cuisine: "thai;noodle" }),
      "Bangkok",
    )
    expect(row?.tags).toEqual(["thai", "noodle", "restaurant"])
  })

  it("keeps the short list of tags and nothing else", () => {
    // The table is truncated by tests and has to fit a free Supabase tier. Phone
    // numbers, opening hours and `addr:*` are neither searched nor budgeted for.
    const row = rowOf(
      node({
        name: "Som Tam Jeh Aoi",
        amenity: "restaurant",
        phone: "+66 2 000 0000",
        opening_hours: "Mo-Su 10:00-20:00",
        "addr:street": "Thanon Phra Athit",
        operator: "somebody",
      }),
      "Bangkok",
    )
    expect(row?.tags).toEqual(["restaurant"])
  })

  it("does not repeat a tag value that two keys agree on", () => {
    const row = rowOf(node({ name: "Kopi", amenity: "cafe", cuisine: "cafe" }), "Bangkok")
    expect(row?.tags).toEqual(["cafe"])
  })

  it("refuses a nameless element, which a named-POI extract cannot match anyway", () => {
    expect(rowOf(node({ amenity: "restaurant" }), "Bangkok")).toBeNull()
    expect(rowOf(node({ name: "   ", amenity: "restaurant" }), "Bangkok")).toBeNull()
    // No `tags` at all, which is what an untagged way comes back as.
    expect(rowOf({ type: "way", id: 3, center: { lat: 13.7, lon: 100.6 } }, "Bangkok")).toBeNull()
  })

  it("refuses an element with no position, or one that is not a number", () => {
    // Ordinary rather than exceptional: the loader counts these rather than
    // failing on them.
    // A relation Overpass returned without a centre.
    expect(rowOf({ type: "relation", id: 9, tags: FOOD }, "Bangkok")).toBeNull()
    expect(
      rowOf({ type: "node", id: 9, lat: Number.NaN, lon: 100.5, tags: FOOD }, "Bangkok"),
    ).toBeNull()
  })

  it("stamps the city it was loaded for, matching `places.city`", () => {
    expect(rowOf(node(FOOD), "Bangkok")?.city).toBe("Bangkok")
  })
})
