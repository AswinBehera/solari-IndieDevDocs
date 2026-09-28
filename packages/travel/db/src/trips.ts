import {
  type Geo,
  POSTCARD_ATTR,
  POSTCARD_NODE,
  type Postcard,
  type PostcardKind,
  type PostcardState,
  postcardIdsIn,
  type Trip,
  type TripStatus,
} from "@dt/core"
import { and, desc, eq, sql } from "drizzle-orm"
import type { Db } from "./client.js"
import { documents, postcards, trips, users } from "./tables.js"

/**
 * Trips, their one document, and the Postcards in it — the Trip Document's storage
 * (P4.1), behind a port the API can fake.
 *
 * **Every read and write is scoped by owner.** The API authenticates and hands down
 * `ownerId` (ADR-0013: no RLS in v1, authorisation lives above the database), and a
 * method here that took a trip id alone would be one forgotten check away from
 * serving someone else's trip. So a trip that exists but is not yours answers
 * exactly like a trip that does not exist: `null`.
 *
 * **The document is saved with its version, and a stale version is refused.** One
 * document, edited from two tabs, is the ordinary case; last-write-wins would lose
 * a paragraph silently. The editor sends the version it loaded, the write only
 * lands if that is still current, and the caller is told the current version
 * otherwise — the plan's "version column for optimistic concurrency".
 */

export interface TripSummary {
  trip: Trip
  /** Postcards on the trip, and how many of them can appear on a map. */
  postcards: number
  withGeo: number
}

export interface TripDocumentRecord {
  content: unknown
  version: number
  updatedAt: Date
}

export interface TripRecord {
  trip: Trip
  document: TripDocumentRecord
  postcards: Postcard[]
}

export interface NewTrip {
  title: string
  destinationCity: string
  startDate: Date | null
  endDate: Date | null
  status: TripStatus
  /** The document's first content. Tiptap JSON; the store does not read it. */
  content: unknown
}

export type TripPatch = Partial<
  Pick<Trip, "title" | "destinationCity" | "startDate" | "endDate" | "status">
>

export interface NewPostcard {
  kind: PostcardKind
  placeId: string | null
  payload: unknown
  geo: Geo | null
  time: { start: Date; end: Date | null } | null
  sourceRefs: string[]
  state?: PostcardState
}

export type PostcardPatch = Partial<Pick<Postcard, "payload" | "geo" | "time" | "state">>

export type SaveResult =
  | { saved: true; version: number }
  /** Someone saved since this version was loaded. `version` is the current one. */
  | { saved: false; version: number }

export interface TripStore {
  /** Whether a sign-up has created this owner's row. Trips hang off it. */
  hasAccount(ownerId: string): Promise<boolean>
  list(ownerId: string): Promise<TripSummary[]>
  create(ownerId: string, input: NewTrip): Promise<TripRecord>
  get(ownerId: string, tripId: string): Promise<TripRecord | null>
  update(ownerId: string, tripId: string, patch: TripPatch): Promise<Trip | null>
  /** Null when the trip is not the owner's. */
  saveDocument(
    ownerId: string,
    tripId: string,
    content: unknown,
    expectedVersion: number,
  ): Promise<SaveResult | null>
  addPostcard(ownerId: string, tripId: string, input: NewPostcard): Promise<Postcard | null>
  updatePostcard(
    ownerId: string,
    postcardId: string,
    patch: PostcardPatch,
  ): Promise<Postcard | null>
  deletePostcard(ownerId: string, postcardId: string): Promise<boolean>
}

/** What a trip's document is before anyone has typed into it. */
export const EMPTY_DOCUMENT = { type: "doc", content: [{ type: "paragraph" }] }

/** `postcardIdsIn`, as jsonpath. */
const REFERENCED_PATH = `strict $.** ? (@.type == "${POSTCARD_NODE}").attrs.${POSTCARD_ATTR}`

type TripRow = typeof trips.$inferSelect
type PostcardRow = typeof postcards.$inferSelect

