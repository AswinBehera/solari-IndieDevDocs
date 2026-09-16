import type { Engagement, HarvestOutcome, SourceId, StorageRef } from "@samsara/core"

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

/** What is known when a run starts. `id` is minted by the caller so it can log it. */
export interface HarvestRunStart {
  id: string
  domainId: string
  personaId: string
  sourceId: SourceId
  query: string
  sessionId: string
  startedAt: Date
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

/** The bound applied when a caller asks for none, and the ceiling on what it may ask for. */
export const RUN_LIST_LIMIT = 50

export interface HarvestRunStore {
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
