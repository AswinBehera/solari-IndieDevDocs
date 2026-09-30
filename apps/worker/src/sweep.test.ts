import { MemoryTripStore } from "@dt/db/trips"
import type { EnqueueInput } from "@samsara/kernel"
import { describe, expect, it } from "vitest"
import type { JobContext } from "./handlers.js"
import { createSweepHandler, dayOf, SWEEP_SOURCE, sweepHarvestKey, sweepQuery } from "./sweep.js"

const NOW = new Date("2026-09-29T02:00:00Z")
const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

async function setup(
  trips: { city: string; status?: "planning" | "dreaming"; text?: string }[],
  healthy = true,
) {
  const store = new MemoryTripStore()
  for (const t of trips) {
    store.accounts.add("u1")
    const made = await store.create("u1", {
      title: "T",
      destinationCity: t.city,
      startDate: null,
      endDate: null,
      status: t.status ?? "planning",
      content: doc(t.text ?? "street food and night markets"),
    })
    void made
  }
  const enqueued: EnqueueInput[] = []
  const seen = new Set<string>()
  const queue = {
    async enqueue(i: EnqueueInput) {
      enqueued.push(i)
      const dup = i.idempotencyKey ? seen.has(i.idempotencyKey) : false
      if (i.idempotencyKey) seen.add(i.idempotencyKey)
      return { id: `j${enqueued.length}`, deduped: dup }
    },
  }
  const notes: string[] = []
  const handler = createSweepHandler({
    trips: store,
    personas: { list: async () => (healthy ? [{ id: "p1" } as never] : []) },
    queue,
    clock: () => NOW,
    maxTrips: 2,
  })
  const ctx = {
    job: { payload: {} },
    async heartbeat(n?: string) {
      if (n) notes.push(n)
    },
  } as unknown as JobContext
  return { handler, ctx, enqueued, notes, store }
}

describe("trip.sweep", () => {
  it("queues one harvest per covered planning trip, keyed by trip and day", async () => {
    const s = await setup([
      { city: "Bangkok" },
      { city: "Tokyo" },
      { city: "Bangkok", status: "dreaming" },
    ])
    await s.handler(s.ctx)
    expect(s.enqueued).toHaveLength(1)
    const job = s.enqueued[0]
    expect(job?.type).toBe("harvest.run")
    expect(job?.payload).toMatchObject({
      personaId: "p1",
      sourceId: SWEEP_SOURCE,
      domainId: "travel",
    })
    // "street food and night markets": one tag a day, asked the way Bangkok asks it.
    expect(["สตรีทฟู้ด กรุงเทพ ร้านเด็ด", "ตลาดนัดกลางคืน กรุงเทพ"]).toContain(
      (job?.payload as { query: string } | undefined)?.query,
    )
    expect(job?.idempotencyKey).toBe(
      sweepHarvestKey([...s.store.trips.values()][0]?.id ?? "", dayOf(NOW)),
    )
  })
  it("is a no-op when run twice the same day", async () => {
    const s = await setup([{ city: "Bangkok" }])
    await s.handler(s.ctx)
    await s.handler(s.ctx)
    expect(s.notes.at(-1)).toContain("0 harvest(s) queued")
  })
  it("respects the per-day trip cap", async () => {
    const s = await setup([{ city: "Bangkok" }, { city: "Bangkok" }, { city: "Bangkok" }])
    await s.handler(s.ctx)
    expect(s.enqueued).toHaveLength(2)
  })
  it("queues nothing without a healthy persona", async () => {
    const s = await setup([{ city: "Bangkok" }], false)
    await s.handler(s.ctx)
    expect(s.enqueued).toHaveLength(0)
  })
})

describe("sweepQuery", () => {
  it("asks a tag the document names in Thai, rotating by day", () => {
    const line = "I care about temples and rooftop bars."
    expect(sweepQuery("Bangkok", line, 0)).toBe("รูฟท็อปบาร์ กรุงเทพ")
    expect(sweepQuery("Bangkok", line, 1)).toBe("วัดสวย กรุงเทพ ไหว้พระ")
  })

  it("caps the query and refuses a city the pipeline does not cover", () => {
    expect(sweepQuery("Bangkok", "x".repeat(300))?.length).toBe(80)
    expect(sweepQuery("Tokyo", "food")).toBeNull()
  })
})
