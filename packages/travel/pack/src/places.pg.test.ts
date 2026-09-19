import { places, schema } from "@dt/db"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { PlaceEntity } from "./entity.js"
import { PostgresPlaceRepo } from "./postgres.js"

/**
 * `PostgresPlaceRepo` against a real Postgres.
 *
 * What needs a database here is not the insert — it is the column defaults, the
 * enum, the `text[]`, and the jsonb round-trip of `externalRef`. Every one of
 * those is a claim about the schema that a fake repo would let pass.
 *
 * Runs whenever `DATABASE_URL` is set, and **fails loudly when it is not** unless
 * `SAMSARA_NO_DB=1` says the omission is deliberate.
 */

const url = process.env.DATABASE_URL
const hasDb = typeof url === "string" && url.length > 0
const optedOut = process.env.SAMSARA_NO_DB === "1"

if (!hasDb && !optedOut) {
  describe("the places repo", () => {
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

const resolved: PlaceEntity = {
  canonicalName: "Kuay Teow Reua Thonglor",
  localName: "ก๋วยเตี๋ยวเรือทองหล่อ",
  city: "Bangkok",
  geo: { lat: 13.7263, lng: 100.5148 },
  externalRef: { source: "osm", id: "node/1" },
  resolvedTier: 1,
  category: "food",
  tags: ["ก๋วยเตี๋ยวเรือ"],
}

describe.runIf(hasDb)("the places repo", () => {
  const d = () => db as NonNullable<typeof db>
  const repo = () => new PostgresPlaceRepo(d())

  beforeEach(async () => {
    await d().execute(sql`truncate table places restart identity cascade`)
  })

  it("writes a resolved place and returns the id the row was given", async () => {
    const id = await repo().upsert(resolved)
    const rows = await d().select().from(places)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(id)
    expect(rows[0]?.canonicalName).toBe("Kuay Teow Reua Thonglor")
    expect(rows[0]?.localName).toBe("ก๋วยเตี๋ยวเรือทองหล่อ")
    expect(rows[0]?.lat).toBeCloseTo(13.7263, 4)
    expect(rows[0]?.lng).toBeCloseTo(100.5148, 4)
    expect(rows[0]?.resolvedTier).toBe(1)
    expect(rows[0]?.category).toBe("food")
    expect(rows[0]?.tags).toEqual(["ก๋วยเตี๋ยวเรือ"])
  })

  it("round-trips the source-tagged externalRef through jsonb", async () => {
    // ADR-0017's tagging only works if the tag survives storage. An id that came
    // back without knowing which namespace it belongs to is an id P2.4 would
    // merge across tiers, which is the exact thing the tag exists to prevent.
    await repo().upsert(resolved)
    const [row] = await d().select().from(places)
    expect(row?.externalRef).toEqual({ source: "osm", id: "node/1" })
  })

  it("writes an unresolvable place with no coordinate and no tier", async () => {
    // Tier 3 still writes the row. The place is known to have been mentioned and
    // simply does not appear on the map, which is different from not existing.
    await repo().upsert({
      ...resolved,
      geo: null,
      externalRef: null,
      resolvedTier: null,
    })
    const [row] = await d().select().from(places)

    expect(row?.lat).toBeNull()
    expect(row?.lng).toBeNull()
    expect(row?.externalRef).toBeNull()
    expect(row?.resolvedTier).toBeNull()
  })

  it("does not deduplicate, because that is P2.4's measurement to make", async () => {
    // Two spellings of one shop legitimately produce two rows here. A repo that
    // collapsed them would improve every dedup metric by removing the cases
    // dedup is scored on, and it would do it invisibly.
    const first = await repo().upsert(resolved)
    const second = await repo().upsert({ ...resolved, canonicalName: "Kuay Tiew Rua Thonglor" })

    expect(second).not.toBe(first)
    expect(await d().select().from(places)).toHaveLength(2)
  })

  it("leaves the corpus-level columns to their defaults", async () => {
    // `scores` is P2.5's and the counts are facts about the whole corpus. A
    // resolver holding one mention cannot know them, so it must not write them.
    await repo().upsert(resolved)
    const [row] = await d().select().from(places)

    expect(row?.scores).toEqual({})
    expect(row?.evidenceCount).toBe(0)
    expect(row?.firstSeenAt).toBeInstanceOf(Date)
    expect(row?.lastSeenAt).toBeInstanceOf(Date)
  })
})
