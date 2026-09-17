import type { MeterId } from "@samsara/core"
import { BudgetGuard, type KernelEvent, MemoryCounterStore, MemoryLogger } from "@samsara/kernel"
import { beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { LlmClient } from "./complete.js"
import type { LlmConfig } from "./config.js"
import { type FakeReply, fakeChatClient } from "./fake.js"
import { definePrompt } from "./prompt.js"

const schema = z.object({ entities: z.array(z.object({ name: z.string() })) })
const prompt = definePrompt({
  id: "engine/test.extract",
  version: "1",
  system: "return json",
  template: "read this: {{body}}",
})
const vars = { body: "some harvested text" }

const CEILINGS: Record<MeterId, number> = {
  "solari.minutes": 4_000,
  "llm.input.tokens": 1_000_000,
  "llm.output.tokens": 200_000,
  "geocode.calls": 800,
}

const config = (models: LlmConfig["models"] = { extract: "vendor/cheap" }): LlmConfig => ({
  apiKey: "test-key",
  baseUrl: "https://example.invalid/v1",
  models,
  format: "schema",
})

let store: MemoryCounterStore
let budget: BudgetGuard
let logger: MemoryLogger

beforeEach(() => {
  store = new MemoryCounterStore()
  budget = new BudgetGuard({ store, ceilings: CEILINGS })
  logger = new MemoryLogger()
})

const client = (replies: readonly FakeReply[], models?: LlmConfig["models"]) => {
  const chat = fakeChatClient(replies)
  return {
    chat,
    llm: new LlmClient({
      chat,
      config: config(models),
      budget,
      logger,
      // No real waiting, and no jitter, so a retry test takes microseconds.
      sleep: async () => {},
      random: () => 0,
    }),
  }
}

const calls = (): Extract<KernelEvent, { event: "llm.call" }>[] =>
  logger.events.filter(
    (event): event is Extract<KernelEvent, { event: "llm.call" }> => event.event === "llm.call",
  )

const spent = async (meter: MeterId): Promise<number> => {
  const key = {
    meter,
    window: "global.day" as const,
    windowKey: new Date().toISOString().slice(0, 10),
  }
  const totals = await store.read([key])
  return totals.get(`${meter}|global.day|${key.windowKey}`) ?? 0
}

const good = JSON.stringify({ entities: [{ name: "a" }] })

describe("complete", () => {
  it("returns the validated value and stamps the prompt's identity on it", async () => {
    const { llm } = client([good])
    const result = await llm.complete(prompt, schema, { task: "extract", vars })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.value).toEqual({ entities: [{ name: "a" }] })
    expect(result.value.promptId).toBe("engine/test.extract")
    expect(result.value.promptVersion).toBe("1")
    expect(result.value.promptFingerprint).toBe(prompt.fingerprint)
    expect(result.value.attempts).toBe(1)
  })

  it("sends the rendered prompt and the schema on the wire", async () => {
    const { chat, llm } = client([good])
    await llm.complete(prompt, schema, { task: "extract", vars })

    const sent = chat.requests[0]
    expect(sent?.model).toBe("vendor/cheap")
    expect(sent?.system).toBe("return json")
    expect(sent?.user).toBe("read this: some harvested text")
    expect(sent?.format.kind).toBe("schema")
  })

  it("records what the provider says it charged, on both meters", async () => {
    const { llm } = client([{ text: good, usage: { inputTokens: 1_234, outputTokens: 56 } }])
    await llm.complete(prompt, schema, { task: "extract", vars })

    expect(await spent("llm.input.tokens")).toBe(1_234)
    expect(await spent("llm.output.tokens")).toBe(56)
  })

  it("meters every attempt, not just the one that worked", async () => {
    // The finding this whole design turns on. ADR-0012 makes a schema-invalid
    // answer retryable, so a cheap model's expensive failure mode is three full
    // round trips. Crediting it with the cost of the last one would rank the
    // least reliable model as the cheapest.
    const { llm } = client([
      { text: '{"entities":"not an array"}', usage: { inputTokens: 100, outputTokens: 10 } },
      { text: "no json here at all", usage: { inputTokens: 100, outputTokens: 10 } },
      { text: good, usage: { inputTokens: 100, outputTokens: 10 } },
    ])

    const result = await llm.complete(prompt, schema, { task: "extract", vars })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.attempts).toBe(3)

    expect(await spent("llm.input.tokens")).toBe(300)
    expect(await spent("llm.output.tokens")).toBe(30)
    expect(calls()).toHaveLength(3)
    expect(calls().map((call) => call.outcome)).toEqual(["invalid", "invalid", "ok"])
  })

  it("treats a schema failure as the provider's, so it retries", async () => {
    const { chat, llm } = client([
      '{"entities":[{"name":1}]}',
      '{"entities":[{"name":2}]}',
      '{"entities":[{"name":3}]}',
    ])
    const result = await llm.complete(prompt, schema, { task: "extract", vars })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("upstream")
    expect(chat.calls).toBe(3)
  })

  it("keeps harvested values out of the failure it reports", async () => {
    // ADR-0014: the repository is public, so the Actions log is public. A Zod
    // issue's `message` quotes the offending value, and the offending value here
    // is harvested text. The summary carries paths and codes and nothing else.
    const harvested = "ก๋วยเตี๋ยว 39"
    const numeric = z.object({ entities: z.array(z.object({ name: z.number() })) })
    const { llm } = client([JSON.stringify({ entities: [{ name: harvested }] })], {
      extract: "vendor/cheap",
    })

    const result = await llm.complete(prompt, numeric, { task: "extract", vars, attempts: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.cause).toMatch(/entities\.0\.name/)
    expect(JSON.stringify(result.error)).not.toContain(harvested)
  })

  it("refuses a truncated answer without retrying it", async () => {
    // The identical request is cut in the identical position. Retrying spends
    // three times the tokens to fail three times.
    const { chat, llm } = client([{ text: '{"entities":[', finishReason: "length" }])
    const result = await llm.complete(prompt, schema, { task: "extract", vars })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("config")
    expect(result.error.message).toMatch(/maxOutputTokens/)
    expect(chat.calls).toBe(1)
  })

  it("classifies a provider outage as theirs and retries it", async () => {
    const outage = Object.assign(new Error("service unavailable"), { status: 503 })
    const { chat, llm } = client([{ throws: outage }, { throws: outage }, good])
    const result = await llm.complete(prompt, schema, { task: "extract", vars })

    expect(result.ok).toBe(true)
    expect(chat.calls).toBe(3)
  })

  it("does not retry a request the provider rejected", async () => {
    const rejected = Object.assign(new Error("unsupported response_format"), { status: 400 })
    const { chat, llm } = client([{ throws: rejected }])
    const result = await llm.complete(prompt, schema, { task: "extract", vars })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("config")
    expect(chat.calls).toBe(1)
  })

  it("marks an unmetered call in the log rather than recording zero", async () => {
    const { llm } = client([
      { text: good, metered: false, usage: { inputTokens: 40, outputTokens: 9 } },
    ])
    await llm.complete(prompt, schema, { task: "extract", vars })

    expect(calls()[0]?.metered).toBe(false)
    // Still recorded. A missing receipt is not a free call.
    expect(await spent("llm.input.tokens")).toBe(40)
  })

  it("logs the identity of the call and none of its content", async () => {
    const { llm } = client([good])
    await llm.complete(prompt, schema, { task: "extract", vars, domainId: "d1" })

    const event = calls()[0]
    expect(event).toMatchObject({
      task: "extract",
      model: "vendor/cheap",
      promptId: "engine/test.extract",
      promptVersion: "1",
      domainId: "d1",
      outcome: "ok",
      kind: null,
    })
    const serialised = JSON.stringify(event)
    expect(serialised).not.toContain("harvested text")
    expect(serialised).not.toContain("entities")
  })
})

