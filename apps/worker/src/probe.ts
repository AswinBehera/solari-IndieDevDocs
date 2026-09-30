import type { Kernel } from "@samsara/kernel"
import {
  type FxRates,
  type ObservationStore,
  PROBE_VIEWPOINTS,
  type ProbeAdapter,
  type ProbeTargetStore,
  runProbe,
  type ScreenshotArchive,
} from "@samsara/probe"
import type { JobHandler } from "./handlers.js"

/**
 * `probe.run` (P3.1): look at one target from every country, once.
 *
 * The job carries a target id and nothing else: the URL, the parsed stay and the
 * owner are read from the row, so a payload cannot smuggle in a URL that never went
 * through the adapter's `parseUrl`. The adapter is looked up by the target's own
 * `sourceId`.
 *
 * Returns normally when cancelled, like `refine.score`: the observations already
 * written are real, and the next scheduled probe is the retry.
 */
export const probeJobKey = (targetId: string, window: string): string =>
  `probe.run:${targetId}:${window}`

export interface ProbeHandlerDeps {
  targets: ProbeTargetStore
  observations: ObservationStore
  archive: ScreenshotArchive
  adapters: ReadonlyMap<string, ProbeAdapter>
  rates?: () => Promise<FxRates>
}

export function createProbeHandler(deps: ProbeHandlerDeps): JobHandler {
  return async (ctx) => {
    const targetId = (ctx.job.payload as { targetId?: unknown } | null)?.targetId
    if (typeof targetId !== "string" || targetId.length === 0) {
      throw new Error("probe.run: payload.targetId must be a non-empty string")
    }
    // Optional subset of viewpoints; an unknown code is dropped, not guessed at.
    const wanted = (ctx.job.payload as { countries?: unknown }).countries
    const viewpoints = Array.isArray(wanted)
      ? PROBE_VIEWPOINTS.filter((vp) => wanted.includes(vp.country))
      : undefined
    if (viewpoints && viewpoints.length === 0) {
      throw new Error("probe.run: payload.countries names no known viewpoint")
    }
    const target = await deps.targets.get(targetId)
    if (!target) {
      await ctx.heartbeat("target is gone, nothing to do")
      return
    }
    const adapter = deps.adapters.get(target.sourceId)
    if (!adapter) throw new Error(`probe.run: no adapter registered for ${target.sourceId}`)
    const report = await runProbe(
      {
        kernel: ctx.kernel as Kernel,
        observations: deps.observations,
        archive: deps.archive,
        ...(deps.rates ? { rates: deps.rates } : {}),
      },
      { target, adapter, signal: ctx.signal, ...(viewpoints ? { viewpoints } : {}) },
    )
    const observed = report.results.filter((r) => r.outcome === "observed").length
    await ctx.heartbeat(`${observed}/${report.results.length} countries observed`)
  }
}
