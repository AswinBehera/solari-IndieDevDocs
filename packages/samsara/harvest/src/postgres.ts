import type { DriftState, Engagement, HarvestOutcome } from "@samsara/core"
import { driftExperiments, harvestRuns, rawItems } from "@samsara/db"
import { and, asc, desc, eq, inArray, lt, type TablesRelationalConfig } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type {
  DriftExperimentFilter,
  DriftExperimentRecord,
  DriftExperimentStore,
  HarvestRunFilter,
  HarvestRunRecord,
  HarvestRunStart,
  HarvestRunStore,
  RawItemRow,
  RawItemStore,
} from "./ports.js"
import {
  boundedLimit,
  EXPERIMENT_LIST_LIMIT,
  EXPERIMENT_RUN_LIMIT,
  ITEM_LIST_LIMIT,
  RUN_LIST_LIMIT,
} from "./ports.js"

/**
 * The real harvest stores.
 *
 * Typed against `PgDatabase` rather than a concrete client, like the kernel's and
 * the persona store's, so a caller may pass a database composed with its own
 * vertical's tables while this file still touches only engine ones.
 */
type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>

type RunRow = typeof harvestRuns.$inferSelect

const toRecord = (row: RunRow): HarvestRunRecord => ({
  id: row.id,
  domainId: row.domainId,
  personaId: row.personaId,
  sourceId: row.sourceId,
  query: row.query,
  sessionId: row.sessionId,
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  outcome: row.outcome,
  itemCount: row.itemCount,
  // Two columns, one field. The table's CHECK keeps them from disagreeing, so
  // the `null` branch here is the only one either column can produce alone.
  experiment:
    row.experimentId === null || row.experimentDay === null
      ? null
      : { id: row.experimentId, day: row.experimentDay },
})

type ExperimentRow = typeof driftExperiments.$inferSelect

const toExperiment = (row: ExperimentRow): DriftExperimentRecord => ({
  id: row.id,
  domainId: row.domainId,
  ownerId: row.ownerId,
  sourceId: row.sourceId,
  query: row.query,
  personaAId: row.personaAId,
  personaBId: row.personaBId,
  days: row.days,
  k: row.k,
  intervalMinutes: row.intervalMinutes,
  startedAt: row.startedAt,
  state: row.state,
})

export class PostgresHarvestRunStore implements HarvestRunStore {
  constructor(private readonly db: Db) {}

  async start(run: HarvestRunStart): Promise<void> {
    await this.db.insert(harvestRuns).values({
      id: run.id,
      domainId: run.domainId,
      personaId: run.personaId,
      sourceId: run.sourceId,
      query: run.query,
      sessionId: run.sessionId,
      startedAt: run.startedAt,
      endedAt: null,
      outcome: "running",
      itemCount: 0,
      experimentId: run.experiment?.id ?? null,
      experimentDay: run.experiment?.day ?? null,
    })
  }

  /**
   * One statement, and deliberately not read-modify-write.
   *
   * There is nothing to read here — every value is supplied — which is the point:
   * a `finish` that first fetched the row to check it was still `running` would
   * turn the terminal transition into two round trips inside a browser session's
   * deadline, for a check nothing acts on.
   */
  async finish(
    id: string,
    outcome: HarvestOutcome,
    itemCount: number,
    endedAt: Date,
  ): Promise<void> {
    await this.db
      .update(harvestRuns)
      .set({ outcome, itemCount, endedAt, updatedAt: new Date() })
      .where(eq(harvestRuns.id, id))
  }

  async byId(id: string): Promise<HarvestRunRecord | null> {
    const rows = await this.db.select().from(harvestRuns).where(eq(harvestRuns.id, id)).limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  /**
   * Newest first, and always limited.
   *
   * `startedAt desc` is both the order the Lab wants and the order the
   * `(persona_id, started_at)` index already carries, so "the newest run this
   * identity did" is an index read of one row rather than a sort of every run
   * that identity has ever done.
   */
  async list(filter: HarvestRunFilter = {}): Promise<HarvestRunRecord[]> {
    const clauses = [
      ...(filter.sourceId ? [eq(harvestRuns.sourceId, filter.sourceId)] : []),
      ...(filter.personaId ? [eq(harvestRuns.personaId, filter.personaId)] : []),
      ...(filter.query ? [eq(harvestRuns.query, filter.query)] : []),
      ...(filter.domainId ? [eq(harvestRuns.domainId, filter.domainId)] : []),
    ]
    const rows = await this.db
      .select()
      .from(harvestRuns)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(harvestRuns.startedAt))
      .limit(boundedLimit(filter.limit, RUN_LIST_LIMIT))
    return rows.map(toRecord)
  }

  /**
   * One experiment's runs, day order, both identities, always limited.
   *
   * `(experiment_id, experiment_day)` is an index, so this is a range read of the
   * dozen-odd rows one experiment owns rather than a filter over every run in the
   * table. `started_at` breaks ties within a day: a retried cell has two rows, and
   * the series takes the first, so the order it arrives in has to be the order it
   * happened in.
   */
  async listByExperiment(experimentId: string, limit?: number): Promise<HarvestRunRecord[]> {
    const rows = await this.db
      .select()
      .from(harvestRuns)
      .where(eq(harvestRuns.experimentId, experimentId))
      .orderBy(asc(harvestRuns.experimentDay), asc(harvestRuns.startedAt))
      .limit(boundedLimit(limit, EXPERIMENT_RUN_LIMIT))
    return rows.map(toRecord)
  }
}

export class PostgresRawItemStore implements RawItemStore {
  constructor(private readonly db: Db) {}