// The three enum columns come back typed `string`: `enums.ts` builds them from the
// Zod enums through a cast, which keeps one list of values and loses the literal
// types on the way. These casts put back what that list already guarantees.
const toTrip = (row: TripRow): Trip => ({
  id: row.id,
  userId: row.userId,
  title: row.title,
  destinationCity: row.destinationCity,
  startDate: row.startDate,
  endDate: row.endDate,
  status: row.status as TripStatus,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const toPostcard = (row: PostcardRow): Postcard => ({
  id: row.id,
  tripId: row.tripId,
  kind: row.kind as PostcardKind,
  placeId: row.placeId,
  payload: row.payload,
  // Null together or set together, which is how `addPostcard` writes them.
  geo: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
  time: row.timeStart ? { start: row.timeStart, end: row.timeEnd } : null,
  sourceRefs: row.sourceRefs,
  state: row.state as PostcardState,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

export class PostgresTripStore implements TripStore {
  constructor(private readonly db: Db) {}

  async hasAccount(ownerId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, ownerId))
    return row !== undefined
  }

  /**
   * The counts are of Postcards the document references, not of rows.
   *
   * A card removed from the text keeps its row so that undo can bring it back
   * (`postcardIdsIn` in `@dt/core` says why), which means a plain `count(*)`
   * would keep counting cards the traveller deleted. The same rule in SQL: a
   * jsonpath over the document's JSON for every `postcard` node's id. `strict`
   * rather than `lax`, because lax `.**` visits each array and its elements both
   * and returns every id twice.
   */
  async list(ownerId: string): Promise<TripSummary[]> {
    const referenced = sql`(select jsonb_array_elements_text(jsonb_path_query_array(${documents.content}, ${REFERENCED_PATH}::jsonpath)))`
    const rows = await this.db
      .select({
        trip: trips,
        postcards: sql<number>`(select count(*)::int from ${postcards} where ${postcards.tripId} = ${trips.id} and ${postcards.id}::text in ${referenced})`,
        withGeo: sql<number>`(select count(*)::int from ${postcards} where ${postcards.tripId} = ${trips.id} and ${postcards.lat} is not null and ${postcards.id}::text in ${referenced})`,
      })
      .from(trips)
      // Left, not inner: a trip written by something other than `create` — the dev
      // seed, a hand INSERT — may have no document yet, and should still be listed.
      .leftJoin(documents, eq(documents.tripId, trips.id))
      .where(eq(trips.userId, ownerId))
      .orderBy(desc(trips.updatedAt), trips.id)
    return rows.map((r) => ({ trip: toTrip(r.trip), postcards: r.postcards, withGeo: r.withGeo }))
  }

  async create(ownerId: string, input: NewTrip): Promise<TripRecord> {
    return await this.db.transaction(async (tx) => {
      const [trip] = await tx
        .insert(trips)
        .values({
          userId: ownerId,
          title: input.title,
          destinationCity: input.destinationCity,
          startDate: input.startDate,
          endDate: input.endDate,
          status: input.status,
        })
        .returning()
      if (!trip) throw new Error("trips insert returned no row")
      const [doc] = await tx
        .insert(documents)
        .values({ tripId: trip.id, content: input.content })
        .returning()
      if (!doc) throw new Error("documents insert returned no row")
      return {
        trip: toTrip(trip),
        document: { content: doc.content, version: doc.version, updatedAt: doc.updatedAt },
        postcards: [],
      }
    })
  }

  async get(ownerId: string, tripId: string): Promise<TripRecord | null> {
    const [row] = await this.db
      .select({ trip: trips, document: documents })
      .from(trips)
      .leftJoin(documents, eq(documents.tripId, trips.id))
      .where(and(eq(trips.id, tripId), eq(trips.userId, ownerId)))
    if (!row) return null
    // A trip with no document gets an empty one the first time it is opened, rather
    // than a 404 for a trip the list just showed. `create` never leaves one without.
    const document =
      row.document ??
      (
        await this.db
          .insert(documents)
          .values({ tripId, content: EMPTY_DOCUMENT })
          .onConflictDoNothing()
          .returning()
      )[0] ??
      (await this.db.select().from(documents).where(eq(documents.tripId, tripId)))[0]
    if (!document) return null
    const cards = await this.db
      .select()
      .from(postcards)
      .where(eq(postcards.tripId, tripId))
      .orderBy(postcards.createdAt, postcards.id)
    return {
      trip: toTrip(row.trip),
      document: {
        content: document.content,
        version: document.version,
        updatedAt: document.updatedAt,
      },
      postcards: cards.map(toPostcard),
    }
  }

  async update(ownerId: string, tripId: string, patch: TripPatch): Promise<Trip | null> {
    const [row] = await this.db
      .update(trips)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(trips.id, tripId), eq(trips.userId, ownerId)))
      .returning()
    return row ? toTrip(row) : null
  }

  async saveDocument(
    ownerId: string,
    tripId: string,
    content: unknown,
    expectedVersion: number,
  ): Promise<SaveResult | null> {
    return await this.db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ id: trips.id })
        .from(trips)
        .where(and(eq(trips.id, tripId), eq(trips.userId, ownerId)))
      if (!owned) return null

      // One statement decides it: the version in the WHERE is the check, so two
      // saves racing from two tabs cannot both land on the same version.
      const [saved] = await tx
        .update(documents)
        .set({ content, version: sql`${documents.version} + 1`, updatedAt: new Date() })
        .where(and(eq(documents.tripId, tripId), eq(documents.version, expectedVersion)))
        .returning({ version: documents.version })
      if (saved) {
        // The trip's own `updated_at` is what the trips list sorts on.
        await tx.update(trips).set({ updatedAt: new Date() }).where(eq(trips.id, tripId))
        return { saved: true, version: saved.version }
      }
      const [current] = await tx
        .select({ version: documents.version })
        .from(documents)
        .where(eq(documents.tripId, tripId))
      return { saved: false, version: current?.version ?? 0 }
    })
  }

  async addPostcard(ownerId: string, tripId: string, input: NewPostcard): Promise<Postcard | null> {
    const [owned] = await this.db
      .select({ id: trips.id })
      .from(trips)
      .where(and(eq(trips.id, tripId), eq(trips.userId, ownerId)))
    if (!owned) return null
    const [row] = await this.db
      .insert(postcards)
      .values({
        tripId,
        kind: input.kind,
        placeId: input.placeId,
        payload: input.payload ?? {},
        lat: input.geo?.lat ?? null,
        lng: input.geo?.lng ?? null,
        timeStart: input.time?.start ?? null,
        timeEnd: input.time?.end ?? null,
        sourceRefs: input.sourceRefs,
        state: input.state ?? "fresh",
      })
      .returning()
    return row ? toPostcard(row) : null
  }

  async updatePostcard(
    ownerId: string,
    postcardId: string,
    patch: PostcardPatch,
  ): Promise<Postcard | null> {
    const set: Partial<typeof postcards.$inferInsert> = { updatedAt: new Date() }
    if (patch.payload !== undefined) set.payload = patch.payload
    if (patch.state !== undefined) set.state = patch.state
    if (patch.geo !== undefined) {
      set.lat = patch.geo?.lat ?? null
      set.lng = patch.geo?.lng ?? null
    }
    if (patch.time !== undefined) {
      set.timeStart = patch.time?.start ?? null
      set.timeEnd = patch.time?.end ?? null
    }
    const [row] = await this.db
      .update(postcards)
      .set(set)
      .where(
        and(
          eq(postcards.id, postcardId),
          sql`${postcards.tripId} in (select ${trips.id} from ${trips} where ${trips.userId} = ${ownerId})`,
        ),
      )
      .returning()
    return row ? toPostcard(row) : null
  }

  async deletePostcard(ownerId: string, postcardId: string): Promise<boolean> {
    const rows = await this.db
      .delete(postcards)
      .where(
        and(
          eq(postcards.id, postcardId),
          sql`${postcards.tripId} in (select ${trips.id} from ${trips} where ${trips.userId} = ${ownerId})`,
        ),
      )
      .returning({ id: postcards.id })
    return rows.length > 0
  }
}

