import type { Kernel } from "@samsara/kernel"
import type {
  FxRates,
  ObservationStore,
  ProbeAdapter,
  ProbeTargetRecord,
  ScreenshotArchive,
} from "./adapter.js"
import { PROBE_VIEWPOINTS, type ProbeViewpoint } from "./viewpoints.js"

/** Plan P3 acceptance: every country answers, or says why not, inside 90 seconds. */
export const PROBE_DEADLINE_MS = 90_000

/** Sessions open at once. Eight at once is eight proxies against one host in the same second. */
export const PROBE_CONCURRENCY = 4

export interface ProbeDeps {
  kernel: Kernel
  observations: ObservationStore
  archive: ScreenshotArchive
  /** Absent means no normalisation: the adapter's raw payload is stored as it came. */
  rates?: () => Promise<FxRates>
  clock?: () => Date
}

export interface ProbeInput {
  target: ProbeTargetRecord
  adapter: ProbeAdapter
  viewpoints?: readonly ProbeViewpoint[]
  concurrency?: number
  deadlineMs?: number
  signal?: AbortSignal
}

export interface CountryResult {
  country: string
  /** `observed` means a row was written, whatever the payload says about the page. */
  outcome: "observed" | "failed"
  observationId?: string
  sessionId?: string
  /** The kernel's classification, when the session itself failed. */
  failure?: string
}

export interface ProbeReport {
  targetId: string
  results: CountryResult[]
}

/**
 * The fan-out (P3.1): one target, N countries, one session each, one observation
 * per session.
 *
 * **A refusal is an observation, not a failure.** The adapter returns a payload
 * saying blocked or no price, with a screenshot, and that is written like any
 * other: which countries a site refuses is the finding. `failed` is only for a
 * session that never produced a page (budget, provider outage, our own deadline),
 * and those write nothing, because an observation needs a session row and a
 * picture to be worth having.
 *
 * **One attempt per country.** A retry re-opens a browser against a host that just
 * declined us, which costs a second session to learn the same thing; the next
 * scheduled probe is the retry.
 *
 * The engine never reads `parsed` or `payload`.
 */
export async function runProbe(deps: ProbeDeps, input: ProbeInput): Promise<ProbeReport> {
  const { target, adapter } = input
  const clock = deps.clock ?? (() => new Date())
  const viewpoints = input.viewpoints ?? PROBE_VIEWPOINTS
  const rates = deps.rates && adapter.normalise ? await deps.rates() : null

  const probeOne = async (vp: ProbeViewpoint): Promise<CountryResult> => {
    let sessionId: string | undefined
    const result = await deps.kernel.withBrowser(
      "probe",
      {
        country: vp.country,
        locale: vp.locale,
        timezoneId: vp.timezoneId,
        ownerId: target.ownerId,
        domainId: target.sourceId,
        runId: target.id,
        deadlineMs: input.deadlineMs ?? PROBE_DEADLINE_MS,
        attempts: 1,
        onSession: (s) => {
          sessionId = s.sessionId
        },
      },
      (page, signal) =>
        adapter.probe(
          { page, country: vp.country, signal: input.signal ?? signal },
          { url: target.url, parsed: target.parsed },
        ),
    )
    if (!result.ok) {
      return {
        country: vp.country,
        outcome: "failed",
        ...(sessionId ? { sessionId } : {}),
        failure: `${result.error.kind}: ${result.error.message}`,
      }
    }
    if (!sessionId) {
      return { country: vp.country, outcome: "failed", failure: "config: no session id reported" }
    }
    const at = clock()
    const capture = result.value
    const payload =
      rates && adapter.normalise ? adapter.normalise(capture.payload, rates) : capture.payload
    const screenshotRef = await deps.archive.put(target.id, vp.country, at, capture.screenshot)
    const observationId = await deps.observations.insert({
      targetId: target.id,
      country: vp.country,
      personaId: null,
      capturedAt: at,
      payload,
      screenshotRef,
      sessionId,
      notes: capture.notes ?? null,
    })
    return { country: vp.country, outcome: "observed", observationId, sessionId }
  }

  const results: CountryResult[] = new Array(viewpoints.length)
  let next = 0
  const worker = async () => {
    while (next < viewpoints.length) {
      if (input.signal?.aborted) return
      const i = next++
      const vp = viewpoints[i] as ProbeViewpoint
      results[i] = await probeOne(vp)
    }
  }
  const width = Math.max(1, Math.min(input.concurrency ?? PROBE_CONCURRENCY, viewpoints.length))
  await Promise.all(Array.from({ length: width }, worker))
  return { targetId: target.id, results: results.filter(Boolean) }
}
