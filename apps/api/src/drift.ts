import { sourceId as sourceIdSchema } from "@samsara/core"
import type { DriftRun } from "@samsara/harvest/drift"
// Subpath imports only, for the reason `lab.ts` gives: `./drift` is pure
// arithmetic and `./ports` is types, and both exist so that importing them from a
// Workers bundle is a compile error the day somebody puts Playwright behind them.
import { driftSeries, planDriftRuns } from "@samsara/harvest/drift"
import type {
  DriftExperimentFilter,
  DriftExperimentRecord,
  HarvestRunRecord,
} from "@samsara/harvest/ports"
import type { JobStore } from "@samsara/kernel/jobs"
import type { PersonaRecord } from "@samsara/personas/store"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"

/**
 * The drift experiment's surface (P1.8).
 *
 * P1.7 built the split screen: one question, two identities, one day. This is the
 * same question asked every day for a week, which sounds like a scheduling feature
 * and is mostly a refusal to lie with a chart.
 *
 * **Creating an experiment enqueues the whole week at once.** Not a recurring job,
 * not a tick that schedules tomorrow — `planDriftRuns` produces every run up front
 * with a `runAfter` and an idempotency key, and the queue holds them. The reasoning
 * is in `@samsara/harvest/drift`; the consequence here is that this handler does
 * `days × 2 + 1` writes in one request, which is what `MAX_DAYS` is sized against.
 *
 * **Reading one back is two queries, not fourteen.** `listByExperiment` for the
 * runs and `rankedUrls` for the identifiers — never `listByRun` in a loop, which
 * would pull every harvested item's text across Hyperdrive to draw a line made of
 * seven numbers.
 */

/**
 * The longest experiment this route will create, and the reason is subrequests.
 *
 * A Worker on the free plan gets 50 subrequests per invocation (ADR-0014). Two
 * persona reads, one insert and `days × 2` enqueues is `3 + 2d`, so fourteen days
 * is 31 and thirty days would be 63 — a limit that would be hit in production and
 * nowhere else, halfway through queueing a month of work, leaving an experiment
 * whose second half does not exist. The plan asks for seven.
 */
const MAX_DAYS = 14
const DEFAULT_DAYS = 7

/** The same ceiling `/lab/compare` uses; k is the width of the arithmetic. */
const MAX_K = 100
const DEFAULT_K = 20

/**
 * A minute, and the reason it is not a day.
 *
 * `intervalMinutes` is settable so the whole mechanism can be demonstrated in ten
 * minutes rather than being provable only by waiting a week or faking a clock. It
 * has a floor because two harvests of the same source seconds apart is not a
 * measurement of drift, it is a rate-limit test.
 */
const MIN_INTERVAL_MINUTES = 1

const createBody = z.object({
  sourceId: sourceIdSchema,
  query: z.string().min(1).max(200),
  personaAId: z.string().min(1),
  personaBId: z.string().min(1),
  days: z.number().int().min(1).max(MAX_DAYS).default(DEFAULT_DAYS),
  k: z.number().int().min(1).max(MAX_K).default(DEFAULT_K),
  intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).default(1440),
  domainId: z.string().min(1).default("atlas"),
  /**
   * Ask the provider to record every session this experiment runs.
   *
   * Deliberately **not** a column on `drift_experiments`. What a recording is
   * lives on `sessions.recording_ref`, one row per session, which already answers
   * "is there video of day 3" — a flag on the experiment would be a second place
   * for the same fact to be wrong, and the one that lies when a run is retried.
   * This decides what goes into the fourteen payloads and nothing else.
   *
   * Off by default, like the payload field it feeds (section 8: recording is on
   * for the first 20 runs of a new adapter, then off). On for the Phase 1
   * acceptance run, because half of that criterion is "recorded sessions show no
   * captcha loops", fourteen sessions is the cheapest evidence this project will
   * ever have for it, and it is evidence that cannot be collected afterwards: a
   * week that was not recorded cannot be re-recorded without running the week.
   */
  recording: z.boolean().default(false),
})

