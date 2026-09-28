import type { Place } from "@dt/core"
import type { Bbox, CardEvidence } from "@dt/ui"
import { api } from "../api"
import { placeFromWire, type WirePlace } from "../places/queries"

/**
 * A place, as a Postcard keeps it.
 *
 * **A snapshot, not a live reference** (§6.2: "never silently refresh what a user
 * pinned"). The card stores the place as it was read — names, scores, the quote —
 * with the moment it was read, and only REFRESH replaces it. A score that moves
 * overnight therefore moves on the Places grid and not under a traveller's pin.
 */
export interface PlaceSnapshot {
  place: WirePlace
  evidence: CardEvidence | null
  readAt: string
}

export function snapshotOf(
  place: WirePlace,
  evidence: CardEvidence | null,
  now: Date,
): PlaceSnapshot {
  return { place, evidence, readAt: now.toISOString() }
}

/** The payload back into something a card can draw, or null for one that is not a place. */
export function placeFromPayload(
  payload: unknown,
): { place: Place; evidence: CardEvidence | null } | null {
  const p = payload as Partial<PlaceSnapshot> | null
  if (!p || typeof p !== "object" || !p.place || typeof p.place.id !== "string") return null
  return { place: placeFromWire(p.place), evidence: p.evidence ?? null }
}

/** Read one place again, for REFRESH. */
export async function readPlace(
  id: string,
): Promise<{ place: WirePlace; evidence: CardEvidence | null }> {
  return await api<{ place: WirePlace; evidence: CardEvidence | null }>(`/places/${id}`)
}

/** Search the table, for `/place`. */
export async function searchPlaces(
  q: string,
): Promise<{ place: WirePlace; evidence: CardEvidence | null }[]> {
  const body = await api<{ places: { place: WirePlace; evidence: CardEvidence | null }[] }>(
    `/places?q=${encodeURIComponent(q)}`,
  )
  return body.places
}

/**
 * The frame a city's locators draw in: west, south, east, north.
 *
 * Bangkok's is `tier0.ts`'s, wide enough for Nonthaburi and Samut Prakan. Tokyo's
 * is the 23 wards. A city without one gets a frame around the point itself, so a
 * dot still lands in the middle rather than off the edge of a frame that is not
 * about it.
 */
const FRAMES: Record<string, Bbox> = {
  Bangkok: [100.3, 13.5, 100.95, 14.0],
  Tokyo: [139.56, 35.52, 139.92, 35.82],
}

export function frameFor(city: string, geo?: { lat: number; lng: number } | null): Bbox {
  const known = FRAMES[city]
  if (known) return known
  if (geo) return [geo.lng - 0.2, geo.lat - 0.2, geo.lng + 0.2, geo.lat + 0.2]
  return FRAMES.Bangkok as Bbox
}
