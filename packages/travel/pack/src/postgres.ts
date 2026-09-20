import { osmPlaces, places } from "@dt/db"
import type { DedupKey, DedupMatch, EntityRepo } from "@samsara/refine"
import { and, between, desc, eq, inArray, ne, sql, type TablesRelationalConfig } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import {
  asExternalRefKey,
  asGeoKey,
  boxAround,
  EXTERNAL_REF_KEY,
  GEO_KEY,
  metresBetween,
} from "./dedup.js"
import type { PlaceEntity } from "./entity.js"
import type { OsmPlaceRow } from "./osm-tags.js"
import type { OsmSearch } from "./resolve.js"
import type { City } from "./tier0.js"
import { normaliseName } from "./tier0.js"

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

  /**
   * The keys in the order the stage gave them, first hit wins (P2.4).
   *
   * The loop is here rather than in the stage because `EntityRepo.findByKeys`
   * says it must be: the strongest key is one indexed equality and the weakest is
   * a box scan plus a distance computation, and returning as soon as the cheap
   * one answers is the difference between dedup costing one query per entity and
   * costing all of them.
   */
  async findByKeys(keys: readonly DedupKey[], exclude: string): Promise<DedupMatch | null> {
    for (const key of keys) {
      const id =
        key.kind === EXTERNAL_REF_KEY
          ? await this.byExternalRef(key.value, exclude)
          : key.kind === GEO_KEY
            ? await this.byGeo(key.value, exclude)
            : unknownKey(key.kind)
      if (id !== null) return { id, kind: key.kind }
    }
    return null
  }

  /**
   * Whole-value jsonb equality, not two `->>` extractions.
   *
   * Both are correct and only one is indexable: `places_external_ref_idx` is a
   * btree over the whole `external_ref` column, so an expression around it takes
   * the index off the table — the same trap `PostgresOsmSearch` documents about
   * wrapping a trigram column in `coalesce`. jsonb equality ignores key order and
   * insignificant whitespace, so the comparison does not depend on how the writer
   * happened to serialise the object.
   *
   * What it *does* depend on is `external_ref` having exactly the two fields this
   * key carries. That is held by `placeEntity`, which the engine validates before
   * the repo is allowed to write, and it is the one thing to change here if a
   * third field is ever added — whole-value equality would stop matching silently,
   * and a duplicate that never collapses is a quiet failure.
   */
  private async byExternalRef(value: unknown, exclude: string): Promise<string | null> {
    const key = asExternalRefKey(value)
    const wanted = JSON.stringify({ source: key.source, id: key.id })
    const [row] = await this.db
      .select({ id: places.id })
      .from(places)
      .where(and(ne(places.id, exclude), sql`${places.externalRef} = ${wanted}::jsonb`))
      // Oldest first, so that when three rows carry one reference the survivor is
      // stable across runs rather than whichever the planner reached first.
      .orderBy(places.firstSeenAt, places.id)
      .limit(1)
    return row?.id ?? null
  }

  /**
   * A bounding box in SQL, then the real radius and the name comparison here.
   *
   * The split is the whole design of this key. The radius could be done in SQL
   * with `earthdistance` or PostGIS, and the name could be done in SQL with
   * `regexp_replace(lower(...))` — and that second one is where it falls apart.
   * `normaliseName` applies NFKC before it lowercases, because Thai arrives in
   * different normal forms from different keyboards, and Postgres has no NFKC
   * without an extension. A SQL normaliser would therefore be a *second, slightly
   * different* normalisation, and the two would disagree on exactly the rows this
   * key exists to catch while agreeing on every row a test would think to write.
   *
   * So the database does the part it is uniquely good at — throwing away
   * everything outside a lat/lng box, from an index, without reading it — and the
   * comparison that decides the merge runs once, in the one function that defines
   * it. A 150m box in a city returns a handful of rows.
   */
  private async byGeo(value: unknown, exclude: string): Promise<string | null> {
    const key = asGeoKey(value)
    const { dLat, dLng } = boxAround(key.lat, key.radiusM)
    const wanted = new Set(key.names)

    const rows = await this.db
      .select({
        id: places.id,
        canonicalName: places.canonicalName,
        localName: places.localName,
        lat: places.lat,
        lng: places.lng,
      })
      .from(places)
      .where(
        and(
          ne(places.id, exclude),
          between(places.lat, key.lat - dLat, key.lat + dLat),
          between(places.lng, key.lng - dLng, key.lng + dLng),
        ),
      )
      .orderBy(places.firstSeenAt, places.id)
      .limit(GEO_CANDIDATES)

    for (const row of rows) {
      const lat = Number(row.lat)
      const lng = Number(row.lng)
      // A row inside the box but outside the circle. The box is a superset by
      // construction — see `boxAround` — and these are its corners.
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      if (metresBetween(key, { lat, lng }) > key.radiusM) continue

      const names = [row.localName, row.canonicalName]
        .filter((name): name is string => name !== null)
        .map(normaliseName)
      if (names.some((name) => name.length > 0 && wanted.has(name))) return row.id
    }
    return null
  }

  /**
   * Fold `from` into `into`, then delete `from`.
   *
   * What folding means, field by field, and the argument is the same one each
   * time: **keep whichever side actually knows something.**
   *
   * - `geo` and `external_ref` and `resolved_tier` move together or not at all,
   *   and only when the survivor has no coordinate. They are one answer from one
   *   tier — a coordinate from Tier 1 with an `external_ref` from Tier 0 would be
   *   a row claiming OSM agrees with a pin it has never seen.
   * - `local_name` fills in when the survivor has none. A native-script name is
   *   the spelling that resolves, and the duplicate having one is the most useful
   *   thing it can contribute.
   * - `tags` are unioned, because they are things sources said about the place
   *   and two sources saying different things is more information, not a conflict.
   * - `first_seen_at` takes the earlier and `last_seen_at` the later, so the span
   *   over the merged row is the span over both.
   * - `evidence_count` adds, matching what `EntityLinks.repoint` just did to the
   *   rows themselves.
   * - `canonical_name`, `city`, `category` and `scores` are left alone. The
   *   survivor is the older row and these are the fields a reader has already
   *   seen; changing them on a merge would rename a place behind whatever is
   *   pointing at it. `scores` additionally belongs to P2.5 and has explanations
   *   attached to evidence that has itself just moved — recomputing it is that
   *   stage's job and guessing at it here would attach a `because` to the wrong
   *   receipts.
   *
   * One statement for the update, and the delete after it, inside one
   * transaction: the stage has already moved every engine pointer onto `into`, so
   * a half-finished merge that left both rows would be found and finished by the
   * next run, but a half-finished merge that deleted `from` without folding it
   * would have thrown the duplicate's coordinate away for good.
   */
  async merge(into: string, from: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(places)
        .where(inArray(places.id, [into, from]))
        .for("update")

      const survivor = rows.find((row) => row.id === into)
      const duplicate = rows.find((row) => row.id === from)
      if (!survivor || !duplicate) {
        throw new Error(`cannot merge ${from} into ${into}: no such row`)
      }

      const takesGeo = survivor.lat === null || survivor.lng === null
      const tags = [...new Set([...survivor.tags, ...duplicate.tags])]

      await tx
        .update(places)
        .set({
          localName: survivor.localName ?? duplicate.localName,
          ...(takesGeo
            ? {
                lat: duplicate.lat,
                lng: duplicate.lng,
                externalRef: duplicate.externalRef,
                resolvedTier: duplicate.resolvedTier,
              }
            : {}),
          tags,
          firstSeenAt:
            duplicate.firstSeenAt < survivor.firstSeenAt
              ? duplicate.firstSeenAt
              : survivor.firstSeenAt,
          lastSeenAt:
            duplicate.lastSeenAt > survivor.lastSeenAt ? duplicate.lastSeenAt : survivor.lastSeenAt,
          evidenceCount: survivor.evidenceCount + duplicate.evidenceCount,
          updatedAt: new Date(),
        })
        .where(eq(places.id, into))

      // Deleted rather than tombstoned. There is no `merged_into` column and
      // adding one is a migration this task does not need: the thing a tombstone
      // would answer — "where did this id go" — is already answered by
      // `entity_resolutions`, whose row for the key was repointed at the survivor
      // before this ran. `postcards.place_id` is `ON DELETE SET NULL`, which is
      // the one reference a delete can reach, and a postcard losing its pin to a
      // merge is a gap worth knowing about rather than a silent rewrite.
      await tx.delete(places).where(eq(places.id, from))
    })
  }
}

