import { randomUUID } from "node:crypto"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createDb } from "./client.js"
import { users } from "./tables.js"
import { type NewTrip, PostgresTripStore } from "./trips.js"

/**
 * `PostgresTripStore` against a real Postgres: the owner scoping, which is the
 * store's whole authorisation story, and the version check, which is one UPDATE's
 * WHERE clause and means nothing against a fake.
 *
 * Fails loudly without `DATABASE_URL`, like every `.pg.test.ts` in the repo, unless
 * `SAMSARA_NO_DB=1` says the omission is deliberate.
 */

const url = process.env.DATABASE_URL
const hasDb = typeof url === "string" && url.length > 0
const optedOut = process.env.SAMSARA_NO_DB === "1"

if (!hasDb && !optedOut) {
  describe("the trips store", () => {
    it("has a database to run against", () => {
      expect.fail(
        "DATABASE_URL is not set, so this file would have skipped and the run would " +
          "have reported green while testing nothing. Run `pnpm db:up` and retry, " +
          "or set SAMSARA_NO_DB=1 to skip on purpose.",
      )
    })
  })
}

const database = hasDb ? createDb(url as string, { max: 4 }) : null
let lock: DatabaseLock | null = null

beforeAll(async () => {
  if (hasDb) lock = await lockDatabase(url as string)
})

afterAll(async () => {
  await database?.sql.end({ timeout: 5 })
  await lock?.release()
})

const ALICE = randomUUID()
const BOB = randomUUID()

const trip = (over: Partial<NewTrip> = {}): NewTrip => ({
  title: "Four days in Bangkok, mostly eating.",
  destinationCity: "Bangkok",
  startDate: new Date("2026-11-14T00:00:00Z"),
  endDate: new Date("2026-11-17T00:00:00Z"),
  status: "planning",
  content: { type: "doc", content: [{ type: "paragraph" }] },
  ...over,
})

describe.runIf(hasDb)("the trips store", () => {
  const d = () => (database as NonNullable<typeof database>).db
  const store = () => new PostgresTripStore(d())

  beforeEach(async () => {
    await d().execute(
      sql`truncate table users, trips, documents, postcards restart identity cascade`,
    )
    await d()
      .insert(users)
      .values([
        { id: ALICE, email: "alice@example.invalid" },
        { id: BOB, email: "bob@example.invalid" },
      ])
  })

  it("knows which owners have an account", async () => {
    expect(await store().hasAccount(ALICE)).toBe(true)
    expect(await store().hasAccount(randomUUID())).toBe(false)
  })

  it("creates a trip with its document at version one", async () => {
    const created = await store().create(ALICE, trip())
    expect(created.trip.title).toBe("Four days in Bangkok, mostly eating.")
    expect(created.document.version).toBe(1)
    expect(created.document.content).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
  })

  it("shows a trip to its owner and to nobody else", async () => {
    const { trip: t } = await store().create(ALICE, trip())
    expect(await store().get(ALICE, t.id)).not.toBeNull()
    expect(await store().get(BOB, t.id)).toBeNull()
    expect(await store().list(BOB)).toEqual([])
  })

  it("saves a document at the version it was loaded at, and refuses a stale one", async () => {
    const { trip: t } = await store().create(ALICE, trip())
    const first = await store().saveDocument(ALICE, t.id, { type: "doc", content: [] }, 1)
    expect(first).toEqual({ saved: true, version: 2 })

    // A second tab still holding version 1.
    const stale = await store().saveDocument(ALICE, t.id, { type: "doc", content: ["x"] }, 1)
    expect(stale).toEqual({ saved: false, version: 2 })
    expect((await store().get(ALICE, t.id))?.document.content).toEqual({ type: "doc", content: [] })
  })

  it("will not save someone else's document", async () => {
    const { trip: t } = await store().create(ALICE, trip())
    expect(await store().saveDocument(BOB, t.id, {}, 1)).toBeNull()
  })

  it("adds a postcard, and counts it and its coordinate on the list", async () => {
    const { trip: t } = await store().create(ALICE, trip())
    await store().addPostcard(ALICE, t.id, {
      kind: "place",
      placeId: null,
      payload: { name: "Jok Prince" },
      geo: { lat: 13.7318, lng: 100.5136 },
      time: null,
      sourceRefs: [],
    })
    await store().addPostcard(ALICE, t.id, {
      kind: "note",
      placeId: null,
      payload: { text: "Cash only" },
      geo: null,
      time: null,
      sourceRefs: [],
    })
    const [summary] = await store().list(ALICE)
    expect(summary).toMatchObject({ postcards: 2, withGeo: 1 })
  })

  it("moves a postcard to a day, and only for its owner", async () => {
    const { trip: t } = await store().create(ALICE, trip())
    const card = await store().addPostcard(ALICE, t.id, {
      kind: "note",
      placeId: null,
      payload: {},
      geo: null,
      time: null,
      sourceRefs: [],
    })
    const day = { start: new Date("2026-11-15T00:00:00Z"), end: null }
    expect(await store().updatePostcard(BOB, card?.id as string, { time: day })).toBeNull()
    const moved = await store().updatePostcard(ALICE, card?.id as string, { time: day })
    expect(moved?.time).toEqual(day)
  })

  it("deletes a postcard for its owner only", async () => {
    const { trip: t } = await store().create(ALICE, trip())
    const card = await store().addPostcard(ALICE, t.id, {
      kind: "note",
      placeId: null,
      payload: {},
      geo: null,
      time: null,
      sourceRefs: [],
    })
    expect(await store().deletePostcard(BOB, card?.id as string)).toBe(false)
    expect(await store().deletePostcard(ALICE, card?.id as string)).toBe(true)
    expect((await store().get(ALICE, t.id))?.postcards).toEqual([])
  })

  it("renames a trip for its owner only", async () => {
    const { trip: t } = await store().create(ALICE, trip())
    expect(await store().update(BOB, t.id, { title: "Mine now" })).toBeNull()
    expect((await store().update(ALICE, t.id, { title: "Tokyo, undated." }))?.title).toBe(
      "Tokyo, undated.",
    )
  })
})
