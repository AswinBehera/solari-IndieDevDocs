import { entityResolutions, evidence, harvestRuns, mentions, rawItems } from "@samsara/db"
import { and, asc, desc, eq, inArray, sql, type TablesRelationalConfig } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type {
  CachedResolution,
  EntityLinks,
  EvidenceRecord,
  EvidenceStore,
  EvidenceWriter,
  MentionFilter,
  MentionRecord,
  MentionRow,
  MentionSink,
  MentionStore,
  PendingMention,
  PendingMentionReader,
  RepointCount,
  ResolutionCache,
  ResolutionCommit,
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

/**
 * The resolve stage's cache, in Postgres (P2.3).
 *
 * The two halves of `commit` go in one transaction, which is the whole reason
 * the port has one method rather than two. Under ADR-0014 a runner is killed
 * between statements as a matter of routine, and the residue that must never be
 * left behind is a cache row claiming an entity that no mention points at — or
 * the reverse, mentions pointing at an entity the cache has no memory of
 * resolving, which would be re-resolved and re-paid for on the next run.
 */
export class PostgresResolutionCache implements ResolutionCache {
  constructor(private readonly db: Db) {}

  async read(domainId: string, keys: readonly string[]): Promise<Map<string, CachedResolution>> {
    // `inArray` with no values is not a query drizzle will build, and an empty
    // page is the ordinary end of a backlog rather than an exceptional case.
    if (keys.length === 0) return new Map()
    const rows = await this.db
      .select({
        key: entityResolutions.key,
        state: entityResolutions.state,
        entityId: entityResolutions.entityId,
        tier: entityResolutions.tier,
        confidence: entityResolutions.confidence,
        attempts: entityResolutions.attempts,
      })
      .from(entityResolutions)
      .where(
        and(eq(entityResolutions.domainId, domainId), inArray(entityResolutions.key, [...keys])),
      )

    return new Map(
      rows.map((row) => [
        row.key,
        {
          state: row.state,
          entityId: row.entityId,
          tier: row.tier,
          confidence: row.confidence,
          attempts: row.attempts,
        },
      ]),
    )
  }

  async commit(entry: ResolutionCommit): Promise<void> {
    await this.db.transaction(async (tx) => {
      /**
       * Upsert on `(domain_id, key)`, and note that `attempts` is written as an
       * expression rather than a value. The caller says *whether* this attempt
       * counted, never what the total is: two runners working overlapping pages
       * would both have read the same total and would both write it back, and
       * the budget this counter protects would then never be reached.
       */
      await tx
        .insert(entityResolutions)
        .values({
          domainId: entry.domainId,
          key: entry.key,
          state: entry.state,
          entityId: entry.entityId,
          tier: entry.tier,
          confidence: entry.confidence,
          attempts: entry.deferred ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: [entityResolutions.domainId, entityResolutions.key],
          set: {
            state: entry.state,
            entityId: entry.entityId,
            tier: entry.tier,
            confidence: entry.confidence,
            attempts: entry.deferred
              ? sql`${entityResolutions.attempts} + 1`
              : entityResolutions.attempts,
            updatedAt: new Date(),
          },
        })

      if (entry.mentionIds.length === 0) return
      await tx
        .update(mentions)
        .set({ entityId: entry.entityId, resolution: entry.state, updatedAt: new Date() })
        .where(inArray(mentions.id, [...entry.mentionIds]))
    })
  }
}

/**
 * Mentions nobody has resolved yet, with the artifact each came from.
 *
 * An inner join for the same reason `PostgresMentionStore.list` uses one:
 * `mentions.raw_item_id` is `NOT NULL` and cascades, so a mention whose item is
 * gone does not exist, and a left join would add a branch the schema cannot
 * produce.
 */
export class PostgresPendingMentions implements PendingMentionReader {
  constructor(private readonly db: Db) {}

  async pending(domainId: string, limit?: number): Promise<PendingMention[]> {
    const rows = await this.db
      .select({
        id: mentions.id,
        rawItemId: mentions.rawItemId,
        domainId: mentions.domainId,
        packVersion: mentions.packVersion,
        payload: mentions.payload,
        sourceId: rawItems.sourceId,
        url: rawItems.url,
        title: rawItems.title,
        text: rawItems.text,
        languageGuess: rawItems.languageGuess,
      })
      .from(mentions)
      .innerJoin(rawItems, eq(mentions.rawItemId, rawItems.id))
      .where(and(eq(mentions.domainId, domainId), eq(mentions.resolution, "pending")))
      // Oldest first: this is a work queue, and newest-first would re-read one
      // page every run while the backlog behind it aged. `id` breaks ties so a
      // page is stable across two reads of the same millisecond.
      .orderBy(asc(mentions.createdAt), asc(mentions.id))
      .limit(boundedLimit(limit, MENTION_LIST_LIMIT))

    return rows.map((row) => ({
      id: row.id,
      rawItemId: row.rawItemId,
      domainId: row.domainId,
      packVersion: row.packVersion,
      payload: row.payload,
      item: {
        id: row.rawItemId,
        sourceId: row.sourceId,
        url: row.url,
        title: row.title,
        text: row.text,
        languageGuess: row.languageGuess,
      },
    }))
  }
}

/**
 * The real `EntityLinks`: three updates, one transaction.
 *
 * One transaction rather than three statements is the whole implementation, and
 * the reason is the port's: under ADR-0014 the runner is a scheduled process that
 * can be stopped between any two statements, and a corpus where the evidence and
 * the mentions disagree about which entity they describe is not a state anything
 * downstream can reason about. Either all three move or none do.
 *
 * Every clause is `entity_id = from` and therefore matches nothing the second
 * time, which is what lets the dedup stage run this *before* the pack's own
 * merge and still be safe to re-run — see `EntityRepo.merge` for why that order
 * is the one that survives being cut in half.
 *
 * `mentions` and `entity_resolutions` carry a nullable `entity_id` and `evidence`
 * does not, and the filter is written the same way for all three regardless: a
 * row with no entity was never pointing at the duplicate, so it is not this
 * operation's business.
 */
export class PostgresEntityLinks implements EntityLinks {
  constructor(private readonly db: Db) {}

  async repoint(domainId: string, from: string, into: string): Promise<RepointCount> {
    if (from === into) return { evidence: 0, mentions: 0, resolutions: 0 }

    return await this.db.transaction(async (tx) => {
      // `returning` a single column rather than reading `rowCount`, which the
      // generic `PgDatabase` type does not expose — the driver's result shape is
      // `unknown` here, and a cast to reach a count is the kind of thing that
      // stops being true when the driver changes. The id lists are small by
      // construction: they are the rows that pointed at one duplicate.
      const movedEvidence = await tx
        .update(evidence)
        .set({ entityId: into })
        .where(and(eq(evidence.domainId, domainId), eq(evidence.entityId, from)))
        .returning({ id: evidence.id })

      const movedMentions = await tx
        .update(mentions)
        .set({ entityId: into })
        .where(and(eq(mentions.domainId, domainId), eq(mentions.entityId, from)))
        .returning({ id: mentions.id })

      const movedResolutions = await tx
        .update(entityResolutions)
        .set({ entityId: into })
        .where(and(eq(entityResolutions.domainId, domainId), eq(entityResolutions.entityId, from)))
        .returning({ id: entityResolutions.id })

      return {
        evidence: movedEvidence.length,
        mentions: movedMentions.length,
        resolutions: movedResolutions.length,
      }
    })
  }
}

/**
 * How much of one entity's evidence a single scoring pass reads.
 *
 * Evidence is the only table in this pipeline that grows without a ceiling —
 * one row per claim, kept forever — and a place that goes around Thai TikTok
 * accumulates them faster than anything else here. An unbounded read would be
 * fine for a year and then be the query that takes the runner down, and it would
 * do it on exactly the entity the product cares most about getting right.
 *
 * So the read is capped per entity, newest first, and the cap is part of what a
 * score *means*: `scores.local` is computed over the most recent two hundred
 * claims about a place, not over all of them. That is a sampling decision and it
 * is written down here rather than discovered later from a slow query log. Two
 * hundred is large enough that the shares a factor computes are stable and small
 * enough that a page of two hundred entities is a bounded amount of memory.
 *
 * Newest first rather than oldest, because a score is a claim about what the
 * corpus says *now*: a shop that has become a tour-bus stop should stop reading
 * as local, and an oldest-first window would hold the original verdict forever.
 */
export const EVIDENCE_PER_ENTITY = 200

/**
 * The real `EvidenceWriter`: one `INSERT … SELECT`, and no rows through here.
 *
 * Every column of an evidence row is already in the database, one join away —
 * the mention carries the domain, the entity and the pack's own payload, the
 * raw item carries the source, the URL, the language, the capture time and the
 * engagement, and the harvest run carries the persona. Reading those back into
 * the engine to write them out again would be a round trip whose only purpose is
 * to compose a row Postgres can compose itself, and it would open a window
 * between the read and the write in which a merge could repoint the mention.
 *
 * Two clauses do the work that the port promises.
 *
 * `mentions.entity_id IS NOT NULL` drops the mentions that did not resolve. The
 * caller hands in everything it committed, because the caller cannot tell — a
 * key answered from the cache may have resolved to an entity last week or been
 * written off as unresolvable, and both come back through the same commit. A
 * row pointing at no entity would be counted by every factor and readable by
 * none, so the filter belongs here rather than in a caller that would have to
 * ask the cache a second time to know.
 *
 * `ON CONFLICT DO NOTHING` against `evidence_domain_mention_idx` makes the whole
 * operation idempotent, which is what lets it be the last thing the resolve
 * stage does. A run cut in half before it leaves resolutions written and
 * evidence unwritten; the next run re-commits those mentions from the cache and
 * records them then. A second runner over the same page adds nothing, which
 * matters more here than anywhere else in the pipeline: double-counted evidence
 * does not fail, it quietly changes every score computed from it.
 */
export class PostgresEvidenceWriter implements EvidenceWriter {
  constructor(private readonly db: Db) {}

  async record(domainId: string, mentionIds: readonly string[]): Promise<number> {
    if (mentionIds.length === 0) return 0

    const written = await this.db
      .insert(evidence)
      .select(
        this.db
          .select({
            // Every column of `evidence`, in the order the table declares them,
            // including the three with defaults. Drizzle's insert-select refuses
            // anything else — "selected fields are not the same or are in a
            // different order compared to the table definition" — and the
            // refusal is worth more than the tidier partial list would have
            // been: a column added to `evidence` fails this query loudly at the
            // first call rather than silently arriving null forever.
            id: sql<string>`gen_random_uuid()`.as("id"),
            domainId: mentions.domainId,
            // Non-null by the `where` below. Drizzle types the column nullable
            // because it is, and the narrowing a `WHERE` does is not something
            // the query builder's types can see.
            entityId: sql<string>`${mentions.entityId}`.as("entity_id"),
            mentionId: mentions.id,
            rawItemId: mentions.rawItemId,
            sourceId: rawItems.sourceId,
            sourceUrl: rawItems.url,
            personaId: harvestRuns.personaId,
            // The item's guess, carried rather than improved on. A better
            // language call is a job for whatever can read the text, and a
            // factor weighing this should know it is weighing a guess.
            language: rawItems.languageGuess,
            capturedAt: rawItems.capturedAt,
            // The pack's own mention payload, stored without being read. This is
            // the same seam `MentionRow.payload` is: the engine carries it.
            extract: mentions.payload,
            rawRef: rawItems.rawRef,
            engagementViews: rawItems.engagementViews,
            engagementLikes: rawItems.engagementLikes,
            engagementComments: rawItems.engagementComments,
            createdAt: sql<Date>`now()`.as("created_at"),
            updatedAt: sql<Date>`now()`.as("updated_at"),
          })
          .from(mentions)
          .innerJoin(rawItems, eq(rawItems.id, mentions.rawItemId))
          .innerJoin(harvestRuns, eq(harvestRuns.id, rawItems.harvestRunId))
          .where(
            and(
              eq(mentions.domainId, domainId),
              inArray(mentions.id, [...mentionIds]),
              sql`${mentions.entityId} is not null`,
            ),
          ),
      )
      .onConflictDoNothing()
      // `returning` rather than a row count, for the reason `PostgresEntityLinks`
      // gives: the generic `PgDatabase` type does not expose the driver's result
      // shape, and reaching a count through a cast stops being true when the
      // driver changes. The list is bounded by the page of mentions.
      .returning({ id: evidence.id })

    return written.length
  }
}

/**
 * The real `EvidenceStore`: one query for a whole page, capped per entity.
 *
 * The cap is a window function rather than a `LIMIT`, and that is the only
 * interesting thing in here. A `LIMIT` over the whole page would take the two
 * hundred newest rows *across* entities, which on a page containing one famous
 * place and a hundred quiet ones means the famous one takes the entire budget
 * and the rest come back empty — every one of them then reported as
 * `unevidenced` by a stage that was told they had nothing. `row_number() over
 * (partition by entity_id …)` gives each entity its own window, so the page's
 * quiet rows are unaffected by whatever the loud one is doing.
 *
 * The tiebreak on `id` is not decoration. Capture times collide — a harvest
 * writes a batch of items with one timestamp — and an unordered tiebreak means
 * the row that falls off the edge of the window is whichever the planner reached
 * first, so a score recomputed over unchanged data could move. With the id in
 * the ordering the window is deterministic and a score only changes when the
 * corpus does.
 */
export class PostgresEvidenceStore implements EvidenceStore {
  constructor(private readonly db: Db) {}

  async forEntities(
    domainId: string,
    entityIds: readonly string[],
  ): Promise<Map<string, EvidenceRecord[]>> {
    const out = new Map<string, EvidenceRecord[]>()
    if (entityIds.length === 0) return out

    const ranked = this.db
      .select({
        id: evidence.id,
        entityId: evidence.entityId,
        rawItemId: evidence.rawItemId,
        sourceId: evidence.sourceId,
        sourceUrl: evidence.sourceUrl,
        language: evidence.language,
        capturedAt: evidence.capturedAt,
        extract: evidence.extract,
        views: evidence.engagementViews,
        likes: evidence.engagementLikes,
        comments: evidence.engagementComments,
        rank: sql<number>`row_number() over (
          partition by ${evidence.entityId}
          order by ${evidence.capturedAt} desc, ${evidence.id}
        )`.as("rank"),
      })
      .from(evidence)
      .where(and(eq(evidence.domainId, domainId), inArray(evidence.entityId, [...entityIds])))
      .as("ranked")

    const rows = await this.db
      .select()
      .from(ranked)
      .where(sql`${ranked.rank} <= ${EVIDENCE_PER_ENTITY}`)
      .orderBy(ranked.entityId, ranked.rank)

    for (const row of rows) {
      const record: EvidenceRecord = {
        id: row.id,
        entityId: row.entityId,
        rawItemId: row.rawItemId,
        sourceId: row.sourceId,
        sourceUrl: row.sourceUrl,
        language: row.language,
        capturedAt: row.capturedAt,
        extract: row.extract,
        engagement: { views: row.views, likes: row.likes, comments: row.comments },
      }
      const bucket = out.get(row.entityId)
      if (bucket) bucket.push(record)
      else out.set(row.entityId, [record])
    }
    // An entity with no rows is absent rather than present-and-empty, which is
    // the port's promise and what lets the stage's "nothing to score" be one
    // check rather than two.
    return out
  }
}