/**
 * How many rows inside the box are worth comparing.
 *
 * Twenty. The box is a 300m square and a name match inside it is the whole
 * question, so the only thing this bound protects against is a coordinate that is
 * wrong in a way that puts it on top of a dense cluster — a market, a mall, a
 * food court. In that case the first twenty by age are as good a sample as any,
 * and an unbounded read is how one bad coordinate turns a dedup run into a scan.
 */
const GEO_CANDIDATES = 20

/** Never reached by this pack's own keys; see `asGeoKey` for why it throws. */
const unknownKey = (kind: string): never => {
  throw new Error(`unknown dedup key kind "${kind}"`)
}

/**
 * How many rows go into one INSERT.
 *
 * Postgres binds at most 65,535 parameters per statement and each row binds
 * eight, so a thousand rows is ~8,000 — well under, and few enough statements
 * that a 200,000-row extract is not 200,000 round trips.
 */
const UPSERT_BATCH = 1000

/**
 * Write an OSM extract into `osm_places`, the table Tier 1 searches.
 *
 * The writer lives beside `PostgresOsmSearch` rather than in the loader tool for
 * one reason: the reader's behaviour depends on what the writer put in the
 * columns — which spelling landed in `name` versus `name_local`, whether a tag
 * list was deduplicated — and a test that exercises both at once can only exist
 * if both are importable from here. `tools/load-osm.ts` fetches, maps and
 * reports; this is the only part of it that touches the database.
 *
 * An upsert keyed on OSM's own `<type>/<id>`. A refresh is a re-run of the same
 * query months later, and the rows it returns are mostly the rows already here:
 * insert-only would fail on the first duplicate, and delete-then-insert would
 * empty the table Tier 1 is reading from for as long as the load takes.
 */
export async function upsertOsmPlaces(db: Db, rows: readonly OsmPlaceRow[]): Promise<number> {
  let written = 0
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH)
    await db
      .insert(osmPlaces)
      .values([...batch])
      .onConflictDoUpdate({
        target: osmPlaces.id,
        /**
         * `excluded` is the row the INSERT proposed, so a refresh takes OSM's
         * current answer for every column: a POI that was renamed, moved or
         * retagged updates rather than keeping the version first loaded.
         *
         * `created_at` is deliberately absent. It records when this extract
         * first saw the POI, and a reload did not make it new — it is the only
         * thing in the table that could ever answer "how long has this been in
         * OSM for us", and an upsert that overwrote it would answer "always
         * today".
         */
        set: {
          city: sql`excluded.city`,
          name: sql`excluded.name`,
          nameLocal: sql`excluded.name_local`,
          nameEn: sql`excluded.name_en`,
          lat: sql`excluded.lat`,
          lng: sql`excluded.lng`,
          category: sql`excluded.category`,
          tags: sql`excluded.tags`,
          updatedAt: sql`now()`,
        },
      })
    written += batch.length
  }
  return written
}
