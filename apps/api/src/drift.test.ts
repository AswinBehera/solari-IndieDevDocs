import type { HarvestRunRecord, RawItemRow } from "@samsara/harvest/ports"
import {
  MemoryDriftExperimentStore,
  MemoryHarvestRunStore,
  MemoryRawItemStore,
} from "@samsara/harvest/store"
import type { EnqueueInput } from "@samsara/kernel/jobs"
import { MemoryPersonaStore } from "@samsara/personas/store"
import { MemoryMentionStore } from "@samsara/refine"
import { beforeEach, describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import type { Verifier } from "./auth.js"
import { noopDispatcher } from "./dispatch.js"

/**
 * The drift experiment's routes (P1.8).
 *
 * Two things are being held to account here. The first is that creating an
 * experiment queues the *whole* week in one request — not a first day that
 * schedules a second — because a chain that breaks on Wednesday loses the rest of
 * the week with nothing left in the queue to notice. The second is the series
 * refusing to plot a day it did not measure: `overlapAt` returns 0 for a day
 * nobody ran, and 0 on this chart is the finding the experiment exists to look
 * for.
 */

const OWNER = "owner-1"
const AUTH = { authorization: "Bearer token", "content-type": "application/json" }
const verifier: Verifier = {
  async verify() {
    return OWNER
  },
}

const at = (iso: string) => new Date(iso)
const START = at("2026-09-16T08:00:00.000Z")

let personas: MemoryPersonaStore
let runs: MemoryHarvestRunStore
let items: MemoryRawItemStore
let experiments: MemoryDriftExperimentStore
let mentions: MemoryMentionStore
let enqueued: EnqueueInput[]
let now: Date

const jobs = {
  async enqueue(input: EnqueueInput) {
    enqueued.push(input)
    return { id: `job-${enqueued.length}`, deduped: false }
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

let nextId = 0
const build = () =>
  createApp({
    jobs: () => jobs,
    verifier,
    dispatcher: noopDispatcher,
    lab: {
      stores: () => ({ personas, runs, items, experiments, mentions }),
      newId: () => `exp-${++nextId}`,
      clock: () => now,
    },
  })

const persona = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `persona ${id}`,
  locality: "Ari",
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

const create = (over: Record<string, unknown> = {}) =>
  build().request("/lab/drift", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      sourceId: "fake.search",
      query: "ของกินอร่อย",
      personaAId: "a",
      personaBId: "b",
      days: 7,
      ...over,
    }),
  })

/** Both sides of one day, at the hour the plan asked for, with items. */
const measured = async (experimentId: string, day: number, urls: { a: string[]; b: string[] }) => {
  const startedAt = new Date(START.getTime() + day * 86_400_000)
  for (const [side, personaId] of [
    ["a", "a"],
    ["b", "b"],
  ] as const) {
    const id = `r${day}${side}`
    const list = urls[side]
    runs.runs.set(id, {
      id,
      domainId: "atlas",
      personaId,
      sourceId: "fake.search",
      query: "ของกินอร่อย",
      sessionId: `s${id}`,
      startedAt,
      endedAt: startedAt,
      outcome: "ok",
      itemCount: list.length,
      experiment: { id: experimentId, day },
    } satisfies HarvestRunRecord)
    await items.insertMany(
      list.map(
        (url, rank): RawItemRow => ({
          id: `${id}-${rank}`,
          harvestRunId: id,
          sourceId: "fake.search",
          rank,
          url,
          title: null,
          text: "อร่อย",
          languageGuess: "th",
          mediaRefs: [],
          engagement: null,
          capturedAt: startedAt,
          rawRef: `captures/fake.search/${id}/1.json`,
        }),
      ),
    )
  }
}