/**
 * The slices of the two stores this file uses.
 *
 * Narrower than the real ports for the reason `lab.ts` states: the read routes
 * here must not be able to write, and the way to guarantee that is for the write
 * method not to be in the type they hold.
 */
export interface DriftExperimentStoreReader {
  byId(id: string): Promise<DriftExperimentRecord | null>
  list(filter?: DriftExperimentFilter): Promise<DriftExperimentRecord[]>
}

export interface DriftExperimentStoreWriter extends DriftExperimentStoreReader {
  insert(row: DriftExperimentRecord): Promise<void>
  setState(id: string, state: DriftExperimentRecord["state"]): Promise<void>
}

export interface DriftRunReaderSlice {
  listByExperiment(experimentId: string, limit?: number): Promise<HarvestRunRecord[]>
}

export interface DriftItemReaderSlice {
  rankedUrls(harvestRunIds: readonly string[], k: number): Promise<Map<string, string[]>>
}

/**
 * One factory for the four stores, as in `lab.ts`, and a separate one for jobs.
 *
 * The four share a Hyperdrive connection and are always used together; the queue
 * is deliberately apart, because it is the thing that must keep working when
 * everything else is misconfigured.
 */
export interface DriftStores {
  experiments: DriftExperimentStoreWriter
  runs: DriftRunReaderSlice
  items: DriftItemReaderSlice
  personas: { byId(id: string): Promise<PersonaRecord | null> }
}

export interface DriftDeps {
  stores: (env: unknown) => DriftStores
  jobs: (env: unknown) => JobStore
  newId?: () => string
  clock?: () => Date
}

const experimentView = (e: DriftExperimentRecord) => ({
  id: e.id,
  domainId: e.domainId,
  sourceId: e.sourceId,
  query: e.query,
  personaAId: e.personaAId,
  personaBId: e.personaBId,
  days: e.days,
  k: e.k,
  intervalMinutes: e.intervalMinutes,
  startedAt: e.startedAt.toISOString(),
  state: e.state,
})

/**
 * An identity that may not be asked to spend, and why.
 *
 * Checked here rather than only at claim time because fourteen queued jobs against
 * a banned persona is fourteen refusals in the runner's log and a chart with no
 * points, discovered a week later. The runner still checks — this is the earlier of
 * two refusals, not a replacement for it.
 */
const unusable = (p: PersonaRecord | null, side: string): string | null => {
  if (!p) return `${side} is not a persona we know`
  if (p.health === "banned" || p.health === "retired") {
    return `${side} is ${p.health} and cannot be asked to run a week of sessions`
  }
  return null
}

