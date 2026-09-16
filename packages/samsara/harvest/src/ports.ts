import type { DriftState, Engagement, HarvestOutcome, SourceId, StorageRef } from "@samsara/core"

/**
 * The harvest ports, and nothing that implements them.
 *
 * Split out of `store.ts` so that a caller may have the types without the module:
 * `store.ts` reaches `node:crypto` for its in-memory archive and `@samsara/sources`
 * for a capture, and the API is compiled against the Workers runtime, which has
 * neither. Same division as `@samsara/kernel/jobs` against the kernel's barrel, and
 * for the same reason — it is a compile error rather than a deploy-day surprise.
 *
 * Nothing here imports a value. If something in this file ever needs to, it belongs
 * in `store.ts` instead.
 */

/**
 * Which designed measurement a run belongs to, and which day of it.
 *
 * A pair rather than two fields that can be set independently, so that "this run
 * is a cell of an experiment" and "this run is day 3" cannot be known separately.
 * Half of it is useless: the day is the key the two identities are paired on, and
 * a run carrying an experiment id and no day cannot be put opposite anything.
 */
export interface ExperimentCell {
  id: string
  /** Zero-based day within the experiment's plan. */
  day: number
}

/** What is known when a run starts. `id` is minted by the caller so it can log it. */
export interface HarvestRunStart {
  id: string
  domainId: string
  personaId: string
  sourceId: SourceId
  query: string
  sessionId: string
  startedAt: Date
  /** Null for an ordinary run — one somebody asked for once. */
  experiment: ExperimentCell | null
}

export interface HarvestRunRecord extends HarvestRunStart {
  endedAt: Date | null
  outcome: HarvestOutcome
  itemCount: number
}

/**
 * Which runs to read, and at most how many.
 *
 * `limit` is part of the filter rather than an optional afterthought because the
 * only caller outside this package is an HTTP handler under a 10 ms CPU ceiling
 * and an account-wide query budget. A `list` with no bound is a `list` that gets
 * slower every day the system runs and never says so.
 */
export interface HarvestRunFilter {
  sourceId?: SourceId
  personaId?: string
  /** Exact match. The comparison in the Lab is only meaningful within one question. */
  query?: string
  limit?: number
}

/**
 * One experiment's runs, both identities, in day order.
 *
 * Deliberately not expressible through `HarvestRunFilter`, whose every read is
 * "newest first, bounded" — the series wants the *oldest* first and wants both
 * sides interleaved, because it is drawing a line rather than showing a latest
 * state. Squeezing it into the filter would mean an `order` parameter, and an
 * order parameter is how a bounded read quietly becomes a scan with a `LIMIT`.
 */
export interface DriftRunReader {
  listByExperiment(experimentId: string, limit?: number): Promise<HarvestRunRecord[]>
}

/** The bound on a series read: two identities across `EXPERIMENT_RUN_LIMIT / 2` days. */
export const EXPERIMENT_RUN_LIMIT = 64

/** The bound applied when a caller asks for none, and the ceiling on what it may ask for. */
export const RUN_LIST_LIMIT = 50

export interface HarvestRunStore extends DriftRunReader {
  start(run: HarvestRunStart): Promise<void>
  /** Terminal transition. Sets `endedAt`, `outcome` and the count in one write. */
  finish(id: string, outcome: HarvestOutcome, itemCount: number, endedAt: Date): Promise<void>
  byId(id: string): Promise<HarvestRunRecord | null>
  /** Newest first, bounded. See `HarvestRunFilter`. */
  list(filter?: HarvestRunFilter): Promise<HarvestRunRecord[]>
}

/** A parsed item, completed with the three things a parser is not allowed to know. */
export interface RawItemRow {
  id: string
  harvestRunId: string
  sourceId: SourceId
  /** Zero-based position within this run, as the source ordered it. See the column. */
  rank: number
  url: string
  title: string | null
  text: string
  languageGuess: string | null
  mediaRefs: readonly string[]
  engagement: Engagement | null
  capturedAt: Date
  rawRef: StorageRef
}

