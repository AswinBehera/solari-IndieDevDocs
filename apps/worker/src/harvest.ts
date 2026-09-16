import type {
  CaptureArchive,
  DriftExperimentStore,
  HarvestRunStore,
  Pacer,
  PersonaSink,
  RawItemStore,
} from "@samsara/harvest"
import { runHarvest } from "@samsara/harvest"
import type { PersonaStore } from "@samsara/personas"
import type { SourceAdapter } from "@samsara/sources"
import type { JobHandler } from "./handlers.js"

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
  }
}
