import { randomUUID } from "node:crypto"
import type { HarvestOutcome, StorageRef } from "@samsara/core"
import type { Capture } from "@samsara/sources"
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
 * Where a run and its items are written, and where the untouched bytes go.
 *
 * Three ports rather than one, because they have three different lifetimes and
 * two different storage systems behind them: a run row is a small mutable record,
 * items are a bulk append, and an archived capture is an object in a bucket that
 * nothing in this package will ever read back. Collapsing them would mean a test
 * for the run's state machine needed a bucket.
 *
 * Two of the three live in `./ports.js` and are re-exported here, so that this
 * module stays the one import anything inside the package needs.
 */

export * from "./ports.js"

/**
 * Object storage for the capture, keyed by run.
 *
 * The engine never dereferences a `StorageRef` — it hands it to whoever asks. This
 * port exists so that the one thing the archive *must* guarantee is stated
 * somewhere: the bytes stored are the bytes received, unmodified. A re-parse that
 * runs against a cleaned-up copy is not a re-parse, it is a second opinion about
 * a document nobody has.
 */
export interface CaptureArchive {
  put(runId: string, capture: Capture<unknown>): Promise<StorageRef>
}

// ---------------------------------------------------------------------------

export class MemoryHarvestRunStore implements HarvestRunStore {
  readonly runs = new Map<string, HarvestRunRecord>()

  async start(run: HarvestRunStart): Promise<void> {
    if (this.runs.has(run.id)) throw new Error(`harvest run already started: ${run.id}`)
    this.runs.set(run.id, { ...run, endedAt: null, outcome: "running", itemCount: 0 })
  }

  async finish(
    id: string,
    outcome: HarvestOutcome,
    itemCount: number,
    endedAt: Date,
  ): Promise<void> {
    const run = this.runs.get(id)
    if (!run) throw new Error(`no such harvest run: ${id}`)
    this.runs.set(id, { ...run, outcome, itemCount, endedAt })
  }

  async byId(id: string): Promise<HarvestRunRecord | null> {
    return this.runs.get(id) ?? null
  }

  async list(filter: HarvestRunFilter = {}): Promise<HarvestRunRecord[]> {
    return [...this.runs.values()]
      .filter(
        (r) =>
          (filter.sourceId === undefined || r.sourceId === filter.sourceId) &&
          (filter.personaId === undefined || r.personaId === filter.personaId) &&
          (filter.query === undefined || r.query === filter.query) &&
          (filter.domainId === undefined || r.domainId === filter.domainId),
      )
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, boundedLimit(filter.limit, RUN_LIST_LIMIT))
  }

  /** Oldest first — a series is drawn left to right. See `DriftRunReader`. */
  async listByExperiment(experimentId: string, limit?: number): Promise<HarvestRunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => r.experiment?.id === experimentId)
      .sort(
        (a, b) =>
          (a.experiment?.day ?? 0) - (b.experiment?.day ?? 0) ||
          a.startedAt.getTime() - b.startedAt.getTime(),
      )
      .slice(0, boundedLimit(limit, EXPERIMENT_RUN_LIMIT))
  }
}

export class MemoryRawItemStore implements RawItemStore {
  readonly items: RawItemRow[] = []

  async insertMany(items: readonly RawItemRow[]): Promise<void> {
    this.items.push(...items)
  }

  /**
   * Sorted by rank, not by insertion order — the same as the real store.
   *
   * A memory store that returned them in the order they arrived would pass every
   * test while the Postgres one was wrong, because in practice the two orders are
   * the same right up until the day somebody inserts a batch twice.
   */
  async listByRun(harvestRunId: string, limit?: number): Promise<RawItemRow[]> {
    return this.items
      .filter((item) => item.harvestRunId === harvestRunId)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, boundedLimit(limit, ITEM_LIST_LIMIT))
  }

  async rankedUrls(harvestRunIds: readonly string[], k: number): Promise<Map<string, string[]>> {
    const wanted = new Set(harvestRunIds)
    const bound = boundedLimit(k, ITEM_LIST_LIMIT)
    const out = new Map<string, string[]>()
    for (const item of [...this.items].sort((a, b) => a.rank - b.rank)) {
      if (!wanted.has(item.harvestRunId)) continue
      const urls = out.get(item.harvestRunId)
      if (urls === undefined) out.set(item.harvestRunId, [item.url])
      else if (urls.length < bound) urls.push(item.url)
    }
    return out
  }
}

/**
 * Experiments in a Map. Enough to drive the whole of P1.8 without a database.
 *
 * Insert is not idempotent and says so by throwing: two experiments with the same
 * id would produce two sets of queued jobs whose idempotency keys collide, and the
 * failure would surface as a week of half-missing days rather than as an error.
 */
export class MemoryDriftExperimentStore implements DriftExperimentStore {
  readonly experiments = new Map<string, DriftExperimentRecord>()

  async insert(row: DriftExperimentRecord): Promise<void> {
    if (this.experiments.has(row.id)) throw new Error(`experiment already exists: ${row.id}`)
    this.experiments.set(row.id, row)
  }

  async byId(id: string): Promise<DriftExperimentRecord | null> {
    return this.experiments.get(id) ?? null
  }

  async list(filter: DriftExperimentFilter = {}): Promise<DriftExperimentRecord[]> {
    return [...this.experiments.values()]
      .filter(
        (e) =>
          (filter.state === undefined || e.state === filter.state) &&
          (filter.ownerId === undefined || e.ownerId === filter.ownerId),
      )
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, boundedLimit(filter.limit, EXPERIMENT_LIST_LIMIT))
  }

  async setState(id: string, state: DriftExperimentRecord["state"]): Promise<void> {
    const row = this.experiments.get(id)
    if (!row) throw new Error(`no such experiment: ${id}`)
    this.experiments.set(id, { ...row, state })
  }
}

/**
 * Keeps captures in a Map. For tests, and for a local run with no bucket.
 *
 * The ref it returns has the same shape as a real key, so a row written against
 * this archive is not distinguishable by shape from one written against Supabase
 * Storage — which matters, because the alternative is a `memory://` scheme that
 * ends up in a production row after somebody boots without credentials.
 */
export class MemoryCaptureArchive implements CaptureArchive {
  readonly objects = new Map<StorageRef, Capture<unknown>>()

  async put(runId: string, capture: Capture<unknown>): Promise<StorageRef> {
    const ref = `captures/${capture.sourceId}/${runId}/${randomUUID()}.json`
    this.objects.set(ref, capture)
    return ref
  }
}