export interface RawItemStore {
  /**
   * One call for the whole batch, not one per item.
   *
   * A harvest returning forty items should be one statement. Forty round trips
   * inside a browser session's deadline is a way to have the deadline expire
   * holding an open browser, which bills for the wait.
   */
  insertMany(items: readonly RawItemRow[]): Promise<void>

  /**
   * One run's items in rank order, bounded.
   *
   * The port had no read method until the Lab needed one, and the shape it got is
   * the narrowest one that answers the Lab's question: a comparison is always
   * "the top k of this run against the top k of that one", so the read is per-run
   * and the bound is the k. There is deliberately no "all items for a persona"
   * and no "items since a date" — those are scans, and a scan belongs to a job
   * that is allowed to take a second, not to a handler with a 10 ms budget.
   */
  listByRun(harvestRunId: string, limit?: number): Promise<RawItemRow[]>

  /**
   * The compared identifiers for several runs at once, and nothing else in the row.
   *
   * A second read method, rather than calling `listByRun` in a loop, because the
   * two reads want different things. The split screen shows items, so it pays for
   * their text. A seven-day plot shows one number per day and never renders an
   * item at all — and a run of `pantip.topic` items is tens of kilobytes each, so
   * fourteen `listByRun` calls would pull megabytes across Hyperdrive to compute
   * a number that only needs the URLs.
   *
   * Keyed by run id, values in rank order, `k` per run. A run with no items is
   * absent from the map rather than present and empty: `overlapAt` is given the
   * empty list either way, and a map that invents keys for runs it did not find
   * would hide a missing run behind a zero.
   */
  rankedUrls(harvestRunIds: readonly string[], k: number): Promise<Map<string, string[]>>
}

/** The bound applied when a caller asks for none, and the ceiling on what it may ask for. */
export const ITEM_LIST_LIMIT = 100

/**
 * The limit actually used: the caller's, clamped to `[1, max]`, or `max` if absent.
 *
 * A ceiling rather than trust, because the caller on the other side of this is a
 * query string. `?limit=100000` must cost the same as `?limit=100`, and it must
 * cost that without the handler having to remember to check — which is why every
 * implementation below goes through this one function rather than each writing
 * its own `Math.min`.
 */
export const boundedLimit = (limit: number | undefined, max: number): number => {
  if (limit === undefined || !Number.isFinite(limit)) return max
  return Math.max(1, Math.min(Math.floor(limit), max))
}

/**
 * The experiment row as a store hands it back (plan P1.8, `DriftExperiment`).
 *
 * A plan, not a log: it says what was designed, and the harvest runs carrying its
 * id say what happened. Nothing here counts days completed, because a progress
 * column is stale the first moment the thing that would update it does not run —
 * and under ADR-0014 a schedule that does not run is the ordinary case.
 */
export interface DriftExperimentRecord {
  id: string
  domainId: string
  ownerId: string | null
  sourceId: SourceId
  query: string
  personaAId: string
  personaBId: string
  days: number
  k: number
  intervalMinutes: number
  startedAt: Date
  state: DriftState
}

export interface DriftExperimentFilter {
  state?: DriftState
  ownerId?: string
  limit?: number
}

export const EXPERIMENT_LIST_LIMIT = 50

export interface DriftExperimentStore {
  insert(row: DriftExperimentRecord): Promise<void>
  byId(id: string): Promise<DriftExperimentRecord | null>
  /** Newest first, bounded, like every other list in this file. */
  list(filter?: DriftExperimentFilter): Promise<DriftExperimentRecord[]>
  /**
   * The brake, and the only mutation this store has.
   *
   * An experiment's remaining days are already rows in the queue when it is
   * created, so there is nothing to cancel by not-scheduling: stopping has to be
   * something the handler reads before it opens a browser. That is why this is a
   * state transition rather than a delete — a deleted plan would leave fourteen
   * queued jobs pointing at nothing and spending anyway.
   */
  setState(id: string, state: DriftState): Promise<void>
}
