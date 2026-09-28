import { randomUUID } from "node:crypto"
import {
  evidence,
  harvestRuns,
  mentions,
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
import { PostgresPlaceReader, TRAVEL_DOMAIN_ID } from "./read.js"

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
