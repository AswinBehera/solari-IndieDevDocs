import { type DealSearch, type DealStub, type OfferRow, offerRows, offerVerdict } from "@dt/ui"
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api"

/**
 * The price card behind the scenes: a link per booking site, each read once from
 * the card's viewpoint, and the codes the Deal hunter has found for those sites.
 *
 * **Never started by opening a document.** Each read is a billed browser session,
 * so it starts from the button, and each offer keeps its probe id in the card's
 * payload: reopening reads the stored observation and spends nothing.
 */

export interface Offer {
  url: string
  probeId: string | null
}

export const DEFAULT_VIEWPOINT = "us"
/** Beam, the Deal hunter preset, seeded with a fixed id (`seed-characters.ts`). */
export const DEAL_HUNTER = { id: "00000000-0000-4000-8000-0000000c0005", name: "Beam" }

interface ProbeResponse {
  target: { id: string; url: string; parsed: unknown }
  observations: { country: string; payload: unknown; capturedAt: string; screenshotRef: string }[]
}

/** A single-country read is one session; past this, it is not coming. */
const GIVE_UP_MS = 3 * 60_000
const POLL_MS = 4_000

/** Offers from a card payload. A card saved before this shape was `{url, probeId}`. */
export function offersOf(payload: Record<string, unknown>): Offer[] {
  const one = (o: unknown): Offer | null => {
    if (typeof o !== "object" || o === null) return null
    const r = o as Record<string, unknown>
    if (typeof r.url !== "string" || !r.url) return null
    return { url: r.url, probeId: typeof r.probeId === "string" ? r.probeId : null }
  }
  if (Array.isArray(payload.offers)) return payload.offers.map(one).filter((o) => o !== null)
  const legacy = one(payload)
  return legacy ? [legacy] : []
}

export function viewpointOf(payload: Record<string, unknown>): string {
  return typeof payload.viewpoint === "string" ? payload.viewpoint : DEFAULT_VIEWPOINT
}

export function useOffers(opts: {
  offers: Offer[]
  viewpoint: string
  editable: boolean
  onChange: (offers: Offer[]) => void
}): {
  rows: OfferRow[]
  verdict: string | null
  checking: boolean
  error: string | null
  check?: () => void
} {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [since] = useState(() => Date.now())
  const qc = useQueryClient()

  const landed = (d: ProbeResponse | undefined) =>
    d?.observations.find((o) => o.country === opts.viewpoint) ?? null

  const probes = useQueries({
    queries: opts.offers.map((o) => ({
      queryKey: ["probe", o.probeId] as const,
      enabled: o.probeId !== null,
      queryFn: () => api<ProbeResponse>(`/probes/${o.probeId}`),
      refetchInterval: (q: { state: { data: ProbeResponse | undefined } }) =>
        landed(q.state.data) || Date.now() - since > GIVE_UP_MS ? false : POLL_MS,
    })),
  })

  const rows = offerRows(
    opts.offers.map((o, i) => {
      const data = probes[i]?.data
      const obs = landed(data)
      const gaveUp = o.probeId !== null && !obs && Date.now() - since > GIVE_UP_MS
      return {
        url: o.url,
        parsed: data?.target.parsed,
        observation: obs
          ? { country: obs.country, payload: obs.payload, screenshotRef: obs.screenshotRef }
          : gaveUp
            ? { country: opts.viewpoint, payload: { status: "no_price" } }
            : null,
        started: o.probeId !== null,
      }
    }),
  )

  const check = async () => {
    setError(null)
    setChecking(true)
    try {
      const next = await Promise.all(
        opts.offers.map(async (o) => {
          if (o.probeId) return o
          const { targetId } = await api<{ targetId: string }>("/probes", {
            method: "POST",
            body: JSON.stringify({ url: o.url, countries: [opts.viewpoint] }),
          })
          return { url: o.url, probeId: targetId }
        }),
      )
      opts.onChange(next)
      await qc.invalidateQueries({ queryKey: ["probe"] })
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not start")
    } finally {
      setChecking(false)
    }
  }

  return {
    rows,
    verdict: offerVerdict(rows),
    checking,
    error,
    ...(opts.editable && opts.offers.length > 0 ? { check: () => void check() } : {}),
  }
}

/** Codes for the card's sites, and what was searched to find them. */
export function useDeals(providers: string[]) {
  return useQuery({
    queryKey: ["deals", providers.join(",")] as const,
    queryFn: () =>
      api<{ deals: DealStub[]; searched: DealSearch }>(
        `/lab/deals?providers=${encodeURIComponent(providers.join(","))}`,
      ),
    staleTime: 60_000,
  })
}
