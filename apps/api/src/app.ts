import { isTerminal } from "@samsara/core"
// `@samsara/kernel/jobs`, never the barrel. The barrel reaches `node:crypto` and
// `NodeJS.Timeout`, and packages are source-only, so importing it here would mean
// compiling Node-only source against the Workers runtime. See `log.node.ts`.
import type { JobStore } from "@samsara/kernel/jobs"
import { STREAM_MAX_LIFETIME_MS, streamPollIntervalMs } from "@samsara/kernel/jobs"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import { requireAuth, type Verifier } from "./auth.js"
import type { Dispatcher } from "./dispatch.js"
import { type KernelDeps, kernelRoutes } from "./kernel.js"
import { type ResearchDeps, researchRoutes } from "./research.js"

/**
 * The API (ADR-0014: Hono on Cloudflare Workers, free plan).
 *
 * The free plan allows **10 ms of CPU per invocation** — not wall clock, which is
 * why a handler may wait on Hyperdrive for far longer than that and still fit. The
 * rule this imposes on every route below: validate, enqueue, read, serialise.
 * Nothing parses a harvested page, scores anything, or loops over a result set of
 * unbounded size. Where that rule is about to be broken the work belongs in
 * `apps/worker`, which runs on a machine that is allowed to think.
 *
 * Built as a factory over injected dependencies rather than reading bindings
 * directly, for two reasons: the CPU measurement in `cpu.test.ts` has to drive the
 * real handlers without a Workers runtime, and the SSE query-count bound from
 * ADR-0016 has to be asserted against a counting store.
 */

export interface AppDeps {
  /** Per-request, because a Workers isolate may serve requests for many seconds. */
  jobs: (env: unknown) => JobStore
  verifier: Verifier
  dispatcher: Dispatcher
  /**
   * Research documents, blocks, facts and receipts. Optional so a deployment
   * without a database answers 404 on them rather than 500 on the first read.
   */
  research?: Pick<ResearchDeps, "store">
  /** The ops dashboard (P5.5). Optional for the reason `lab` is. */
  kernel?: Omit<KernelDeps, "verifier">
  /** Injectable for tests; production gets the defaults. */
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
  maxLifetimeMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createApp(deps: AppDeps) {
  const clock = deps.clock ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const maxLifetimeMs = deps.maxLifetimeMs ?? STREAM_MAX_LIFETIME_MS
  const app = new Hono<{ Bindings: Record<string, unknown> }>()

  /**
   * Unauthenticated and deliberately does not touch Postgres.
   *
   * A health check that queries the database is a health check that spends the
   * shared Hyperdrive quota every time anything pings it — uptime monitors ping
   * often — and it conflates "the API is up" with "the database is up", which are
   * different alerts with different responses. Database health is a separate,
   * authenticated route when something needs it.
   */
  app.get("/health", (c) => c.json({ ok: true, service: "api" }))

  const auth = requireAuth(deps.verifier)

  /**
   * Enqueue, then dispatch (ADR-0016). In that order, and the order is the point:
   * the row is the durable record and the dispatch is an optimisation on top of
   * it. If the dispatch fails, cron still drains the row; if the row were written
   * second, a dispatch that succeeded would race a runner against its own job.
   */
  app.post("/jobs", auth, async (c) => {
    const body = await c.req.json<{
      type?: string
      domainId?: string | null
      payload?: unknown
      idempotencyKey?: string | null
      priority?: number
    }>()

    if (typeof body.type !== "string" || body.type.length === 0) {
      throw new HTTPException(400, { message: "type is required" })
    }

    const store = deps.jobs(c.env)
    const result = await store.enqueue({
      type: body.type,
      domainId: body.domainId ?? null,
      // From the verified token, never from the body. A client that could name its
      // own owner could enqueue work billed to somebody else's meter.
      ownerId: c.get("ownerId"),
      payload: body.payload ?? {},
      idempotencyKey: body.idempotencyKey ?? null,
      priority: body.priority ?? 0,
    })

    // A deduped enqueue is not dispatched again. This is the refusal ADR-0016 asks
    // for — "the API must refuse to dispatch when a run for that job is already in
    // flight, or a double-click spends two runners on one job" — and it falls out
    // of the idempotency key rather than needing a separate in-flight check.
    const dispatched = result.deduped ? false : await deps.dispatcher.dispatch(result.id)

    // 200 rather than 409 on a duplicate: a user who double-clicked meant to start
    // the work once, and the useful answer is the job that is running, not an error.
    return c.json(
      { id: result.id, deduped: result.deduped, dispatched },
      result.deduped ? 200 : 202,
    )
  })

  /**
   * Progress (ADR-0016, decision 1).
   *
   * Every property of this loop exists to keep a shared, account-wide quota from
   * being spent by a tab nobody is looking at:
   *
   * - **One query per tick.** Events carry their own state, so there is no second
   *   read of the job row to find out whether it finished.
   * - **A backing-off interval.** Fast while a human is plausibly watching, slow
   *   afterwards. A flat one-second poll is 86,400 queries a day per tab against a
   *   100,000-a-day account ceiling.
   * - **A bounded lifetime.** The stream closes itself; the client reconnects if
   *   the human is still there, and does not if they are not.
   *
   * The bound this produces is asserted by `stream.test.ts` against
   * `maxStreamQueries()`, computed from the same schedule so the two cannot drift.
   */
  app.get("/jobs/:id/events", auth, async (c) => {
    const jobId = c.req.param("id")
    const store = deps.jobs(c.env)
    const startedAt = clock()

    return streamSSE(c, async (stream) => {
      // `Last-Event-ID` is the standard reconnect header, and honouring it is what
      // makes the bounded lifetime above cheap rather than lossy: a client that is
      // closed at 15 minutes resumes exactly where it stopped.
      let cursor = Number(c.req.header("last-event-id") ?? -1)
      if (!Number.isFinite(cursor)) cursor = -1

      while (true) {
        const elapsed = clock() - startedAt
        if (elapsed >= maxLifetimeMs) {
          await stream.writeSSE({
            event: "stream.closed",
            data: JSON.stringify({ reason: "lifetime" }),
          })
          return
        }

        const events = await store.eventsAfter(jobId, cursor, 100)
        for (const e of events) {
          cursor = e.seq
          await stream.writeSSE({
            id: String(e.seq),
            event: "job.state",
            data: JSON.stringify({ state: e.state, note: e.note, at: e.at }),
          })
        }

        const last = events.at(-1)
        if (last && isTerminal(last.state)) {
          await stream.writeSSE({
            event: "stream.closed",
            data: JSON.stringify({ reason: "terminal" }),
          })
          return
        }

        if (stream.aborted || stream.closed) return
        await sleep(streamPollIntervalMs(elapsed))
      }
    })
  })

  // Mounted, not inlined: a deployment without these deps simply has no such
  // routes, which is the difference between "not configured" and "configured
  // and broken".
  if (deps.kernel) {
    app.route("/lab/kernel", kernelRoutes({ ...deps.kernel, verifier: deps.verifier }))
  }
  if (deps.research) {
    app.route(
      "/",
      researchRoutes({
        ...deps.research,
        jobs: deps.jobs,
        verifier: deps.verifier,
        dispatcher: deps.dispatcher,
      }),
    )
  }

  app.onError((e, c) => {
    if (e instanceof HTTPException) return c.json({ error: e.message }, e.status)
    // Never the thrown message: it can carry a connection string. The class is
    // what a client can act on, and the log is where the detail belongs — except
    // that this log is public (ADR-0014), so it gets the class too.
    return c.json({ error: "internal" }, 500)
  })

  return app
}
