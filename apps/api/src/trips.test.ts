import { MemoryTripStore } from "@dt/db/trips"
import type { PlaceCardRow, PlaceReader } from "@dt/travel-pack/read"
import { beforeEach, describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import type { Verifier } from "./auth.js"
import { noopDispatcher } from "./dispatch.js"
import { MAX_DOCUMENT_BYTES, MAX_POSTCARD_BYTES } from "./trips.js"

/**
 * The Trip Document's routes. What they own is validation, the status codes, and
 * handing the owner down; owner scoping and the version check are the store's, and
 * are tested against Postgres in `@dt/db` — the memory store keeps both rules so
 * that these tests exercise the routes against the same behaviour.
 */

const ALICE = "00000000-0000-4000-8000-00000000a11c"
const BOB = "00000000-0000-4000-8000-000000000b0b"

const jobs = {
  async enqueue() {
    return { id: "job-1", deduped: false }
  },
  async claim() {
    return { jobs: [], reclaimed: 0 }
  },
  async heartbeat() {},
  async succeed() {},
  async fail() {
    return { willRetry: false }
  },
  async release() {},
  async eventsAfter() {
    return []
  },
}

/** The bearer token *is* the owner here, so one test can speak as two people. */
const verifier: Verifier = {
  async verify(token) {
    return token
  },
}

class FakeReader implements PlaceReader {
  readonly searched: string[] = []
  async top(): Promise<PlaceCardRow[]> {
    return []
  }
  async byId(): Promise<PlaceCardRow | null> {
    return null
  }
  async search(query: string): Promise<PlaceCardRow[]> {
    this.searched.push(query)
    return []
  }
}

let store: MemoryTripStore
let reader: FakeReader

const app = () =>
  createApp({
    jobs: () => jobs,
    verifier,
    dispatcher: noopDispatcher,
    trips: { store: () => store },
    places: { reader: () => reader },
  })

const as = (owner: string, init: RequestInit = {}) => ({
  ...init,
  headers: {
    authorization: `Bearer ${owner}`,
    ...(init.body === undefined ? {} : { "content-type": "application/json" }),
  },
})

const post = (owner: string, body: unknown) =>
  as(owner, { method: "POST", body: JSON.stringify(body) })

const TRIP = {
  title: "Four days in Bangkok, mostly eating.",
  destinationCity: "Bangkok",
  startDate: "2026-11-14T00:00:00.000Z",
  endDate: "2026-11-17T00:00:00.000Z",
  status: "planning",
}

async function created(owner = ALICE) {
  const res = await app().request("/trips", post(owner, TRIP))
  return ((await res.json()) as { trip: { id: string } }).trip.id
}

beforeEach(() => {
  store = new MemoryTripStore()
  store.accounts.add(ALICE)
  store.accounts.add(BOB)
  reader = new FakeReader()
})

describe("trips", () => {
  it("refuses a request with no token", async () => {
    expect((await app().request("/trips")).status).toBe(401)
  })

  it("leaves /health unauthenticated beside routes mounted at the root", async () => {
    expect((await app().request("/health")).status).toBe(200)
  })

  it("creates a trip with an empty document at version one", async () => {
    const res = await app().request("/trips", post(ALICE, TRIP))
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      trip: { startDate: string }
      document: { version: number }
    }
    expect(body.document.version).toBe(1)
    expect(body.trip.startDate).toBe("2026-11-14T00:00:00.000Z")
  })

  it("says why when the sign-in has no account yet", async () => {
    const res = await app().request("/trips", post("00000000-0000-4000-8000-00000000fe11", TRIP))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "no account for this sign-in yet" })
  })

  it.each([
    ["no destination", { title: "x" }, "destinationCity"],
    ["a blank title", { ...TRIP, title: "  " }, "title"],
    ["a date that is not a date", { ...TRIP, startDate: "next tuesday" }, "startDate"],
    ["a status that does not exist", { ...TRIP, status: "abandoned" }, "status"],
  ])("refuses %s, naming the field", async (_label, body, field) => {
    const res = await app().request("/trips", post(ALICE, body))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(field)
  })

  it("lists only the caller's trips", async () => {
    await created(ALICE)
    await created(BOB)
    const res = await app().request("/trips", as(ALICE))
    const body = (await res.json()) as { trips: { trip: { userId: string } }[] }
    expect(body.trips.map((t) => t.trip.userId)).toEqual([ALICE])
  })

  it("answers someone else's trip with a 404, not a 403", async () => {
    const id = await created(ALICE)
    expect((await app().request(`/trips/${id}`, as(BOB))).status).toBe(404)
    expect((await app().request(`/trips/${id}`, as(ALICE))).status).toBe(200)
  })

  it("renames a trip and sets its dates", async () => {
    const id = await created()
    const res = await app().request(
      `/trips/${id}`,
      as(ALICE, {
        method: "PATCH",
        body: JSON.stringify({ title: "Tokyo, undated.", startDate: null }),
      }),
    )
    const body = (await res.json()) as {
      trip: { title: string; startDate: string | null; endDate: string }
    }
    expect(body.trip.title).toBe("Tokyo, undated.")
    expect(body.trip.startDate).toBeNull()
    // Untouched fields stay: an absent key means "leave it", not "clear it".
    expect(body.trip.endDate).toBe("2026-11-17T00:00:00.000Z")
  })
})

