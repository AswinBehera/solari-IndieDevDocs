import { type PriceCheck, priceRows } from "@dt/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api"

/**
 * The price check behind a card (P3.4, P4.7): start one probe, then read what has
 * landed until every country has answered or the wait runs out.
 *
 * **Never started by opening a document.** A probe is eight billed browser sessions,
 * so it starts from a button, and the card remembers the probe id in its own payload:
 * reopening the document reads the stored observations and spends nothing.
 */

interface ProbeResponse {
  target: { id: string; url: string }
  observations: { country: string; payload: unknown; capturedAt: string }[]
}

/** Countries a probe can reach today: the eight asked for, less `th` (no proxy there). */
export const REACHABLE = 7
/** Past this the card stops polling and shows what it has: the rest are not coming. */
const GIVE_UP_MS = 4 * 60_000
const POLL_MS = 5_000

export async function startProbe(url: string): Promise<{ targetId: string }> {
  return api<{ targetId: string }>("/probes", { method: "POST", body: JSON.stringify({ url }) })
}

export function usePriceCheck(opts: {
  url: string
  probeId: string | null
  editable: boolean
  onStarted: (probeId: string) => void
}): { check: PriceCheck; start?: () => void } {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [since] = useState(() => Date.now())
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ["probe", opts.probeId] as const,
    enabled: opts.probeId !== null,
    queryFn: () => api<ProbeResponse>(`/probes/${opts.probeId}`),
    refetchInterval: (query) => {
      const n = query.state.data?.observations.length ?? 0
      return n >= REACHABLE || Date.now() - since > GIVE_UP_MS ? false : POLL_MS
    },
  })

  const start = async () => {
    setError(null)
    setStarting(true)
    try {
      const { targetId } = await startProbe(opts.url)
      opts.onStarted(targetId)
      await qc.invalidateQueries({ queryKey: ["probe", targetId] })
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not start")
    } finally {
      setStarting(false)
    }
  }

  const startFn = opts.editable && opts.url ? { start: () => void start() } : {}
  if (error) return { check: { state: "error", message: error }, ...startFn }
  if (starting) return { check: { state: "starting" } }
  if (opts.probeId && q.data) {
    const rows = priceRows(q.data.observations)
    const finished = q.data.observations.length >= REACHABLE || Date.now() - since > GIVE_UP_MS
    return { check: { state: finished ? "done" : "running", rows } as PriceCheck, ...startFn }
  }
  if (opts.probeId && q.isError)
    return { check: { state: "error", message: q.error.message }, ...startFn }
  if (opts.probeId) return { check: { state: "running", rows: [] } }
  return { check: { state: "idle" }, ...startFn }
}
