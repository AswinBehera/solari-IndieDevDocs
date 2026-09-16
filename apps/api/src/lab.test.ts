import { overlapAt } from "@samsara/harvest/overlap"
import type { HarvestRunRecord, RawItemRow } from "@samsara/harvest/ports"
import { MemoryHarvestRunStore, MemoryRawItemStore } from "@samsara/harvest/store"
import { MemoryPersonaStore } from "@samsara/personas/store"
import { beforeEach, describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import type { Verifier } from "./auth.js"
import { noopDispatcher } from "./dispatch.js"

/**
 * The Persona Lab's read surface (P1.7).
 *
 * What these tests are actually about is the sentence in the plan: "rough UI is
 * fine; correctness of the comparison is not". So most of what follows is about
 * `/lab/compare` refusing to produce a number that reads as a measurement when it
 * is not one — the same identity on both sides, a run that came back blocked, a
 * side with no run at all.
 */

const OWNER = "owner-1"
const AUTH = { authorization: "Bearer token", "content-type": "application/json" }

const verifier: Verifier = {
  async verify() {
    return OWNER
  },
}

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

const at = (iso: string) => new Date(iso)

let personas: MemoryPersonaStore
let runs: MemoryHarvestRunStore
let items: MemoryRawItemStore

const build = (withLab = true) =>
  createApp({
    jobs: () => jobs,
    verifier,
    dispatcher: noopDispatcher,
    ...(withLab ? { lab: { stores: () => ({ personas, runs, items }) } } : {}),
  })

const persona = (id: string, over: Partial<Parameters<MemoryPersonaStore["insert"]>[0]> = {}) => ({
  id,
  name: `persona ${id}`,
  locality: "Bangkok",
  country: "th",
  locale: "th-TH",
  timezoneId: "Asia/Bangkok",
  tier: "anon" as const,
  solariProfileId: null,
  proxySession: null,
  health: "healthy" as const,
  seedPlanId: null,
  lastAliveAt: null,
  stats: { sessions: 0, minutes: 0, blocks: 0 },
  ...over,
})

const run = (
  over: Partial<HarvestRunRecord> & { id: string; personaId: string },
): HarvestRunRecord => ({
  domainId: "atlas",
  sourceId: "fake.search",
  query: "ของกินอร่อย",
  sessionId: "session-1",
  startedAt: at("2026-09-16T10:00:00.000Z"),
  endedAt: at("2026-09-16T10:01:00.000Z"),
  outcome: "ok",
  itemCount: 0,
  ...over,
})

const item = (
  runId: string,
  rank: number,
  url: string,
  over: Partial<RawItemRow> = {},
): RawItemRow => ({
  id: `${runId}-${rank}`,
  harvestRunId: runId,
  sourceId: "fake.search",
  rank,
  url,
  title: null,
  text: "อร่อย",
  languageGuess: "th",
  mediaRefs: [],
  engagement: null,
  capturedAt: at("2026-09-16T10:00:30.000Z"),
  rawRef: `captures/fake.search/${runId}/1.json`,
  ...over,
})

beforeEach(() => {
  personas = new MemoryPersonaStore()
  runs = new MemoryHarvestRunStore()
  items = new MemoryRawItemStore()
})

describe("the Lab's surface exists only where it is configured", () => {
  it("answers 404 when the app was built without lab stores", async () => {
    // Not 500 on the first read, and not an unauthenticated 200 either. A
    // deployment that was never given these stores does not have these routes.
    const res = await build(false).request("/lab/personas", { headers: AUTH })
    expect(res.status).toBe(404)
  })

  it("refuses an unauthenticated read", async () => {
    const res = await build().request("/lab/personas")
    expect(res.status).toBe(401)
  })
})

describe("personas", () => {
  it("creates one from the five things a caller may say", async () => {
    const res = await build().request("/lab/personas", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "Ari local",
        locality: "Ari, Bangkok",
        country: "th",
        locale: "th-TH",
        timezoneId: "Asia/Bangkok",
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { persona: { id: string; tier: string; health: string } }
    expect(body.persona.tier).toBe("anon")
    expect(body.persona.health).toBe("healthy")

    const stored = await personas.byId(body.persona.id)
    // The counters a health assessment reads as evidence are ours, not the body's.
    expect(stored?.stats).toEqual({ sessions: 0, minutes: 0, blocks: 0 })
    expect(stored?.lastAliveAt).toBeNull()
    expect(stored?.solariProfileId).toBeNull()
  })

  it("will not take a country in the wrong form", async () => {
    const res = await build().request("/lab/personas", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "x",
        locality: "x",
        country: "TH",
        locale: "th-TH",
        timezoneId: "Asia/Bangkok",
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("country")
    // The message names the field and the rule, and does not echo the value back.
    expect(body.error).not.toContain("TH")
  })

  it("ignores stats a client tries to invent", async () => {
    const res = await build().request("/lab/personas", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "x",
        locality: "x",
        country: "th",
        locale: "th-TH",
        timezoneId: "Asia/Bangkok",
        stats: { sessions: 40, minutes: 900, blocks: 0 },
        health: "banned",
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { persona: { id: string; health: string } }
    expect(body.persona.health).toBe("healthy")
    expect((await personas.byId(body.persona.id))?.stats.sessions).toBe(0)
  })

  it("lists banned identities too", async () => {
    await personas.insert(persona("a"))
    await personas.insert(persona("b", { health: "banned" }))
    const res = await build().request("/lab/personas", { headers: AUTH })
    const body = (await res.json()) as { personas: { id: string }[] }
    // The Lab exists to make the outcome visible. Hiding the banned one would hide
    // the single most informative row on the page.
    expect(body.personas.map((p) => p.id).sort()).toEqual(["a", "b"])
  })
})

describe("one run's items", () => {
  it("404s for a run that does not exist", async () => {
    const res = await build().request("/lab/harvests/nope/items", { headers: AUTH })
    expect(res.status).toBe(404)
  })

  it("comes back in the order the source chose, whatever order it was written in", async () => {
    runs.runs.set("r1", run({ id: "r1", personaId: "a", itemCount: 3 }))
    await items.insertMany([
      item("r1", 2, "https://x.test/c"),
      item("r1", 0, "https://x.test/a"),
      item("r1", 1, "https://x.test/b"),
    ])
    const res = await build().request("/lab/harvests/r1/items", { headers: AUTH })
    const body = (await res.json()) as { items: { rank: number; url: string }[] }
    expect(body.items.map((i) => i.url)).toEqual([
      "https://x.test/a",
      "https://x.test/b",
      "https://x.test/c",
    ])
  })

  it("previews the text rather than shipping it, and says so", async () => {
    runs.runs.set("r1", run({ id: "r1", personaId: "a" }))
    await items.insertMany([item("r1", 0, "https://x.test/a", { text: "ก".repeat(1200) })])
    const res = await build().request("/lab/harvests/r1/items", { headers: AUTH })
    const body = (await res.json()) as { items: { text: string; truncated: boolean }[] }
    expect(body.items[0]?.truncated).toBe(true)
    expect(body.items[0]?.text.length).toBeLessThan(1200)
  })
})

describe("the split screen", () => {
  const seed = () => {
    runs.runs.set("ra", run({ id: "ra", personaId: "a", itemCount: 4 }))
    runs.runs.set("rb", run({ id: "rb", personaId: "b", itemCount: 4 }))
    return items.insertMany([
      item("ra", 0, "https://x.test/1"),
      item("ra", 1, "https://x.test/2"),
      item("ra", 2, "https://x.test/3"),
      item("ra", 3, "https://x.test/4"),
      item("rb", 0, "https://x.test/3"),
      item("rb", 1, "https://x.test/9"),
      item("rb", 2, "https://x.test/8"),
      item("rb", 3, "https://x.test/7"),
    ])
  }

  const compare = (qs: string) => build().request(`/lab/compare?${qs}`, { headers: AUTH })

  it("refuses the same persona on both sides", async () => {
    const res = await compare("a=a&b=a&query=x")
    expect(res.status).toBe(400)
    // `overlapAt(x, x, k)` is a perfectly good 1.0, which is exactly the problem:
    // a screen showing complete agreement because both columns are one identity is
    // the most convincing wrong answer this tool could produce.
    expect(((await res.json()) as { error: string }).error).toContain("different")
  })

  it("reports the same figure the engine's own primitive does", async () => {
    await seed()
    const res = await compare("a=a&b=b&query=" + encodeURIComponent("ของกินอร่อย"))
    const body = (await res.json()) as {
      overlap: { k: number; shared: number; comparable: number; overlap: number }
      a: { items: { url: string }[] }
      b: { items: { url: string }[] }
    }
    const expected = overlapAt(
      body.a.items.map((i) => i.url),
      body.b.items.map((i) => i.url),
      20,
    )
    // Not a recomputation of the arithmetic — a check that the route did not grow
    // one of its own. There is meant to be exactly one implementation.
    expect(body.overlap).toEqual(expected)
    expect(body.overlap.shared).toBe(1)
    expect(body.overlap.comparable).toBe(4)
  })

  it("compares only within one question", async () => {
    await seed()
    const res = await compare("a=a&b=b&query=something+else")
    const body = (await res.json()) as {
      a: { harvest: unknown }
      b: { harvest: unknown }
      overlap: { comparable: number }
    }
    expect(body.a.harvest).toBeNull()
    expect(body.b.harvest).toBeNull()
    // Nothing to compare, and the result says which — `comparable: 0` is the field
    // that separates "they agreed on nothing" from "there was nothing to agree on".
    expect(body.overlap.comparable).toBe(0)
  })

  it("shows the newest run even when it was blocked, rather than an older good one", async () => {
    await seed()
    runs.runs.set(
      "ra2",
      run({
        id: "ra2",
        personaId: "a",
        outcome: "blocked",
        itemCount: 0,
        startedAt: at("2026-09-16T12:00:00.000Z"),
      }),
    )
    const res = await compare("a=a&b=b&query=" + encodeURIComponent("ของกินอร่อย"))
    const body = (await res.json()) as {
      a: { harvest: { id: string; outcome: string }; items: unknown[] }
      overlap: { comparable: number }
    }
    // Falling back to `ra` would put the two columns on different days, which is a
    // comparison that cannot be wrong because it is not about anything.
    expect(body.a.harvest.id).toBe("ra2")
    expect(body.a.harvest.outcome).toBe("blocked")
    expect(body.a.items).toEqual([])
    expect(body.overlap.comparable).toBe(0)
  })

  it("clamps k rather than trusting the query string", async () => {
    await seed()
    const res = await compare("a=a&b=b&query=" + encodeURIComponent("ของกินอร่อย") + "&k=1000000")
    const body = (await res.json()) as { overlap: { k: number } }
    expect(body.overlap.k).toBe(100)
  })

  it("narrows to one source when asked", async () => {
    await seed()
    runs.runs.set(
      "rc",
      run({
        id: "rc",
        personaId: "a",
        sourceId: "other.search",
        startedAt: at("2026-09-16T13:00:00.000Z"),
      }),
    )
    const q = encodeURIComponent("ของกินอร่อย")
    const wide = (await (await compare(`a=a&b=b&query=${q}`)).json()) as {
      a: { harvest: { id: string } }
    }
    expect(wide.a.harvest.id).toBe("rc")
    const narrow = (await (await compare(`a=a&b=b&query=${q}&sourceId=fake.search`)).json()) as {
      a: { harvest: { id: string } }
    }
    expect(narrow.a.harvest.id).toBe("ra")
  })
})