beforeEach(async () => {
  personas = new MemoryPersonaStore()
  runs = new MemoryHarvestRunStore()
  items = new MemoryRawItemStore()
  experiments = new MemoryDriftExperimentStore()
  mentions = new MemoryMentionStore()
  enqueued = []
  nextId = 0
  now = START
  await personas.insert(persona("a"))
  await personas.insert(persona("b"))
})

describe("creating an experiment", () => {
  it("queues the whole week up front, both identities, staggered by a day", async () => {
    const res = await create()
    expect(res.status).toBe(201)
    const body = (await res.json()) as { experiment: { id: string }; queued: number }
    expect(body.queued).toBe(14)
    expect(enqueued).toHaveLength(14)

    // Ordinary `harvest.run` jobs, not a new type. A drift day *is* a harvest —
    // it opens the same browser and costs the same money — and giving it its own
    // job type would be a second path through the queue's idempotency and
    // dispatch rules.
    expect(new Set(enqueued.map((j) => j.type))).toEqual(new Set(["harvest.run"]))

    const days = enqueued.map((j) => (j.payload as { experimentDay: number }).experimentDay)
    expect(days).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6])
    expect(enqueued[0]?.runAfter).toEqual(START)
    expect(enqueued[12]?.runAfter).toEqual(at("2026-09-22T08:00:00.000Z"))
  })

  it("keys every day so that creating the same week twice costs nothing", async () => {
    await create()
    const keys = enqueued.map((j) => j.idempotencyKey)
    expect(new Set(keys).size).toBe(14)
    expect(keys[0]).toBe("drift:exp-1:0:a")
  })

  it("leaves recording off unless asked, and puts it in every payload when asked", async () => {
    await create()
    // Absent, not `false`: the handler's parser distinguishes the two, and a week
    // that did not ask for recordings should not mention them.
    expect(
      enqueued.every((j) => (j.payload as { recording?: boolean }).recording === undefined),
    ).toBe(true)

    enqueued = []
    await create({ recording: true })
    // All fourteen, because the evidence for "no captcha loops" is the set of
    // sessions, and a recorded half-week answers a different question than the
    // acceptance criterion asks.
    expect(enqueued).toHaveLength(14)
    expect(enqueued.every((j) => (j.payload as { recording?: boolean }).recording === true)).toBe(
      true,
    )
  })

  it("bills the verified owner, never a name from the body", async () => {
    await create({ ownerId: "somebody-else" })
    expect(enqueued[0]?.ownerId).toBe(OWNER)
  })

  it("refuses one identity compared with itself", async () => {
    const res = await create({ personaBId: "a" })
    expect(res.status).toBe(400)
    // A week of `overlapAt(x, x, k)` is a flat line at 1.0 that costs fourteen
    // browser sessions to draw.
    expect(((await res.json()) as { error: string }).error).toContain("different")
    expect(enqueued).toHaveLength(0)
  })

  it("refuses a banned identity before it queues anything", async () => {
    await personas.setHealth("b", "banned")
    const res = await create()
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain("banned")
    // The runner checks too. This is the earlier of the two refusals, and it is
    // the one that keeps a week of certain failures out of the queue entirely.
    expect(enqueued).toHaveLength(0)
    expect(await experiments.list()).toHaveLength(0)
  })

  it("refuses a persona that does not exist", async () => {
    const res = await create({ personaAId: "nobody" })
    expect(res.status).toBe(400)
    expect(enqueued).toHaveLength(0)
  })

  it("will not accept a month, because the write would not fit in one invocation", async () => {
    // 3 + 2d subrequests against a ceiling of 50 (ADR-0014). Thirty days would be
    // refused halfway through queueing, leaving an experiment whose second half
    // does not exist.
    const res = await create({ days: 30 })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain("days")
  })

  it("takes an interval short enough to demonstrate without waiting a week", async () => {
    await create({ days: 2, intervalMinutes: 5 })
    expect(enqueued[2]?.runAfter).toEqual(at("2026-09-16T08:05:00.000Z"))
  })
})

