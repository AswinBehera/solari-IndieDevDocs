import type {
  CaptureArchive,
  DriftExperimentStore,
  HarvestRunStore,
  Pacer,
  PersonaSink,
  RawItemStore,
} from "@samsara/harvest"
import { runHarvest } from "@samsara/harvest"
import type { JobStore } from "@samsara/kernel"
import type { PersonaStore } from "@samsara/personas"
import type { SourceAdapter } from "@samsara/sources"
import type { JobHandler } from "./handlers.js"
import { refineJobKey } from "./refine.js"

/**
 * The `harvest.run` job type: one identity, one source, one question.
 *
 * **One handler for every domain**, which is the same rule that makes adapters
 * per-source rather than per-domain. The alternative — `harvest.run.travel` in the
 * queue — would be the seam breaking in the one place it is hardest to see, since
 * nothing about a job type is typechecked.
 *
 * The registry is a plain `Map` and is deliberately not a discovery mechanism.
 * Adapters are registered in `boot.ts` by name, so the set of sources a deployment
 * can harvest from is a line of code somebody wrote rather than whatever happened
 * to be on disk — which matters when each entry can spend money.
 */

export interface HarvestPayload {
  personaId: string
  sourceId: string
  query: string
  domainId: string
  deadlineMs?: number
  attempts?: number
  /**
   * Ask the provider to record the session video.
   *
   * Off by default (section 8: recording is on for the first 20 runs of a new
   * adapter, then off). It is a payload field rather than a property of the
   * adapter because "this adapter is new" is a fact about the *calendar*, not
   * about the code, and encoding it in the adapter would mean a deploy to turn it
   * off — which is how recordings stay on for six months.
   */
  recording?: boolean
  /**
   * Which drift experiment this run is a cell of, and which day (P1.8).
   *
   * Both or neither — the run table has a CHECK saying so, and half a pairing key
   * is a run that can never be put opposite anything. Present in the payload
   * rather than looked up here because the experiment's plan was written when it
   * was created; this job is just one of the fourteen it queued.
   */
  experimentId?: string
  experimentDay?: number
}

/**
 * Payload validation, in the handler. Same reasoning as `persona.keepalive`: the
 * queue column is `jsonb` and anything with the connection string can write a row,
 * so a typo in an operator's `INSERT` must not become a browser session asking a
 * source about `undefined` at the usual rate.
 */
function parsePayload(raw: unknown): HarvestPayload {
  const p = (raw ?? {}) as Partial<HarvestPayload>
  const required = ["personaId", "sourceId", "query", "domainId"] as const
  for (const key of required) {
    const value = p[key]
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`harvest.run: payload.${key} must be a non-empty string`)
    }
  }
  for (const key of ["deadlineMs", "attempts"] as const) {
    const value = p[key]
    if (value !== undefined && (typeof value !== "number" || value <= 0)) {
      throw new Error(`harvest.run: payload.${key} must be a positive number`)
    }
  }
  if (p.recording !== undefined && typeof p.recording !== "boolean") {
    throw new Error("harvest.run: payload.recording must be a boolean")
  }
  const hasId = typeof p.experimentId === "string" && p.experimentId.length > 0
  const hasDay = typeof p.experimentDay === "number" && Number.isInteger(p.experimentDay)
  if (hasId !== hasDay) {
    // The same all-or-nothing rule the table's CHECK enforces, stated here so the
    // failure is a refused job rather than a constraint violation three statements
    // into a browser session that has already been paid for.
    throw new Error(
      "harvest.run: payload.experimentId and payload.experimentDay are set together or not at all",
    )
  }
  if (hasDay && (p.experimentDay as number) < 0) {
    throw new Error("harvest.run: payload.experimentDay must not be negative")
  }
  return {
    personaId: p.personaId as string,
    sourceId: p.sourceId as string,
    query: p.query as string,
    domainId: p.domainId as string,
    ...(p.deadlineMs === undefined ? {} : { deadlineMs: p.deadlineMs }),
    ...(p.attempts === undefined ? {} : { attempts: p.attempts }),
    ...(p.recording === undefined ? {} : { recording: p.recording }),
    ...(hasId ? { experimentId: p.experimentId as string } : {}),
    ...(hasDay ? { experimentDay: p.experimentDay as number } : {}),
  }
}

export interface HarvestHandlerDeps {
  sources: ReadonlyMap<string, SourceAdapter<unknown>>
  personas: PersonaStore
  runs: HarvestRunStore
  items: RawItemStore
  archive: CaptureArchive
  pacer?: Pacer
  /**
   * The drift experiments, read-only in practice (P1.8).
   *
   * Optional because a deployment that never runs an experiment does not need it,
   * and because the refusal below is the *only* thing it is for. It has to be here
   * rather than in the API: stopping an experiment cannot unqueue the days it
   * already queued, so "stopped" only stops spend if something reads it at claim
   * time, before a browser opens.
   */
  experiments?: Pick<DriftExperimentStore, "byId">
  /**
   * Where the follow-on `refine.extract` job goes (P2.6).
   *
   * Required, unlike the two optional deps above, because the failure it prevents
   * is silent. A harvest that does not chain still succeeds, still writes its
   * items and still reports a green run — the only symptom is that `/lab/mentions`
   * stays empty for reasons nothing says out loud. A missing optional dep would
   * produce exactly that; a missing required one does not compile.
   */
  queue: Pick<JobStore, "enqueue">
}

