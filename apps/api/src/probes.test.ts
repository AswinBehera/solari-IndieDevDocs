import { MemoryObservationStore, MemoryProbeTargetStore } from "@samsara/probe"
import { describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import { noopDispatcher } from "./dispatch.js"

const enqueued: { type: string; payload: unknown; idempotencyKey?: string | null }[] = []
const jobs = {
  async enqueue(i: (typeof enqueued)[number]) {
    enqueued.push(i)
    return { id: `job-${enqueued.length}`, deduped: false }
  },
} as never

const targets = new MemoryProbeTargetStore()
const observations = new MemoryObservationStore()
const app = createApp({
  jobs: () => jobs,
  verifier: { verify: async (t: string) => t },
  dispatcher: noopDispatcher,
  probes: {
    targets: () => targets,
    observations: () => observations,
    clock: () => new Date("2026-09-29T00:00:00Z"),
  },
})
const as = (owner: string, init: RequestInit = {}) => ({
  ...init,
  headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
})
const post = (owner: string, url: string) =>
  app.request("/probes", as(owner, { method: "POST", body: JSON.stringify({ url }) }))
const URL_OK = "https://www.booking.com/hotel/th/x.html"

describe("/probes", () => {
  it("refuses a URL the adapter does not understand, before any job exists", async () => {
    const before = enqueued.length
    const res = await post("alice", "https://www.airbnb.com/rooms/1")
    expect(res.status).toBe(422)
    expect(enqueued.length).toBe(before)
  })

  it("stores a target and queues one probe.run keyed by target and hour", async () => {
    const res = await post("alice", URL_OK)
    expect(res.status).toBe(202)
    const { targetId } = (await res.json()) as { targetId: string }
    const job = enqueued.at(-1)
    expect(job?.type).toBe("probe.run")
    expect(job?.payload).toEqual({ targetId })
    expect(job?.idempotencyKey).toBe(
      `probe.run:${targetId}:${Math.floor(Date.parse("2026-09-29T00:00:00Z") / 3_600_000)}`,
    )
    // The same paste is the same target.
    const again = (await (await post("alice", URL_OK)).json()) as { targetId: string }
    expect(again.targetId).toBe(targetId)
  })

  it("reads observations for the owner and a 404 for anyone else", async () => {
    const { targetId } = (await (await post("alice", URL_OK)).json()) as { targetId: string }
    await observations.insert({
      targetId,
      country: "us",
      personaId: null,
      capturedAt: new Date(),
      payload: { status: "price", usd: 543 },
      screenshotRef: "probe/x.png",
      sessionId: "s1",
      notes: null,
    })
    const mine = await app.request(`/probes/${targetId}`, as("alice"))
    expect(mine.status).toBe(200)
    expect(((await mine.json()) as { observations: unknown[] }).observations).toHaveLength(1)
    expect((await app.request(`/probes/${targetId}`, as("bob"))).status).toBe(404)
  })

  it("needs a token", async () => {
    expect((await app.request("/probes", { method: "POST", body: "{}" })).status).toBe(401)
  })
})
