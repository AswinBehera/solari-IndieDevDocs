import {
  MemoryCaptureArchive,
  MemoryDriftExperimentStore,
  MemoryHarvestRunStore,
  MemoryRawItemStore,
} from "@samsara/harvest"
import {
  type BrowserHandle,
  type BrowserLauncher,
  BudgetGuard,
  DEFAULT_CEILINGS,
  type JobStore,
  Kernel,
  MemoryCounterStore,
  MemoryJobStore,
  MemoryLogger,
  MemorySessionStore,
  SessionRegistry,
} from "@samsara/kernel"
import { MemoryPersonaStore, type PersonaRecord } from "@samsara/personas"
import type { Capture, ItemDraft, SourceAdapter } from "@samsara/sources"
import { describe, expect, it } from "vitest"
import type { JobContext } from "./handlers.js"
import { createHarvestHandler } from "./harvest.js"
import { createPackRegistry } from "./packs.js"
import { refineJobKey } from "./refine.js"

/**
 * The handler's own job, which is smaller than it looks: validate a payload that
 * anything with the connection string can write, refuse to spend on an identity
 * that is finished, and hand the rest to `runHarvest`. Everything below tests one
 * of those three, because the orchestration itself is already tested where it
 * lives.
 */

function fakeLauncher() {
  let launches = 0
  const launcher: BrowserLauncher = {
    async launch(): Promise<BrowserHandle> {
      launches += 1
      return {
        id: `fake-${launches}`,
        async newPage() {
          return {}
        },
        async close() {},
      }
    },
    async dispose() {},
  }
  return {
    launcher,
    get launches() {
      return launches
    },
  }
}

const adapter: SourceAdapter<{ n: number }> = {
  id: "fake.source",
  async capture(_ctx, query): Promise<Capture<{ n: number }>> {
    return {
      sourceId: "fake.source",
      query,
      url: "https://fake.test/q",
      capturedAt: new Date("2026-09-12T00:00:00Z"),
      payload: { n: 2 },
    }
  },
  parse(capture): readonly ItemDraft[] {
    return Array.from({ length: capture.payload.n }, (_, i) => ({
      url: `https://fake.test/i/${i}`,
      title: `item ${i}`,
      text: "body",
      languageGuess: null,
      mediaRefs: [],
      engagement: null,
    }))
  },
}

/**
 * An adapter that fails the way a page does: a thrown Error from inside the
 * session, which the kernel classifies as `internal` and whose text survives only
 * on `Failure.cause`. See the `cause` test at the bottom of this file.
 */
const throwingAdapter = (message: string): SourceAdapter<{ n: number }> => ({
  ...adapter,
  async capture(): Promise<Capture<{ n: number }>> {
    throw new ReferenceError(message)
  },
})

async function harness(
  behaviour: {
    health?: PersonaRecord["health"]
    experiment?: "running" | "stopped"
    sourceThrows?: string
    /** Makes the follow-on enqueue fail, which must not fail the harvest. */
    queueThrows?: boolean
  } = {},
) {
  const logger = new MemoryLogger()
  const fake = fakeLauncher()
  const kernel = new Kernel({
    registry: new SessionRegistry(new MemorySessionStore(), logger),
    guard: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: DEFAULT_CEILINGS }),
    browser: fake.launcher,
    logger,
  })
  const personas = new MemoryPersonaStore()
  const persona: PersonaRecord = {
    id: "p1",
    name: "regular",
    locality: "District 1",
    country: "sg",
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    tier: "anon",
    solariProfileId: null,
    proxySession: "sticky-1",
    health: behaviour.health ?? "healthy",
    seedPlanId: null,
    lastAliveAt: null,
    stats: { sessions: 0, minutes: 0, blocks: 0 },
  }
  await personas.insert(persona)

  const runs = new MemoryHarvestRunStore()
  const items = new MemoryRawItemStore()
  const experiments = new MemoryDriftExperimentStore()
  await experiments.insert({
    id: "exp-1",
    domainId: "atlas",
    ownerId: "owner-1",
    sourceId: "fake.source",
    query: "xin chào",
    personaAId: "p1",
    personaBId: "p2",
    days: 7,
    k: 20,
    intervalMinutes: 1440,
    startedAt: new Date("2026-09-12T00:00:00Z"),
    state: behaviour.experiment ?? "running",
  })
  const jobs = new MemoryJobStore()
  const queue: Pick<JobStore, "enqueue"> = behaviour.queueThrows
    ? {
        async enqueue() {
          throw new Error("queue is unreachable")
        },
      }
    : jobs

  const handler = createHarvestHandler({
    sources: new Map([
      [
        adapter.id,
        (behaviour.sourceThrows === undefined
          ? adapter
          : throwingAdapter(behaviour.sourceThrows)) as unknown as SourceAdapter<unknown>,
      ],
    ]),
    personas,
    runs,
    items,
    archive: new MemoryCaptureArchive(),
    experiments,
    queue,
  })

  const notes: string[] = []
  const ctx = (payload: unknown): JobContext => ({
    job: { id: "j1", type: "harvest.run", payload } as JobContext["job"],
    kernel,
    packs: createPackRegistry(),
    logger,
    signal: new AbortController().signal,
    async heartbeat(note?: string) {
      if (note) notes.push(note)
    },
  })

  return { handler, ctx, runs, items, personas, experiments, notes, fake, jobs }
}

