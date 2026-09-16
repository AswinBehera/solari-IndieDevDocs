import { useQuery } from "@tanstack/react-query"
import { api } from "../api"
import type { DriftExperiment, DriftSeries, Harvest, Persona } from "./types"

/**
 * Query keys in one file, because two components read the same personas.
 *
 * The create form invalidates `["lab", "personas"]` and the split screen's
 * dropdowns update, which only holds while both spell the key the same way. A key
 * assembled inline in each caller is a cache that silently splits in two.
 *
 * Every entry here is also a query against an account-wide Hyperdrive ceiling of
 * 100,000 a day (ADR-0016), which is why nothing here polls by default.
 */

export const labKeys = {
  personas: ["lab", "personas"] as const,
  harvests: (personaId: string | null) => ["lab", "harvests", personaId] as const,
  // A prefix of `drift` below, on purpose: stopping an experiment changes both the
  // row in the list and the `state` the series header reads, and one invalidation
  // that covers both is one fewer way for the two to disagree on screen.
  driftList: ["lab", "drift"] as const,
  drift: (experimentId: string | null, k: number | null) =>
    ["lab", "drift", experimentId, k] as const,
}

export function usePersonas() {
  return useQuery({
    queryKey: labKeys.personas,
    queryFn: () => api<{ personas: Persona[] }>("/lab/personas"),
    select: (data) => data.personas,
  })
}

/** Long enough for a browser session to finish, short enough not to poll all afternoon. */
const WATCH_MAX_MS = 10 * 60 * 1000
const WATCH_INTERVAL_MS = 10_000

/**
 * One persona's runs, newest first, polled only while something is expected.
 *
 * `watchSince` is the moment a harvest was queued, and it is the whole condition:
 * with no queued job this list refetches when somebody navigates or acts, and
 * never on a timer. The alternative — a flat interval — is the same arithmetic
 * that makes ADR-0016's SSE loop back off: a tab left open on a ten-second poll
 * is 8,640 queries a day against a ceiling of 100,000 for the entire account, and
 * nobody is looking at it.
 *
 * The poll stops on the first run that both started after the enqueue and reached
 * an outcome — `blocked` included, because a source refusing an identity is a
 * result and not a reason to keep asking — or at `WATCH_MAX_MS`, by which point
 * the run is not late, it is lost.
 */
export function useHarvests(personaId: string | null, watchSince: number | null) {
  return useQuery({
    queryKey: labKeys.harvests(personaId),
    queryFn: () =>
      api<{ harvests: Harvest[] }>(
        `/lab/harvests${personaId ? `?personaId=${encodeURIComponent(personaId)}` : ""}`,
      ),
    select: (data) => data.harvests,
    enabled: personaId !== null,
    refetchInterval: (query) => {
      if (watchSince === null) return false
      if (Date.now() - watchSince > WATCH_MAX_MS) return false
      const settled = (query.state.data?.harvests ?? []).some(
        (h) => h.outcome !== null && Date.parse(h.startedAt) >= watchSince,
      )
      return settled ? false : WATCH_INTERVAL_MS
    },
  })
}

/**
 * The drift experiments, and one of them as a series (P1.8).
 *
 * **The poll is the experiment's own interval.** A series changes when a day comes
 * due and its two runs land, which for the default experiment is once every 1,440
 * minutes; polling faster than the thing can change is the tab-left-open arithmetic
 * `useHarvests` above refuses. A demonstration experiment with `intervalMinutes: 1`
 * therefore refreshes about once a minute and a real one effectively never refreshes
 * inside a session, which is correct in both cases and is one rule rather than two.
 *
 * It stops when there is nothing left to wait for: a stopped experiment's remaining
 * days will be refused by the runner, and a complete one has no days left to come.
 */
const MIN_POLL_MS = 30_000

export function useDriftExperiments() {
  return useQuery({
    queryKey: labKeys.driftList,
    queryFn: () => api<{ experiments: DriftExperiment[] }>("/lab/drift"),
    select: (data) => data.experiments,
  })
}

export function useDriftSeries(experimentId: string | null, k: number | null) {
  return useQuery({
    queryKey: labKeys.drift(experimentId, k),
    enabled: experimentId !== null,
    queryFn: () =>
      api<DriftSeries>(
        `/lab/drift/${encodeURIComponent(experimentId as string)}${k ? `?k=${k}` : ""}`,
      ),
    refetchInterval: (query) => {
      const series = query.state.data
      if (!series) return false
      if (series.experiment.state === "stopped" || series.summary.complete) return false
      return Math.max(MIN_POLL_MS, series.experiment.intervalMinutes * 60_000)
    },
  })
}
