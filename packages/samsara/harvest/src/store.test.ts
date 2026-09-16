import { describe, expect, it } from "vitest"
import { boundedLimit, ITEM_LIST_LIMIT, RUN_LIST_LIMIT } from "./ports.js"
import {
  MemoryDriftExperimentStore,
  MemoryHarvestRunStore,
  MemoryRawItemStore,
  type RawItemRow,
} from "./store.js"

/**
 * The in-memory stores, held to the behaviour the real ones have.
 *
 * These exist so that tests elsewhere — the API's CPU measurement, the run
 * orchestration — do not need a database. That makes them dangerous in one
 * specific way: a fake that is *convenient* rather than *faithful* lets every
 * test pass while the Postgres implementation is wrong, because the two agree
 * right up until the day they matter. So the properties asserted here are the
 * ones `harvest.pg.test.ts` asserts against real SQL, deliberately duplicated.
 *
 * `overlap.test.ts` covers the arithmetic; nothing below does any.
 */

const capturedAt = new Date("2026-09-16T10:00:00.000Z")

const item = (over: Partial<RawItemRow> & { harvestRunId: string; rank: number }): RawItemRow => ({
  id: `${over.harvestRunId}-${over.rank}`,
  sourceId: "fake.search",
  url: `https://fake.test/${over.rank}`,
  title: null,
  text: "",
  languageGuess: null,
  mediaRefs: [],
  engagement: null,
  capturedAt,
  rawRef: "captures/fake.search/1.json",
  ...over,
})

const run = (id: string, over: Partial<Parameters<MemoryHarvestRunStore["start"]>[0]> = {}) => ({
  id,
  domainId: "atlas",
  personaId: "persona-1",
  sourceId: "fake.search",
  query: "ของกินอร่อย",
  sessionId: "session-1",
  startedAt: capturedAt,
  experiment: null,
  ...over,
})

describe("bounded reads", () => {
  it("falls back to the ceiling rather than to unbounded", () => {
    // The direction matters more than the number. A missing limit that meant "all"
    // would turn every forgotten argument into a full scan inside a 10 ms handler.
    expect(boundedLimit(undefined, ITEM_LIST_LIMIT)).toBe(ITEM_LIST_LIMIT)
    expect(boundedLimit(Number.NaN, RUN_LIST_LIMIT)).toBe(RUN_LIST_LIMIT)
    expect(boundedLimit(Number.POSITIVE_INFINITY, RUN_LIST_LIMIT)).toBe(RUN_LIST_LIMIT)
  })

  it("clamps at both ends and never returns a fraction", () => {
    expect(boundedLimit(1_000_000, ITEM_LIST_LIMIT)).toBe(ITEM_LIST_LIMIT)
    // Zero and below become one, not zero: a caller asking for nothing has made a
    // mistake, and answering with an empty list would read as "the run is empty".
    expect(boundedLimit(0, ITEM_LIST_LIMIT)).toBe(1)
    expect(boundedLimit(-5, ITEM_LIST_LIMIT)).toBe(1)
    expect(boundedLimit(20.7, ITEM_LIST_LIMIT)).toBe(20)
  })
})

describe("the in-memory raw item store", () => {
  it("returns a run's items in rank order, not insertion order", async () => {
    const items = new MemoryRawItemStore()
    await items.insertMany([
      item({ harvestRunId: "r1", rank: 2 }),
      item({ harvestRunId: "r1", rank: 0 }),
      item({ harvestRunId: "r1", rank: 1 }),
    ])
    expect((await items.listByRun("r1")).map((i) => i.rank)).toEqual([0, 1, 2])
  })

  it("keeps one run's items out of another's", async () => {
    const items = new MemoryRawItemStore()
    await items.insertMany([
      item({ harvestRunId: "r1", rank: 0 }),
      item({ harvestRunId: "r2", rank: 0 }),
    ])
    expect(await items.listByRun("r1")).toHaveLength(1)
    expect(await items.listByRun("r3")).toHaveLength(0)
  })

  it("takes the limit off the top of the ranking", async () => {
    const items = new MemoryRawItemStore()
    await items.insertMany(
      Array.from({ length: 5 }, (_, rank) => item({ harvestRunId: "r1", rank })).reverse(),
    )
    expect((await items.listByRun("r1", 2)).map((i) => i.rank)).toEqual([0, 1])
  })

  it("returns ranked urls for several runs at once, k each", async () => {
    const items = new MemoryRawItemStore()
    await items.insertMany([
      ...Array.from({ length: 4 }, (_, rank) => item({ harvestRunId: "r1", rank })),
      ...Array.from({ length: 4 }, (_, rank) => item({ harvestRunId: "r2", rank })),
    ])
    const urls = await items.rankedUrls(["r1", "r2"], 2)
    expect(urls.get("r1")).toEqual(["https://fake.test/0", "https://fake.test/1"])
    // k applies per run, not across the batch: a fourteen-day plot asking for the
    // top 20 wants twenty from each day, not twenty spread over the week.
    expect(urls.get("r2")).toHaveLength(2)
  })

  it("leaves a run with no items out of the map rather than putting an empty list in it", async () => {
    const items = new MemoryRawItemStore()
    await items.insertMany([item({ harvestRunId: "r1", rank: 0 })])
    const urls = await items.rankedUrls(["r1", "r2"], 20)
    // Present-and-empty and absent read the same to `overlapAt`, but only one of
    // them lets the caller tell "this run returned nothing" from "this run is not
    // in the result", and the series needs that distinction to mark a day empty.
    expect(urls.has("r2")).toBe(false)
  })
})

