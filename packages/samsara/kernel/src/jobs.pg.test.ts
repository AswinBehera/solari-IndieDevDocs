import { samsaraSchema } from "@samsara/db"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { failure } from "./result.js"
import { PostgresJobStore } from "./stores/postgres.js"

/**
 * The queue against a real Postgres.
 *
 * This file exists for one property the in-memory store is structurally unable to
 * check: `FOR UPDATE SKIP LOCKED`. Two runners overlapping is not a rare case
 * under ADR-0014 — a cron run and a `workflow_dispatch` run can be awake at the
 * same instant by design — and "two runners never claim the same row" is the
 * single assumption everything else here rests on. A fake that runs one statement
 * at a time cannot fail that test, which means it cannot pass it either.
 *
 * Runs whenever `DATABASE_URL` is set, and **fails loudly when it is not** unless
 * `SAMSARA_NO_DB=1` says the omission is deliberate.
 *
 * The earlier version of this comment said "skipped unless `DATABASE_URL` is set,
 * so `pnpm test` stays runnable on a machine with no Docker", and that was the
 * second time the same mistake was made here. The first was Turbo's strict env
 * mode swallowing the variable (P0.7); this was P0.8's fresh-clone run, where
 * following the README exactly produced `67 passed | 14 skipped`, exit 0, and no
 * coverage at all of the one component with real concurrency in it. Fixing the
 * plumbing is not enough: a silent skip is a green run that means nothing, and the
 * only durable fix is to make the absence an event. Opting out is still allowed —
 * it just has to be said out loud, which is the same bargain the seam checker's
 * allow comments strike. (Writing that marker literally here made the checker fail
 * this very file for an unused allow, which is the check being right.)
 */

const url = process.env.DATABASE_URL
const hasDb = typeof url === "string" && url.length > 0
const optedOut = process.env.SAMSARA_NO_DB === "1"

if (!hasDb && !optedOut) {
  describe("the queue, against Postgres", () => {
    it("has a database to run against", () => {
      expect.fail(
        "DATABASE_URL is not set, so the FOR UPDATE SKIP LOCKED tests would have " +
          "skipped and this run would have reported green while testing nothing. " +
          "Run `pnpm db:up` and retry, or set SAMSARA_NO_DB=1 to skip on purpose.",
      )
    })
  })
}

const client = hasDb ? postgres(url as string, { max: 4 }) : undefined
const db = client ? drizzle(client, { schema: samsaraSchema }) : undefined

// Held for the whole file: these suites truncate shared tables, and Turbo runs
// the packages that do so at the same time. See `@samsara/db/testing`.
let lock: DatabaseLock | null = null

beforeAll(async () => {
  if (hasDb) lock = await lockDatabase(url as string)
})

afterAll(async () => {
  await client?.end({ timeout: 5 })
  await lock?.release()
})

