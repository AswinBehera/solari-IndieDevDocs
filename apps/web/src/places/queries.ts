import type { Place } from "@dt/core"
import type { CardEvidence } from "@dt/ui"
import { useQuery } from "@tanstack/react-query"
import { api } from "../api"

/**
 * `/lab/places`, and the one conversion the wire forces on it.
 *
 * JSON has no dates, so the four timestamps on a `Place` arrive as ISO strings,
 * and a card handed a string where its type says `Date` would compile and then
 * fail the first time anything called a method on it. `fromWire` is the only
 * place that is fixed, and it is a plain function so a test can hold it.
 */

type DateField = "firstSeenAt" | "lastSeenAt" | "createdAt" | "updatedAt"
export type WirePlace = Omit<Place, DateField> & Record<DateField, string>

/** The numbers Phase 2's acceptance is written in; absent from older API builds. */
export interface PlaceSummary {
  total: number
  withGeo: number
  strong: number
}

export interface PlacesResponse {
  places: { place: WirePlace; evidence: CardEvidence | null }[]
  summary?: PlaceSummary
}

export interface PlaceGridData {
  places: Place[]
  /** Quote per place id, the shape `PlaceGrid` takes. */
  evidence: Record<string, CardEvidence>
  summary: PlaceSummary | null
}

/** One place off the wire, its four timestamps turned back into dates. */
export function placeFromWire(p: WirePlace): Place {
  return {
    ...p,
    firstSeenAt: new Date(p.firstSeenAt),
    lastSeenAt: new Date(p.lastSeenAt),
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt),
  }
}

export function fromWire(body: PlacesResponse): PlaceGridData {
  const places: Place[] = []
  const evidence: Record<string, CardEvidence> = {}
  for (const row of body.places) {
    places.push(placeFromWire(row.place))
    if (row.evidence) evidence[row.place.id] = row.evidence
  }
  return { places, evidence, summary: body.summary ?? null }
}

/** Fetched once per visit and category: nothing here polls, for ADR-0016's Hyperdrive reason. */
export function usePlaces(category: string | null = null) {
  return useQuery({
    queryKey: ["lab", "places", category] as const,
    queryFn: () =>
      api<PlacesResponse>(
        category ? `/lab/places?category=${encodeURIComponent(category)}` : "/lab/places",
      ),
    select: fromWire,
  })
}
