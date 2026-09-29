import { randomUUID } from "node:crypto"
import {
  evidence,
  harvestRuns,
  mentions,
  osmPlaces,
  personas,
  places,
  rawItems,
  schema,
  sessions,
} from "@dt/db"
import type { ScoreSet } from "@samsara/core"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { travelPack } from "./pack.js"
import { PostgresOsmPlaceIndex, PostgresPlaceReader, TRAVEL_DOMAIN_ID } from "./read.js"

/**
 * `PostgresPlaceReader` against a real Postgres.
 *
 * What needs a database is the ordering over a jsonb path, the DISTINCT ON with a
 * window count riding along, and the `domain_id` half of the evidence filter —
 * each a claim about SQL that a fake would pass by construction.
 *
 * Fails loudly without `DATABASE_URL`, like every `.pg.test.ts` here, unless
 * `SAMSARA_NO_DB=1` says the omission is deliberate.
 */

const url = process.env.DATABASE_URL
const hasDb = typeof url === "string" && url.length > 0
const optedOut = process.env.SAMSARA_NO_DB === "1"

if (!hasDb && !optedOut) {
  describe("the places reader", () => {
    it("has a database to run against", () => {
      expect.fail(
        "DATABASE_URL is not set, so this file would have skipped and the run would " +
          "have reported green while testing nothing. Run `pnpm db:up` and retry, " +
          "or set SAMSARA_NO_DB=1 to skip on purpose.",
      )
    })
  })
}

const client = hasDb ? postgres(url as string, { max: 4, onnotice: () => {} }) : null
const db = client ? drizzle(client, { schema }) : null

let lock: DatabaseLock | null = null

beforeAll(async () => {
  if (hasDb) lock = await lockDatabase(url as string)
})

afterAll(async () => {
  await client?.end({ timeout: 5 })
  await lock?.release()
})

describe("the domain id", () => {
  it("is the travel pack's own, written out so the API need not import the pack", () => {
    expect(TRAVEL_DOMAIN_ID).toBe(travelPack.id)
  })
})

const local = (value: number): ScoreSet => ({
  local: {
    value,
    because: [{ factor: "native-language share", contribution: value, evidenceIds: [] }],
  },
})