describe("the document", () => {
  const save = (id: string, version: number, content: unknown = { type: "doc", content: [] }) =>
    app().request(
      `/trips/${id}/document`,
      as(ALICE, { method: "PUT", body: JSON.stringify({ content, version }) }),
    )

  it("saves at the loaded version and hands back the next one", async () => {
    const id = await created()
    const res = await save(id, 1)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 2 })
  })

  it("refuses a stale version with a 409 carrying the current one", async () => {
    const id = await created()
    await save(id, 1)
    const res = await save(id, 1)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { version: number }).version).toBe(2)
  })

  it("refuses a body too large to be a document before parsing it", async () => {
    const id = await created()
    const huge = "x".repeat(MAX_DOCUMENT_BYTES + 1)
    const res = await save(id, 1, { type: "doc", text: huge })
    expect(res.status).toBe(413)
  })

  it("refuses a save with no version", async () => {
    const id = await created()
    const res = await app().request(
      `/trips/${id}/document`,
      as(ALICE, { method: "PUT", body: JSON.stringify({ content: {} }) }),
    )
    expect(res.status).toBe(400)
  })
})

describe("postcards", () => {
  const card = {
    kind: "place",
    payload: { name: "Jok Prince" },
    geo: { lat: 13.7318, lng: 100.5136 },
  }

  it("adds a postcard to a trip, defaulting what it was not told", async () => {
    const id = await created()
    const res = await app().request(`/trips/${id}/postcards`, post(ALICE, card))
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      postcard: { state: string; sourceRefs: string[]; time: null }
    }
    expect(body.postcard).toMatchObject({ state: "fresh", sourceRefs: [], time: null })
  })

  it("will not add a postcard to someone else's trip", async () => {
    const id = await created(ALICE)
    expect((await app().request(`/trips/${id}/postcards`, post(BOB, card))).status).toBe(404)
  })

  it("refuses a postcard body too large to be one", async () => {
    const id = await created()
    const res = await app().request(
      `/trips/${id}/postcards`,
      post(ALICE, { ...card, payload: { image: "x".repeat(MAX_POSTCARD_BYTES) } }),
    )
    expect(res.status).toBe(413)
  })

  it("refuses a coordinate off the planet", async () => {
    const id = await created()
    const res = await app().request(
      `/trips/${id}/postcards`,
      post(ALICE, { ...card, geo: { lat: 113, lng: 0 } }),
    )
    expect(res.status).toBe(400)
  })

  it("moves a postcard to a day, then deletes it", async () => {
    const id = await created()
    const added = (await (
      await app().request(`/trips/${id}/postcards`, post(ALICE, card))
    ).json()) as {
      postcard: { id: string }
    }
    const pid = added.postcard.id
    const day = { start: "2026-11-15T00:00:00.000Z", end: null }
    const moved = await app().request(
      `/postcards/${pid}`,
      as(ALICE, { method: "PATCH", body: JSON.stringify({ time: day }) }),
    )
    expect(((await moved.json()) as { postcard: { time: unknown } }).postcard.time).toEqual(day)

    expect((await app().request(`/postcards/${pid}`, as(BOB, { method: "DELETE" }))).status).toBe(
      404,
    )
    expect((await app().request(`/postcards/${pid}`, as(ALICE, { method: "DELETE" }))).status).toBe(
      204,
    )
    expect((await app().request(`/postcards/${pid}`, as(ALICE, { method: "DELETE" }))).status).toBe(
      404,
    )
  })
})

describe("the read-only link", () => {
  it("is minted by the owner, read by anyone, and stops when unshared", async () => {
    const id = await created()
    expect((await app().request(`/trips/${id}/share`, post(BOB, {}))).status).toBe(404)
    const res = await app().request(`/trips/${id}/share`, post(ALICE, {}))
    const { token } = (await res.json()) as { token: string }

    // No authorization header at all.
    const shared = await app().request(`/share/${token}`)
    expect(shared.status).toBe(200)
    const body = (await shared.json()) as { trip: Record<string, unknown> }
    expect(body.trip.title).toBe(TRIP.title)
    expect(body.trip).not.toHaveProperty("userId")

    expect((await app().request(`/trips/${id}`, as(ALICE))).status).toBe(200)
    expect(
      ((await (await app().request(`/trips/${id}`, as(ALICE))).json()) as { shareToken: string })
        .shareToken,
    ).toBe(token)

    const off = await app().request(`/trips/${id}/share`, as(ALICE, { method: "DELETE" }))
    expect(off.status).toBe(204)
    expect((await app().request(`/share/${token}`)).status).toBe(404)
  })

  it("refuses a malformed token before looking it up", async () => {
    expect((await app().request("/share/x")).status).toBe(404)
    expect((await app().request(`/share/${"a".repeat(23)}`)).status).toBe(404)
  })
})

describe("GET /places, what /place searches", () => {
  it("passes the query to the reader, trimmed", async () => {
    const res = await app().request("/places?q=%20rung%20", as(ALICE))
    expect(res.status).toBe(200)
    expect(reader.searched).toEqual(["rung"])
  })

  it.each(["", "%20%20", "x".repeat(81)])("refuses q=%s before reading", async (q) => {
    const res = await app().request(`/places?q=${q}`, as(ALICE))
    expect(res.status).toBe(400)
    expect(reader.searched).toEqual([])
  })
})
