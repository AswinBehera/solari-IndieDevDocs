import type { LookupPort, PendingMention, ResolveCtx } from "@samsara/refine"
import { MemoryEntityRepo, MemoryResolutionCache, resolve } from "@samsara/refine"
import { describe, expect, it } from "vitest"
import type { PlaceEntity } from "./entity.js"
import type { PlaceMention } from "./mention.js"
import { createTravelPack } from "./pack.js"
import { createResolver, placeKey, spellingsOf, tier0 } from "./resolve.js"
import { BANGKOK, nameAgreement, pinsIn } from "./tier0.js"

/**
 * ADR-0017's tiers, against real link shapes.
 *
 * The strings here are the ones that actually appear in harvested Thai food
 * writing: a Google Maps share link with its `!3d!4d` payload, a price written
 * as "39 บาท", a district name that is also part of half the shop names in it.
 * Made-up inputs would prove the branches run; these are the inputs that decide
 * whether the branches are right.
 */

const SAPHAN_TAKSIN = "ก๋วยเตี๋ยวเรือทองหล่อ"
const CHAROEN = "ร้านเจ๊โอวข้าวต้มเป็ด"

const maps = (name: string, lat: number, lng: number, id = "0x30e29e:0xabc") =>
  `https://www.google.com/maps/place/${encodeURIComponent(name)}/@${lat},${lng},17z/` +
  `data=!3m1!4b1!4m6!3m5!1s${id}!8m2!3d${lat}!4d${lng}`

const mention = (over: Partial<PlaceMention> = {}): PlaceMention => ({
  localName: SAPHAN_TAKSIN,
  romanName: "Kuay Teow Reua Thonglor",
  dish: "ก๋วยเตี๋ยวเรือ",
  category: "food",
  priceHint: "39 บาท",
  quote: "อร่อยมาก ชามละ 39 บาท",
  sentiment: "positive",
  creatorReads: "local",
  ...over,
})

const ctxWith = (text: string, over: Partial<ResolveCtx> = {}): ResolveCtx => ({
  item: {
    id: "item-1",
    sourceId: "pantip.search",
    url: "https://example.invalid/topic/1",
    title: "รีวิวร้านเด็ด",
    text,
    languageGuess: "th",
  },
  ...over,
})

const lookupReturning = (result: Awaited<ReturnType<LookupPort["lookup"]>>): LookupPort => ({
  lookup: async () => result,
})

describe("reading pins out of an artifact", () => {
  it("takes the place's own coordinate over the viewport's", () => {
    // `@lat,lng` is where the map was panned to and `!3d!4d` is the pin. They
    // differ by a block or two, which is the difference between the right corner
    // and the wrong one on a street with four noodle shops.
    const url =
      "https://www.google.com/maps/place/Wat+Pho/@13.7400,100.4900,17z/" +
      "data=!4m6!3m5!1s0x30e2:0x1!8m2!3d13.7465!4d100.4927"
    expect(pinsIn(url)[0]).toMatchObject({ lat: 13.7465, lng: 100.4927, name: "Wat Pho" })
  })

  it("keeps the link's own id, which is a free dedup key for P2.4", () => {
    const [pin] = pinsIn(maps(SAPHAN_TAKSIN, 13.7263, 100.5148, "0x30e29ecf:0xdeadbeef"))
    expect(pin?.ref).toEqual({ source: "artifact", id: "0x30e29ecf:0xdeadbeef" })
    expect(pin?.name).toBe(SAPHAN_TAKSIN)
  })

  it("does not read a price, a date or a version number as a coordinate", () => {
    // The bare-pair pattern is the one that can go wrong in prose, and Thai food
    // writing is full of numbers.
    const prose = "ชามละ 39.50 บาท, 2.5 ดาว — อัปเดต 2026.09.19, v1.2.3 ราคา 120.00, 80.00"
    expect(pinsIn(prose)).toEqual([])
  })

  it("refuses a pair too coarse to be a pin", () => {
    // Two decimals is good to about a kilometre, which is a neighbourhood rather
    // than a shop. This is the assertion that pins the three-decimal rule: the
    // prose above is refused by the latitude bound whatever the rule says, so on
    // its own it would let the rule be loosened without anything noticing.
    expect(pinsIn("พิกัด 13.75, 100.50")).toEqual([])
    expect(pinsIn("พิกัด 13.756, 100.501")).toHaveLength(1)
  })

  it("reads a bare pair when it really is one, and refuses null island", () => {
    expect(pinsIn("พิกัด 13.7563, 100.5018")[0]).toMatchObject({ lat: 13.7563, lng: 100.5018 })
    expect(pinsIn("geo:0.0000,0.0000")).toEqual([])
  })

  it("reads geo: and OSM links, which come from share sheets and forum posts", () => {
    expect(pinsIn("geo:13.7563,100.5018")[0]).toMatchObject({ lat: 13.7563 })
    expect(
      pinsIn("https://www.openstreetmap.org/?mlat=13.7563&mlon=100.5018#map=19/13.75/100.50")[0],
    ).toMatchObject({ lat: 13.7563, lng: 100.5018 })
  })
})