describe.runIf(hasDb)("the places reader", () => {
  const d = () => db as NonNullable<typeof db>
  const reader = () => new PostgresPlaceReader(d())

  let itemId: string
  let personaId: string

  beforeEach(async () => {
    await d().execute(
      sql`truncate table places, evidence, mentions, raw_items, harvest_runs, sessions, personas restart identity cascade`,
    )
    personaId = randomUUID()
    await d().insert(personas).values({
      id: personaId,
      name: "regular",
      locality: "Thonglor",
      country: "th",
      locale: "th-TH",
      timezoneId: "Asia/Bangkok",
      tier: "anon",
    })
    const [session] = await d()
      .insert(sessions)
      .values({ purpose: "harvest", personaId, country: "sg", outcome: "ok", minutes: 0.5 })
      .returning({ id: sessions.id })
    const runId = randomUUID()
    await d()
      .insert(harvestRuns)
      .values({
        id: runId,
        domainId: TRAVEL_DOMAIN_ID,
        personaId,
        sourceId: "pantip.forum",
        query: "ก๋วยเตี๋ยว",
        sessionId: session?.id as string,
        startedAt: new Date("2026-09-20T00:00:00Z"),
        outcome: "ok",
        itemCount: 1,
      })
    itemId = randomUUID()
    await d()
      .insert(rawItems)
      .values({
        id: itemId,
        harvestRunId: runId,
        sourceId: "pantip.forum",
        rank: 0,
        url: "https://pantip.com/topic/1",
        title: "ก๋วยเตี๋ยว",
        text: "ก๋วยเตี๋ยว",
        languageGuess: "th",
        mediaRefs: [],
        capturedAt: new Date("2026-09-20T00:00:00Z"),
        rawRef: "captures/pantip.forum/1.json",
      })
  })

  const place = async (name: string, scores: ScoreSet = {}) => {
    const [row] = await d()
      .insert(places)
      .values({ canonicalName: name, city: "Bangkok", scores, lat: 13.73, lng: 100.57 })
      .returning({ id: places.id })
    return row?.id as string
  }

  /** One claim about `entityId`, with its own mention, because both keys are real. */
  const claim = async (
    entityId: string,
    over: { quote?: string | null; at?: string; domainId?: string } = {},
  ) => {
    const domainId = over.domainId ?? TRAVEL_DOMAIN_ID
    const [mention] = await d()
      .insert(mentions)
      .values({ rawItemId: itemId, domainId, packVersion: "1", payload: {}, confidence: 0.9 })
      .returning({ id: mentions.id })
    await d()
      .insert(evidence)
      .values({
        domainId,
        entityId,
        mentionId: mention?.id as string,
        rawItemId: itemId,
        sourceId: "pantip.forum",
        sourceUrl: "https://pantip.com/topic/1",
        personaId,
        language: "th",
        capturedAt: new Date(over.at ?? "2026-09-20T00:00:00Z"),
        extract: over.quote === null ? {} : { quote: over.quote ?? "อร่อยมาก" },
        rawRef: "captures/pantip.forum/1.json",
      })
  }

  it("returns nothing against an empty table", async () => {
    await expect(reader().top(10)).resolves.toEqual([])
  })

  it("puts the strongest local score first and an unscored place last", async () => {
    const low = await place("Low", local(0.2))
    const none = await place("Unscored")
    const high = await place("High", local(0.9))

    const rows = await reader().top(10)
    expect(rows.map((r) => r.place.id)).toEqual([high, low, none])
  })

  it("stops at the limit, keeping the strongest", async () => {
    await place("Low", local(0.2))
    const high = await place("High", local(0.9))
    const rows = await reader().top(1)
    expect(rows.map((r) => r.place.id)).toEqual([high])
  })

  it("quotes the newest claim that has a quote, and counts every claim", async () => {
    const id = await place("Rung Rueang", local(0.8))
    await claim(id, { quote: "เก่า", at: "2026-09-01T00:00:00Z" })
    await claim(id, { quote: "ใหม่", at: "2026-09-10T00:00:00Z" })
    // Newest of all, and no quote: counted, not shown.
    await claim(id, { quote: null, at: "2026-09-20T00:00:00Z" })

    const [row] = await reader().top(10)
    expect(row?.quote).toEqual({
      quote: "ใหม่",
      sourceId: "pantip.forum",
      sourceUrl: "https://pantip.com/topic/1",
      language: "th",
    })
    expect(row?.place.evidenceCount).toBe(3)
  })

  it("counts from the evidence table, not from the column nothing maintains", async () => {
    const id = await place("Rung Rueang")
    await claim(id)
    await claim(id)
    const [row] = await reader().top(10)
    expect(row?.place.evidenceCount).toBe(2)
  })

  it("reads another domain's evidence as nobody's", async () => {
    const id = await place("Rung Rueang")
    await claim(id, { domainId: "atlas" })
    const [row] = await reader().top(10)
    expect(row?.quote).toBeNull()
    expect(row?.place.evidenceCount).toBe(0)
  })

  it("filters the top by category", async () => {
    await place("Noodles", local(0.9))
    const [row] = await d()
      .insert(places)
      .values({ canonicalName: "Wat Pho", city: "Bangkok", category: "temple", scores: local(0.5) })
      .returning({ id: places.id })
    expect((await reader().top(10, "temple")).map((r) => r.place.id)).toEqual([row?.id])
  })

  it("counts what Phase 2's acceptance counts", async () => {
    await place("Strong", local(0.8))
    await place("Exactly the line", local(0.7))
    await d().insert(places).values({ canonicalName: "Unpinned", city: "Bangkok" })
    // Above 0.7, not at it; and `place()` gives every row a coordinate but the last.
    expect(await reader().summary()).toEqual({ total: 3, withGeo: 2, strong: 1 })
  })

  it("finds a place by its roman name, in any case", async () => {
    const id = await place("Rung Rueang", local(0.8))
    await place("Jay Fai", local(0.9))
    const rows = await reader().search("rung", 10)
    expect(rows.map((r) => r.place.id)).toEqual([id])
  })

  it("finds a place by its Thai name", async () => {
    const [row] = await d()
      .insert(places)
      .values({ canonicalName: "Jok Prince", localName: "โจ๊กปรินซ์", city: "Bangkok" })
      .returning({ id: places.id })
    const rows = await reader().search("ปรินซ์", 10)
    expect(rows.map((r) => r.place.id)).toEqual([row?.id])
  })

  it("puts the stronger local score first among matches", async () => {
    const low = await place("Noodle A", local(0.3))
    const high = await place("Noodle B", local(0.9))
    const rows = await reader().search("noodle", 10)
    expect(rows.map((r) => r.place.id)).toEqual([high, low])
  })

  it("reads one place by id, with its quote, and nothing for an unknown id", async () => {
    const id = await place("Rung Rueang", local(0.8))
    await claim(id, { quote: "อร่อย" })
    expect((await reader().byId(id))?.quote?.quote).toBe("อร่อย")
    expect(await reader().byId(randomUUID())).toBeNull()
  })

  it("reads % in a query as a percent sign, not a wildcard", async () => {
    await place("Anything")
    expect(await reader().search("%", 10)).toEqual([])
  })

  it("hands back the place as the card reads it, coordinate and scores intact", async () => {
    await place("Rung Rueang", local(0.8))
    const [row] = await reader().top(10)
    expect(row?.place).toMatchObject({
      canonicalName: "Rung Rueang",
      geo: { lat: 13.73, lng: 100.57 },
      scores: local(0.8),
    })
    expect(row?.place.firstSeenAt).toBeInstanceOf(Date)
  })
})

