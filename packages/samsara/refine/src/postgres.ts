import { mentions, rawItems } from "@samsara/db"
import { and, desc, eq, inArray, type TablesRelationalConfig } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type {
  MentionFilter,
  MentionRecord,
  MentionRow,
  MentionSink,
  MentionStore,
} from "./ports.js"
import { MENTION_LIST_LIMIT } from "./ports.js"

/**
 * The real mention stores.
 *
 * Typed against `PgDatabase` rather than a concrete client, like the harvest
 * stores and the kernel's, so a caller may pass a database composed with its own
 * vertical's tables while this file still touches only engine ones.
 */
type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>

/** Same clamp as the harvest stores use, duplicated rather than imported: this
 * package has no business depending on `@samsara/harvest` for four lines of
 * arithmetic, and a shared helper for it would have to live in `@samsara/core`,
 * which is a wider change than one list bound deserves. */
const boundedLimit = (limit: number | undefined, max: number): number => {
  if (limit === undefined || !Number.isFinite(limit)) return max
  return Math.max(1, Math.min(Math.floor(limit), max))
}

export class PostgresMentionSink implements MentionSink {
  constructor(private readonly db: Db) {}

  /**
   * One statement for the batch, for the reason `MentionSink` states: a runner
   * that may be cancelled at any moment should not be twenty round trips deep in
   * a loop when it is.
   *
   * The empty case returns early because drizzle refuses a `VALUES` list with no
   * rows, and a batch that found no mentions is the ordinary outcome here rather
   * than an exceptional one — two thirds of the golden set name nowhere.
   */
  async insertMany(rows: readonly MentionRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.db.insert(mentions).values(
      rows.map((row) => ({
        id: row.id,
        rawItemId: row.rawItemId,
        domainId: row.domainId,
        packVersion: row.packVersion,
        payload: row.payload,
        entityId: row.entityId,
        resolution: row.resolution,
        confidence: row.confidence,
      })),
    )
  }

  /**
   * Which of these items already have mentions at this pack version.
   *
   * `selectDistinct` on the one column the caller asked about: the answer is a
   * set of item ids, and pulling whole rows to build it would mean fetching every
   * mention of every item in order to throw all of them away. An item that named
   * eight places is one row here, not eight.
   *
   * The empty case returns early for the same reason the insert does — `inArray`
   * with no values is not a query drizzle will build.
   */
  async extractedIds(
    rawItemIds: readonly string[],
    domainId: string,
    packVersion: string,
  ): Promise<Set<string>> {
    if (rawItemIds.length === 0) return new Set()
    const rows = await this.db
      .selectDistinct({ rawItemId: mentions.rawItemId })
      .from(mentions)
      .where(
        and(
          inArray(mentions.rawItemId, [...rawItemIds]),
          eq(mentions.domainId, domainId),
          eq(mentions.packVersion, packVersion),
        ),
      )
    return new Set(rows.map((row) => row.rawItemId))
  }
}

export class PostgresMentionStore implements MentionStore {
  constructor(private readonly db: Db) {}

  /**
   * Mentions with the item each came from, newest first, always limited.
   *
   * An inner join, not a left one: `mentions.raw_item_id` is `NOT NULL` and
   * `ON DELETE cascade`, so a mention whose item is gone does not exist. Writing
   * it as a left join would add a branch for a row the schema cannot produce, and
   * the reader of that branch would reasonably assume it can.
   */
  async list(filter: MentionFilter): Promise<MentionRecord[]> {
    const where = [
      ...(filter.domainId ? [eq(mentions.domainId, filter.domainId)] : []),
      ...(filter.packVersion ? [eq(mentions.packVersion, filter.packVersion)] : []),
      ...(filter.resolution ? [eq(mentions.resolution, filter.resolution)] : []),
      ...(filter.rawItemId ? [eq(mentions.rawItemId, filter.rawItemId)] : []),
    ]

    const rows = await this.db
      .select({
        id: mentions.id,
        rawItemId: mentions.rawItemId,
        domainId: mentions.domainId,
        packVersion: mentions.packVersion,
        payload: mentions.payload,
        entityId: mentions.entityId,
        resolution: mentions.resolution,
        confidence: mentions.confidence,
        createdAt: mentions.createdAt,
        sourceId: rawItems.sourceId,
        url: rawItems.url,
        title: rawItems.title,
        languageGuess: rawItems.languageGuess,
      })
      .from(mentions)
      .innerJoin(rawItems, eq(mentions.rawItemId, rawItems.id))
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(mentions.createdAt), desc(mentions.id))
      .limit(boundedLimit(filter.limit, MENTION_LIST_LIMIT))

    return rows.map((row) => ({
      id: row.id,
      rawItemId: row.rawItemId,
      domainId: row.domainId,
      packVersion: row.packVersion,
      payload: row.payload,
      entityId: row.entityId,
      resolution: row.resolution,
      confidence: row.confidence,
      createdAt: row.createdAt,
      item: {
        sourceId: row.sourceId,
        url: row.url,
        title: row.title,
        languageGuess: row.languageGuess,
      },
    }))
  }
}
