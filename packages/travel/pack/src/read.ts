import type { Place, PlaceCategory } from "@dt/core"
import { evidence, osmPlaces, places } from "@dt/db"
import type { ScoreSet } from "@samsara/core"
import { and, eq, ilike, inArray, or, sql, type TablesRelationalConfig } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"

/**
 * The read side of `places`, for the grid P2.7 draws at `/lab/places`.
 *
 * A separate entry point from `./postgres` because its one caller is the API,
 * which compiles against the Workers runtime and takes nothing it does not need:
 * this file imports two tables, the query builder, and types. The repo in
 * `./postgres` is the pipeline's writer and carries the dedup keys and the
 * resolver's types with it.
 *
 * **The domain id is written out rather than imported from `travelPack`,** for
 * the same reason — `pack.ts` reaches the prompt, and the prompt reaches the LLM
 * package. `read.test.ts` holds the two equal.
 */
export const TRAVEL_DOMAIN_ID = "travel"

/** One quote, shaped the way `@dt/ui`'s `CardEvidence` is. */
export interface PlaceQuote {
  quote: string
  sourceId: string
  sourceUrl: string
  language: string | null
}

export interface PlaceCardRow {
  place: Place
  /** Null when no evidence row for this place carries a quote. */
  quote: PlaceQuote | null
}

/**
 * The numbers Phase 2's acceptance is written in: how many places, how many with
 * a coordinate, and how many with `scores.local` above 0.7.
 */
export interface PlaceSummary {
  total: number
  withGeo: number
  strong: number
}

/** The threshold the acceptance names: "at least 30 with scores.local above 0.7". */
export const STRONG_LOCAL = 0.7

export interface PlaceReader {
  /** The strongest local scores first, at most `limit` of them, optionally of one category. */
  top(limit: number, category?: PlaceCategory): Promise<PlaceCardRow[]>
  summary(): Promise<PlaceSummary>
  /**
   * Places whose local or roman name contains `query`, strongest local score
   * first — what `/place` in the Trip Document searches (P4.2).
   */
  search(query: string, limit: number): Promise<PlaceCardRow[]>
  /** One place as the card reads it, or null. What a Postcard's REFRESH re-reads. */
  byId(id: string): Promise<PlaceCardRow | null>
}

/** `%` and `_` are wildcards to `ilike`; a name containing either means them literally. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

// The same widening `./postgres` uses, so a caller holding any drizzle Postgres
// database — postgres-js on the worker, Hyperdrive's on the API — can pass it.
type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>

/**
 * Two queries, and the second is bounded by the first.
 *
 * **The order is `scores.local` descending with an unscored place read as zero,**
 * then id — the same order `byLocalScore` puts on the card grid, short of its
 * middle tie-break on evidence count, which would need the count for every row in
 * the table to pick the first page. The grid re-sorts what it is given, so the
 * only effect is at the boundary of `limit`, among places tied on score.
 *
 * **`evidenceCount` is counted here, not read from the column.** Nothing in the
 * pipeline maintains `places.evidence_count`: the repo inserts it at its default
 * of zero, only a merge adds to it, and evidence is written by the engine, which
 * has never heard of the column. Reading it would show every place as having no
 * evidence while the card quoted some. The count comes back with the quote, in
 * one window over the rows this page already needed.
 *
 * **The quote is the newest one**, for the reason `EVIDENCE_PER_ENTITY` reads
 * newest first: a card is a claim about what the corpus says now.
 */
export class PostgresPlaceReader implements PlaceReader {
  constructor(private readonly db: Db) {}

  async top(limit: number, category?: PlaceCategory): Promise<PlaceCardRow[]> {
    const rows = await this.db
      .select()
      .from(places)
      .where(category ? eq(places.category, category) : undefined)
      .orderBy(sql`coalesce((${places.scores}->'local'->>'value')::float8, 0) desc`, places.id)
      .limit(limit)
    return await this.withQuotes(rows)
  }

