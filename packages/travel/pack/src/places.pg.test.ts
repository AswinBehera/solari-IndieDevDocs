import { places, schema } from "@dt/db"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { EXTERNAL_REF_KEY, GEO_KEY, placeDedupKeys } from "./dedup.js"
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

/**
 * The dedup half (P2.4), against the same database.
 *
 * What needs a real Postgres here is precisely what a fake cannot have: the
 * jsonb equality that `places_external_ref_idx` is built over, the `BETWEEN` on
 * two float columns that stands in for a radius, and a `merge` that is a
 * transaction over a `SELECT … FOR UPDATE`. `MemoryEntityRepo` answers all three
 * questions correctly and proves none of them.
 */
describe.runIf(hasDb)("the places repo, deduplicating", () => {
  const d = () => db as NonNullable<typeof db>
  const repo = () => new PostgresPlaceRepo(d())

  beforeEach(async () => {
    await d().execute(sql`truncate table places restart identity cascade`)
  })

  /** Write a row and make it older than everything written after it. */
  const older = async (entity: PlaceEntity, secondsAgo: number): Promise<string> => {
    const id = await repo().upsert(entity)
    const at = new Date(Date.now() - secondsAgo * 1000)
    await d().update(places).set({ firstSeenAt: at, lastSeenAt: at }).where(eq(places.id, id))
    return id
  }

  it("finds a row by the reference, and says which key found it", async () => {
    const first = await older(resolved, 60)
    const second = await repo().upsert({ ...resolved, canonicalName: "Kuay Tiew Rua" })

    // The kind comes back because it lands in the stage's report, which is the
    // only thing that would ever reveal a key quietly matching nothing.
    expect(await repo().findByKeys(placeDedupKeys(resolved), second)).toEqual({
      id: first,
      kind: EXTERNAL_REF_KEY,
    })
  })

  it("does not match one source's id against another's", async () => {
    // The case section 2.4 names. Both rows are far enough apart that the
    // coordinate key cannot rescue the test into passing for the wrong reason.
    await older({ ...resolved, externalRef: { source: "geocoder", id: "node/1" } }, 60)
    const mine = await repo().upsert({
      ...resolved,
      geo: { lat: 13.9, lng: 100.9 },
      externalRef: { source: "osm", id: "node/1" },
    })

    const keys = placeDedupKeys({
      ...resolved,
      geo: { lat: 13.9, lng: 100.9 },
      externalRef: { source: "osm", id: "node/1" },
    })
    expect(await repo().findByKeys(keys, mine)).toBeNull()
  })

  it("never returns the row that asked", async () => {
    // Dedup runs over rows that already exist, so every entity is in the table
    // when its own keys are asked. Without the exclusion every place in Thailand
    // is a duplicate of itself.
    const only = await repo().upsert(resolved)

    expect(await repo().findByKeys(placeDedupKeys(resolved), only)).toBeNull()
  })

  it("falls through to the coordinate when the reference misses", async () => {
    const first = await older({ ...resolved, externalRef: { source: "osm", id: "node/9" } }, 60)
    // Same shop, spelled differently, a hundred metres away, and resolved by a
    // different tier — which is the duplicate this key exists for.
    const entity: PlaceEntity = {
      ...resolved,
      canonicalName: "Kuay Tiew Rua Thong Lor",
      geo: { lat: 13.7273, lng: 100.5148 },
      externalRef: { source: "geocoder", id: "abc" },
    }
    const second = await repo().upsert(entity)

    expect(await repo().findByKeys(placeDedupKeys(entity), second)).toEqual({
      id: first,
      kind: GEO_KEY,
    })
  })

  it("leaves a row outside the radius alone", async () => {
    await older(resolved, 60)
    const entity: PlaceEntity = {
      ...resolved,
      geo: { lat: 13.7283, lng: 100.5148 },
      externalRef: null,
    }
    const second = await repo().upsert(entity)

    // Two hundred metres. The box the SQL asks for is wider than the circle, so
    // this row *is* read and then thrown away by `metresBetween` — which is the
    // half of the split that only a database can exercise.
    expect(await repo().findByKeys(placeDedupKeys(entity), second)).toBeNull()
  })

  it("leaves a different name inside the radius alone", async () => {
    await older(resolved, 60)
    const entity: PlaceEntity = {
      ...resolved,
      canonicalName: "Thip Samai",
      localName: "ทิพย์สมัย",
      geo: { lat: 13.7264, lng: 100.5148 },
      externalRef: null,
    }
    const second = await repo().upsert(entity)

    expect(await repo().findByKeys(placeDedupKeys(entity), second)).toBeNull()
  })

  it("prefers the oldest row when three carry one reference", async () => {
    const first = await older(resolved, 300)
    await older({ ...resolved, canonicalName: "B" }, 200)
    const mine = await repo().upsert({ ...resolved, canonicalName: "C" })

    // Stability across runs, not correctness: any of the three is a legitimate
    // answer, and one that changes with the planner makes a merge chain depend
    // on which row Postgres happened to reach first.
    expect(await repo().findByKeys(placeDedupKeys(resolved), mine)).toMatchObject({ id: first })
  })

  it("refuses a key kind this pack never built", async () => {
    const id = await repo().upsert(resolved)

    await expect(repo().findByKeys([{ kind: "embedding", value: [] }], id)).rejects.toThrow(
      /embedding/,
    )
  })
})

