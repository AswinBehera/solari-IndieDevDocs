import { osmPlaces, places } from "@dt/db"
import type { EntityRepo } from "@samsara/refine"
import { and, desc, eq, sql, type TablesRelationalConfig } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { PlaceEntity } from "./entity.js"
import type { OsmSearch } from "./resolve.js"
import type { City } from "./tier0.js"

/**
 * Tier 1, against our own OSM extract (ADR-0017).
 *
 * A separate entry point from the pack's barrel, following the convention the
 * engine's stores use: importing `@dt/travel-pack` must not drag a database
 * driver into a runtime that cannot load one, and `apps/api` compiles against
 * the Workers runtime.
 *
 * Typed against `PgDatabase` rather than a concrete client, like every other
 * store here, so a caller may pass a database composed with its own tables.
 */
type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>

/**
 * How many candidates to bring back.
 *
 * Five, not one. The resolver applies its own floor and its own bbox check, and
 * a query that returned only the top row would hand it a decision already made —
 * by `similarity` alone, which knows nothing about where the place is. Five is
 * enough for the second-best row to win when the best one is outside the city,
 * and small enough that the sort is free.
 */
const CANDIDATES = 5

/**
 * The similarity below which a row is not worth returning at all.
 *
 * Matches pg_trgm's own default for the `%` operator, deliberately: the `%` in
 * the WHERE clause is what makes the GIN index usable, and a floor in the
 * application that was *lower* than the operator's would be a floor that never
 * fires, quietly, because the rows it would have admitted were never fetched.
 * The resolver's own floor sits above this one.
 */
const SIMILARITY_FLOOR = 0.3

export class PostgresOsmSearch implements OsmSearch {
  constructor(private readonly db: Db) {}

  /**
   * Every spelling in one statement.
   *
   * The score is the best agreement any spelling reaches with any of the row's
   * three name columns. That cross product is the entire point of the tier: a
   * Thai source writes the shop's name in Thai and it matches `name:th`, an
   * English blog writes a romanisation and it matches `name:en`, and OSM's plain
   * `name` tag in Thailand is sometimes one and sometimes the other. Asking each
   * spelling separately would mean choosing which to trust, and there is no
   * basis for that choice at the point it would have to be made.
   *
   * `coalesce(..., '')` rather than leaving the nulls: `similarity()` of null is
   * null, and `greatest()` ignores nulls in Postgres — but the `%` operator in
   * the WHERE clause does not match a null either, so a row whose only populated
   * column is `name` would be filtered out by a predicate on `name_local`. The
   * empty string scores zero and stays out of the way.
   */
  async search(
    names: readonly string[],
    city: City,
  ): Promise<{ lat: number; lng: number; osmId: string; name: string; confidence: number }[]> {
    const wanted = names.map((name) => name.trim()).filter((name) => name.length > 0)
    if (wanted.length === 0) return []

    const columns = [
      sql`${osmPlaces.name}`,
      sql`coalesce(${osmPlaces.nameLocal}, '')`,
      sql`coalesce(${osmPlaces.nameEn}, '')`,
    ]
    const scores = sql.join(
      wanted.flatMap((name) => columns.map((column) => sql`similarity(${column}, ${name})`)),
      sql`, `,
    )
    /**
     * `%` on the raw columns, not the coalesced ones. An expression around an
     * indexed column takes the GIN index off the table entirely, which is a
     * change that breaks nothing visibly and makes this tier a scan.
     *
     * Index-*compatible* is all this guarantees. With a city predicate beside
     * it the planner may still answer `city = ?` from the btree and apply these
     * as a filter, which is what it does on a small table and may well remain
     * right on a large one — filtering one city's POIs is cheap. Which plan it
     * picks over a loaded extract is a measurement to take against one; that
     * the index *can* be used is the part that has to be true either way.
     */
    const matches = sql.join(
      wanted.flatMap((name) => [
        sql`${osmPlaces.name} % ${name}`,
        sql`${osmPlaces.nameLocal} % ${name}`,
        sql`${osmPlaces.nameEn} % ${name}`,
      ]),
      sql` or `,
    )

    // The query builder rather than `db.execute`: typed against the generic
    // `PgDatabase`, `execute` returns the driver's own result shape, which is
    // `unknown` here — so a raw statement would have to be cast, and a cast is
    // exactly the thing that stops being true when a column is renamed.
    const score = sql<number>`greatest(${scores})`
    const rows = await this.db
      .select({
        id: osmPlaces.id,
        name: osmPlaces.name,
        lat: osmPlaces.lat,
        lng: osmPlaces.lng,
        score,
      })
      .from(osmPlaces)
      .where(and(eq(osmPlaces.city, city.name), sql`(${matches})`))
      .orderBy(desc(score))
      .limit(CANDIDATES)

    const out: { lat: number; lng: number; osmId: string; name: string; confidence: number }[] = []
    for (const row of rows) {
      const confidence = Number(row.score)
      if (!Number.isFinite(confidence) || confidence < SIMILARITY_FLOOR) continue
      out.push({
        lat: Number(row.lat),
        lng: Number(row.lng),
        osmId: row.id,
        name: row.name,
        confidence,
      })
    }
    return out
  }
}

/**
 * `EntityRepo<PlaceEntity>` over the `places` table.
 *
 * An insert, not an upsert, despite the port's name. `EntityRepo.upsert` is
 * explicit that two resolutions of two spellings of one name legitimately
 * produce two rows here and that collapsing them is P2.4's job — a repo that
 * deduplicated early would hide exactly what P2.4 is measured on. The name is
 * the port's; the behaviour is the port's docstring's.
 *
 * Four columns are left to their defaults rather than written from the entity:
 * `scores` is P2.5's, and `first_seen_at`, `last_seen_at` and `evidence_count`
 * are facts about the corpus. A resolver holding one mention would be setting
 * them from a sample of one, and "seen once, just now" written confidently is
 * worse than the default that says the same thing without claiming to know.
 */
export class PostgresPlaceRepo implements EntityRepo<PlaceEntity> {
  constructor(private readonly db: Db) {}

  async upsert(entity: PlaceEntity): Promise<string> {
    const [row] = await this.db
      .insert(places)
      .values({
        canonicalName: entity.canonicalName,
        localName: entity.localName,
        city: entity.city,
        // Flattened into two columns, because that is what the table has. The
        // entity carries one nullable pair so that "no coordinate" is a single
        // state; the pair is null together or set together, and splitting it
        // here is the only place the two halves could drift apart.
        lat: entity.geo?.lat ?? null,
        lng: entity.geo?.lng ?? null,
        externalRef: entity.externalRef,
        resolvedTier: entity.resolvedTier,
        category: entity.category,
        tags: entity.tags,
      })
      .returning({ id: places.id })

    // The insert returns a row or throws; this is for the type, not for a case
    // that happens.
    if (!row) throw new Error("places insert returned no row")
    return row.id
  }
}