/**
 * The same port in memory, for the API's tests and for nothing else.
 *
 * It keeps the two rules that matter — owner scoping and the version check —
 * because a fake without them would let a route test pass over exactly the
 * behaviour the route exists to enforce.
 */
export class MemoryTripStore implements TripStore {
  readonly accounts = new Set<string>()
  readonly trips = new Map<string, Trip>()
  readonly documents = new Map<string, TripDocumentRecord>()
  readonly postcards = new Map<string, Postcard>()
  private n = 0

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private id(): string {
    this.n++
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`
  }

  private owned(ownerId: string, tripId: string): Trip | null {
    const trip = this.trips.get(tripId)
    return trip && trip.userId === ownerId ? trip : null
  }

  async hasAccount(ownerId: string): Promise<boolean> {
    return this.accounts.has(ownerId)
  }

  async list(ownerId: string): Promise<TripSummary[]> {
    return [...this.trips.values()]
      .filter((t) => t.userId === ownerId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((trip) => {
        const referenced = new Set(postcardIdsIn(this.documents.get(trip.id)?.content))
        const cards = [...this.postcards.values()].filter(
          (p) => p.tripId === trip.id && referenced.has(p.id),
        )
        return { trip, postcards: cards.length, withGeo: cards.filter((p) => p.geo).length }
      })
  }

  async create(ownerId: string, input: NewTrip): Promise<TripRecord> {
    const now = this.clock()
    const { content, ...fields } = input
    const trip: Trip = { id: this.id(), userId: ownerId, ...fields, createdAt: now, updatedAt: now }
    this.trips.set(trip.id, trip)
    const document = { content, version: 1, updatedAt: now }
    this.documents.set(trip.id, document)
    return { trip, document: { ...document }, postcards: [] }
  }

  async get(ownerId: string, tripId: string): Promise<TripRecord | null> {
    const trip = this.owned(ownerId, tripId)
    const document = this.documents.get(tripId)
    if (!trip || !document) return null
    const cards = [...this.postcards.values()].filter((p) => p.tripId === tripId)
    return { trip, document: { ...document }, postcards: cards }
  }

  async update(ownerId: string, tripId: string, patch: TripPatch): Promise<Trip | null> {
    const trip = this.owned(ownerId, tripId)
    if (!trip) return null
    const next = { ...trip, ...patch, updatedAt: this.clock() }
    this.trips.set(tripId, next)
    return next
  }

  async saveDocument(
    ownerId: string,
    tripId: string,
    content: unknown,
    expectedVersion: number,
  ): Promise<SaveResult | null> {
    const trip = this.owned(ownerId, tripId)
    const current = this.documents.get(tripId)
    if (!trip || !current) return null
    if (current.version !== expectedVersion) return { saved: false, version: current.version }
    const version = current.version + 1
    this.documents.set(tripId, { content, version, updatedAt: this.clock() })
    this.trips.set(tripId, { ...trip, updatedAt: this.clock() })
    return { saved: true, version }
  }

  async addPostcard(ownerId: string, tripId: string, input: NewPostcard): Promise<Postcard | null> {
    if (!this.owned(ownerId, tripId)) return null
    const now = this.clock()
    const card: Postcard = {
      id: this.id(),
      tripId,
      kind: input.kind,
      placeId: input.placeId,
      payload: input.payload ?? {},
      geo: input.geo,
      time: input.time,
      sourceRefs: input.sourceRefs,
      state: input.state ?? "fresh",
      createdAt: now,
      updatedAt: now,
    }
    this.postcards.set(card.id, card)
    return card
  }

  async updatePostcard(
    ownerId: string,
    postcardId: string,
    patch: PostcardPatch,
  ): Promise<Postcard | null> {
    const card = this.postcards.get(postcardId)
    if (!card || !this.owned(ownerId, card.tripId)) return null
    const next = { ...card, ...patch, updatedAt: this.clock() }
    this.postcards.set(postcardId, next)
    return next
  }

  async deletePostcard(ownerId: string, postcardId: string): Promise<boolean> {
    const card = this.postcards.get(postcardId)
    if (!card || !this.owned(ownerId, card.tripId)) return false
    return this.postcards.delete(postcardId)
  }
}
