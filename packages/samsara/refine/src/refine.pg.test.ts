import { randomUUID } from "node:crypto"
import { harvestRuns, mentions, personas, rawItems, samsaraSchema, sessions } from "@samsara/db"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { MentionRow } from "./ports.js"
import { PostgresMentionSink, PostgresMentionStore } from "./postgres.js"

/**
 * The mention stores against a real Postgres.
 *
 * What needs a real database here is the **cascade**. `mentions.raw_item_id` is
 * `ON DELETE cascade`, which encodes the rule that a mention is a claim *about*
 * an item and cannot outlive it — delete the item and the claim goes with it. An
 * in-memory sink will happily keep an orphan, and an orphaned mention is the
 * worst kind, because it still renders: a name with a quote attributed to a post
 * that is no longer there.
 *
 * The other thing a fake cannot check is that `payload` survives the round trip
 * through `jsonb` **unread**. The engine stores what the pack validated and hands
 * it back without opinion, and a non-Latin script in a JSON column is exactly
 * where a silent re-encoding would show up. The fixtures are Vietnamese for the
 * reason `harvest.pg.test.ts`'s are: the engine must not be developed against the
 * one language its first vertical happens to be about (ADR-0009).
 *
 * Runs whenever `DATABASE_URL` is set, and **fails loudly when it is not** unless
 * `SAMSARA_NO_DB=1` says the omission is deliberate. See `harvest.pg.test.ts`.
 */

const url = process.env.DATABASE_URL
const hasDb = typeof url === "string" && url.length > 0
const optedOut = process.env.SAMSARA_NO_DB === "1"

if (!hasDb && !optedOut) {
  describe("refine, against Postgres", () => {
    it("has a database to run against", () => {
      expect.fail(
        "DATABASE_URL is not set, so the cascade test would have skipped and this " +
          "run would have reported green while testing nothing. Run `pnpm db:up` " +
          "and retry, or set SAMSARA_NO_DB=1 to skip on purpose.",
      )
    })
  })
}

const client = hasDb ? postgres(url as string, { max: 4, onnotice: () => {} }) : null
const db = client ? drizzle(client, { schema: samsaraSchema }) : null

// Held for the whole file: this suite truncates shared tables, and Turbo runs the
// packages that do so at the same time. See `@samsara/db/testing`.
let lock: DatabaseLock | null = null

beforeAll(async () => {
  if (hasDb) lock = await lockDatabase(url as string)
})

afterAll(async () => {
  await client?.end({ timeout: 5 })
  await lock?.release()
})

const capturedAt = new Date("2026-09-18T10:00:00.000Z")

