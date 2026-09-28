import type { Postcard, PostcardKind, PostcardState, Trip, TripStatus } from "@dt/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api"

/**
 * Trips, their document and their Postcards, as the browser sees them.
 *
 * JSON has no dates, so every timestamp arrives as an ISO string and is turned
 * back into a `Date` here — once, at the edge — so that nothing past this file
 * has to wonder which one it is holding. The conversions are plain functions a
 * test can hold; the hooks around them are thin.
 */

type Wire<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: T[P] extends Date ? string : string | null
}

export type WireTrip = Wire<Trip, "startDate" | "endDate" | "createdAt" | "updatedAt">
export type WirePostcard = Omit<Postcard, "time" | "createdAt" | "updatedAt"> & {
  time: { start: string; end: string | null } | null
  createdAt: string
  updatedAt: string
}

export interface TripSummary {
  trip: Trip
  postcards: number
  withGeo: number
}

export interface TripRecord {
  trip: Trip
  document: { content: unknown; version: number; updatedAt: Date }
  postcards: Postcard[]
}

const date = (s: string) => new Date(s)
const maybeDate = (s: string | null) => (s === null ? null : new Date(s))

export function tripFromWire(t: WireTrip): Trip {
  return {
    ...t,
    startDate: maybeDate(t.startDate),
    endDate: maybeDate(t.endDate),
    createdAt: date(t.createdAt),
    updatedAt: date(t.updatedAt),
  }
}

export function postcardFromWire(p: WirePostcard): Postcard {
  return {
    ...p,
    time: p.time ? { start: date(p.time.start), end: maybeDate(p.time.end) } : null,
    createdAt: date(p.createdAt),
    updatedAt: date(p.updatedAt),
  }
}

export function recordFromWire(r: {
  trip: WireTrip
  document: { content: unknown; version: number; updatedAt: string }
  postcards: WirePostcard[]
}): TripRecord {
  return {
    trip: tripFromWire(r.trip),
    document: { ...r.document, updatedAt: date(r.document.updatedAt) },
    postcards: r.postcards.map(postcardFromWire),
  }
}

/** A calendar day as the API stores it: midnight UTC. `"2026-11-14"` in, ISO out. */
export const dayToIso = (day: string): string => `${day}T00:00:00.000Z`

export const tripKeys = {
  all: ["trips"] as const,
  one: (id: string) => ["trips", id] as const,
}

export function useTrips() {
  return useQuery({
    queryKey: tripKeys.all,
    queryFn: () =>
      api<{ trips: { trip: WireTrip; postcards: number; withGeo: number }[] }>("/trips"),
    select: (body): TripSummary[] => body.trips.map((t) => ({ ...t, trip: tripFromWire(t.trip) })),
  })
}

export interface NewTripInput {
  title: string
  destinationCity: string
  startDate: string | null
  endDate: string | null
  status: TripStatus
  content?: unknown
}

export function useCreateTrip() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: NewTripInput) =>
      api<{ trip: WireTrip }>("/trips", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => client.invalidateQueries({ queryKey: tripKeys.all }),
  })
}

export function useTrip(id: string) {
  return useQuery({
    queryKey: tripKeys.one(id),
    queryFn: () =>
      api<{
        trip: WireTrip
        document: { content: unknown; version: number; updatedAt: string }
        postcards: WirePostcard[]
      }>(`/trips/${id}`),
    select: recordFromWire,
    // The editor owns the document once it is open; a background refetch landing
    // an older copy under the cursor would be worse than a stale list of cards.
    refetchOnMount: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function usePatchTrip(id: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<Omit<NewTripInput, "content">>) =>
      api<{ trip: WireTrip }>(`/trips/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => client.invalidateQueries({ queryKey: tripKeys.all, exact: true }),
  })
}

export interface NewPostcardInput {
  kind: PostcardKind
  placeId?: string | null
  payload?: unknown
  geo?: { lat: number; lng: number } | null
  time?: { start: string; end: string | null } | null
  sourceRefs?: string[]
  state?: PostcardState
}

export async function createPostcard(tripId: string, input: NewPostcardInput): Promise<Postcard> {
  const body = await api<{ postcard: WirePostcard }>(`/trips/${tripId}/postcards`, {
    method: "POST",
    body: JSON.stringify(input),
  })
  return postcardFromWire(body.postcard)
}

export interface PostcardPatchInput {
  payload?: unknown
  geo?: { lat: number; lng: number } | null
  time?: { start: string; end: string | null } | null
  state?: PostcardState
}

export async function patchPostcard(id: string, patch: PostcardPatchInput): Promise<Postcard> {
  const body = await api<{ postcard: WirePostcard }>(`/postcards/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
  return postcardFromWire(body.postcard)
}

export async function deletePostcard(id: string): Promise<void> {
  await api<unknown>(`/postcards/${id}`, { method: "DELETE" })
}
