import { randomUUID } from "node:crypto"
import { places, schema } from "@dt/db"
import type { ScoreSet } from "@samsara/core"
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

describe.runIf(hasDb)("the places repo, scoring", () => {
  const d = () => db as NonNullable<typeof db>
  const repo = () => new PostgresPlaceRepo(d())

  beforeEach(async () => {
    await d().execute(sql`truncate table places restart identity cascade`)
  })

  const row = async (id: string) => (await d().select().from(places).where(eq(places.id, id)))[0]

  const set = (value: number, factor: string): ScoreSet => ({
    local: { value, because: [{ factor, contribution: value, evidenceIds: [] }] },
  })

  it("starts empty rather than at zero, because a resolver has no explanations", async () => {
    const id = await repo().upsert(resolved)

    // `{}` is not `{ local: { value: 0 } }`. An unscored place and a place that
    // scored badly must not render the same, which is the whole of decision 3.
    expect((await row(id))?.scores).toEqual({})
  })

  it("stores the value and its explanations through jsonb intact", async () => {
    const id = await repo().upsert(resolved)
    const scores: ScoreSet = {
      local: {
        value: 0.75,
        because: [
          { factor: "nativeLanguageShare", contribution: 0.5, evidenceIds: [randomUUID()] },
          { factor: "sourceDiversity", contribution: 0.25, evidenceIds: [] },
        ],
      },
    }

    await repo().writeScores(id, scores)

    // Read back whole, because `because` is what the card renders and a jsonb
    // round trip that reordered or re-typed it would show up nowhere else.
    expect((await row(id))?.scores).toEqual(scores)
  })

  it("replaces the whole set, so a key the pack stopped computing disappears", async () => {
    const id = await repo().upsert(resolved)
    await repo().writeScores(id, {
      ...set(0.9, "nativeLanguageShare"),
      tourist: { value: 0.2, because: [] },
    })

    await repo().writeScores(id, set(0.4, "nativeLanguageShare"))

    // A stale `tourist` under a fresh `local` would be a number with no factors
    // behind it, pointing at evidence that may since have moved.
    expect((await row(id))?.scores).toEqual(set(0.4, "nativeLanguageShare"))
  })

  it("touches nothing else on the row", async () => {
    const id = await repo().upsert(resolved)
    const before = await row(id)

    await repo().writeScores(id, set(0.5, "sourceDiversity"))
    const after = await row(id)

    // `evidence_count` especially: the scorer reads a capped window, and writing
    // a windowed count into a column that means "how many" would be worse than
    // leaving it.
    expect(after?.evidenceCount).toBe(before?.evidenceCount)
    expect(after?.lastSeenAt).toEqual(before?.lastSeenAt)
    expect(after?.canonicalName).toBe(before?.canonicalName)
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() as number)
  })

  it("survives a merge without inheriting the duplicate's numbers", async () => {
    const survivor = await repo().upsert(resolved)
    const duplicate = await repo().upsert({ ...resolved, canonicalName: "Kuay Tiew Rua" })
    await repo().writeScores(survivor, set(0.9, "nativeLanguageShare"))
    await repo().writeScores(duplicate, set(0.1, "nativeLanguageShare"))

    await repo().merge(survivor, duplicate)

    // Left alone by the fold, deliberately: the explanations point at evidence
    // the engine has just repointed, and recomputing is the score stage's job.
    // Guessing here would attach a `because` to the wrong receipts.
    expect((await row(survivor))?.scores).toEqual(set(0.9, "nativeLanguageShare"))
  })
})

/**
 * `page`, which is how both entity-shaped stages get their work.
 *
 * What needs a real database here is the keyset itself. The rows a resolve job
 * writes share a `first_seen_at` to the microsecond — it is a column default
 * evaluated inside one transaction — so "does the tie-break work" is a question
 * about what Postgres actually stores, and an in-memory fake that mints a
 * distinct timestamp per row cannot ask it.
 */
