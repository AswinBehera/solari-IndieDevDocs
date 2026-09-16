import { useQuery } from "@tanstack/react-query"
import { api } from "../api"
import type { Harvest, Persona } from "./types"

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
