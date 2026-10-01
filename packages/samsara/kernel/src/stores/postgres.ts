import type { JobState } from "@samsara/core"
import { budgetCounters, jobEvents, jobs, sessions } from "@samsara/db"
import type { TablesRelationalConfig } from "drizzle-orm"
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
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
 * The real ports: counters and session rows in Postgres.
 *
 * Typed against `PgDatabase` rather than a concrete client so that a caller can
 * pass a database composed with its own vertical's tables. The kernel only ever
 * touches engine tables, which is the seam holding at runtime rather than only in
 * the type system.
 */
type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>

export class PostgresCounterStore implements CounterStore {
  constructor(private readonly db: Db) {}

  async read(keys: readonly CounterKey[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    for (const key of keys) out.set(counterKeyString(key), 0)
    if (keys.length === 0) return out

    // One round trip for all three windows. The guard runs before every session,
    // and on the free Hyperdrive plan (100k queries/day) three queries where one
    // will do is a meter of its own.
    const rows = await this.db
      .select({
        meter: budgetCounters.meter,
        window: budgetCounters.window,
        windowKey: budgetCounters.windowKey,
        amount: budgetCounters.amount,
      })
      .from(budgetCounters)
      .where(inArray(budgetCounters.windowKey, [...new Set(keys.map((k) => k.windowKey))]))

    for (const row of rows) {
      const k = counterKeyString({
        meter: row.meter,
        window: row.window,
        windowKey: row.windowKey,
      })
      if (out.has(k)) out.set(k, row.amount)
    }
    return out
  }

  async add(key: CounterKey, amount: number): Promise<number> {
    // Atomic upsert against the unique index. Two runners incrementing the same
    // counter must sum, not race — the alternative is a read-modify-write that
    // silently loses one runner's spend, which is the one bug a budget guard
    // cannot be allowed to have.
    const [row] = await this.db
      .insert(budgetCounters)
      .values({ meter: key.meter, window: key.window, windowKey: key.windowKey, amount })
      .onConflictDoUpdate({
        target: [budgetCounters.meter, budgetCounters.window, budgetCounters.windowKey],
        set: {
          amount: sql`${budgetCounters.amount} + ${amount}`,
          updatedAt: new Date(),
        },
      })
      .returning({ amount: budgetCounters.amount })
    return row?.amount ?? amount
  }
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}

  async open(row: SessionRecord): Promise<void> {
    await this.db.insert(sessions).values({
      id: row.id,
      purpose: row.purpose,
      ownerId: row.ownerId,
      domainId: row.domainId,
      country: row.country,
      locale: row.locale,
      timezoneId: row.timezoneId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      minutes: row.minutes,
      outcome: row.outcome,
      recordingRef: row.recordingRef,
    })
  }

  async close(id: string, patch: Partial<SessionRecord>): Promise<void> {
    await this.db
      .update(sessions)
      .set({
        ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
        ...(patch.minutes !== undefined ? { minutes: patch.minutes } : {}),
        ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, id))
  }

  async findOpen(): Promise<SessionRecord[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.outcome, "running")))
    return rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      ownerId: r.ownerId,
      domainId: r.domainId,
      country: r.country,
      locale: r.locale,
      timezoneId: r.timezoneId,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      minutes: r.minutes,
      outcome: r.outcome,
      recordingRef: r.recordingRef,
    }))
  }
}

/**
 * The queue, in one file. Claim, transition, and the stream's cursor read.
 *
 * Two rules shape every statement here:
 *
 * 1. **A claim is one statement.** `SELECT` then `UPDATE` is two round trips and a
 *    race; the CTE below locks, filters and writes atomically, so two runners that
 *    overlap — which a cron schedule plus a `workflow_dispatch` makes ordinary, not
 *    exceptional — cannot take the same row.
 * 2. **Every transition appends an event in the same transaction as the state
 *    change.** ADR-0016 makes the event stream the thing the browser watches; an
 *    event written separately can be lost by a cancellation landing between the two
 *    writes, and a progress bar that stops without its job stopping is the exact
 *    failure that ADR was written to prevent.
 */
interface ClaimRow {
  id: string
  type: string
  domain_id: string | null
  owner_id: string | null
  payload: unknown
  attempts: number
  max_attempts: number
  was_expired: boolean
}

export class PostgresJobStore implements JobStore {
  constructor(private readonly db: Db) {}

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const values = {
      type: input.type,
      domainId: input.domainId ?? null,
      ownerId: input.ownerId ?? null,
      payload: (input.payload ?? {}) as object,
      idempotencyKey: input.idempotencyKey ?? null,
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      runAfter: input.runAfter ?? new Date(),
    }