export function driftRoutes(deps: DriftDeps) {
  const drift = new Hono<{ Bindings: Record<string, unknown> }>()
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const clock = deps.clock ?? (() => new Date())

  drift.post("/", async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new HTTPException(400, {
        message: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body",
      })
    }
    const body = parsed.data
    if (body.personaAId === body.personaBId) {
      // The same refusal `/lab/compare` makes, for the same reason and with more
      // at stake: a week of an identity compared with itself is a flat line at
      // 1.0 that costs fourteen browser sessions to draw.
      throw new HTTPException(400, { message: "a and b must be different personas" })
    }

    const personaStore = deps.stores(c.env).personas
    const [a, b] = await Promise.all([
      personaStore.byId(body.personaAId),
      personaStore.byId(body.personaBId),
    ])
    const refusal = unusable(a, "personaAId") ?? unusable(b, "personaBId")
    if (refusal) throw new HTTPException(400, { message: refusal })

    const experiment: DriftExperimentRecord = {
      id: newId(),
      domainId: body.domainId,
      // From the verified token, never the body: a week of sessions has somebody
      // to bill, and a client that could name its own owner could bill anyone.
      ownerId: c.get("ownerId"),
      sourceId: body.sourceId,
      query: body.query,
      personaAId: body.personaAId,
      personaBId: body.personaBId,
      days: body.days,
      k: body.k,
      intervalMinutes: body.intervalMinutes,
      startedAt: clock(),
      state: "running",
    }

    // The row first, then the jobs. A job that names an experiment which does not
    // exist yet is a foreign key violation in the runner; an experiment with no
    // jobs yet is a plan that has not been queued, which is what a failure here
    // should look like.
    await deps.stores(c.env).experiments.insert(experiment)

    const jobs = deps.jobs(c.env)
    const plans = planDriftRuns(experiment)
    const enqueued: string[] = []
    for (const plan of plans) {
      // Sequential rather than `Promise.all`: these share one Hyperdrive
      // connection, and the idempotency key means a retry of this whole request
      // re-enqueues nothing rather than doubling the week.
      const result = await jobs.enqueue({
        type: "harvest.run",
        domainId: experiment.domainId,
        ownerId: experiment.ownerId,
        payload: {
          personaId: plan.personaId,
          sourceId: experiment.sourceId,
          query: experiment.query,
          domainId: experiment.domainId,
          experimentId: experiment.id,
          experimentDay: plan.day,
          // Spread rather than `recording: false`: `exactOptionalPropertyTypes`
          // is on and the handler's parser treats absent and present-and-false
          // differently in exactly one respect — an absent field cannot be a
          // typo'd one.
          ...(body.recording ? { recording: true } : {}),
        },
        idempotencyKey: plan.idempotencyKey,
        runAfter: plan.runAfter,
      })
      enqueued.push(result.id)
    }

    return c.json({ experiment: experimentView(experiment), queued: enqueued.length }, 201)
  })

  drift.get("/", async (c) => {
    const state = c.req.query("state")
    const rows = await deps.stores(c.env).experiments.list({
      ...(state === "running" || state === "stopped" ? { state } : {}),
    })
    return c.json({ experiments: rows.map(experimentView) })
  })

  /**
   * One experiment as a series, which is the thing the Lab plots.
   *
   * Two reads and one pure function. The arithmetic is `driftSeries` from the
   * engine rather than anything written here, for the reason `/lab/compare` gives:
   * there is meant to be exactly one implementation of every number that reaches a
   * screen, and a chart that computes its own overlap is a second one.
   */
  drift.get("/:id", async (c) => {
    const stores = deps.stores(c.env)
    const experiment = await stores.experiments.byId(c.req.param("id"))
    if (!experiment) throw new HTTPException(404, { message: "no such experiment" })

    const k = Math.max(1, Math.min(Number(c.req.query("k")) || experiment.k, MAX_K))
    const runs = await stores.runs.listByExperiment(experiment.id)
    const urls = await stores.items.rankedUrls(
      runs.map((r) => r.id),
      k,
    )
    const series = driftSeries(experiment, runs, urls, k, clock())

    return c.json({
      experiment: experimentView(experiment),
      k: series.k,
      summary: series.summary,
      points: series.points.map((p) => ({
        day: p.day,
        dueAt: p.dueAt.toISOString(),
        measuredAt: p.measuredAt?.toISOString() ?? null,
        state: p.state,
        overlap: p.overlap,
        meanRankShift: p.meanRankShift,
        a: sideView(p.a),
        b: sideView(p.b),
      })),
    })
  })

  /**
   * Stop spending. Not delete.
   *
   * The remaining days are already rows in the queue, so nothing is cancelled by
   * this write — the runner reads the experiment's state before it opens a browser
   * and refuses there. Deleting the row instead would leave those jobs pointing at
   * nothing, spending anyway, and would take the days already measured with it.
   */
  drift.post("/:id/stop", async (c) => {
    const store = deps.stores(c.env).experiments
    const experiment = await store.byId(c.req.param("id"))
    if (!experiment) throw new HTTPException(404, { message: "no such experiment" })
    if (experiment.state === "stopped") return c.json({ experiment: experimentView(experiment) })
    await store.setState(experiment.id, "stopped")
    return c.json({ experiment: experimentView({ ...experiment, state: "stopped" }) })
  })

  return drift
}

const sideView = (run: DriftRun | null) =>
  run === null
    ? null
    : {
        runId: run.runId,
        personaId: run.personaId,
        outcome: run.outcome,
        itemCount: run.itemCount,
        startedAt: run.startedAt.toISOString(),
      }