describe.skipIf(!hasDb)("the queue, against Postgres", () => {
  const store = () => new PostgresJobStore(db as never)

  beforeEach(async () => {
    // `job_events` goes with it by cascade. Truncate rather than delete so the
    // test is not slowly poisoned by rows from earlier runs of itself.
    await db?.execute(sql`TRUNCATE TABLE jobs CASCADE`)
  })

  it("claims a queued row and marks it running under a lease", async () => {
    const s = store()
    const { id } = await s.enqueue({ type: "noop" })
    const claimed = await s.claim({ runId: "run-a", limit: 5, leaseMs: 60_000 })

    expect(claimed.jobs.map((j) => j.id)).toEqual([id])
    expect(claimed.jobs[0]?.attempt).toBe(1)
    expect(claimed.reclaimed).toBe(0)
  })

  it("never hands the same row to two concurrent runners", async () => {
    // The reason this file exists. Both claims are in flight at once, against the
    // same three rows, on separate connections.
    const s = store()
    for (let i = 0; i < 3; i++) await s.enqueue({ type: "noop" })

    const [a, b] = await Promise.all([
      s.claim({ runId: "run-a", limit: 3, leaseMs: 60_000 }),
      s.claim({ runId: "run-b", limit: 3, leaseMs: 60_000 }),
    ])

    const ids = [...a.jobs, ...b.jobs].map((j) => j.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(3)
  })

  it("reclaims a row whose lease expired, because a cancelled runner is routine", async () => {
    const s = store()
    await s.enqueue({ type: "noop" })

    // A one-millisecond lease is a runner that was killed the instant it claimed.
    await s.claim({ runId: "dead-runner", limit: 1, leaseMs: 1 })
    await new Promise((r) => setTimeout(r, 20))

    const second = await s.claim({ runId: "run-b", limit: 1, leaseMs: 60_000 })
    expect(second.jobs).toHaveLength(1)
    expect(second.reclaimed).toBe(1)
    // The attempt *is* consumed here, unlike a clean shutdown's release: nobody
    // told us this runner died, so we cannot tell a cancellation from a handler
    // that hung. Counting it is what stops a job that reliably wedges its runner
    // from being retried forever.
    expect(second.jobs[0]?.attempt).toBe(2)
  })

  it("does not claim a row whose lease is still live", async () => {
    const s = store()
    await s.enqueue({ type: "noop" })
    await s.claim({ runId: "run-a", limit: 1, leaseMs: 60_000 })

    const second = await s.claim({ runId: "run-b", limit: 1, leaseMs: 60_000 })
    expect(second.jobs).toHaveLength(0)
  })

  it("collides on the idempotency key and returns the existing row", async () => {
    const s = store()
    const first = await s.enqueue({ type: "noop", idempotencyKey: "dupe-42" })
    const second = await s.enqueue({ type: "noop", idempotencyKey: "dupe-42" })

    expect(second.id).toBe(first.id)
    expect(second.deduped).toBe(true)
  })

  it("treats null idempotency keys as distinct, so unkeyed jobs never collide", async () => {
    // Postgres' "nulls are distinct" default, relied on rather than worked around.
    const s = store()
    const a = await s.enqueue({ type: "noop" })
    const b = await s.enqueue({ type: "noop" })
    expect(a.id).not.toBe(b.id)
  })

  it("orders by priority, then by when the row became due", async () => {
    const s = store()
    const past = new Date(Date.now() - 60_000)
    await s.enqueue({ type: "noop", idempotencyKey: "low", priority: 0, runAfter: past })
    await s.enqueue({ type: "noop", idempotencyKey: "high", priority: 10 })

    const claimed = await s.claim({ runId: "run-a", limit: 1, leaseMs: 60_000 })
    expect(claimed.jobs[0]?.payload).toEqual({})
    const events = await s.eventsAfter(claimed.jobs[0]?.id as string, -1, 10)
    expect(events.map((e) => e.state)).toEqual(["queued", "running"])
  })

  it("does not claim a row that is not yet due", async () => {
    const s = store()
    await s.enqueue({ type: "noop", runAfter: new Date(Date.now() + 60_000) })
    const claimed = await s.claim({ runId: "run-a", limit: 1, leaseMs: 60_000 })
    expect(claimed.jobs).toHaveLength(0)
  })

  it("filters to the types the runner can actually handle", async () => {
    const s = store()
    await s.enqueue({ type: "block.run" })
    const claimed = await s.claim({ runId: "run-a", limit: 5, leaseMs: 60_000, types: ["noop"] })
    expect(claimed.jobs).toHaveLength(0)
  })

  it("appends a dense, per-job event sequence for the stream to page through", async () => {
    const s = store()
    const { id } = await s.enqueue({ type: "noop" })
    await s.claim({ runId: "run-a", limit: 1, leaseMs: 60_000 })
    await s.heartbeat(id, 60_000, "halfway")
    await s.succeed(id, "done")

    const events = await s.eventsAfter(id, -1, 100)
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3])
    expect(events.map((e) => e.state)).toEqual(["queued", "running", "running", "succeeded"])
    // The cursor genuinely resumes rather than replaying.
    expect(await s.eventsAfter(id, 1, 100)).toHaveLength(2)
  })

  it("requeues a retryable failure and retires it when the attempts run out", async () => {
    const s = store()
    const { id } = await s.enqueue({ type: "noop", maxAttempts: 2 })

    await s.claim({ runId: "run-a", limit: 1, leaseMs: 60_000 })
    expect(await s.fail(id, failure("upstream", "provider 503"))).toEqual({ willRetry: true })

    await s.claim({
      runId: "run-a",
      limit: 1,
      leaseMs: 60_000,
      now: new Date(Date.now() + 3_600_000),
    })
    expect(await s.fail(id, failure("upstream", "provider 503"))).toEqual({ willRetry: false })
  })

  it("refuses to retry a failure class that retrying cannot fix", async () => {
    // `blocked` retried is a browser being trained into a ban; `config` retried is
    // the same wrong argument sent twice. See `retry.ts` for the full case.
    const s = store()
    const { id } = await s.enqueue({ type: "noop", maxAttempts: 5 })
    await s.claim({ runId: "run-a", limit: 1, leaseMs: 60_000 })
    expect(await s.fail(id, failure("blocked", "bot wall"))).toEqual({ willRetry: false })
  })

  it("gives the attempt back when a claim is released rather than failed", async () => {
    const s = store()
    const { id } = await s.enqueue({ type: "noop" })
    await s.claim({ runId: "run-a", limit: 1, leaseMs: 60_000 })
    await s.release([id])

    const again = await s.claim({ runId: "run-b", limit: 1, leaseMs: 60_000 })
    expect(again.jobs[0]?.attempt).toBe(1)
    expect(again.reclaimed).toBe(0)
  })
})
