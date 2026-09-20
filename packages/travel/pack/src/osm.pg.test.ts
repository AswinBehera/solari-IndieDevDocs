import { osmPlaces, schema } from "@dt/db"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { OsmPlaceRow } from "./osm-tags.js"
import { PostgresOsmSearch, upsertOsmPlaces } from "./postgres.js"
import { BANGKOK } from "./tier0.js"

/**
 * Tier 1 against a real Postgres, which is the only place it can be tested.
 *
 * Every interesting thing in `PostgresOsmSearch` is something no fake has: the
 * `pg_trgm` extension, the `%` operator, `similarity()`, `greatest()` over a
 * cross product of spellings and columns, and whether any of that is valid SQL
 * at all. A mock would assert the shape of a string we made up.
 *
 * The fixtures are real Bangkok POIs with real name tags, including the case the
 * whole tier exists for: a row whose `name` is Thai and whose `name:en` is a
 * romanisation nobody would guess from the Thai.
 *
 * Runs whenever `DATABASE_URL` is set, and **fails loudly when it is not** unless
 * `SAMSARA_NO_DB=1` says the omission is deliberate.
 */

const url = process.env.DATABASE_URL
const hasDb = typeof url === "string" && url.length > 0
const optedOut = process.env.SAMSARA_NO_DB === "1"

