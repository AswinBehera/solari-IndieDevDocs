import type { PlaceCardRow } from "@dt/travel-pack/read"
import type { HarvestRunRecord, RawItemRow } from "@samsara/harvest/ports"
import {
  MemoryDriftExperimentStore,
  MemoryHarvestRunStore,
  MemoryRawItemStore,
} from "@samsara/harvest/store"
import type { EnqueueInput, EnqueueResult, JobStore, StoredJobEvent } from "@samsara/kernel/jobs"
import { MemoryPersonaStore } from "@samsara/personas/store"
import { MemoryMentionStore } from "@samsara/refine"
import { describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import type { Verifier } from "./auth.js"
import { noopDispatcher } from "./dispatch.js"
import { MAX_LIMIT } from "./places.js"

/**
 * P0.5's first acceptance criterion: **CPU per request against the free plan's
 * 10 ms ceiling** (ADR-0014).
 *
 * Three things about this measurement, stated plainly because a number without
 * them is worse than no number:
 *
 * 1. **Workers meters CPU, not wall clock.** A handler may wait on Hyperdrive for
 *    a second and still fit inside 10 ms. So the thing to measure is
 *    `process.cpuUsage()`, not elapsed time — measuring the wrong one would make a
 *    slow-but-idle handler look like a failure and a tight compute loop look fine.
 * 2. **This runs in Node, and is therefore a proxy.** Workers deliberately freezes
 *    `Date.now()` and `performance.now()` between I/O so that timing side channels
 *    do not exist, which means a Worker cannot measure its own CPU from inside. The
 *    authoritative number comes from the Cloudflare dashboard after deploy; this
 *    test's job is to catch a regression in CI long before that.
 * 3. **The I/O is stubbed, and that is the point.** What is being measured is the
 *    part we are billed for: parse, validate, serialise. Time spent waiting on
 *    Postgres is not CPU and does not count against the ceiling.
 *
 * The assertion is set at half the ceiling, not at the ceiling. A handler that
 * measures 9 ms here has already failed — the margin is what absorbs a colder
 * isolate, a bigger payload, and the runtime overhead this proxy cannot see.
 */

const CEILING_MS = 10
const BUDGET_MS = CEILING_MS / 2
const ITERATIONS = 500

const verifier: Verifier = {
  async verify() {
    return "owner-1"
  },
}
const AUTH = { authorization: "Bearer token", "content-type": "application/json" }

const store: JobStore = {
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    return { id: `job-${input.idempotencyKey ?? "1"}`, deduped: false }
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
  async eventsAfter(): Promise<StoredJobEvent[]> {
    return [{ seq: 0, state: "running", note: null, at: new Date(0) }]
  },
}

/**
 * The Lab's stores, filled once with the widest comparison the route allows.
 *
 * `MAX_K` items a side, not a realistic twenty: the number this test has to
 * defend is the worst case a query string can ask for, because that is the one an
 * unfriendly caller will ask for.
 */
const MAX_K = 100
const personas = new MemoryPersonaStore()
const runs = new MemoryHarvestRunStore()
const items = new MemoryRawItemStore()
const experiments = new MemoryDriftExperimentStore()
const mentions = new MemoryMentionStore()

const capturedAt = new Date("2026-09-16T10:00:00.000Z")
const labRun = (
  id: string,
  personaId: string,
  experiment: HarvestRunRecord["experiment"] = null,
): HarvestRunRecord => ({
  id,
  domainId: "atlas",
  personaId,
  sourceId: "fake.search",
  query: "ของกินอร่อย",
  sessionId: "session-1",
  startedAt: capturedAt,
  endedAt: capturedAt,
  outcome: "ok",
  itemCount: MAX_K,
  experiment,
})
runs.runs.set("ra", labRun("ra", "a"))
runs.runs.set("rb", labRun("rb", "b"))

const labItems: RawItemRow[] = []
for (const [runId, offset] of [
  ["ra", 0],
  ["rb", 50],
] as const) {
  for (let rank = 0; rank < MAX_K; rank++) {
    labItems.push({
      id: `${runId}-${rank}`,
      harvestRunId: runId,
      sourceId: "fake.search",
      rank,
      url: `https://x.test/${rank + offset}`,
      title: "ร้านข้าวมันไก่",
      // Longer than the preview cut, so the truncation is measured too.
      text: "อร่อยมาก ".repeat(80),
      languageGuess: "th",
      mediaRefs: [`raw/fake.search/${rank}.jpg`],
      engagement: { views: 1000, likes: 10, comments: null },
      capturedAt,
      rawRef: `captures/fake.search/${runId}/1.json`,
    })
  }
}
await items.insertMany(labItems)

/**
 * The Place grid at its widest page, each place carrying a full explanation.
 *
 * Eight factors a score, two scores, and a 200-character quote — the most the
 * pack writes — so what is measured is the serialisation of the largest page the
 * route will hand back, not of the thirty a gate review reads.
 */
const because = (score: string) =>
  Array.from({ length: 8 }, (_, i) => ({
    factor: `${score} factor ${i}`,
    contribution: 0.05,
    evidenceIds: Array.from(
      { length: 10 },
      (_, j) => `00000000-0000-4000-8000-${String(j).padStart(12, "0")}`,
    ),
  }))
const placeRows: PlaceCardRow[] = Array.from({ length: MAX_LIMIT }, (_, i) => ({
  place: {
    id: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
    canonicalName: "Rung Rueang Pork Noodle",
    localName: "ก๋วยเตี๋ยวหมูรุ่งเรือง",
    city: "Bangkok",
    geo: { lat: 13.7304, lng: 100.5707 },
    externalRef: { source: "osm", id: `node/${i}` },
    resolvedTier: 1,
    category: "food",
    tags: ["noodles"],
    scores: {
      local: { value: 0.8, because: because("local") },
      tourist: { value: 0.2, because: because("tourist") },
    },
    firstSeenAt: capturedAt,
    lastSeenAt: capturedAt,
    evidenceCount: 40,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  },
  quote: {
    quote: "อร่อยมาก ".repeat(22).slice(0, 200),
    sourceId: "pantip.forum",
    sourceUrl: "https://pantip.com/topic/42000000",
    language: "th",
  },
}))

const app = createApp({
  jobs: () => store,
  verifier,
  dispatcher: noopDispatcher,
  lab: { stores: () => ({ personas, runs, items, experiments, mentions }) },
  places: {
    reader: () => ({
      top: async (limit) => placeRows.slice(0, limit),
      search: async (_q, limit) => placeRows.slice(0, limit),
    }),
  },
})

/**
 * A full fortnight of measured days, at the widest k the route allows.
 *
 * The drift series is the one handler whose cost grows with something a client
 * chooses — days × two runs, each compared at k — so it is measured at the
 * maximum of both rather than at the seven days the plan asks for. `MAX_DAYS` is
 * bounded by the subrequest ceiling on the *write* side; this is the read side
 * proving the arithmetic that bound allows still fits in 10 ms.
 */
const DRIFT_DAYS = 14
await experiments.insert({
  id: "exp-1",
  domainId: "atlas",
  ownerId: "owner-1",
  sourceId: "fake.search",
  query: "ของกินอร่อย",
  personaAId: "a",
  personaBId: "b",
  days: DRIFT_DAYS,
  k: MAX_K,
  intervalMinutes: 1440,
  startedAt: capturedAt,
  state: "running",
})
const driftItems: RawItemRow[] = []
for (let day = 0; day < DRIFT_DAYS; day++) {
  for (const [side, personaId, offset] of [
    ["a", "a", 0],
    ["b", "b", 50],
  ] as const) {
    const runId = `d${day}${side}`
    runs.runs.set(runId, {
      ...labRun(runId, personaId, { id: "exp-1", day }),
      startedAt: new Date(capturedAt.getTime() + day * 86_400_000),
    })
    for (let rank = 0; rank < MAX_K; rank++) {
      driftItems.push({
        ...(labItems[0] as RawItemRow),
        id: `${runId}-${rank}`,
        harvestRunId: runId,
        rank,
        url: `https://x.test/${rank + offset}`,
      })
    }
  }
}
await items.insertMany(driftItems)

/** Total CPU (user + system) per iteration, in milliseconds. */
async function cpuPerRequest(run: () => Promise<unknown>): Promise<number> {
  // Warm up first. The first few hundred calls are measuring V8's optimiser, not
  // the handler, and a Worker isolate serves many requests too.
  for (let i = 0; i < 100; i++) await run()
  const before = process.cpuUsage()
  for (let i = 0; i < ITERATIONS; i++) await run()
  const d = process.cpuUsage(before)
  return (d.user + d.system) / 1000 / ITERATIONS
}

describe("CPU per request against the 10 ms free-plan ceiling", () => {
  it("measures POST /jobs", async () => {
    let n = 0
    const ms = await cpuPerRequest(async () => {
      n += 1
      const res = await app.request("/jobs", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          type: "harvest.run",
          domainId: "travel",
          idempotencyKey: `k-${n}`,
          payload: { city: "Lisbon", nights: 3, travellers: 2 },
        }),
      })
      await res.json()
    })
    console.log(`POST /jobs        ${ms.toFixed(3)} ms CPU/request (ceiling ${CEILING_MS} ms)`)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it("measures GET /jobs/:id/events for a single tick", async () => {
    // One tick, not a whole stream: the ceiling is per invocation, and a stream that
    // waits fifteen minutes still only spends CPU on the ticks it actually serves.
    const oneTick = createApp({
      jobs: () => store,
      verifier,
      dispatcher: noopDispatcher,
      clock: () => 0,
      sleep: async () => {},
      maxLifetimeMs: 0,
    })
    const ms = await cpuPerRequest(async () => {
      const res = await oneTick.request("/jobs/job-1/events", { headers: AUTH })
      await res.text()
    })
    console.log(`GET  /jobs/:id/events  ${ms.toFixed(3)} ms CPU/request (ceiling ${CEILING_MS} ms)`)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it("measures GET /lab/compare at the widest k it allows", async () => {
    const q = encodeURIComponent("ของกินอร่อย")
    const ms = await cpuPerRequest(async () => {
      const res = await app.request(`/lab/compare?a=a&b=b&query=${q}&k=${MAX_K}`, { headers: AUTH })
      await res.json()
    })
    console.log(`GET  /lab/compare ${ms.toFixed(3)} ms CPU/request (ceiling ${CEILING_MS} ms)`)
    // The heaviest handler in the app: four reads, `overlapAt` over two hundred
    // strings, and two hundred items serialised. If this ever approaches the
    // ceiling the fix is a smaller `MAX_K`, not a bigger budget.
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it("measures POST /lab/personas, which is the only route that runs a schema", async () => {
    let n = 0
    const ms = await cpuPerRequest(async () => {
      n += 1
      const res = await app.request("/lab/personas", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          name: `persona ${n}`,
          locality: "Ari, Bangkok",
          country: "th",
          locale: "th-TH",
          timezoneId: "Asia/Bangkok",
        }),
      })
      await res.json()
    })
    console.log(`POST /lab/personas ${ms.toFixed(3)} ms CPU/request (ceiling ${CEILING_MS} ms)`)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it("measures GET /lab/drift/:id over a full fortnight at the widest k", async () => {
    const ms = await cpuPerRequest(async () => {
      const res = await app.request(`/lab/drift/exp-1?k=${MAX_K}`, { headers: AUTH })
      await res.json()
    })
    console.log(`GET  /lab/drift/:id ${ms.toFixed(3)} ms CPU/request (ceiling ${CEILING_MS} ms)`)
    // Fourteen `overlapAt` calls and fourteen `meanRankShift` calls over two
    // hundred strings each. If this ever approaches the ceiling the fix is fewer
    // days or a smaller k — both are already columns — not a bigger budget.
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it("measures GET /lab/places at the widest page it allows", async () => {
    const ms = await cpuPerRequest(async () => {
      const res = await app.request(`/lab/places?limit=${MAX_LIMIT}`, { headers: AUTH })
      await res.json()
    })
    console.log(`GET  /lab/places  ${ms.toFixed(3)} ms CPU/request (ceiling ${CEILING_MS} ms)`)
    // All serialisation: the ordering and the quote are chosen in SQL. Measured
    // at 22 ms for two hundred places, which is how `MAX_LIMIT` came to be thirty;
    // if this approaches the ceiling again the fix is a cursor, not a bigger budget.
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it("measures GET /health", async () => {
    const ms = await cpuPerRequest(async () => {
      const res = await app.request("/health")
      await res.json()
    })
    console.log(`GET  /health      ${ms.toFixed(3)} ms CPU/request (ceiling ${CEILING_MS} ms)`)
    // The cheapest thing the API does, and the one an uptime monitor will call
    // most often. If this is not an order of magnitude under the ceiling, something
    // has been added to it that does not belong there.
    expect(ms).toBeLessThan(CEILING_MS / 10)
  })
})