export function createHarvestHandler(deps: HarvestHandlerDeps): JobHandler {
  return async (ctx) => {
    const input = parsePayload(ctx.job.payload)

    const adapter = deps.sources.get(input.sourceId)
    if (!adapter) {
      // `config`, and therefore not retried: a source that is not registered will
      // not become registered by trying again in thirty seconds.
      throw new Error(`harvest.run: no adapter registered for source ${input.sourceId}`)
    }

    if (input.experimentId !== undefined && deps.experiments) {
      const experiment = await deps.experiments.byId(input.experimentId)
      if (!experiment) {
        throw new Error(`harvest.run: no such experiment: ${input.experimentId}`)
      }
      if (experiment.state === "stopped") {
        // Not a retry and not a failure of this job — the experiment was called
        // off after this day was queued, which is the ordinary way a week ends
        // early. The days already measured stay where they are.
        await ctx.heartbeat(
          `experiment ${experiment.id} was stopped; not spending on day ${input.experimentDay}`,
        )
        return
      }
    }

    const persona = await deps.personas.byId(input.personaId)
    if (!persona) throw new Error(`harvest.run: no such persona: ${input.personaId}`)
    if (persona.health === "banned" || persona.health === "retired") {
      // Checked before the session opens, for the same reason `keepalive` checks it:
      // the point of the health state is that it stops spend.
      throw new Error(
        `harvest.run: persona ${persona.id} is ${persona.health}; harvesting would spend on a dead identity`,
      )
    }

    await ctx.heartbeat(`harvest ${input.sourceId} as ${persona.id}`)

    const result = await runHarvest(
      adapter,
      {
        kernel: ctx.kernel,
        runs: deps.runs,
        items: deps.items,
        archive: deps.archive,
        // Passed unconditionally, unlike in a test: a production harvest that does
        // not tell the persona what happened is a ban detector with no evidence.
        personas: deps.personas satisfies PersonaSink,
        logger: ctx.logger,
        ...(deps.pacer ? { pacer: deps.pacer } : {}),
      },
      {
        domainId: input.domainId,
        persona: {
          id: persona.id,
          country: persona.country,
          locale: persona.locale,
          timezoneId: persona.timezoneId,
        },
        query: input.query,
        proxySession: persona.proxySession,
        profileId: persona.solariProfileId,
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
        ...(input.recording === undefined ? {} : { recording: input.recording }),
        ...(input.experimentId === undefined || input.experimentDay === undefined
          ? {}
          : { experiment: { id: input.experimentId, day: input.experimentDay } }),
      },
    )

    if (!result.ok) {
      // `cause` as well as `kind: message`, because the kind alone is not a
      // diagnosis. This cost a session during P1.8's end-to-end run: a harvest
      // failed twice as `internal: unhandled kernel error`, which is what
      // `classify` says when it cannot positively identify a thrown value, and
      // the actual content was sitting on `Failure.cause` the whole time and was
      // dropped one line before it reached `jobs.last_error`. `record-capture.ts`
      // learned the same lesson and says so in the same words. `cause` is an
      // Error's name and message only, never a stack, so it is safe in a column.
      const { kind, message, cause } = result.error
      throw new Error(`${kind}: ${message}${cause ? ` — ${cause}` : ""}`)
    }

    const report = result.value
    await ctx.heartbeat(
      `${report.outcome}: ${report.itemCount} item(s), ${report.minutes.toFixed(2)} min`,
    )

    // P2.6's chaining, and it happens *after* the report above on purpose: the
    // harvest is finished and has said so by this point, and nothing below is
    // allowed to change that.
    if (report.itemCount === 0) return

    // `get`, not `require`. A domain can be harvested without being extractable —
    // the engine stamps `domainId` on rows and has no opinion about packs, which
    // is the seam working rather than a gap in it. Said out loud regardless,
    // because the other thing this looks like is a runner that shipped without
    // its pack, and those two must not be indistinguishable in the log.
    const pack = ctx.packs.get(input.domainId)
    if (!pack) {
      await ctx.heartbeat(
        `no pack registered for ${input.domainId}: ${report.itemCount} item(s) harvested, none queued for extraction`,
      )
      return
    }

    try {
      const { deduped } = await deps.queue.enqueue({
        type: "refine.extract",
        domainId: input.domainId,
        idempotencyKey: refineJobKey(input.domainId, pack.version, report.runId),
        payload: { domainId: input.domainId, harvestRunId: report.runId },
      })
      await ctx.heartbeat(
        deduped
          ? `extraction of run ${report.runId} was already queued`
          : `queued extraction of run ${report.runId}`,
      )
    } catch (error) {
      // Deliberately not fatal, which is the opposite of the rule everywhere else
      // in this file. Failing here would put the *harvest* back in the queue, and
      // a harvest costs a browser session and real provider minutes; re-spending
      // them to repair a failed INSERT is a worse outcome than the gap it repairs.
      //
      // The gap is recoverable by other means, which is the only reason swallowing
      // it is honest: `tools/backfill-refine.ts` enqueues from the runs table, so
      // anything missed here is reachable without anyone knowing it was missed.
      //
      // Recorded as a heartbeat rather than a kernel event, and not because a
      // kernel event would be wrong — because `KernelEvent` is a closed union
      // whose closedness is ADR-0014's actual defence, so widening it is a
      // reviewed diff in `log.ts` and not something a catch block helps itself to.
      // The note is the better home regardless: heartbeats land in `job_events`
      // (ADR-0016), which outlives a workflow log and can be queried. The error's
      // class only, never its message, which may carry a connection string.
      const kind = error instanceof Error ? error.name : "unknown"
      await ctx.heartbeat(
        `could not queue extraction of run ${report.runId} (${kind}); backfill can recover it`,
      )
    }
  }
}