describe.runIf(hasDb)("the OpenStreetMap fallback", () => {
  const d = () => db as NonNullable<typeof db>
  const index = () => new PostgresOsmPlaceIndex(d())

  beforeEach(async () => {
    await d().execute(sql`truncate table places, osm_places restart identity cascade`)
    await d()
      .insert(osmPlaces)
      .values([
        {
          id: "way/376312450",
          city: "Bangkok",
          name: "วัดโพธิ์",
          nameEn: "Wat Pho",
          lat: 13.7465,
          lng: 100.4927,
          category: "temple",
          tags: ["amenity=place_of_worship"],
        },
        {
          id: "relation/11169995",
          city: "Bangkok",
          name: "วัดพระเชตุพนวิมลมังคลารามราชวรมหาวิหาร",
          nameEn: "Wat Phra Chettuphon Wimon Mangkhalaram Ratchaworamahawihan",
          commonName: "Wat Pho",
          commonLocal: "วัดโพธิ์",
          altNames: ["Wat Pho", "วัดโพธิ์", "Temple of the Reclining Buddha"],
          lat: 13.7459,
          lng: 100.4928,
          category: "temple",
        },
        {
          id: "node/1",
          city: "Bangkok",
          name: "ท่าเรือวัดโพธิ์",
          nameEn: "Wat Pho Pier",
          lat: 13.745,
          lng: 100.49,
          category: "other",
        },
        {
          id: "node/2",
          city: "Bangkok",
          name: "ICONSIAM",
          nameEn: "ICONSIAM",
          lat: 13.7267,
          lng: 100.5104,
          category: "shop",
        },
      ])
  })

  it("finds a place by its English name, the closest name first", async () => {
    const rows = await index().search("wat pho", 5)
    expect(rows.map((r) => r.osmId)).toEqual(["relation/11169995", "way/376312450", "node/1"])
    expect(rows[1]).toEqual({
      osmId: "way/376312450",
      name: "Wat Pho",
      localName: "วัดโพธิ์",
      formalName: null,
      category: "temple",
      geo: { lat: 13.7465, lng: 100.4927 },
    })
  })

  it("finds a place by its Thai name", async () => {
    const ids = (await index().search("วัดโพธิ์", 5)).map((r) => r.osmId)
    expect(ids.slice(0, 2).sort()).toEqual(["relation/11169995", "way/376312450"])
  })

  it("finds a place by a name it is only known by, and titles it that way", async () => {
    const [hit] = await index().search("reclining buddha", 5)
    expect(hit).toMatchObject({
      osmId: "relation/11169995",
      name: "Wat Pho",
      localName: "วัดโพธิ์",
      formalName: "Wat Phra Chettuphon Wimon Mangkhalaram Ratchaworamahawihan",
    })
  })

  it("matches every word in any order, across names", async () => {
    expect((await index().search("reclining the temple", 5))[0]?.osmId).toBe("relation/11169995")
    expect(await index().search("temple of dawn", 5)).toEqual([])
  })

  it("keeps no local name when the sign is already roman", async () => {
    expect((await index().search("iconsiam", 5))[0]?.localName).toBeNull()
  })

  it("promotes a row into places once, with the reference Tier 1 would give it", async () => {
    const first = await index().promote("way/376312450")
    const again = await index().promote("way/376312450")
    expect(first?.place).toMatchObject({
      canonicalName: "Wat Pho",
      localName: "วัดโพธิ์",
      category: "temple",
      geo: { lat: 13.7465, lng: 100.4927 },
      externalRef: { source: "osm", id: "way/376312450" },
      resolvedTier: 1,
      scores: {},
      evidenceCount: 0,
    })
    expect(again?.place.id).toBe(first?.place.id)
    const [{ n } = { n: 0 }] = await d().select({ n: sql<number>`count(*)::int` }).from(places)
    expect(n).toBe(1)
  })

  it("leaves a promoted row out of the fallback, since the table now answers for it", async () => {
    await index().promote("way/376312450")
    expect((await index().search("wat pho", 5)).map((r) => r.osmId)).toEqual([
      "relation/11169995",
      "node/1",
    ])
  })

  it("promotes nothing for an id the extract does not hold", async () => {
    expect(await index().promote("node/404")).toBeNull()
  })

  it("reads % as a percent sign", async () => {
    expect(await index().search("%", 5)).toEqual([])
  })
})
