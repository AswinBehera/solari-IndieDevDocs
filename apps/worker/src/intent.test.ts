import type { MeterId } from "@samsara/core"
import {
  BudgetGuard,
  Kernel,
  MemoryCounterStore,
  MemoryLogger,
  MemorySessionStore,
  SessionRegistry,
} from "@samsara/kernel"
import { fakeChatClient, LlmClient, type LlmConfig } from "@samsara/llm"
import { PackRegistry } from "@samsara/refine"
import { describe, expect, it } from "vitest"
import type { JobContext } from "./handlers.js"
import { createIntentHandler } from "./intent.js"

const CEILINGS: Record<MeterId, number> = {
  "solari.minutes": 4_000,
  "llm.input.tokens": 1_000_000,
  "llm.output.tokens": 200_000,
  "geocode.calls": 800,
}
const config: LlmConfig = {
  apiKey: "k",
  baseUrl: "https://example.invalid/v1",
  models: { extract: "vendor/cheap" },
  format: "schema",
}

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

function setup(opts: {
  startDate?: Date | null
  endDate?: Date | null
  content?: unknown
  reply?: string
  withoutLlm?: boolean
  gone?: boolean
}) {
  const chat = fakeChatClient([
    opts.reply ?? JSON.stringify({ startDate: "2026-11-03", endDate: "2026-11-10" }),
  ])
  const llm = new LlmClient({
    chat,
    config,
    budget: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS }),
    sleep: async () => {},
  })
  const updates: { startDate?: Date; endDate?: Date }[] = []
  const trips = {
    async get() {
      if (opts.gone) return null
      return {
        trip: { startDate: opts.startDate ?? null, endDate: opts.endDate ?? null },
        document: { content: opts.content ?? doc("Bangkok, 3-10 November"), version: 1 },
      } as never
    },
    async update(_o: string, _t: string, patch: { startDate?: Date; endDate?: Date }) {
      updates.push(patch)
      return null
    },
  }
  const handler = createIntentHandler({
    trips,
    ...(opts.withoutLlm ? {} : { llm }),
    clock: () => new Date("2026-09-29T00:00:00Z"),
  })
  const logger = new MemoryLogger()
  const ctx = (payload: unknown): JobContext => ({
    job: { id: "j", type: "trip.intent", payload } as JobContext["job"],
    kernel: new Kernel({
      registry: new SessionRegistry(new MemorySessionStore(), logger),
      guard: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS }),
      logger,
    }),
    packs: new PackRegistry(),
    logger,
    signal: new AbortController().signal,
    async heartbeat() {},
  })
  return { handler, ctx, chat, updates }
}

const PAYLOAD = { tripId: "t1", ownerId: "o1" }

describe("trip.intent", () => {
  it("fills both empty dates from the prose", async () => {
    const s = setup({})
    await s.handler(s.ctx(PAYLOAD))
    expect(s.updates).toEqual([
      { startDate: new Date("2026-11-03T00:00:00Z"), endDate: new Date("2026-11-10T00:00:00Z") },
    ])
  })

  it("never overwrites a date the traveller set, and fills only the other", async () => {
    const set = new Date("2026-11-01T00:00:00Z")
    const s = setup({ startDate: set })
    await s.handler(s.ctx(PAYLOAD))
    expect(s.updates).toEqual([{ endDate: new Date("2026-11-10T00:00:00Z") }])
  })

  it("does not call the model when both dates are set or there is no prose", async () => {
    const both = setup({ startDate: new Date(), endDate: new Date() })
    await both.handler(both.ctx(PAYLOAD))
    const empty = setup({ content: { type: "doc", content: [{ type: "paragraph" }] } })
    await empty.handler(empty.ctx(PAYLOAD))
    expect(both.chat.calls + empty.chat.calls).toBe(0)
  })

  it("writes nothing for a backwards range, an impossible date, or nulls", async () => {
    for (const reply of [
      { startDate: "2026-11-10", endDate: "2026-11-03" },
      { startDate: "2026-02-31", endDate: null },
      { startDate: null, endDate: null },
    ]) {
      const s = setup({ reply: JSON.stringify(reply) })
      await s.handler(s.ctx(PAYLOAD))
      expect(s.updates).toEqual([])
    }
  })

  it("refuses by name without an LLM, and rejects a bad payload", async () => {
    const s = setup({ withoutLlm: true })
    await expect(s.handler(s.ctx(PAYLOAD))).rejects.toThrow("OPENROUTER_API_KEY")
    const t = setup({})
    await expect(t.handler(t.ctx({ tripId: "t1" }))).rejects.toThrow("ownerId")
  })

  it("does nothing for a trip that has gone", async () => {
    const s = setup({ gone: true })
    await s.handler(s.ctx(PAYLOAD))
    expect(s.chat.calls).toBe(0)
  })
})