describe("deciding two names are the same place", () => {
  it("ignores script composition, case and punctuation", () => {
    expect(nameAgreement("Wat Pho", "wat-pho")).toBe(0.95)
    expect(nameAgreement(SAPHAN_TAKSIN, SAPHAN_TAKSIN.normalize("NFD"))).toBe(0.95)
  })

  it("ignores a leading word that says what a place is rather than what it is called", () => {
    // The mention says "ร้าน…" and the map link does not. Without this the two
    // fall through to containment, which is a weaker claim than they deserve.
    expect(nameAgreement(CHAROEN, "เจ๊โอวข้าวต้มเป็ด")).toBe(0.9)
    expect(nameAgreement("The Commons", "Commons")).toBe(0.9)
  })

  it("refuses a district name that happens to be inside a shop name", () => {
    // The failure this file is organised to avoid, in its most likely form:
    // ทองหล่อ is a whole district and appears inside dozens of shop names in it.
    // Containment alone would pin every one of them to the same coordinate.
    expect(nameAgreement("ทองหล่อ", SAPHAN_TAKSIN)).toBeNull()
    expect(nameAgreement("Thonglor", "Thonglor Noodle Boat House Original")).toBeNull()
  })

  it("allows containment when the shared part is most of both names", () => {
    expect(nameAgreement("Kuay Teow Reua Thonglor", "Kuay Teow Reua Thonglor 2")).toBe(0.75)
  })

  it("refuses two names with nothing in common", () => {
    expect(nameAgreement(SAPHAN_TAKSIN, "Wat Pho")).toBeNull()
  })
})

describe("Tier 0, the primary path", () => {
  it("takes a coordinate the author already pinned", () => {
    const got = tier0(mention(), `อร่อย ${maps(SAPHAN_TAKSIN, 13.7263, 100.5148)}`, BANGKOK)
    expect(got?.pin).toMatchObject({ lat: 13.7263, lng: 100.5148 })
    expect(got?.confidence).toBe(0.95)
  })

  it("matches on the roman name when the link is in Latin script", () => {
    const got = tier0(mention(), maps("Kuay Teow Reua Thonglor", 13.7263, 100.5148), BANGKOK)
    expect(got?.pin.lat).toBe(13.7263)
  })

  it("does not give a listicle's first pin to every place it names", () => {
    // **The most important test in this file.** An artifact naming ten shops
    // carries ten map links, and a resolver that took the first coordinate it
    // found would resolve all ten, at Tier 0, with high confidence, onto a map
    // that looks populated and is wrong — undetectably, because a wrong pin and
    // a right one are the same shape.
    const listicle = [
      `1. ${SAPHAN_TAKSIN} ${maps(SAPHAN_TAKSIN, 13.7263, 100.5148)}`,
      `2. ${CHAROEN} ${maps(CHAROEN, 13.7512, 100.5086)}`,
      `3. Wat Pho ${maps("Wat Pho", 13.7465, 100.4927)}`,
    ].join("\n")

    expect(tier0(mention(), listicle, BANGKOK)?.pin.lat).toBe(13.7263)
    expect(
      tier0(mention({ localName: CHAROEN, romanName: null }), listicle, BANGKOK)?.pin.lat,
    ).toBe(13.7512)
    // And a place the artifact never named gets nothing, rather than the nearest
    // link going spare.
    expect(
      tier0(mention({ localName: "ข้าวมันไก่ประตูน้ำ", romanName: null }), listicle, BANGKOK),
    ).toBeNull()
  })

  it("refuses a coordinate from another country", () => {
    // A source comparing Bangkok with Tokyo, or a footer linking the writer's
    // home city. The name could still agree — chains exist — and the pin would
    // be five thousand kilometres out.
    const tokyo = maps(SAPHAN_TAKSIN, 35.6762, 139.6503)
    expect(tier0(mention(), tokyo, BANGKOK)).toBeNull()
  })

  it("ignores a coordinate nothing attributes to anything", () => {
    // A bare geotag. See `tier0.ts` for why this costs real recall and is still
    // the right call, and what would have to change to use it.
    expect(tier0(mention(), "พิกัด 13.7563, 100.5018 อร่อยมาก", BANGKOK)).toBeNull()
  })
})

