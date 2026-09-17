import type { MeterId } from "@samsara/core"
import { BudgetGuard, MemoryCounterStore } from "@samsara/kernel"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { compare } from "./compare.js"
import type { LlmConfig } from "./config.js"
import { fakeChatClient } from "./fake.js"
import type { ChatRequest, ChatResponse } from "./ports.js"
import { definePrompt } from "./prompt.js"

const schema = z.object({ entities: z.array(z.string()) })
const prompt = definePrompt({
  id: "engine/test.extract",
  version: "2",
  template: "read {{body}}",
})

const CEILINGS: Record<MeterId, number> = {
  "solari.minutes": 4_000,
  "llm.input.tokens": 10_000_000,
  "llm.output.tokens": 2_000_000,
  "geocode.calls": 800,
}

const config: LlmConfig = {
  apiKey: "test-key",
  baseUrl: "https://example.invalid/v1",
  models: {},
  format: "schema",
}

const cases = [
  { id: "a", vars: { body: "one" } },
  { id: "b", vars: { body: "two" } },
  { id: "c", vars: { body: "three" } },
]

/** Answers per model, so a scripted list does not have to predict the shuffle. */
const byModel = (
  answers: Record<string, (req: ChatRequest, seen: number) => Partial<ChatResponse> | string>,
) => {
  const seen = new Map<string, number>()
  return fakeChatClient(
    Array.from({ length: 64 }, () => (req: ChatRequest) => {
      const count = seen.get(req.model) ?? 0
      seen.set(req.model, count + 1)
      const answer = answers[req.model]
      if (!answer) throw new Error(`no scripted answer for ${req.model}`)
      return answer(req, count)
    }),
  )
}

const guard = () => new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS })
const valid = JSON.stringify({ entities: ["x"] })

describe("compare", () => {
  it("ranks a reliable model above a cheaper one that fails its schema", async () => {
    const chat = byModel({
      "vendor/solid": () => ({ text: valid, usage: { inputTokens: 100, outputTokens: 20 } }),
      // Never returns the shape. Three attempts per case, all wasted.
      "vendor/cheap": () => ({ text: "{}", usage: { inputTokens: 100, outputTokens: 20 } }),
    })

    const report = await compare({
      chat,
      config,
      budget: guard(),
      sleep: async () => {},
      task: "extract",
      prompt,
      schema,
      cases,
      seed: 7,
      candidates: [
        {
          model: "vendor/cheap",
          rate: { inputPerMTok: 0.05, outputPerMTok: 0.1, readOn: "2026-09-17" },
        },
        {
          model: "vendor/solid",
          rate: { inputPerMTok: 1, outputPerMTok: 3, readOn: "2026-09-17" },
        },
      ],
    })

    expect(report.models.map((m) => m.model)).toEqual(["vendor/solid", "vendor/cheap"])
    expect(report.models[0]?.validRate).toBe(1)
    expect(report.models[1]?.validRate).toBe(0)
  })

  it("counts the retries, so an unreliable model is not reported as cheap", async () => {
    const chat = byModel({
      "vendor/cheap": () => ({ text: "{}", usage: { inputTokens: 100, outputTokens: 20 } }),
    })

    const report = await compare({
      chat,
      config,
      budget: guard(),
      sleep: async () => {},
      task: "extract",
      prompt,
      schema,
      cases,
      candidates: [
        {
          model: "vendor/cheap",
          rate: { inputPerMTok: 1, outputPerMTok: 1, readOn: "2026-09-17" },
        },
      ],
    })

    const only = report.models[0]
    // Three cases, three attempts each. A report built from returned values
    // rather than from the log would have seen none of these.
    expect(only?.cases).toBe(3)
    expect(only?.attempts).toBe(9)
    expect(only?.inputTokens).toBe(900)
    expect(only?.usd).toBeCloseTo((900 + 180) / 1_000_000, 10)
    expect(only?.failures).toEqual([{ kind: "upstream", count: 3 }])
  })

  it("reports tokens without dollars when no rate was given", async () => {
    const chat = byModel({ "vendor/solid": () => valid })
    const report = await compare({
      chat,
      config,
      budget: guard(),
      sleep: async () => {},
      task: "extract",
      prompt,
      schema,
      cases,
      candidates: [{ model: "vendor/solid" }],
    })

    expect(report.models[0]?.usd).toBeUndefined()
    expect(report.models[0]?.inputTokens).toBeGreaterThan(0)
  })

  it("averages a grade only over the cases that carried one", async () => {
    const chat = byModel({ "vendor/solid": () => valid })
    const report = await compare({
      chat,
      config,
      budget: guard(),
      sleep: async () => {},
      task: "extract",
      prompt,
      schema,
      candidates: [{ model: "vendor/solid" }],
      cases: [
        { id: "a", vars: { body: "one" }, grade: () => 1 },
        { id: "b", vars: { body: "two" }, grade: () => 0 },
        { id: "c", vars: { body: "three" } },
      ],
    })

    expect(report.models[0]?.grade).toEqual({ mean: 0.5, graded: 2 })
  })

  it("records the seed and the prompt's fingerprint, so a run can be repeated", async () => {
    const chat = byModel({ "vendor/solid": () => valid })
    const report = await compare({
      chat,
      config,
      budget: guard(),
      sleep: async () => {},
      task: "extract",
      prompt,
      schema,
      cases,
      seed: 20260917,
      candidates: [{ model: "vendor/solid" }],
    })

    expect(report.seed).toBe(20260917)
    expect(report.promptVersion).toBe("2")
    expect(report.promptFingerprint).toBe(prompt.fingerprint)
  })

  it("shuffles, and the same seed shuffles the same way", async () => {
    const order = async (seed: number): Promise<string[]> => {
      const seenBodies: string[] = []
      const chat = fakeChatClient(
        Array.from({ length: 16 }, () => (req: ChatRequest) => {
          seenBodies.push(req.user)
          return valid
        }),
      )
      await compare({
        chat,
        config,
        budget: guard(),
        task: "extract",
        prompt,
        schema,
        cases,
        seed,
        candidates: [{ model: "vendor/solid" }],
      })
      return seenBodies
    }

    expect(await order(1)).toEqual(await order(1))
    expect(await order(1)).not.toEqual(["read one", "read two", "read three"])
  })
})
