import {
  type BrowserLauncher,
  BudgetGuard,
  Kernel,
  MemoryCounterStore,
  MemoryLogger,
  MemorySessionStore,
  SessionRegistry,
} from "@samsara/kernel"
import {
  MemoryObservationStore,
  MemoryProbeTargetStore,
  MemoryScreenshotArchive,
  type ProbeAdapter,
} from "@samsara/probe"
import { PackRegistry } from "@samsara/refine"
import { describe, expect, it } from "vitest"
import type { JobContext } from "./handlers.js"
import { createProbeHandler } from "./probe.js"

const adapter: ProbeAdapter = {
  id: "price.stay" as never,
  parseUrl: () => ({ ok: true, parsed: {} }),
  async probe(ctx) {
    return { payload: { status: "price", country: ctx.country }, screenshot: new Uint8Array([1]) }
  },
}

function setup() {
  const logger = new MemoryLogger()
  const launcher: BrowserLauncher = {
    async launch() {
      return { id: "h", newPage: async () => ({}), close: async () => {} }
    },
    async dispose() {},
  }
  const kernel = new Kernel({
    registry: new SessionRegistry(new MemorySessionStore(), logger),
    guard: new BudgetGuard({
      store: new MemoryCounterStore(),
      ceilings: {
        "solari.minutes": 4000,
        "llm.input.tokens": 1,
        "llm.output.tokens": 1,
        "geocode.calls": 1,
      },
    }),
    browser: launcher,
    logger,
  })
  const targets = new MemoryProbeTargetStore()
  const observations = new MemoryObservationStore()
  const handler = createProbeHandler({
    targets,
    observations,
    archive: new MemoryScreenshotArchive(),
    adapters: new Map([["price.stay", adapter]]),
  })
  const notes: string[] = []
  const ctx = (payload: unknown): JobContext => ({
    job: { id: "j", type: "probe.run", payload } as JobContext["job"],
    kernel,
    packs: new PackRegistry(),
    logger,
    signal: new AbortController().signal,
    async heartbeat(n) {
      if (n) notes.push(n)
    },
  })
  return { handler, ctx, targets, observations, notes }
}

describe("probe.run", () => {
  it("probes the stored target from every country the provider can reach", async () => {
    const s = setup()
    const t = await s.targets.upsert({
      ownerId: "o",
      sourceId: "price.stay",
      url: "https://x.invalid/",
      parsed: {},
    })
    await s.handler(s.ctx({ targetId: t.id }))
    expect(s.observations.rows).toHaveLength(7)
    expect(s.notes.at(-1)).toBe("7/8 countries observed")
  })
  it("probes only the named countries when the payload lists some", async () => {
    const s = setup()
    const t = await s.targets.upsert({
      ownerId: "o",
      sourceId: "price.stay",
      url: "https://x.invalid/",
      parsed: {},
    })
    await s.handler(s.ctx({ targetId: t.id, countries: ["us"] }))
    expect(s.observations.rows.map((o) => o.country)).toEqual(["us"])
    await expect(s.handler(s.ctx({ targetId: t.id, countries: ["zz"] }))).rejects.toThrow(
      "no known viewpoint",
    )
  })
  it("rejects a bad payload, a missing adapter, and tolerates a vanished target", async () => {
    const s = setup()
    await expect(s.handler(s.ctx({}))).rejects.toThrow("targetId")
    const t = await s.targets.upsert({
      ownerId: "o",
      sourceId: "unknown.src",
      url: "https://y.invalid/",
      parsed: {},
    })
    await expect(s.handler(s.ctx({ targetId: t.id }))).rejects.toThrow("no adapter")
    await s.handler(s.ctx({ targetId: "gone" }))
    expect(s.notes.at(-1)).toContain("gone")
  })
})
