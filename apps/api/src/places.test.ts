import type { OsmMatch, OsmPlaceIndex, PlaceCardRow, PlaceReader } from "@dt/travel-pack/read"
import {
  MemoryDriftExperimentStore,
  MemoryHarvestRunStore,
  MemoryRawItemStore,
} from "@samsara/harvest/store"
import { MemoryPersonaStore } from "@samsara/personas/store"
import { MemoryMentionStore } from "@samsara/refine"
import { describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import type { Verifier } from "./auth.js"
import { noopDispatcher } from "./dispatch.js"
import { DEFAULT_LIMIT, MAX_LIMIT, SEARCH_LIMIT } from "./places.js"

/**
 * `/lab/places`: what the route owns is the limit, the auth, and the mount order.
 * Which places come first and which quote is shown are the reader's, and are
 * tested against Postgres in `@dt/travel-pack`.
 */

const AUTH = { authorization: "Bearer token" }

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

class FakeReader implements PlaceReader {
  readonly asked: number[] = []
  constructor(private readonly rows: PlaceCardRow[] = []) {}
  readonly categories: (string | undefined)[] = []
  async top(limit: number, category?: string) {
    this.asked.push(limit)
    this.categories.push(category)
    return this.rows.slice(0, limit)
  }
  readonly searched: string[] = []
  async byId(): Promise<PlaceCardRow | null> {
    return null
  }
  async summary() {
    return { total: 0, withGeo: 0, strong: 0 }
  }
  async search(query: string, limit: number) {
    this.searched.push(query)
    return this.rows.slice(0, limit)
  }
}

const at = new Date("2026-09-20T00:00:00Z")

const row: PlaceCardRow = {
  place: {
    id: "00000000-0000-4000-8000-000000000040",
    canonicalName: "Rung Rueang Pork Noodle",
    localName: "ก๋วยเตี๋ยวหมูรุ่งเรือง",
    city: "Bangkok",
    geo: { lat: 13.7304, lng: 100.5707 },
    externalRef: { source: "osm", id: "node/1" },
    resolvedTier: 1,
    category: "food",
    tags: [],
    scores: {},
    firstSeenAt: at,
    lastSeenAt: at,
    evidenceCount: 1,
    createdAt: at,
    updatedAt: at,
  },
  quote: {
    quote: "อร่อยมาก",
    sourceId: "pantip.forum",
    sourceUrl: "https://pantip.com/topic/1",
    language: "th",
  },
}

function build(opts: { reader?: FakeReader; withLab?: boolean; withPlaces?: boolean } = {}) {
  const reader = opts.reader ?? new FakeReader([row])
  let verified = 0
  const verifier: Verifier = {
    async verify() {
      verified++
      return "owner-1"
    },
  }
  const app = createApp({
    jobs: () => jobs,
    verifier,
    dispatcher: noopDispatcher,
    ...(opts.withPlaces === false ? {} : { places: { reader: () => reader } }),
    ...(opts.withLab
      ? {
          lab: {
            stores: () => ({
              personas: new MemoryPersonaStore(),
              runs: new MemoryHarvestRunStore(),
              items: new MemoryRawItemStore(),
              experiments: new MemoryDriftExperimentStore(),
              mentions: new MemoryMentionStore(),
            }),
          },
        }
      : {}),
  })
  return { app, reader, verified: () => verified }
}

describe("GET /lab/places", () => {
  it("refuses a request with no token", async () => {
    const { app, reader } = build()
    const res = await app.request("/lab/places")
    expect(res.status).toBe(401)
    expect(reader.asked).toHaveLength(0)
  })

  it("hands back each place with its quote, under the card's name for it", async () => {
    const { app } = build()
    const res = await app.request("/lab/places", { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { places: { place: { id: string }; evidence: unknown }[] }
    expect(body.places).toHaveLength(1)
    expect(body.places[0]?.place.id).toBe(row.place.id)
    expect(body.places[0]?.evidence).toEqual(row.quote)
  })

  it("asks for the default page when no limit is given", async () => {
    const { app, reader } = build()
    await app.request("/lab/places", { headers: AUTH })
    expect(reader.asked).toEqual([DEFAULT_LIMIT])
  })

  it("clamps a large limit rather than serialising whatever was asked for", async () => {
    const { app, reader } = build()
    await app.request("/lab/places?limit=100000", { headers: AUTH })
    expect(reader.asked).toEqual([MAX_LIMIT])
  })

  it.each(["0", "-3", "2.5", "many"])("refuses limit=%s before reading", async (limit) => {
    const { app, reader } = build()
    const res = await app.request(`/lab/places?limit=${limit}`, { headers: AUTH })
    expect(res.status).toBe(400)
    expect(reader.asked).toHaveLength(0)
  })

  it("passes a category through, and refuses one that does not exist", async () => {
    const { app, reader } = build()
    expect((await app.request("/lab/places?category=temple", { headers: AUTH })).status).toBe(200)
    expect(reader.categories).toEqual(["temple"])
    const res = await app.request("/lab/places?category=casino", { headers: AUTH })
    expect(res.status).toBe(400)
  })

  it("carries the acceptance numbers beside the page", async () => {
    const { app } = build()
    const res = await app.request("/lab/places", { headers: AUTH })
    expect(((await res.json()) as { summary: unknown }).summary).toEqual({
      total: 0,
      withGeo: 0,
      strong: 0,
    })
  })

  it("verifies the token once, even with the Lab mounted over the same prefix", async () => {
    const { app, verified } = build({ withLab: true })
    const res = await app.request("/lab/places", { headers: AUTH })
    expect(res.status).toBe(200)
    expect(verified()).toBe(1)
  })

  it("leaves the Lab's own routes working beside it", async () => {
    const { app } = build({ withLab: true })
    const res = await app.request("/lab/personas", { headers: AUTH })
    expect(res.status).toBe(200)
  })

  it("does not exist on a deployment that was not given a reader", async () => {
    const { app } = build({ withPlaces: false })
    const res = await app.request("/lab/places", { headers: AUTH })
    expect(res.status).toBe(404)
  })
})

const watPho: OsmMatch = {
  osmId: "way/376312450",
  name: "Wat Pho",
  localName: "วัดโพธิ์",
  formalName: null,
  category: "temple",
  geo: { lat: 13.7465, lng: 100.4927 },
}

class FakeOsm implements OsmPlaceIndex {
  readonly searched: { query: string; limit: number }[] = []
  readonly promoted: string[] = []
  async search(query: string, limit: number) {
    this.searched.push({ query, limit })
    return [watPho].slice(0, limit)
  }
  async promote(osmId: string) {
    this.promoted.push(osmId)
    return osmId === watPho.osmId ? row : null
  }
}

describe("/places, falling back to OpenStreetMap", () => {
  const verifier: Verifier = {
    async verify() {
      return "owner-1"
    },
  }
  const withOsm = (reader: FakeReader, osm?: FakeOsm) =>
    createApp({
      jobs: () => jobs,
      verifier,
      dispatcher: noopDispatcher,
      places: { reader: () => reader, ...(osm ? { osm: () => osm } : {}) },
    })

  it("fills what the scored table leaves of the menu from the extract", async () => {
    const osm = new FakeOsm()
    const res = await withOsm(new FakeReader([row]), osm).request("/places?q=wat", {
      headers: AUTH,
    })
    const body = (await res.json()) as { places: unknown[]; osm: OsmMatch[] }
    expect(body.places).toHaveLength(1)
    expect(body.osm).toEqual([watPho])
    expect(osm.searched).toEqual([{ query: "wat", limit: SEARCH_LIMIT - 1 }])
  })

  it("does not ask the extract when the scored table fills the menu", async () => {
    const osm = new FakeOsm()
    const full = Array.from({ length: SEARCH_LIMIT }, () => row)
    const res = await withOsm(new FakeReader(full), osm).request("/places?q=rung", {
      headers: AUTH,
    })
    expect(((await res.json()) as { osm: unknown[] }).osm).toEqual([])
    expect(osm.searched).toEqual([])
  })

  it("still leaves room for three extract rows under a nearly full scored list", async () => {
    const osm = new FakeOsm()
    const most = Array.from({ length: SEARCH_LIMIT - 1 }, () => row)
    await withOsm(new FakeReader(most), osm).request("/places?q=rung", { headers: AUTH })
    expect(osm.searched[0]?.limit).toBe(3)
  })

  it("answers an empty fallback where no extract is wired", async () => {
    const res = await withOsm(new FakeReader([])).request("/places?q=wat", { headers: AUTH })
    expect(((await res.json()) as { osm: unknown[] }).osm).toEqual([])
  })

  it("promotes a picked row and hands it back as a card", async () => {
    const osm = new FakeOsm()
    const res = await withOsm(new FakeReader(), osm).request("/places/osm", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ osmId: watPho.osmId }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { place: { id: string } }).place.id).toBe(row.place.id)
    expect(osm.promoted).toEqual([watPho.osmId])
  })

  it.each([{}, { osmId: 5 }, { osmId: "node/" }, { osmId: "../etc" }, { osmId: "node/1; drop" }])(
    "refuses %j before promoting anything",
    async (body) => {
      const osm = new FakeOsm()
      const res = await withOsm(new FakeReader(), osm).request("/places/osm", {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
      expect(osm.promoted).toEqual([])
    },
  )

  it("answers 404 for an id the extract does not hold", async () => {
    const res = await withOsm(new FakeReader(), new FakeOsm()).request("/places/osm", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ osmId: "node/404" }),
    })
    expect(res.status).toBe(404)
  })

  it("refuses a promotion with no token", async () => {
    const osm = new FakeOsm()
    const res = await withOsm(new FakeReader(), osm).request("/places/osm", {
      method: "POST",
      body: JSON.stringify({ osmId: watPho.osmId }),
    })
    expect(res.status).toBe(401)
    expect(osm.promoted).toEqual([])
  })
})