describe("the tiers below Tier 0", () => {
  const resolver = (osm?: Parameters<typeof createResolver>[0]["osm"]) =>
    createResolver({ city: BANGKOK, ...(osm === undefined ? {} : { osm }) })

  const unpinned = "ร้านนี้อร่อยมาก ไปกินบ่อย"

  it("falls to the OSM extract, and tags the ref as OSM", async () => {
    const osm = {
      search: async () => [
        { lat: 13.73, lng: 100.52, osmId: "node/123", name: SAPHAN_TAKSIN, confidence: 0.82 },
      ],
    }
    const got = await resolver(osm)(mention(), ctxWith(unpinned))

    expect(got.outcome).toBe("resolved")
    if (got.outcome !== "resolved") return
    expect(got.tier).toBe(1)
    expect(got.entity.externalRef).toEqual({ source: "osm", id: "node/123" })
    expect(got.entity.resolvedTier).toBe(1)
  })

  it("hands the OSM extract every spelling at once, not one call per name", async () => {
    const calls: string[][] = []
    const osm = {
      search: async (names: readonly string[]) => {
        calls.push([...names])
        return []
      },
    }
    await resolver(osm)(mention(), ctxWith(unpinned))
    expect(calls).toEqual([[SAPHAN_TAKSIN, "Kuay Teow Reua Thonglor"]])
  })

  it("asks the metered tier once, for one spelling, with the city attached", async () => {
    // 800 calls a day. Two spellings per mention halves the corpus this tier can
    // reach, for a gain that is not there: a geocoder that cannot find the Thai
    // name rarely finds a romanisation of it.
    const asked: string[] = []
    const lookup: LookupPort = {
      lookup: async (query) => {
        asked.push(query)
        return { ok: true, hits: [{ lat: 13.73, lng: 100.52, ref: "liq-9", confidence: 0.8 }] }
      },
    }
    const got = await resolver()(mention(), ctxWith(unpinned, { lookup }))

    expect(asked).toEqual([`${SAPHAN_TAKSIN}, Bangkok`])
    expect(got.outcome).toBe("resolved")
    if (got.outcome !== "resolved") return
    expect(got.tier).toBe(2)
    expect(got.entity.externalRef).toEqual({ source: "geocoder", id: "liq-9" })
  })

  it("defers when the meter refuses, and forwards the reason unchanged", async () => {
    // The whole reason `LookupResult` is a union. `unresolvable` here would
    // record "there is no such place" on the day a quota ran out — terminally,
    // with nothing left that would ever ask again.
    const got = await resolver()(
      mention(),
      ctxWith(unpinned, { lookup: lookupReturning({ ok: false, reason: "budget" }) }),
    )
    expect(got).toEqual({ outcome: "deferred", reason: "budget" })
  })

  it("does not believe a low-confidence geocoder hit", async () => {
    // A hosted geocoder answers something for almost any string. ADR-0017 is
    // explicit that choosing which POI a caption meant is entity resolution and
    // no geocoder does it for us, so a weak hit is a guess wearing a coordinate.
    const got = await resolver()(
      mention(),
      ctxWith(unpinned, {
        lookup: lookupReturning({
          ok: true,
          hits: [{ lat: 13.73, lng: 100.52, ref: "liq-9", confidence: 0.2 }],
        }),
      }),
    )
    expect(got.outcome).toBe("unresolvable")
  })

  it("does not believe a geocoder hit in the wrong city", async () => {
    const got = await resolver()(
      mention(),
      ctxWith(unpinned, {
        lookup: lookupReturning({
          ok: true,
          hits: [{ lat: 35.68, lng: 139.65, ref: "liq-1", confidence: 0.99 }],
        }),
      }),
    )
    expect(got.outcome).toBe("unresolvable")
  })

  it("says Tier 3 rather than deferring when no tier below 0 is configured", async () => {
    // A deployment with no extract and no key. Deferring would spend three runs
    // re-asking a question nothing configured can answer and then write it off
    // anyway, with the tier recorded as null. Saying so on the first run is
    // better information and costs nothing.
    const got = await resolver()(mention(), ctxWith(unpinned))

    expect(got.outcome).toBe("unresolvable")
    if (got.outcome !== "unresolvable") return
    expect(got.tier).toBe(3)
    // Still written, with no coordinate: ADR-0008's rule is kept by not drawing
    // it, not by forgetting the name.
    expect(got.entity).toMatchObject({ geo: null, resolvedTier: null, city: "Bangkok" })
  })

  it("defers a cancelled run instead of writing off what it never tried", async () => {
    const controller = new AbortController()
    controller.abort()
    const got = await resolver()(mention(), ctxWith(unpinned, { signal: controller.signal }))
    expect(got).toEqual({ outcome: "deferred", reason: "cancelled" })
  })
})