describe("the in-memory harvest run store", () => {
  const filled = async () => {
    const runs = new MemoryHarvestRunStore()
    await runs.start(run("older", { startedAt: new Date("2026-09-15T10:00:00.000Z") }))
    await runs.start(run("newer"))
    await runs.start(run("other-question", { query: "ที่เที่ยว" }))
    await runs.start(run("other-persona", { personaId: "persona-2" }))
    return runs
  }

  it("lists newest first", async () => {
    const runs = await filled()
    expect((await runs.list({ personaId: "persona-1", query: "ของกินอร่อย" }))[0]?.id).toBe("newer")
  })

  it("matches the query exactly", async () => {
    const runs = await filled()
    // A comparison is only meaningful within one question; a prefix match would
    // quietly compare two different ones.
    expect(await runs.list({ query: "ของกิน" })).toHaveLength(0)
    expect(await runs.list({ query: "ของกินอร่อย" })).toHaveLength(3)
  })

  it("combines its filters rather than choosing between them", async () => {
    const runs = await filled()
    const rows = await runs.list({ personaId: "persona-1", query: "ของกินอร่อย", limit: 1 })
    expect(rows.map((r) => r.id)).toEqual(["newer"])
  })

  it("records an outcome where the run can be read back with it", async () => {
    const runs = new MemoryHarvestRunStore()
    await runs.start(run("r1"))
    expect((await runs.byId("r1"))?.outcome).toBe("running")
    await runs.finish("r1", "blocked", 0, new Date("2026-09-16T10:01:00.000Z"))
    const read = await runs.byId("r1")
    // `blocked` with zero items is a result, not a failure to record one — it is a
    // source telling us what it thinks of an identity.
    expect(read?.outcome).toBe("blocked")
    expect(read?.itemCount).toBe(0)
  })

  it("lists one experiment's runs oldest first, and nobody else's", async () => {
    const runs = new MemoryHarvestRunStore()
    await runs.start(run("e-day-1", { experiment: { id: "exp-1", day: 1 } }))
    await runs.start(run("e-day-0", { experiment: { id: "exp-1", day: 0 } }))
    await runs.start(run("other-exp", { experiment: { id: "exp-2", day: 0 } }))
    await runs.start(run("ad-hoc"))
    // Oldest first, unlike every other list in the package: a series is a line
    // drawn left to right, not a "what happened most recently" panel.
    expect((await runs.listByExperiment("exp-1")).map((r) => r.id)).toEqual(["e-day-0", "e-day-1"])
  })
})

describe("the in-memory experiment store", () => {
  const experiment = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    domainId: "atlas",
    ownerId: "owner-1",
    sourceId: "fake.search",
    query: "ของกินอร่อย",
    personaAId: "persona-1",
    personaBId: "persona-2",
    days: 7,
    k: 20,
    intervalMinutes: 1440,
    startedAt: capturedAt,
    state: "running" as const,
    ...over,
  })

  it("refuses to insert the same experiment twice", async () => {
    const store = new MemoryDriftExperimentStore()
    await store.insert(experiment("exp-1"))
    // Two rows with one id would enqueue two sets of jobs whose idempotency keys
    // collide, and that surfaces as a half-missing week rather than as an error.
    await expect(store.insert(experiment("exp-1"))).rejects.toThrow(/already exists/)
  })

  it("filters by state, which is how the runner finds what is still spending", async () => {
    const store = new MemoryDriftExperimentStore()
    await store.insert(experiment("exp-1"))
    await store.insert(experiment("exp-2", { state: "stopped" }))
    expect((await store.list({ state: "running" })).map((e) => e.id)).toEqual(["exp-1"])
  })

  it("stops an experiment in a way the handler can read before it opens a browser", async () => {
    const store = new MemoryDriftExperimentStore()
    await store.insert(experiment("exp-1"))
    await store.setState("exp-1", "stopped")
    // The remaining days are already queued rows. Nothing is cancelled by this —
    // the refusal has to happen at claim time, and this is what it reads.
    expect((await store.byId("exp-1"))?.state).toBe("stopped")
  })
})
