import type { MeterId } from "@samsara/core"
import {
  type BrowserLauncher,
  BudgetGuard,
  Kernel,
  MemoryCounterStore,
  MemoryLogger,
  MemorySessionStore,
  SessionRegistry,
} from "@samsara/kernel"
import { describe, expect, it } from "vitest"
import type { ProbeAdapter, ProbeTargetRecord } from "./adapter.js"
import { dailyFx } from "./fx.js"
import { MemoryObservationStore, MemoryScreenshotArchive } from "./memory.js"
import { runProbe } from "./run.js"
import { PROBE_VIEWPOINTS } from "./viewpoints.js"

const CEILINGS: Record<MeterId, number> = {
  "solari.minutes": 4_000,
  "llm.input.tokens": 1,
  "llm.output.tokens": 1,
  "geocode.calls": 1,
}

function kernel(failCountries: string[] = []) {
  const logger = new MemoryLogger()
  let n = 0
  const launcher: BrowserLauncher = {
    async launch(config) {
      if (failCountries.includes(config.proxy?.country ?? "")) throw new Error("ECONNREFUSED")
      return { id: `h${++n}`, newPage: async () => ({}), close: async () => {} }
    },
    async dispose() {},
  }
  return new Kernel({
    registry: new SessionRegistry(new MemorySessionStore(), logger),
    guard: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS }),
    browser: launcher,
    logger,
  })
}

const target: ProbeTargetRecord = {
  id: "t1",
  ownerId: "o1",
  sourceId: "fake.price",
  url: "https://example.invalid/x",
  parsed: { id: 1 },
  watch: false,
  cadence: null,
  createdAt: new Date(0),
}

const adapter = (over: Partial<ProbeAdapter> = {}): ProbeAdapter => ({
  id: "fake.price" as never,
  parseUrl: () => ({ ok: true, parsed: {} }),
  async probe(ctx) {
    return {
      payload: { amount: 100, currency: "USD", seenIn: ctx.country },
      screenshot: new Uint8Array([1]),
    }
  },
  ...over,
})

describe("runProbe", () => {
  it("writes one observation per country with its own session and screenshot", async () => {
    const observations = new MemoryObservationStore()
    const archive = new MemoryScreenshotArchive()
    const report = await runProbe(
      { kernel: kernel(), observations, archive },
      { target, adapter: adapter() },
    )
    // `th` is not in the provider's proxy pool (see `countries.ts`), so it is refused by
    // name and reported, never quietly probed from Singapore.
    expect(report.results.map((r) => [r.country, r.outcome])).toEqual(
      PROBE_VIEWPOINTS.map((v) => [v.country, v.country === "th" ? "failed" : "observed"]),
    )
    expect(report.results.find((r) => r.country === "th")?.failure).toContain(
      "not in the provider's pool",
    )
    expect(observations.rows).toHaveLength(7)
    expect(new Set(observations.rows.map((r) => r.sessionId)).size).toBe(7)
    expect(archive.puts).toHaveLength(7)
    expect(observations.rows.every((r) => r.screenshotRef.startsWith("probe/t1/"))).toBe(true)
  })

  it("records a session that never produced a page as failed and writes nothing for it", async () => {
    const observations = new MemoryObservationStore()
    const report = await runProbe(
      { kernel: kernel(["jp"]), observations, archive: new MemoryScreenshotArchive() },
      { target, adapter: adapter() },
    )
    const jp = report.results.find((r) => r.country === "jp")
    expect(jp?.outcome).toBe("failed")
    expect(observations.rows.map((r) => r.country)).not.toContain("jp")
    expect(observations.rows).toHaveLength(6)
  })

  it("stores a refusal payload as an observation like any other", async () => {
    const observations = new MemoryObservationStore()
    const blocked = adapter({
      async probe() {
        return { payload: { status: "blocked" }, screenshot: new Uint8Array([1]) }
      },
    })
    await runProbe(
      { kernel: kernel(), observations, archive: new MemoryScreenshotArchive() },
      { target, adapter: blocked },
    )
    expect(observations.rows[0]?.payload).toEqual({ status: "blocked" })
  })

  it("normalises through the adapter's own hook and keeps the raw payload", async () => {
    const observations = new MemoryObservationStore()
    const withFx = adapter({
      normalise: (p, rates) => ({ ...(p as object), usd: 100 * (rates.USD ?? 0) }),
    })
    await runProbe(
      {
        kernel: kernel(),
        observations,
        archive: new MemoryScreenshotArchive(),
        rates: async () => ({ USD: 1 }),
      },
      { target, adapter: withFx, viewpoints: PROBE_VIEWPOINTS.filter((v) => v.country === "us") },
    )
    expect(observations.rows[0]?.payload).toMatchObject({ amount: 100, currency: "USD", usd: 100 })
  })

  it("opens no browser when the rate source fails", async () => {
    const observations = new MemoryObservationStore()
    await expect(
      runProbe(
        {
          kernel: kernel(),
          observations,
          archive: new MemoryScreenshotArchive(),
          rates: async () => {
            throw new Error("fx down")
          },
        },
        { target, adapter: adapter({ normalise: (p) => p }) },
      ),
    ).rejects.toThrow("fx down")
    expect(observations.rows).toHaveLength(0)
  })
})

describe("dailyFx", () => {
  const body = { rates: { USD: 1, THB: 32, JPY: 150, BAD: 0 } }
  it("inverts the quote to USD per unit and caches for the UTC day", async () => {
    let calls = 0
    const f = (async () => {
      calls++
      return { ok: true, json: async () => body }
    }) as unknown as typeof fetch
    const rates = dailyFx(f, () => new Date("2026-09-29T01:00:00Z"))
    const a = await rates()
    await rates()
    expect(calls).toBe(1)
    expect(a.THB).toBeCloseTo(1 / 32)
    expect(a.BAD).toBeUndefined()
  })
  it("throws rather than returning stale rates when the source fails", async () => {
    const f = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
    await expect(dailyFx(f)()).rejects.toThrow("503")
  })
})

describe("the viewpoints", () => {
  it("differ from the provider's pool only by th, which is reported rather than substituted", async () => {
    const { isSupportedProxyCountry } = await import("@samsara/kernel")
    expect(
      PROBE_VIEWPOINTS.filter((v) => !isSupportedProxyCountry(v.country)).map((v) => v.country),
    ).toEqual(["th"])
  })
})