describe("the cache key", () => {
  const key = placeKey(BANGKOK)

  it("collapses the spellings of one name", () => {
    expect(key(mention({ localName: ` ${SAPHAN_TAKSIN} ` }))).toBe(key(mention()))
    expect(key(mention({ localName: "The Commons" }))).toBe(
      key(mention({ localName: "thecommons" })),
    )
  })

  it("keys on the local name, which is the field every mention has", () => {
    // Keying on the roman name would give every mention lacking one a key of its
    // own, defeating the cache exactly where sources are thinnest.
    expect(key(mention({ romanName: null }))).toBe(key(mention({ romanName: "Whatever" })))
  })

  it("separates two cities, because the same shop name is in all of them", () => {
    const chiangMai = placeKey({ name: "Chiang Mai", bbox: [98.9, 18.7, 99.1, 18.9] })
    expect(chiangMai(mention())).not.toBe(key(mention()))
  })

  it("names nothing a resolver has not been given", () => {
    expect(spellingsOf(mention({ romanName: null }))).toEqual([SAPHAN_TAKSIN])
    expect(spellingsOf(mention({ localName: "X", romanName: "X" }))).toEqual(["X"])
  })
})

describe("the whole pack, through the engine's resolve stage", () => {
  const pending = (m: PlaceMention, text: string, id: string): PendingMention => ({
    id,
    rawItemId: `raw-${id}`,
    domainId: "travel",
    packVersion: "1",
    payload: m,
    item: { ...ctxWith(text).item, id: `raw-${id}` },
  })

  it("resolves a real listicle and reports the tier mix P2.3 is judged on", async () => {
    const places = new MemoryEntityRepo<PlaceEntity>()
    const pack = createTravelPack({ places })
    const cache = new MemoryResolutionCache()

    const listicle = [
      `1. ${SAPHAN_TAKSIN} ${maps(SAPHAN_TAKSIN, 13.7263, 100.5148)}`,
      `2. ${CHAROEN} ${maps(CHAROEN, 13.7512, 100.5086)}`,
      "3. ข้าวมันไก่ประตูน้ำ ไม่มีพิกัด",
    ].join("\n")

    const report = await resolve({
      pack,
      cache,
      mentions: [
        pending(mention(), listicle, "m1"),
        // The same shop again, spelled with a stray space, from the same item.
        pending(mention({ localName: ` ${SAPHAN_TAKSIN}` }), listicle, "m2"),
        pending(mention({ localName: CHAROEN, romanName: null }), listicle, "m3"),
        pending(mention({ localName: "ข้าวมันไก่ประตูน้ำ", romanName: null }), listicle, "m4"),
      ],
    })

    // Four mentions, three keys: the stray space cost nothing.
    expect(report).toMatchObject({ mentions: 4, keys: 3, asked: 3, resolved: 2, unresolvable: 1 })
    expect(report.tiers).toEqual([
      { tier: 0, count: 2 },
      { tier: 3, count: 1 },
    ])
    // Every mention ends up pointing somewhere, including the unplaceable one.
    expect(places.entities).toHaveLength(3)
    expect(cache.mentions.size).toBe(4)
    expect(cache.mentions.get("m2")?.entityId).toBe(cache.mentions.get("m1")?.entityId)
    expect(cache.mentions.get("m4")?.state).toBe("unresolvable")
  })

  it("writes an entity the engine's own schema accepts", async () => {
    // The engine validates against `entitySchema` before the repo is allowed to
    // write, and silently counts a rejection as `invalid`. A resolver producing
    // a shape `@dt/core`'s `place` would refuse fails without saying so here, so
    // this asserts the count rather than trusting the entity count alone.
    const places = new MemoryEntityRepo<PlaceEntity>()
    const report = await resolve({
      pack: createTravelPack({ places }),
      cache: new MemoryResolutionCache(),
      mentions: [pending(mention(), maps(SAPHAN_TAKSIN, 13.7263, 100.5148), "m1")],
    })
    expect(report.invalid).toBe(0)
    expect(places.entities[0]?.entity).toMatchObject({
      canonicalName: "Kuay Teow Reua Thonglor",
      localName: SAPHAN_TAKSIN,
      city: "Bangkok",
      geo: { lat: 13.7263, lng: 100.5148 },
      resolvedTier: 0,
      category: "food",
      tags: ["ก๋วยเตี๋ยวเรือ"],
    })
  })
})