describe.runIf(hasDb)("the places repo, paging", () => {
  const d = () => db as NonNullable<typeof db>
  const repo = () => new PostgresPlaceRepo(d())

  beforeEach(async () => {
    await d().execute(sql`truncate table places restart identity cascade`)
  })

  /** `n` rows, all with the default `first_seen_at`, which is the hard case. */
  const fill = async (n: number): Promise<string[]> => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      ids.push(await repo().upsert({ ...resolved, canonicalName: `Place ${i}` }))
    }
    return ids
  }

  const walk = async (limit: number): Promise<string[]> => {
    const seen: string[] = []
    let cursor: string | null = null
    for (;;) {
      const page = await repo().page(cursor, limit)
      seen.push(...page.entities.map((row) => row.id))
      cursor = page.cursor
      if (cursor === null) break
    }
    return seen
  }

  it("walks every row exactly once, at full timestamp precision", async () => {
    // Seven rows written in quick succession. The failure this guards is a
    // cursor that loses microseconds on the way out and seeks from a moment
    // slightly *before* the row it names, which re-reads that row forever.
    const ids = await fill(7)
    const seen = await walk(3)
    expect(seen.length).toBe(7)
    expect(new Set(seen)).toEqual(new Set(ids))
  })

  it("breaks a tie on the id when rows share a timestamp exactly", async () => {
    // One resolve job's batch: the column default is evaluated once inside one
    // transaction, so these are equal to the microsecond and the timestamp alone
    // cannot order them.
    const firstSeenAt = new Date("2026-02-01T00:00:00.000Z")
    await d()
      .insert(places)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          canonicalName: `Batch ${i}`,
          city: "Bangkok",
          firstSeenAt,
          lastSeenAt: firstSeenAt,
        })),
      )

    const seen = await walk(2)
    const rows = await d().select({ id: places.id }).from(places).orderBy(places.id)
    expect(seen).toEqual(rows.map((row) => row.id))
  })

  it("orders oldest first, which is the order dedup's survivor depends on", async () => {
    await fill(5)
    const seen = await walk(2)
    const rows = await d()
      .select({ id: places.id })
      .from(places)
      .orderBy(places.firstSeenAt, places.id)
    expect(seen).toEqual(rows.map((row) => row.id))
  })

  it("ends on a short page without another round trip", async () => {
    await fill(2)
    const page = await repo().page(null, 5)
    expect(page.entities).toHaveLength(2)
    expect(page.cursor).toBeNull()
  })

  it("returns an empty, finished page against an empty table", async () => {
    await expect(repo().page(null, 5)).resolves.toEqual({ entities: [], cursor: null })
  })

  it("reads a row back as the entity the resolver wrote", async () => {
    await repo().upsert(resolved)
    const page = await repo().page(null, 5)
    expect(page.entities[0]?.entity).toEqual(resolved)
  })

  it("reads a row with no coordinate back as one null, not two", async () => {
    // The pairing `upsert` flattens into two columns, read back. A row with one
    // half set is not a coordinate and must not come back looking like one.
    await repo().upsert({ ...resolved, geo: null, externalRef: null, resolvedTier: null })
    const page = await repo().page(null, 5)
    expect(page.entities[0]?.entity.geo).toBeNull()
  })

  it("refuses a cursor it did not mint rather than reporting an empty table", async () => {
    await fill(2)
    await expect(repo().page("somewhere", 5)).rejects.toThrow(/cursor/)
  })

  it("does not skip a row when a merge removes one the caller has passed", async () => {
    const ids = await fill(6)
    const first = await repo().page(null, 3)
    await repo().merge(first.entities[1]?.id ?? "", first.entities[0]?.id ?? "")

    const second = await repo().page(first.cursor, 3)
    const tail = ids.filter((id) => !first.entities.some((row) => row.id === id))
    expect(new Set(second.entities.map((row) => row.id))).toEqual(new Set(tail))
  })
})