describe("reading one back", () => {
  it("404s for an experiment that does not exist", async () => {
    const res = await build().request("/lab/drift/nope", { headers: AUTH })
    expect(res.status).toBe(404)
  })

  it("draws a point only for a day it actually compared", async () => {
    await create()
    await measured("exp-1", 0, { a: ["u1", "u2"], b: ["u1", "u9"] })
    await measured("exp-1", 2, { a: ["u1", "u2"], b: ["u3", "u4"] })
    now = at("2026-09-20T08:00:00.000Z") // day 4 is due

    const res = await build().request("/lab/drift/exp-1", { headers: AUTH })
    const body = (await res.json()) as {
      summary: { comparedDays: number; missingDays: number; meanOverlap: number }
      points: { day: number; state: string; overlap: unknown; measuredAt: string | null }[]
    }
    expect(body.points.map((p) => p.state)).toEqual([
      "compared",
      "missing",
      "compared",
      "missing",
      "missing",
      "pending",
      "pending",
    ])
    // Null, not zero. Day 1 never ran, and "these two were shown nothing in
    // common" is the single most interesting reading this chart can produce — a
    // scheduler that slept must not be able to manufacture it.
    expect(body.points[1]?.overlap).toBeNull()
    expect(body.points[1]?.measuredAt).toBeNull()
    expect(body.summary.comparedDays).toBe(2)
    expect(body.summary.missingDays).toBe(3)
    expect(body.summary.meanOverlap).toBe(0.25)
  })

  it("reports the figure the engine's own primitive does", async () => {
    await create({ days: 1 })
    await measured("exp-1", 0, { a: ["u1", "u2", "u3"], b: ["u3", "u2", "u9"] })
    now = at("2026-09-16T09:00:00.000Z")
    const res = await build().request("/lab/drift/exp-1", { headers: AUTH })
    const body = (await res.json()) as {
      points: { overlap: { shared: number; comparable: number }; meanRankShift: number }[]
    }
    expect(body.points[0]?.overlap).toEqual({ k: 20, shared: 2, comparable: 3, overlap: 2 / 3 })
    // Carried beside the overlap because they answer different questions: two
    // thirds shared tells you nothing about whether the shared ones moved.
    expect(body.points[0]?.meanRankShift).toBe(1)
  })

  it("clamps k rather than trusting the query string", async () => {
    await create({ days: 1 })
    const res = await build().request("/lab/drift/exp-1?k=1000000", { headers: AUTH })
    expect(((await res.json()) as { k: number }).k).toBe(100)
  })
})

describe("stopping", () => {
  it("stops the experiment without deleting what it measured", async () => {
    await create()
    await measured("exp-1", 0, { a: ["u1"], b: ["u1"] })
    const res = await build().request("/lab/drift/exp-1/stop", { method: "POST", headers: AUTH })
    expect(res.status).toBe(200)
    expect((await experiments.byId("exp-1"))?.state).toBe("stopped")

    // The remaining days are still queued rows — nothing here cancels them, and
    // the point of the state is that the runner reads it before opening a browser.
    // Deleting the row instead would leave those jobs spending against nothing.
    const series = (await (
      await build().request("/lab/drift/exp-1", { headers: AUTH })
    ).json()) as { points: { state: string }[] }
    expect(series.points[0]?.state).toBe("compared")
  })

  it("is idempotent, because a second click is the same intention", async () => {
    await create()
    await build().request("/lab/drift/exp-1/stop", { method: "POST", headers: AUTH })
    const res = await build().request("/lab/drift/exp-1/stop", { method: "POST", headers: AUTH })
    expect(res.status).toBe(200)
  })

  it("refuses an unauthenticated stop", async () => {
    await create()
    const res = await build().request("/lab/drift/exp-1/stop", { method: "POST" })
    expect(res.status).toBe(401)
    expect((await experiments.byId("exp-1"))?.state).toBe("running")
  })
})
