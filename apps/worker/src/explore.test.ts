import type { EnqueueInput } from "@samsara/kernel"
import type { LlmClient } from "@samsara/llm"
import { MemoryPersonaStore, type PersonaRecord } from "@samsara/personas"
import { describe, expect, it } from "vitest"
import { createExploreHandler, MAX_HARVESTS } from "./explore.js"
import type { JobContext } from "./handlers.js"

const NOW = new Date("2026-09-30T02:00:00Z")

const persona = (over: Partial<PersonaRecord> = {}): PersonaRecord => ({
  id: "p1",
  name: "Auntie Noi",
  locality: "Yaowarat, Bangkok",
  country: "sg",
  locale: "th-TH",
  timezoneId: "Asia/Bangkok",
  tier: "anon",
  solariProfileId: null,
  proxySession: null,
  health: "healthy",
  seedPlanId: null,
  lastAliveAt: null,
  stats: { sessions: 0, minutes: 0, blocks: 0 },
  traits: { interests: ["street food", "temples"], sources: ["youtube.search", "pantip.forum"] },
  ...over,
})

async function run(p: PersonaRecord, payload: Record<string, unknown>, llm?: LlmClient) {
  const personas = new MemoryPersonaStore()
  await personas.insert(p)
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
  const handler = createExploreHandler({ personas, queue, llm, clock: () => NOW })
  const ctx = {
    job: { id: "job-1", ownerId: "u1", payload: { personaId: p.id, city: "Bangkok", ...payload } },
    signal: new AbortController().signal,
    async heartbeat(n?: string) {
      if (n) notes.push(n)
    },
  } as unknown as JobContext
  await handler(ctx)
  const queries = enqueued.map((e) => (e.payload as { query: string; sourceId: string }).query)
  return { enqueued, notes, queries, again: () => handler(ctx) }
}

describe("persona.explore", () => {
  it("asks a Thai character's interests in Thai, on each of its sources", async () => {
    const r = await run(persona(), {})
    expect(r.queries).toEqual([
      "สตรีทฟู้ด กรุงเทพ ร้านเด็ด",
      "สตรีทฟู้ด กรุงเทพ ร้านเด็ด",
      "วัดสวย กรุงเทพ ไหว้พระ",
      "วัดสวย กรุงเทพ ไหว้พระ",
    ])
    expect(r.enqueued.map((e) => (e.payload as { sourceId: string }).sourceId)).toEqual([
      "youtube.search",
      "pantip.forum",
      "youtube.search",
      "pantip.forum",
    ])
    expect(r.enqueued.every((e) => e.type === "harvest.run" && e.ownerId === "u1")).toBe(true)
  })

  it("lets the traveller's interests override the character's own", async () => {
    const r = await run(persona(), { interests: ["rooftop bars"], sources: ["youtube.search"] })
    expect(r.queries).toEqual(["รูฟท็อปบาร์ กรุงเทพ"])
  })

  it("asks the tourist control in English, which is the point of it", async () => {
    const r = await run(persona({ locale: "en-AU", country: "au" }), {
      sources: ["youtube.search"],
    })
    expect(r.queries).toEqual(["street food Bangkok", "temples Bangkok"])
  })

  it("translates a free-text interest with the model, and skips it without one", async () => {
    const llm = {
      complete: async () => ({ ok: true, value: { value: { query: "ร้านแผ่นเสียง กรุงเทพ" } } }),
    } as unknown as LlmClient
    const translated = await run(
      persona(),
      {
        interests: ["vinyl records"],
        sources: ["youtube.search"],
      },
      llm,
    )
    expect(translated.queries).toEqual(["ร้านแผ่นเสียง กรุงเทพ"])

    const skipped = await run(persona(), {
      interests: ["vinyl records"],
      sources: ["youtube.search"],
    })
    expect(skipped.queries).toEqual([])
    expect(skipped.notes.join("\n")).toContain('no model to translate "vinyl records"')
  })

  it("is one outing per day however many times it is pressed, and bounded", async () => {
    const many = persona({
      traits: {
        interests: ["food", "coffee", "temples", "markets", "massage", "parks"],
        sources: ["youtube.search", "pantip.forum", "maps.search"],
      },
    })
    const r = await run(many, {})
    expect(r.enqueued).toHaveLength(MAX_HARVESTS)
    await r.again()
    expect(r.notes.at(-1)).toContain("0 search(es) queued")
  })

  it("sends nobody out as a banned character", async () => {
    const r = await run(persona({ health: "banned" }), {})
    expect(r.enqueued).toHaveLength(0)
  })
})