const PAYLOAD = { personaId: "p1", sourceId: "fake.source", query: "xin chào", domainId: "atlas" }

describe("harvest.run", () => {
  it("harvests, writes the items and reports what it cost", async () => {
    const h = await harness()
    await h.handler(h.ctx(PAYLOAD))
    expect(h.items.items).toHaveLength(2)
    const [run] = await h.runs.list({})
    expect(run?.outcome).toBe("ok")
    expect(h.notes.some((n) => n.startsWith("ok:"))).toBe(true)
  })

  it("tells the persona what happened, because the ban detector reads that", async () => {
    const h = await harness()
    await h.handler(h.ctx(PAYLOAD))
    const persona = await h.personas.byId("p1")
    expect(persona?.stats.sessions).toBe(1)
  })

  it("refuses a payload that is missing a field, before anything opens", async () => {
    const h = await harness()
    for (const key of ["personaId", "sourceId", "query", "domainId"]) {
      const payload: Record<string, unknown> = { ...PAYLOAD }
      delete payload[key]
      await expect(h.handler(h.ctx(payload))).rejects.toThrow(key)
    }
    expect(h.fake.launches).toBe(0)
  })

  it("refuses a blank query rather than asking the source nothing", async () => {
    const h = await harness()
    await expect(h.handler(h.ctx({ ...PAYLOAD, query: "   " }))).rejects.toThrow("query")
    expect(h.fake.launches).toBe(0)
  })

  it("refuses an unregistered source without opening a session", async () => {
    // Not retried, and deliberately so: a source that is not registered will not
    // become registered by trying again in thirty seconds.
    const h = await harness()
    await expect(h.handler(h.ctx({ ...PAYLOAD, sourceId: "nope" }))).rejects.toThrow("no adapter")
    expect(h.fake.launches).toBe(0)
  })

  it("refuses to spend on a banned identity", async () => {
    const h = await harness({ health: "banned" })
    await expect(h.handler(h.ctx(PAYLOAD))).rejects.toThrow("banned")
    expect(h.fake.launches).toBe(0)
  })

  it("throws rather than swallowing, so classify decides about the retry", async () => {
    const h = await harness()
    await expect(h.handler(h.ctx({ ...PAYLOAD, personaId: "ghost" }))).rejects.toThrow(
      "no such persona",
    )
  })
})

describe("harvest.run as a day of a drift experiment (P1.8)", () => {
  const CELL = { ...PAYLOAD, experimentId: "exp-1", experimentDay: 3 }

  it("records which experiment and which day the run was a cell of", async () => {
    const h = await harness()
    await h.handler(h.ctx(CELL))
    const [run] = await h.runs.list({})
    // A stored pairing key, not a reconstruction from the clock: under ADR-0014 a
    // day that fires eighteen hours late is ordinary, and a series that bucketed
    // by wall clock would put it opposite the wrong sibling or nothing at all.
    expect(run?.experiment).toEqual({ id: "exp-1", day: 3 })
  })

  it("refuses half a pairing key before it opens anything", async () => {
    const h = await harness()
    for (const half of [{ experimentId: "exp-1" }, { experimentDay: 0 }]) {
      await expect(h.handler(h.ctx({ ...PAYLOAD, ...half }))).rejects.toThrow("together")
    }
    // The table has the same CHECK. This one exists so the failure is a refused
    // job rather than a constraint violation inside a paid-for browser session.
    expect(h.fake.launches).toBe(0)
  })

  it("does not spend on a day of an experiment that was stopped", async () => {
    const h = await harness({ experiment: "stopped" })
    await h.handler(h.ctx(CELL))
    // Not thrown: being called off after the day was queued is the ordinary way a
    // week ends early, and a failed job would retry it four more times. Stopping
    // cannot unqueue the remaining days, so this refusal is the only thing that
    // makes the button mean anything.
    expect(h.fake.launches).toBe(0)
    expect(await h.runs.list({})).toHaveLength(0)
    expect(h.notes.some((n) => n.includes("stopped"))).toBe(true)
  })

  it("refuses a day that names an experiment which does not exist", async () => {
    const h = await harness()
    await expect(h.handler(h.ctx({ ...CELL, experimentId: "ghost" }))).rejects.toThrow(
      "no such experiment",
    )
    expect(h.fake.launches).toBe(0)
  })

  it("still runs an ordinary harvest, which names no experiment at all", async () => {
    const h = await harness({ experiment: "stopped" })
    await h.handler(h.ctx(PAYLOAD))
    // One stopped experiment must not become a runner that refuses every harvest.
    expect(h.fake.launches).toBe(1)
    expect((await h.runs.list({}))[0]?.experiment).toBeNull()
  })
})