describe.runIf(hasDb)("refine, against Postgres", () => {
  const d = () => db as NonNullable<typeof db>
  const sink = () => new PostgresMentionSink(d())
  const store = () => new PostgresMentionStore(d())

  let itemId: string

  beforeEach(async () => {
    await d().execute(
      sql`truncate table mentions, raw_items, harvest_runs, sessions, personas restart identity cascade`,
    )
    const personaId = randomUUID()
    await d().insert(personas).values({
      id: personaId,
      name: "regular",
      locality: "District 1",
      country: "vn",
      locale: "vi-VN",
      timezoneId: "Asia/Ho_Chi_Minh",
      tier: "anon",
    })
    const [session] = await d()
      .insert(sessions)
      .values({ purpose: "harvest", personaId, country: "vn", outcome: "ok", minutes: 0.5 })
      .returning({ id: sessions.id })
    const runId = randomUUID()
    await d()
      .insert(harvestRuns)
      .values({
        id: runId,
        domainId: "atlas",
        personaId,
        sourceId: "fake.search",
        query: "xin chào thế giới",
        sessionId: session?.id as string,
        startedAt: capturedAt,
        outcome: "ok",
        itemCount: 1,
      })
    itemId = randomUUID()
    await d()
      .insert(rawItems)
      .values({
        id: itemId,
        harvestRunId: runId,
        sourceId: "fake.search",
        rank: 0,
        url: "https://example.invalid/topic/44225687",
        title: "xin chào thế giới",
        text: "xin chào",
        languageGuess: "vi",
        mediaRefs: [],
        capturedAt,
        rawRef: `captures/fake.search/${runId}/1.json`,
      })
  })

  const row = (over: Partial<MentionRow> = {}): MentionRow => ({
    id: randomUUID(),
    rawItemId: itemId,
    domainId: "atlas",
    packVersion: "1",
    payload: { localName: "Phở Hòa", romanName: "Pho Hoa", sentiment: "positive" },
    entityId: null,
    resolution: "pending",
    confidence: 0.9,
    ...over,
  })

  it("writes a batch and reads it back with the item it came from", async () => {
    await sink().insertMany([row(), row({ payload: { localName: "Bún Chả" } })])

    const read = await store().list({ domainId: "atlas" })
    expect(read).toHaveLength(2)
    // The join is the point: a name with no way to check it is not reviewable.
    expect(read[0]?.item.url).toBe("https://example.invalid/topic/44225687")
    expect(read[0]?.item.sourceId).toBe("fake.search")
    expect(read[0]?.item.languageGuess).toBe("vi")
  })

  it("hands the payload back exactly as the pack wrote it", async () => {
    await sink().insertMany([row()])
    const [read] = await store().list({ domainId: "atlas" })
    // Diacritics through `jsonb` and back. An engine that "helpfully" normalised
    // this would break the golden scorer's name matching without failing anything
    // else — `Pho Hoa` and `Phở Hòa` are two names to a string comparison.
    expect(read?.payload).toEqual({
      localName: "Phở Hòa",
      romanName: "Pho Hoa",
      sentiment: "positive",
    })
  })

  it("an empty batch is not an error", async () => {
    await sink().insertMany([])
    expect(await store().list({})).toHaveLength(0)
  })

  it("loses its mentions when the item is deleted", async () => {
    await sink().insertMany([row(), row()])
    await d().delete(rawItems).where(sql`${rawItems.id} = ${itemId}`)
    // Not "returns nothing because the join found no item" — the rows are gone.
    const remaining = await d().select({ id: mentions.id }).from(mentions)
    expect(remaining).toHaveLength(0)
  })

  describe("extractedIds", () => {
    it("names the items already extracted at this pack version", async () => {
      await sink().insertMany([row()])
      const seen = await sink().extractedIds([itemId, randomUUID()], "atlas", "1")
      expect(seen).toEqual(new Set([itemId]))
    })

    it("counts an item once however many names it found in it", async () => {
      await sink().insertMany([row(), row(), row()])
      const seen = await sink().extractedIds([itemId], "atlas", "1")
      // `selectDistinct` earning its keep: three mentions, one id.
      expect(seen.size).toBe(1)
    })

    it("does not skip an item when the pack version has moved on", async () => {
      await sink().insertMany([row({ packVersion: "1" })])
      // The version bump is precisely the case where re-extraction is wanted:
      // new prompt, new answer. Reporting it as already done would mean a prompt
      // change silently never reached the corpus it was written for.
      expect(await sink().extractedIds([itemId], "atlas", "2")).toEqual(new Set())
    })

    it("does not confuse one pack's work for another's", async () => {
      await sink().insertMany([row({ domainId: "atlas" })])
      expect(await sink().extractedIds([itemId], "creator", "1")).toEqual(new Set())
    })

    it("asks nothing when given nothing", async () => {
      expect(await sink().extractedIds([], "atlas", "1")).toEqual(new Set())
    })
  })

  describe("list", () => {
    it("filters by resolution, so the lab can show what is still pending", async () => {
      // The resolved row is made by an `update`, not by the sink, and that is not
      // test convenience — `MentionRow.entityId` is typed `null`, so the write
      // path *cannot* express a resolved mention. It is a state P2.3 moves a row
      // into after the fact, and writing this any other way would have needed the
      // type widened, which would let a pack invent an entity id.
      const pending = row()
      const toResolve = row()
      await sink().insertMany([pending, toResolve])
      const entityId = randomUUID()
      await d()
        .update(mentions)
        .set({ resolution: "resolved", entityId })
        .where(sql`${mentions.id} = ${toResolve.id}`)

      expect(await store().list({ resolution: "pending" })).toHaveLength(1)
      const [resolved] = await store().list({ resolution: "resolved" })
      expect(resolved?.id).toBe(toResolve.id)
      expect(resolved?.entityId).toBe(entityId)
    })

    it("filters to one item's mentions", async () => {
      await sink().insertMany([row(), row()])
      expect(await store().list({ rawItemId: itemId })).toHaveLength(2)
      expect(await store().list({ rawItemId: randomUUID() })).toHaveLength(0)
    })

    it("bounds the list even when asked for more", async () => {
      await sink().insertMany(Array.from({ length: 5 }, () => row()))
      expect(await store().list({ limit: 1_000_000 })).toHaveLength(5)
      expect(await store().list({ limit: 2 })).toHaveLength(2)
      // A nonsense limit falls back to the bound rather than throwing: this is a
      // query string, and the caller of a lab screen is a URL bar.
      expect(await store().list({ limit: Number.NaN })).toHaveLength(5)
    })
  })
})