  async summary(): Promise<PlaceSummary> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        withGeo: sql<number>`count(${places.lat})::int`,
        strong: sql<number>`(count(*) filter (where (${places.scores}->'local'->>'value')::float8 > ${STRONG_LOCAL}))::int`,
      })
      .from(places)
    return row ?? { total: 0, withGeo: 0, strong: 0 }
  }

  /**
   * `ilike` on both names, not trigram: `places` has no trigram index, and at the
   * size the table is (hundreds, a city's worth) a scan answers faster than the
   * index would be worth maintaining. Thai has no case, so `ilike` is only doing
   * work on the roman name, which is the one people type.
   */
  async search(query: string, limit: number): Promise<PlaceCardRow[]> {
    const pattern = `%${escapeLike(query.trim())}%`
    const rows = await this.db
      .select()
      .from(places)
      .where(or(ilike(places.canonicalName, pattern), ilike(places.localName, pattern)))
      .orderBy(sql`coalesce((${places.scores}->'local'->>'value')::float8, 0) desc`, places.id)
      .limit(limit)
    return await this.withQuotes(rows)
  }

  async byId(id: string): Promise<PlaceCardRow | null> {
    const rows = await this.db.select().from(places).where(eq(places.id, id))
    const [row] = await this.withQuotes(rows)
    return row ?? null
  }

  private async withQuotes(rows: (typeof places.$inferSelect)[]): Promise<PlaceCardRow[]> {
    if (rows.length === 0) return []

    const ids = rows.map((row) => row.id)
    const quotes = await this.db
      .selectDistinctOn([evidence.entityId], {
        entityId: evidence.entityId,
        quote: sql<string | null>`${evidence.extract}->>'quote'`,
        sourceId: evidence.sourceId,
        sourceUrl: evidence.sourceUrl,
        language: evidence.language,
        // Evaluated before DISTINCT ON keeps one row, so this counts every row
        // for the place, quoted or not.
        count: sql<number>`(count(*) over (partition by ${evidence.entityId}))::int`,
      })
      .from(evidence)
      .where(and(eq(evidence.domainId, TRAVEL_DOMAIN_ID), inArray(evidence.entityId, ids)))
      .orderBy(
        evidence.entityId,
        // A quoted row before an unquoted one, then newest. `false` sorts first.
        sql`(coalesce(${evidence.extract}->>'quote', '') = '')`,
        sql`${evidence.capturedAt} desc`,
        evidence.id,
      )
    const byId = new Map(quotes.map((q) => [q.entityId, q]))

    return rows.map((row) => {
      const q = byId.get(row.id)
      return {
        place: {
          id: row.id,
          canonicalName: row.canonicalName,
          localName: row.localName,
          city: row.city,
          // Null together or set together, as `upsert` writes them.
          geo: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
          externalRef: row.externalRef as Place["externalRef"],
          resolvedTier: row.resolvedTier as Place["resolvedTier"],
          category: row.category as PlaceCategory,
          tags: row.tags,
          // Written only through `writeScores`, whose input the engine built.
          scores: row.scores as ScoreSet,
          firstSeenAt: row.firstSeenAt,
          lastSeenAt: row.lastSeenAt,
          evidenceCount: q?.count ?? 0,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        quote: q?.quote
          ? {
              quote: q.quote,
              sourceId: q.sourceId,
              sourceUrl: q.sourceUrl,
              language: q.language,
            }
          : null,
      }
    })
  }
}

/**
 * A point of interest from the OpenStreetMap extract that no harvest has scored.
 *
 * `/place` falls back to these when the scored table has too little to show,
 * so a traveller who types "Wat Pho" gets Wat Pho, with its coordinate, labelled
 * as not scored rather than a blank result.
 */
export interface OsmMatch {
  /** `node/123` or `way/456`, the extract's own id. */
  osmId: string
  name: string
  localName: string | null
  /**
   * The formal name, when `name` is the common one: tells the Wat Pho everyone
   * means from the smaller temple that is actually named วัดโพธิ์.
   */
  formalName: string | null
  category: PlaceCategory
  geo: { lat: number; lng: number }
}

export interface OsmPlaceIndex {
  /**
   * Extract rows whose name, Thai name or English name contains `query`, closest
   * name first. Rows already promoted to `places` are left out: those come back
   * from `PlaceReader.search` with whatever the pipeline knows about them.
   */
  search(query: string, limit: number): Promise<OsmMatch[]>
  /**
   * The `places` row for an extract row, created on first use. It gets the same
   * `externalRef` and tier Tier 1 resolution would give it, so a later harvest
   * that resolves a mention to this POI merges into it through dedup's
   * `externalRef` key and the card gains scores instead of getting a twin.
   * Null for an id the extract does not hold.
   */
  promote(osmId: string): Promise<PlaceCardRow | null>
}

/** Enough for any name; past it the query is a sentence, not a name. */
const MAX_WORDS = 6

const osmRef = (osmId: string) => sql`jsonb_build_object('source', 'osm', 'id', ${osmId}::text)`

/** Thai script, the test for whether the extract's primary `name` is the local one. */
const THAI = /[฀-๿]/