describe.runIf(hasDb)("the places repo, merging", () => {
  const d = () => db as NonNullable<typeof db>
  const repo = () => new PostgresPlaceRepo(d())

  beforeEach(async () => {
    await d().execute(sql`truncate table places restart identity cascade`)
  })

  const row = async (id: string) => (await d().select().from(places).where(eq(places.id, id)))[0]

  it("keeps whichever side knows something, and deletes the duplicate", async () => {
    const survivor = await repo().upsert({
      ...resolved,
      localName: null,
      tags: ["ก๋วยเตี๋ยวเรือ"],
    })
    const duplicate = await repo().upsert({
      ...resolved,
      canonicalName: "Kuay Tiew Rua",
      tags: ["boat noodles", "ก๋วยเตี๋ยวเรือ"],
    })
    const earlier = new Date(Date.now() - 86_400_000)
    await d()
      .update(places)
      .set({ firstSeenAt: earlier, evidenceCount: 3 })
      .where(eq(places.id, duplicate))
    await d().update(places).set({ evidenceCount: 2 }).where(eq(places.id, survivor))

    await repo().merge(survivor, duplicate)
    const kept = await row(survivor)

    expect(await row(duplicate)).toBeUndefined()
    // The native-script name is the spelling that resolves, so a duplicate
    // carrying one is the most useful thing it has to give.
    expect(kept?.localName).toBe("ก๋วยเตี๋ยวเรือทองหล่อ")
    expect(kept?.tags?.slice().sort()).toEqual(["boat noodles", "ก๋วยเตี๋ยวเรือ"])
    expect(kept?.firstSeenAt?.getTime()).toBe(earlier.getTime())
    expect(kept?.evidenceCount).toBe(5)
    // Left alone on purpose: the survivor is the older row and this is the name
    // whatever is already pointing at it has seen.
    expect(kept?.canonicalName).toBe("Kuay Teow Reua Thonglor")
  })

  it("does not overwrite a coordinate the survivor already has", async () => {
    const survivor = await repo().upsert(resolved)
    const duplicate = await repo().upsert({
      ...resolved,
      geo: { lat: 13.9, lng: 100.9 },
      externalRef: { source: "geocoder", id: "abc" },
      resolvedTier: 2,
    })

    await repo().merge(survivor, duplicate)
    const kept = await row(survivor)

    expect(kept?.lat).toBeCloseTo(13.7263, 4)
    expect(kept?.externalRef).toEqual({ source: "osm", id: "node/1" })
    expect(kept?.resolvedTier).toBe(1)
  })

  it("takes the coordinate, its reference and its tier together or not at all", async () => {
    // A Tier 1 coordinate under a Tier 0 reference would be a row claiming OSM
    // agrees with a pin it has never seen. They are one answer from one tier.
    const survivor = await repo().upsert({
      ...resolved,
      geo: null,
      externalRef: null,
      resolvedTier: null,
    })
    const duplicate = await repo().upsert({
      ...resolved,
      geo: { lat: 13.9, lng: 100.9 },
      externalRef: { source: "geocoder", id: "abc" },
      resolvedTier: 2,
    })

    await repo().merge(survivor, duplicate)
    const kept = await row(survivor)

    expect(kept?.lat).toBeCloseTo(13.9, 4)
    expect(kept?.externalRef).toEqual({ source: "geocoder", id: "abc" })
    expect(kept?.resolvedTier).toBe(2)
  })

  it("refuses a merge whose rows are not both there", async () => {
    const survivor = await repo().upsert(resolved)

    // Loud rather than silent: the engine has already repointed evidence at the
    // survivor by the time this runs, and a merge that quietly did nothing would
    // leave the duplicate in the table with none of its own evidence left.
    await expect(repo().merge(survivor, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(
      /cannot merge/,
    )
  })
})
