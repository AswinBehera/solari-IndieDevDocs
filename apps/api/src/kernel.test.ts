import { describe, expect, it } from "vitest"
import { createApp } from "./app.js"

const snapshot = {
  open: [],
  minutesToday: [{ purpose: "harvest" as const, minutes: 1.5 }],
  used: { "solari.minutes": 10 },
  adapters: [
    { domainId: "youtube.search", total: 4, blocked: 1 },
    { domainId: "idle", total: 0, blocked: 0 },
  ],
  personas: [],
}

const app = createApp({
  jobs: () => {
    throw new Error("unused")
  },
  verifier: {
    verify: async (t: string) => {
      if (t !== "ok") throw new Error("bad token")
      return "u"
    },
  },
  dispatcher: { dispatch: async () => {} } as never,
  kernel: {
    reader: () => ({ snapshot: async () => snapshot }),
    clock: () => new Date("2026-09-29T00:00:00Z"),
  },
})

describe("GET /lab/kernel", () => {
  it("refuses an unauthenticated request", async () => {
    const res = await app.request("/lab/kernel", {}, {})
    expect(res.status).toBe(401)
  })

  it("lays ceilings over counters and derives blocked rate", async () => {
    const res = await app.request(
      "/lab/kernel",
      { headers: { authorization: "Bearer ok" } },
      { BUDGET_SOLARI_MINUTES: "100" },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      meters: { meter: string; ceiling: number; used: number }[]
      adapters: { blockedRate: number }[]
    }
    const minutes = body.meters.find((m) => m.meter === "solari.minutes")
    expect(minutes).toEqual({ meter: "solari.minutes", ceiling: 100, used: 10 })
    expect(body.meters.find((m) => m.meter === "geocode.calls")?.used).toBe(0)
    expect(body.adapters.map((a) => a.blockedRate)).toEqual([0.25, 0])
  })
})