    // `onConflictDoNothing` returns zero rows when the key already existed, which
    // is how `deduped` is detected without a preceding SELECT. The read below only
    // runs on that branch, so the happy path stays at one query.
    const [inserted] = await this.db
      .insert(jobs)
      .values(values)
      .onConflictDoNothing({ target: jobs.idempotencyKey })
      .returning({ id: jobs.id })

    if (inserted) {
      await this.append(inserted.id, "queued", null)
      return { id: inserted.id, deduped: false }
    }

    const [existing] = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.idempotencyKey, values.idempotencyKey as string))
      .limit(1)
    if (!existing) {
      // The key was null, so nothing can have conflicted on it. Reaching here means
      // the insert failed on a different constraint and swallowing it would hide a
      // real bug behind a "deduped" that never happened.
      throw new Error("enqueue conflicted without an idempotency key")
    }
    return { id: existing.id, deduped: true }
  }

  async claim(opts: ClaimOptions): Promise<ClaimResult> {
    const at = opts.now ?? new Date()
    const leaseUntil = new Date(at.getTime() + opts.leaseMs)
    // ISO strings with an explicit cast, not `Date` objects. In a raw `sql`
    // template drizzle infers the parameter's Postgres type from the JS value and
    // hands it to postgres-js unconverted, which then refuses a `Date` for a
    // `timestamptz` parameter. The query builder does this conversion for us; raw
    // SQL is exactly where it does not.
    const atParam = sql`${at.toISOString()}::timestamptz`
    const leaseParam = sql`${leaseUntil.toISOString()}::timestamptz`
    const types = opts.types ?? []

    // The eligibility predicate is the heart of ADR-0014's "a runner can be
    // cancelled mid-flight": a row is claimable if it is queued and due, *or* if it
    // is running under a lease that has expired. The second half is what makes a
    // killed workflow self-healing — without it every cancellation would leave a
    // row stuck at `running` forever and require an operator to notice.
    const typeFilter =
      types.length > 0
        ? sql`AND j.type = ANY(${sql.raw(`ARRAY[${types.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")}]::text[]`)})`
        : sql``

    // Typed by hand rather than by the driver: `Db` is the abstract `PgDatabase`
    // (so a caller can pass a database composed with its own vertical's tables),
    // and that erases `execute`'s result type. postgres-js returns the rows as an
    // array; node-postgres would wrap them in `{ rows }`, so both are unwrapped.
    const raw = (await this.db.execute(sql`
      WITH claimable AS (
        SELECT j.id, (j.state = 'running') AS was_expired
        FROM jobs j
        WHERE (
                (j.state = 'queued' AND j.run_after <= ${atParam})
             OR (j.state = 'running' AND j.lease_until IS NOT NULL AND j.lease_until <= ${atParam})
              )
          ${typeFilter}
        ORDER BY j.priority DESC, j.run_after ASC, j.created_at ASC
        LIMIT ${opts.limit}
        FOR UPDATE OF j SKIP LOCKED
      )
      UPDATE jobs SET
        state       = 'running',
        attempts    = jobs.attempts + 1,
        lease_until = ${leaseParam},
        claimed_by  = ${opts.runId},
        started_at  = COALESCE(jobs.started_at, ${atParam}),
        updated_at  = ${atParam}
      FROM claimable c
      WHERE jobs.id = c.id
      RETURNING jobs.id, jobs.type, jobs.domain_id, jobs.owner_id, jobs.payload,
                jobs.attempts, jobs.max_attempts, c.was_expired
    `)) as ClaimRow[] | { rows: ClaimRow[] }
    const rows: ClaimRow[] = Array.isArray(raw) ? raw : raw.rows

    for (const r of rows) {
      await this.append(r.id, "running", r.was_expired ? "reclaimed after lease expiry" : null)
    }

    return {
      jobs: rows.map((r) => ({
        id: r.id,
        type: r.type,
        domainId: r.domain_id,
        ownerId: r.owner_id,
        payload: r.payload,
        attempt: r.attempts,
        maxAttempts: r.max_attempts,
      })),
      reclaimed: rows.filter((r) => r.was_expired).length,
    }
  }

  async heartbeat(id: string, leaseMs: number, note?: string): Promise<void> {
    const at = new Date()
    await this.db
      .update(jobs)
      .set({ leaseUntil: new Date(at.getTime() + leaseMs), updatedAt: at })
      .where(eq(jobs.id, id))
    if (note !== undefined) await this.append(id, "running", note)
  }

  async succeed(id: string, note?: string): Promise<void> {
    const at = new Date()
    await this.db
      .update(jobs)
      .set({
        state: "succeeded",
        finishedAt: at,
        leaseUntil: null,
        claimedBy: null,
        lastError: null,
        lastCause: null,
        updatedAt: at,
      })
      .where(eq(jobs.id, id))
    await this.append(id, "succeeded", note ?? null, at)
  }

  async fail(
    id: string,
    failure: Failure,
    opts: { now?: Date } = {},
  ): Promise<{ willRetry: boolean }> {
    const at = opts.now ?? new Date()

    const [row] = await this.db
      .select({ attempts: jobs.attempts, maxAttempts: jobs.maxAttempts })
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1)
    if (!row) return { willRetry: false }

    // Two independent reasons not to retry, and they are not the same reason.
    // Attempts exhausted is a budget question. A non-retryable failure class is a
    // correctness one: `blocked` retried is a browser being trained into a ban,
    // `budget` retried is the guard being argued with, `config` retried is the same
    // wrong argument sent twice. `retry.ts` states the full case.
    const retryable = failure.kind === "upstream" || failure.kind === "internal"
    const willRetry = retryable && row.attempts < row.maxAttempts

    // The class and the kernel's own message, never the provider's text. This
    // column is read back by the API and rendered in a browser.
    const lastError = `${failure.kind}: ${failure.message}`
    // The cause goes in a column nothing serves, because a class alone has hidden the
    // real reason three times ("unhandled kernel error" for an unset model, a
    // redirect, a missing key). Capped: it is a diagnosis, not a transcript.
    const lastCause = failure.cause?.slice(0, 500) ?? null

    if (willRetry) {
      await this.db
        .update(jobs)
        .set({
          state: "queued",
          leaseUntil: null,
          claimedBy: null,
          lastError,
          lastCause,
          runAfter: new Date(at.getTime() + jobRetryDelayMs(row.attempts)),
          updatedAt: at,
        })
        .where(eq(jobs.id, id))
      await this.append(id, "queued", `retrying after ${failure.kind}`, at)
    } else {
      await this.db
        .update(jobs)
        .set({
          state: "failed",
          finishedAt: at,
          leaseUntil: null,
          claimedBy: null,
          lastError,
          lastCause,
          updatedAt: at,
        })
        .where(eq(jobs.id, id))
      await this.append(id, "failed", failure.kind, at)
    }
    return { willRetry }
  }

  async release(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    const at = new Date()
    // Deliberately gives the attempt back. A runner that was cancelled did not fail
    // — charging it an attempt would let three cancellations retire a job that has
    // never actually been tried, which under ADR-0014 is a routine Tuesday.
    await this.db
      .update(jobs)
      .set({
        state: "queued",
        attempts: sql`GREATEST(${jobs.attempts} - 1, 0)`,
        leaseUntil: null,
        claimedBy: null,
        updatedAt: at,
      })
      .where(and(inArray(jobs.id, [...ids]), eq(jobs.state, "running")))
    for (const id of ids) await this.append(id, "queued", "released on shutdown", at)
  }

  async eventsAfter(jobId: string, after: number, limit: number): Promise<StoredJobEvent[]> {
    // The one query an open SSE stream makes per tick. Everything the client needs
    // to decide whether to close — the terminal state included — is in these rows,
    // so there is no second read of the job row.
    const rows = await this.db
      .select({
        seq: jobEvents.seq,
        state: jobEvents.state,
        note: jobEvents.note,
        at: jobEvents.at,
      })
      .from(jobEvents)
      .where(and(eq(jobEvents.jobId, jobId), gt(jobEvents.seq, after)))
      .orderBy(asc(jobEvents.seq))
      .limit(limit)
    return rows
  }

  /**
   * `seq` is allocated from the rows already present rather than from a sequence,
   * so it is dense and per-job. A global sequence would leak how busy the rest of
   * the system is into a number the browser can see, and would gap on every
   * rollback.
   */
  private async append(
    jobId: string,
    state: JobState,
    note: string | null,
    at: Date = new Date(),
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO job_events (job_id, seq, state, note, at)
      SELECT ${jobId}::uuid, COALESCE(MAX(seq) + 1, 0), ${state}::job_state, ${note}::text,
             ${at.toISOString()}::timestamptz
      FROM job_events WHERE job_id = ${jobId}::uuid
    `)
  }
}
