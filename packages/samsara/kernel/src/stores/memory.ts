import type { JobState } from "@samsara/core"
import type { CounterKey, CounterStore } from "../budget.js"
import { counterKeyString } from "../budget.js"
import type {
  ClaimOptions,
  ClaimResult,
  EnqueueInput,
  EnqueueResult,
  JobStore,
  StoredJobEvent,
} from "../jobs.js"
import { jobRetryDelayMs } from "../jobs.js"
import type { SessionRecord, SessionStore } from "../registry.js"
import type { Failure } from "../result.js"

/**
 * In-memory ports. Two uses, and only two:
 *
 * - unit tests, which must be able to drive a meter past its ceiling without a
 *   database and without spending anything;
 * - a dry run, where forgetting is the point.
 *
 * Never in a scheduled runner. A counter that resets when the process exits is
 * exactly the failure ADR-0014 moved counters into Postgres to avoid.
 */

export class MemoryCounterStore implements CounterStore {
  private readonly totals = new Map<string, number>()

  async read(keys: readonly CounterKey[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    for (const key of keys) {
      const k = counterKeyString(key)
      out.set(k, this.totals.get(k) ?? 0)
    }
    return out
  }

  async add(key: CounterKey, amount: number): Promise<number> {
    const k = counterKeyString(key)
    const next = (this.totals.get(k) ?? 0) + amount
    this.totals.set(k, next)
    return next
  }

  /** Test affordance: set a counter straight to a value without running anything. */
  seed(key: CounterKey, amount: number): void {
    this.totals.set(counterKeyString(key), amount)
  }
}

export class MemorySessionStore implements SessionStore {
  readonly rows = new Map<string, SessionRecord>()

  async open(row: SessionRecord): Promise<void> {
    this.rows.set(row.id, { ...row })
  }

  async close(id: string, patch: Partial<SessionRecord>): Promise<void> {
    const existing = this.rows.get(id)
    if (!existing) return
    this.rows.set(id, { ...existing, ...patch })
  }

  async findOpen(): Promise<SessionRecord[]> {
    return [...this.rows.values()].filter((r) => r.outcome === "running")
  }
}

interface MemoryJobRow {
  id: string
  type: string
  domainId: string | null
  ownerId: string | null
  payload: unknown
  idempotencyKey: string | null
  state: JobState
  priority: number
  attempts: number
  maxAttempts: number
  runAfter: Date
  leaseUntil: Date | null
  claimedBy: string | null
  lastError: string | null
  lastCause: string | null
  createdAt: Date
}

/**
 * The queue without Postgres.
 *
 * It reproduces the *semantics* of the real claim — ordering, lease expiry,
 * attempt accounting — but it cannot reproduce `SKIP LOCKED`, because nothing here
 * is concurrent. That gap is deliberate and is why `jobs.pg.test.ts` exists and
 * runs against a real database: the one property most worth testing about this
 * queue is the one an in-memory fake is structurally unable to test.
 */
export class MemoryJobStore implements JobStore {
  readonly rows = new Map<string, MemoryJobRow>()
  readonly events = new Map<string, StoredJobEvent[]>()
  private seq = 0

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const key = input.idempotencyKey ?? null
    if (key !== null) {
      const existing = [...this.rows.values()].find((r) => r.idempotencyKey === key)
      if (existing) return { id: existing.id, deduped: true }
    }
    const id = `job-${++this.seq}`
    const at = this.clock()
    this.rows.set(id, {
      id,
      type: input.type,
      domainId: input.domainId ?? null,
      ownerId: input.ownerId ?? null,
      payload: input.payload ?? {},
      idempotencyKey: key,
      state: "queued",
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      runAfter: input.runAfter ?? at,
      leaseUntil: null,
      claimedBy: null,
      lastError: null,
      lastCause: null,
      createdAt: at,
    })
    this.append(id, "queued", null)
    return { id, deduped: false }
  }

  async claim(opts: ClaimOptions): Promise<ClaimResult> {
    const at = opts.now ?? this.clock()
    const types = new Set(opts.types ?? [])
    const eligible = [...this.rows.values()]
      .filter((r) => (types.size === 0 ? true : types.has(r.type)))
      .filter(
        (r) =>
          (r.state === "queued" && r.runAfter.getTime() <= at.getTime()) ||
          (r.state === "running" &&
            r.leaseUntil !== null &&
            r.leaseUntil.getTime() <= at.getTime()),
      )
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.runAfter.getTime() - b.runAfter.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .slice(0, opts.limit)

    const claimed: ClaimResult["jobs"] = []
    let reclaimed = 0
    for (const r of eligible) {
      const wasExpired = r.state === "running"
      if (wasExpired) reclaimed += 1
      r.state = "running"
      r.attempts += 1
      r.leaseUntil = new Date(at.getTime() + opts.leaseMs)
      r.claimedBy = opts.runId
      this.append(r.id, "running", wasExpired ? "reclaimed after lease expiry" : null)
      claimed.push({
        id: r.id,
        type: r.type,
        domainId: r.domainId,
        ownerId: r.ownerId,
        payload: r.payload,
        attempt: r.attempts,
        maxAttempts: r.maxAttempts,
      })
    }
    return { jobs: claimed, reclaimed }
  }

  async heartbeat(id: string, leaseMs: number, note?: string): Promise<void> {
    const r = this.rows.get(id)
    if (!r) return
    r.leaseUntil = new Date(this.clock().getTime() + leaseMs)
    if (note !== undefined) this.append(id, "running", note)
  }

  async succeed(id: string, note?: string): Promise<void> {
    const r = this.rows.get(id)
    if (!r) return
    r.state = "succeeded"
    r.leaseUntil = null
    r.claimedBy = null
    this.append(id, "succeeded", note ?? null)
  }

  async fail(
    id: string,
    failure: Failure,
    opts: { now?: Date } = {},
  ): Promise<{ willRetry: boolean }> {
    const r = this.rows.get(id)
    if (!r) return { willRetry: false }
    const at = opts.now ?? this.clock()
    const retryable = failure.kind === "upstream" || failure.kind === "internal"
    const willRetry = retryable && r.attempts < r.maxAttempts
    r.lastError = `${failure.kind}: ${failure.message}`
    r.lastCause = failure.cause?.slice(0, 500) ?? null
    r.leaseUntil = null
    r.claimedBy = null
    if (willRetry) {
      r.state = "queued"
      r.runAfter = new Date(at.getTime() + jobRetryDelayMs(r.attempts))
      this.append(id, "queued", `retrying after ${failure.kind}`)
    } else {
      r.state = "failed"
      this.append(id, "failed", failure.kind)
    }
    return { willRetry }
  }

  async release(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const r = this.rows.get(id)
      if (r?.state !== "running") continue
      r.state = "queued"
      r.attempts = Math.max(r.attempts - 1, 0)
      r.leaseUntil = null
      r.claimedBy = null
      this.append(id, "queued", "released on shutdown")
    }
  }

  async eventsAfter(jobId: string, after: number, limit: number): Promise<StoredJobEvent[]> {
    return (this.events.get(jobId) ?? []).filter((e) => e.seq > after).slice(0, limit)
  }

  private append(jobId: string, state: JobState, note: string | null): void {
    const list = this.events.get(jobId) ?? []
    list.push({ seq: list.length, state, note, at: this.clock() })
    this.events.set(jobId, list)
  }
}