export class PostgresOsmPlaceIndex implements OsmPlaceIndex {
  constructor(private readonly db: Db) {}

  async search(query: string, limit: number): Promise<OsmMatch[]> {
    const q = query.trim()
    const words = q
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .slice(0, MAX_WORDS)
    if (words.length === 0) return []
    const rows = await this.db
      .select({
        id: osmPlaces.id,
        name: osmPlaces.name,
        nameLocal: osmPlaces.nameLocal,
        nameEn: osmPlaces.nameEn,
        commonName: osmPlaces.commonName,
        commonLocal: osmPlaces.commonLocal,
        category: osmPlaces.category,
        lat: osmPlaces.lat,
        lng: osmPlaces.lng,
      })
      .from(osmPlaces)
      .where(
        and(
          // Every word somewhere in any name, so "temple of dawn" finds "Temple
          // of the Dawn" and "pho wat" still finds Wat Pho. Thai has no spaces,
          // so a Thai query is one word and this is a plain contains.
          ...words.map(
            (word) =>
              sql`(${osmPlaces.name} || ' ' || coalesce(${osmPlaces.nameLocal}, '') || ' ' || coalesce(${osmPlaces.nameEn}, '') || ' ' || array_to_string(${osmPlaces.altNames}, ' ')) ilike ${`%${escapeLike(word)}%`}`,
          ),
          sql`not exists (select 1 from ${places} where ${places.externalRef} = jsonb_build_object('source', 'osm', 'id', ${osmPlaces.id}))`,
        ),
      )
      .orderBy(
        // The best any name reaches, the common and alternate ones included, so
        // the Wat Pho everyone means outranks the smaller temple actually named
        // วัดโพธิ์. Past that, a mapped common name is a sign of a place people
        // talk about.
        sql`greatest(similarity(${osmPlaces.name}, ${q}), similarity(coalesce(${osmPlaces.nameLocal}, ''), ${q}), similarity(coalesce(${osmPlaces.nameEn}, ''), ${q}), coalesce((select max(similarity(a, ${q})) from unnest(${osmPlaces.altNames}) a), 0)) desc`,
        sql`(${osmPlaces.commonName} is null)`,
        // "other" is the extract's catch-all: bus stops, piers, offices. A temple
        // or a market of the same name is almost always what was meant.
        sql`(${osmPlaces.category} = 'other')`,
        osmPlaces.id,
      )
      .limit(limit)
    return rows.map((r) => {
      const names = namesOf(r)
      return {
        osmId: r.id,
        name: names.canonicalName,
        localName: names.localName,
        formalName: r.commonName ? (r.nameEn ?? r.name) : null,
        category: r.category as PlaceCategory,
        geo: { lat: r.lat, lng: r.lng },
      }
    })
  }

  async promote(osmId: string): Promise<PlaceCardRow | null> {
    const reader = new PostgresPlaceReader(this.db)
    const existing = await this.promoted(osmId)
    if (existing) return await reader.byId(existing)

    const [row] = await this.db.select().from(osmPlaces).where(eq(osmPlaces.id, osmId))
    if (!row) return null
    const names = namesOf(row)
    const [inserted] = await this.db
      .insert(places)
      .values({
        canonicalName: names.canonicalName,
        localName: names.localName,
        city: row.city,
        lat: row.lat,
        lng: row.lng,
        externalRef: { source: "osm", id: row.id },
        resolvedTier: 1,
        category: row.category,
        tags: row.tags,
      })
      .returning({ id: places.id })
    if (!inserted) throw new Error("places insert returned no row")
    return await reader.byId(inserted.id)
  }

  private async promoted(osmId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: places.id })
      .from(places)
      .where(sql`${places.externalRef} = ${osmRef(osmId)}`)
      .orderBy(places.createdAt)
      .limit(1)
    return row?.id ?? null
  }
}

/**
 * The card's two names from the extract's. OSM's `name` is whatever is on the
 * sign, usually Thai in Bangkok; `name:en` is the roman one when mapped; and the
 * common names, when there are any, are what people actually call it.
 */
function namesOf(row: {
  name: string
  nameLocal: string | null
  nameEn: string | null
  commonName: string | null
  commonLocal: string | null
}): {
  canonicalName: string
  localName: string | null
} {
  const canonicalName = row.commonName ?? row.nameEn ?? row.name
  const local = row.commonLocal ?? row.nameLocal ?? (THAI.test(row.name) ? row.name : null)
  return { canonicalName, localName: local === canonicalName ? null : local }
}
