import type { Place, PlaceCategory } from "@dt/core"
import { evidence, places } from "@dt/db"
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

export interface PlaceReader {
  /** The strongest local scores first, at most `limit` of them. */
  top(limit: number): Promise<PlaceCardRow[]>
  /**
   * Places whose local or roman name contains `query`, strongest local score
   * first — what `/place` in the Trip Document searches (P4.2).
   */
  search(query: string, limit: number): Promise<PlaceCardRow[]>
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

  async top(limit: number): Promise<PlaceCardRow[]> {
    const rows = await this.db
      .select()
      .from(places)
      .orderBy(sql`coalesce((${places.scores}->'local'->>'value')::float8, 0) desc`, places.id)
      .limit(limit)
    return await this.withQuotes(rows)
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