  /**
   * One statement for the batch.
   *
   * A harvest returning forty items must not be forty round trips: they would run
   * inside the session's deadline, and a deadline that expires while inserting is
   * a deadline that expires holding an open browser, which bills for the wait.
   *
   * The empty case returns early because drizzle refuses a `VALUES` list with no
   * rows, and an empty harvest is ordinary rather than exceptional.
   */
  async insertMany(items: readonly RawItemRow[]): Promise<void> {
    if (items.length === 0) return
    await this.db.insert(rawItems).values(
      items.map((item) => ({
        id: item.id,
        harvestRunId: item.harvestRunId,
        sourceId: item.sourceId,
        url: item.url,
        title: item.title,
        text: item.text,
        languageGuess: item.languageGuess,
        rank: item.rank,
        mediaRefs: [...item.mediaRefs],
        engagementViews: item.engagement?.views ?? null,
        engagementLikes: item.engagement?.likes ?? null,
        engagementComments: item.engagement?.comments ?? null,
        capturedAt: item.capturedAt,
        rawRef: item.rawRef,
      })),
    )
  }

  /**
   * One run's items, in the order the source returned them, always limited.
   *
   * The engagement columns are three nullable integers in the table and one
   * nullable object in the row, and the reconstruction below is the only place
   * that knows it: a run with no engagement figures at all gets `null` rather
   * than `{views: null, likes: null, comments: null}`, so that "the source does
   * not publish these" and "the source published zero" stay different answers.
   */
  async listByRun(harvestRunId: string, limit?: number): Promise<RawItemRow[]> {
    const rows = await this.db
      .select()
      .from(rawItems)
      .where(eq(rawItems.harvestRunId, harvestRunId))
      .orderBy(asc(rawItems.rank))
      .limit(boundedLimit(limit, ITEM_LIST_LIMIT))

    return rows.map((row) => {
      const engagement: Engagement | null =
        row.engagementViews === null &&
        row.engagementLikes === null &&
        row.engagementComments === null
          ? null
          : {
              views: row.engagementViews,
              likes: row.engagementLikes,
              comments: row.engagementComments,
            }
      return {
        id: row.id,
        harvestRunId: row.harvestRunId,
        sourceId: row.sourceId,
        rank: row.rank,
        url: row.url,
        title: row.title,
        text: row.text,
        languageGuess: row.languageGuess,
        mediaRefs: row.mediaRefs,
        engagement,
        capturedAt: row.capturedAt,
        rawRef: row.rawRef,
      }
    })
  }

  /**
   * The compared identifiers for many runs, in one statement.
   *
   * Two columns and `rank < k` rather than `select *` and a slice in memory: a
   * week's plot is fourteen runs, and fourteen runs of `pantip.topic` is megabytes
   * of post text crossing Hyperdrive to compute a number that only ever looks at
   * URLs. The whole read is bounded twice over — by `k` inside each run, and by
   * how many run ids the caller was allowed to collect in the first place.
   *
   * Runs with no items simply do not appear in the result, which is what lets the
   * series tell a day that returned nothing from a day that never ran.
   */
  async rankedUrls(harvestRunIds: readonly string[], k: number): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    if (harvestRunIds.length === 0) return out
    const bound = boundedLimit(k, ITEM_LIST_LIMIT)
    const rows = await this.db
      .select({ harvestRunId: rawItems.harvestRunId, url: rawItems.url })
      .from(rawItems)
      .where(and(inArray(rawItems.harvestRunId, [...harvestRunIds]), lt(rawItems.rank, bound)))
      .orderBy(asc(rawItems.harvestRunId), asc(rawItems.rank))
      .limit(harvestRunIds.length * bound)
    for (const row of rows) {
      const urls = out.get(row.harvestRunId)
      if (urls === undefined) out.set(row.harvestRunId, [row.url])
      else urls.push(row.url)
    }
    return out
  }
}

/**
 * The experiment plan rows.
 *
 * No update path beyond `setState`, because everything else about an experiment is
 * already queued the moment it is created: changing `days` or `query` afterwards
 * would leave the row describing one measurement and the queue holding another.
 */
export class PostgresDriftExperimentStore implements DriftExperimentStore {
  constructor(private readonly db: Db) {}

  async insert(row: DriftExperimentRecord): Promise<void> {
    await this.db.insert(driftExperiments).values({
      id: row.id,
      domainId: row.domainId,
      ownerId: row.ownerId,
      sourceId: row.sourceId,
      query: row.query,
      personaAId: row.personaAId,
      personaBId: row.personaBId,
      days: row.days,
      k: row.k,
      intervalMinutes: row.intervalMinutes,
      startedAt: row.startedAt,
      state: row.state,
    })
  }

  async byId(id: string): Promise<DriftExperimentRecord | null> {
    const rows = await this.db
      .select()
      .from(driftExperiments)
      .where(eq(driftExperiments.id, id))
      .limit(1)
    return rows[0] ? toExperiment(rows[0]) : null
  }

  async list(filter: DriftExperimentFilter = {}): Promise<DriftExperimentRecord[]> {
    const clauses = [
      ...(filter.state ? [eq(driftExperiments.state, filter.state)] : []),
      ...(filter.ownerId ? [eq(driftExperiments.ownerId, filter.ownerId)] : []),
    ]
    const rows = await this.db
      .select()
      .from(driftExperiments)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(driftExperiments.startedAt))
      .limit(boundedLimit(filter.limit, EXPERIMENT_LIST_LIMIT))
    return rows.map(toExperiment)
  }

  async setState(id: string, state: DriftState): Promise<void> {
    await this.db
      .update(driftExperiments)
      .set({ state, updatedAt: new Date() })
      .where(eq(driftExperiments.id, id))
  }
}