describe("routing", () => {
  it("refuses a task with no model configured, and names the variable", async () => {
    const { chat, llm } = client([good], {})
    const result = await llm.complete(prompt, schema, { task: "extract", vars })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("config")
      expect(result.error.message).toMatch(/LLM_MODEL_EXTRACT/)
    }
    expect(chat.calls).toBe(0)
  })

  it("refuses a free route by default, because the default is the careful one", async () => {
    const { chat, llm } = client([good], { extract: "vendor/cheap:free" })
    const result = await llm.complete(prompt, schema, { task: "extract", vars })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/free route/)
    expect(chat.calls).toBe(0)
  })

  it("allows a free route when the caller says the content is public", async () => {
    const { chat, llm } = client([good], { extract: "vendor/cheap:free" })
    const result = await llm.complete(prompt, schema, {
      task: "extract",
      vars,
      sensitivity: "public",
    })

    expect(result.ok).toBe(true)
    expect(chat.calls).toBe(1)
  })

  it("refuses a prompt it cannot render, before spending anything", async () => {
    const { chat, llm } = client([good])
    const result = await llm.complete(prompt, schema, { task: "extract", vars: { wrong: "x" } })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("config")
    expect(chat.calls).toBe(0)
    expect(await spent("llm.input.tokens")).toBe(0)
  })
})

describe("the budget guard", () => {
  it("refuses before the call when the input meter is exhausted", async () => {
    await budget.record("llm.input.tokens", CEILINGS["llm.input.tokens"], {})
    const { chat, llm } = client([good])
    const result = await llm.complete(prompt, schema, { task: "extract", vars })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("budget")
      expect(result.error.meter).toBe("llm.input.tokens")
    }
    expect(chat.calls).toBe(0)
  })

  it("reserves the output cap up front, not after the answer arrives", async () => {
    await budget.record("llm.output.tokens", CEILINGS["llm.output.tokens"] - 10, {})
    const { chat, llm } = client([good])
    const result = await llm.complete(prompt, schema, {
      task: "extract",
      vars,
      maxOutputTokens: 1_000,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.meter).toBe("llm.output.tokens")
    expect(chat.calls).toBe(0)
  })

  it("refuses a retry once the earlier attempts have exhausted the meter", async () => {
    // The reason the check sits inside the attempt rather than above the loop.
    budget = new BudgetGuard({
      store,
      ceilings: { ...CEILINGS, "llm.input.tokens": 150 },
    })
    // The first attempt lands the meter exactly on its ceiling, which `check`
    // treats as exhausted in its own right — the clause `budget.ts` keeps
    // separate precisely so a caller asking for a small amount at 100% is not
    // waved through forever.
    const { chat, llm } = client([
      { text: "not json", usage: { inputTokens: 150, outputTokens: 5 } },
      { text: good, usage: { inputTokens: 150, outputTokens: 5 } },
    ])
    const result = await llm.complete(prompt, schema, { task: "extract", vars })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("budget")
    // One call made, one refused before it could be made.
    expect(chat.calls).toBe(1)
  })
})