describe("what reaches jobs.last_error", () => {
  it("carries the failure's cause, because the kind alone is not a diagnosis", async () => {
    // The defect this pins down cost a session during P1.8's end-to-end run: two
    // days of an experiment failed as `internal: unhandled kernel error` and the
    // actual text — a ReferenceError from the page — was on `Failure.cause` the
    // whole time, discarded one line before the queue wrote the column.
    // `record-capture.ts` had already paid for the same lesson once.
    const h = await harness({ sourceThrows: "results is not defined" })
    await expect(h.handler(h.ctx(PAYLOAD))).rejects.toThrow("results is not defined")
  })
})

describe("the chaining into extraction (P2.6)", () => {
  // A harvest that found items queues the job that reads them. The alternative
  // was a scan for unextracted runs, which would have made "did this get
  // extracted" a question with a different answer every time it was asked.
  const TRAVEL = { ...PAYLOAD, domainId: "travel" }

  it("queues one refine.extract carrying the run it just wrote", async () => {
    const h = await harness()
    await h.handler(h.ctx(TRAVEL))

    const queued = [...h.jobs.rows.values()].filter((r) => r.type === "refine.extract")
    expect(queued).toHaveLength(1)
    const [runId] = [...h.runs.runs.keys()]
    expect(queued[0]?.payload).toEqual({ domainId: "travel", harvestRunId: runId })
    expect(queued[0]?.domainId).toBe("travel")
  })

  it("keys the job on the pack version, so a bumped prompt is not locked out", async () => {
    // `jobs.idempotency_key` is a permanent unique index — it collides against
    // succeeded rows too. Without the version in the key a run could be extracted
    // exactly once ever, and the one recovery `pack.version` exists to provide
    // would be the one the queue forbids.
    const h = await harness()
    await h.handler(h.ctx(TRAVEL))

    const [job] = [...h.jobs.rows.values()].filter((r) => r.type === "refine.extract")
    const version = createPackRegistry().require("travel").version
    const [runId] = [...h.runs.runs.keys()]
    expect(job?.idempotencyKey).toBe(refineJobKey("travel", version, runId as string))
    expect(job?.idempotencyKey).toContain(`:${version}:`)
  })

  it("does not queue anything for a domain with no pack", async () => {
    // Harvesting a domain nobody wrote a pack for is the seam working, not a gap:
    // the engine stamps `domainId` and has no opinion about packs. It still says
    // so, because the other reading is a runner that shipped without its pack.
    const h = await harness()
    await h.handler(h.ctx(PAYLOAD))

    expect([...h.jobs.rows.values()].filter((r) => r.type === "refine.extract")).toHaveLength(0)
    expect(h.notes.join(" ")).toContain("no pack registered for atlas")
  })

  it("does not queue an extraction of nothing", async () => {
    // A blocked harvest is not a failed job — it succeeds with an outcome and zero
    // items, which is the case this branch exists for. Queueing here would spend a
    // model call to discover the wall that the harvest already reported.
    const h = await harness({ sourceThrows: "blocked" })
    await expect(h.handler(h.ctx(TRAVEL))).resolves.toBeUndefined()

    expect(h.items.items).toHaveLength(0)
    expect([...h.jobs.rows.values()].filter((r) => r.type === "refine.extract")).toHaveLength(0)
  })

  it("survives a queue that is unreachable, because the harvest has already been paid for", async () => {
    // The opposite of the rule everywhere else in this handler. Failing here would
    // put the harvest back in the queue and re-spend a browser session to repair a
    // failed INSERT — and the gap is recoverable from the runs table anyway.
    const h = await harness({ queueThrows: true })
    await expect(h.handler(h.ctx(TRAVEL))).resolves.toBeUndefined()

    expect(h.notes.join(" ")).toContain("backfill can recover it")
    // The harvest itself still landed, which is the whole point of not throwing.
    expect(h.items.items.length).toBeGreaterThan(0)
  })
})
