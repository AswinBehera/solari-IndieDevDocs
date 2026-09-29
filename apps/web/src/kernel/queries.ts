import { useQuery } from "@tanstack/react-query"
import { api } from "../api"

/** `/lab/kernel` (P5.5), as the API sends it. Nothing here needs converting: no dates are used as dates. */
export interface KernelResponse {
  now: string
  open: { id: string; purpose: string; country: string; startedAt: string }[]
  minutesToday: { purpose: string; minutes: number }[]
  meters: { meter: string; ceiling: number; used: number }[]
  adapters: { domainId: string; total: number; blocked: number; blockedRate: number }[]
  personas: {
    id: string
    name: string
    country: string
    health: string
    lastAliveAt: string | null
    sessions: number
    blocks: number
  }[]
}

/** Fraction of a ceiling used, clamped to the bar, and 0 for a ceiling that is not positive. */
export function usedFraction(used: number, ceiling: number): number {
  if (!(ceiling > 0)) return 0
  return Math.min(1, Math.max(0, used / ceiling))
}

/**
 * Fetched once per visit, like every Lab read: a poll here would be a query per
 * viewer per interval against the Hyperdrive allowance (ADR-0016).
 */
export function useKernel() {
  return useQuery({
    queryKey: ["lab", "kernel"] as const,
    queryFn: () => api<KernelResponse>("/lab/kernel"),
  })
}