if (!hasDb && !optedOut) {
  describe("Tier 1, against Postgres", () => {
    it("has a database to run against", () => {
      expect.fail(
        "DATABASE_URL is not set, so the trigram search would have skipped and this " +
          "run would have reported green while testing nothing. Run `pnpm db:up` " +
          "and retry, or set SAMSARA_NO_DB=1 to skip on purpose.",
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

describe.runIf(hasDb)("Tier 1, against Postgres", () => {
  const d = () => db as NonNullable<typeof db>
  const osm = () => new PostgresOsmSearch(d())

  beforeEach(async () => {
    await d().execute(sql`truncate table osm_places restart identity cascade`)
    await d()
      .insert(osmPlaces)
      .values([
        {
          id: "node/1",
          city: "Bangkok",
          name: "ก๋วยเตี๋ยวเรือทองหล่อ",
          nameLocal: "ก๋วยเตี๋ยวเรือทองหล่อ",
          nameEn: "Kuay Teow Reua Thonglor",
          lat: 13.7263,
          lng: 100.5148,
          category: "food",
        },
        {
          id: "node/2",
          city: "Bangkok",
          name: "เจ๊โอวข้าวต้มเป็ด",
          nameLocal: "เจ๊โอวข้าวต้มเป็ด",
          nameEn: null,
          lat: 13.7512,
          lng: 100.5086,
          category: "food",
        },
        {
          id: "node/3",
          city: "Bangkok",
          name: "Wat Pho",
          nameLocal: "วัดโพธิ์",
          nameEn: "Wat Pho",
          lat: 13.7465,
          lng: 100.4927,
          category: "temple",
        },
        // Same name, different city. The city filter is not decoration: shop
        // names repeat across Thailand and a match here would be a pin 700km out.
        {
          id: "node/4",
          city: "Chiang Mai",
          name: "ก๋วยเตี๋ยวเรือทองหล่อ",
          nameLocal: "ก๋วยเตี๋ยวเรือทองหล่อ",
          nameEn: null,
          lat: 18.7883,
          lng: 98.9853,
          category: "food",
        },
      ])
  })

  it("matches a Thai name written in Thai", async () => {
    const [hit] = await osm().search(["ก๋วยเตี๋ยวเรือทองหล่อ"], BANGKOK)
    expect(hit?.osmId).toBe("node/1")
    expect(hit?.confidence).toBe(1)
  })

  it("matches the romanisation against name:en, which is why the tier works", async () => {
    // ADR-0007's premise was that only Google indexes a Thai shop name. This is
    // the counter-example: OSM carries the romanisation as a separate tag, and a
    // mention that arrived only in Latin script still resolves.
    const [hit] = await osm().search(["Kuay Teow Reua Thonglor"], BANGKOK)
    expect(hit?.osmId).toBe("node/1")
  })

  it("tolerates a misspelling, which is the point of trigrams over equality", async () => {
    const [hit] = await osm().search(["Kuay Tiew Rua Thonglor"], BANGKOK)
    expect(hit?.osmId).toBe("node/1")
    expect(hit?.confidence).toBeGreaterThan(0.3)
    expect(hit?.confidence).toBeLessThan(1)
  })

  it("scores every spelling against every name column and keeps the best", async () => {
    // The Thai spelling is a miss for node/3's `name` and an exact hit for its
    // `name:th`. A query that scored only one column would rank this below noise.
    const [hit] = await osm().search(["ไม่มีอยู่จริงเลย", "วัดโพธิ์"], BANGKOK)
    expect(hit?.osmId).toBe("node/3")
    expect(hit?.confidence).toBe(1)
  })

  it("never returns another city's rows", async () => {
    const hits = await osm().search(["ก๋วยเตี๋ยวเรือทองหล่อ"], BANGKOK)
    expect(hits.map((hit) => hit.osmId)).not.toContain("node/4")
  })

  it("returns nothing rather than the least-bad row", async () => {
    // A geocoder answers something for any string; this tier must not. The
    // resolver's job is to tell "no match" from "could not look", and a
    // best-effort row here would make that distinction unavailable.
    expect(await osm().search(["Eiffel Tower"], BANGKOK)).toEqual([])
  })

  it("ranks better matches first, so the resolver's floor means something", async () => {
    const hits = await osm().search(["ข้าวต้มเป็ด"], BANGKOK)
    expect(hits[0]?.osmId).toBe("node/2")
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]?.confidence).toBeGreaterThanOrEqual(hits[i]?.confidence ?? 0)
    }
  })

  it("asks nothing at all for an empty list of spellings", async () => {
    expect(await osm().search([], BANGKOK)).toEqual([])
    expect(await osm().search(["  "], BANGKOK)).toEqual([])
  })

  it("writes a predicate the trigram indexes can answer", async () => {
    // What this can prove and what it cannot, stated plainly.
    //
    // It proves the predicate is *index-compatible*: with `enable_seqscan` off,
    // a bare `name % ?` is answered from the GIN index. That is the property
    // that breaks silently — wrapping an indexed column in `coalesce` removes
    // it, and this file's first draft did exactly that.
    //
    // It does not prove the planner will choose that path in the real query. On
    // these four rows it does not: it answers `city = 'Bangkok'` from the btree
    // and applies the trigram predicates as a filter. Whether that is still the
    // right plan over a loaded city extract is a measurement to take against
    // one, not an assertion to make here over four rows.
    // In a transaction, because `SET LOCAL` applies to one and because the pool
    // hands out connections per statement — a setting and the `explain` that
    // depends on it would otherwise run against different backends.
    const plans = await d().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`)
      const explain = async (where: ReturnType<typeof sql>) =>
        JSON.stringify(await tx.execute(sql`explain select id from osm_places where ${where}`))
      return {
        name: await explain(sql`${osmPlaces.name} % 'ทองหล่อ'`),
        local: await explain(sql`${osmPlaces.nameLocal} % 'ทองหล่อ'`),
        // The negative case, so the two above are about this predicate rather
        // than about Postgres naming an index in any plan at all.
        wrapped: await explain(sql`coalesce(${osmPlaces.name}, '') % 'ทองหล่อ'`),
      }
    })

    expect(plans.name).toContain("osm_places_name_trgm_idx")
    expect(plans.local).toContain("osm_places_name_local_trgm_idx")
    expect(plans.wrapped).not.toContain("osm_places_name_trgm_idx")
  })
})

/**
 * The writer, tested where the reader is, because the reader depends on it.
 *
 * `tools/load-osm.ts` is the only caller and cannot be tested at all — it is a
 * fetch against volunteer infrastructure. What can be tested is the half that
 * touches the database, and the property that matters is the one a second run
 * exercises: an extract refreshed months later is mostly rows that are already
 * here, and Tier 1 has to keep answering throughout.
 */
describe.runIf(hasDb)("loading an extract", () => {
  const d = () => db as NonNullable<typeof db>

  const row = (over: Partial<OsmPlaceRow> = {}): OsmPlaceRow => ({
    id: "node/1",
    city: "Bangkok",
    name: "ก๋วยเตี๋ยวเรือทองหล่อ",
    nameLocal: "ก๋วยเตี๋ยวเรือทองหล่อ",
    nameEn: "Kuay Teow Reua Thonglor",
    lat: 13.7263,
    lng: 100.5148,
    category: "food",
    tags: ["restaurant", "thai"],
    ...over,
  })

  const stored = async (id: string) =>
    (await d().select().from(osmPlaces).where(eq(osmPlaces.id, id)))[0]

  beforeEach(async () => {
    await d().execute(sql`truncate table osm_places restart identity cascade`)
  })

  it("writes rows a search can find", async () => {
    expect(await upsertOsmPlaces(d(), [row()])).toBe(1)
    const [hit] = await new PostgresOsmSearch(d()).search(["Kuay Teow Reua Thonglor"], BANGKOK)
    expect(hit?.osmId).toBe("node/1")
  })

  it("refreshes a POI in place rather than duplicating it", async () => {
    // The whole reason the primary key is OSM's `<type>/<id>` and not ours. A
    // second run of the same query is the ordinary case, not the exception.
    await upsertOsmPlaces(d(), [row()])
    await upsertOsmPlaces(d(), [row({ name: "ก๋วยเตี๋ยวเรือ ทองหล่อ", category: "drink" })])

    const all = await d().select().from(osmPlaces)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ name: "ก๋วยเตี๋ยวเรือ ทองหล่อ", category: "drink" })
  })

  it("keeps when we first saw the POI, and moves when we last looked", async () => {
    await upsertOsmPlaces(d(), [row()])
    const first = await stored("node/1")
    await upsertOsmPlaces(d(), [row({ name: "renamed" })])
    const second = await stored("node/1")

    // `created_at` is the only thing in the table that could answer "how long
    // has this been in our extract"; an upsert that overwrote it would answer
    // "always today".
    expect(second?.createdAt).toEqual(first?.createdAt)
    expect(second?.updatedAt.getTime()).toBeGreaterThanOrEqual(first?.updatedAt.getTime() ?? 0)
  })

  it("clears a spelling OSM has dropped, rather than keeping a stale one", async () => {
    // The tempting alternative — only overwrite non-null values — would make the
    // table accumulate spellings that no longer exist anywhere, and Tier 1 would
    // go on matching a name the place has not had for a year.
    await upsertOsmPlaces(d(), [row()])
    await upsertOsmPlaces(d(), [row({ nameEn: null })])
    expect((await stored("node/1"))?.nameEn).toBeNull()
  })

  it("writes more rows than fit in one statement", async () => {
    // Postgres binds at most 65,535 parameters, so the loader batches. A city
    // extract is six figures of rows and the batching is the difference between
    // a load and a crash at row 8,192.
    const rows = Array.from({ length: 2_500 }, (_, i) =>
      row({ id: `node/${i}`, name: `Place ${i}`, nameLocal: null, nameEn: null }),
    )
    expect(await upsertOsmPlaces(d(), rows)).toBe(2_500)
    const [count] = await d().select({ n: sql<number>`count(*)::int` }).from(osmPlaces)
    expect(count?.n).toBe(2_500)
  })

  it("writes nothing, and asks nothing, for an empty extract", async () => {
    // An INSERT with no VALUES is a syntax error, and "Overpass returned
    // nothing" has to be a quiet no-op rather than a crash — it is what a bbox
    // with a typo in it looks like.
    expect(await upsertOsmPlaces(d(), [])).toBe(0)
  })
})
