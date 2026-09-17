import type { MeterId } from "@samsara/core"
import { BudgetGuard, MemoryCounterStore } from "@samsara/kernel"
import { fakeChatClient, LlmClient, type LlmConfig } from "@samsara/llm"
import { ENVELOPE_INSTRUCTIONS, extract, ITEMS_VARIABLE, MemoryMentionSink } from "@samsara/refine"
import { describe, expect, it } from "vitest"
import { placeMention } from "./mention.js"
import { travelPack } from "./pack.js"
import { placeExtractPrompt } from "./prompt.js"

describe("the prompt", () => {
  it("declares the one variable the engine fills, and no other", () => {
    // `render` throws on an unused variable as well as a missing one, so a prompt
    // that declared a second would fail as `config` on every call — after the
    // routing succeeded and before anything useful happened.
    expect(placeExtractPrompt.variables).toEqual([ITEMS_VARIABLE])
  })

  it("carries the engine's envelope instructions verbatim", () => {
    expect(placeExtractPrompt.system).toContain(ENVELOPE_INSTRUCTIONS)
  })

  it("is versioned with the pack, because the pack version is what re-extraction keys on", () => {
    expect(travelPack.version).toBe(placeExtractPrompt.version)
  })

  it("has a fingerprint, so two rows claiming one version can be told apart", () => {
    expect(placeExtractPrompt.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("the mention schema", () => {
  const valid = {
    localName: "ร้านลุงไสว",
    romanName: null,
    dish: "ก๋วยเตี๋ยวเรือ",
    category: "food",
    priceHint: "39 บาท",
    quote: "อร่อยมาก ราคาไม่แพง",
    sentiment: "positive",
    creatorReads: "local",
  }

  it("accepts a Thai mention with no romanisation", () => {
    expect(placeMention.safeParse(valid).success).toBe(true)
  })

  it("requires the native name, which is the one that resolves", () => {
    expect(placeMention.safeParse({ ...valid, localName: "" }).success).toBe(false)
  })

  it("rejects a quote long enough to be a paraphrase", () => {
    expect(placeMention.safeParse({ ...valid, quote: "ก".repeat(201) }).success).toBe(false)
  })

  it("allows an unknown author, because a forced guess is worse than a gap", () => {
    expect(placeMention.safeParse({ ...valid, creatorReads: "unknown" }).success).toBe(true)
  })

  it("keeps a vague price as the source wrote it", () => {
    expect(placeMention.safeParse({ ...valid, priceHint: "ไม่ถึงร้อย" }).success).toBe(true)
  })
})

describe("the pack against the engine", () => {
  // Not a golden-set test — no model answers here. It asserts the thing a golden
  // set cannot, which is that this pack satisfies the generic stage's contract
  // end to end: prompt renders, envelope validates, mention parses, row lands.
  const CEILINGS: Record<MeterId, number> = {
    "solari.minutes": 4_000,
    "llm.input.tokens": 1_000_000,
    "llm.output.tokens": 200_000,
    "geocode.calls": 800,
  }
  const config: LlmConfig = {
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    models: { extract: "vendor/cheap" },
    format: "schema",
  }

  it("turns one Thai item into one Mention row", async () => {
    const chat = fakeChatClient(() =>
      JSON.stringify({
        items: [
          {
            ref: "1",
            mentions: [
              {
                confidence: 0.8,
                mention: {
                  localName: "ร้านลุงไสว",
                  romanName: null,
                  dish: "ก๋วยเตี๋ยวเรือ",
                  category: "food",
                  priceHint: "39 บาท",
                  quote: "อร่อยมาก",
                  sentiment: "positive",
                  creatorReads: "local",
                },
              },
            ],
          },
        ],
      }),
    )
    const sink = new MemoryMentionSink()

    const report = await extract({
      pack: travelPack,
      llm: new LlmClient({
        chat,
        config,
        budget: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS }),
        sleep: async () => {},
      }),
      sink,
      items: [
        {
          id: "r1",
          sourceId: "pantip.topic",
          url: "https://example.invalid/topic/1",
          title: "ร้านลุงไสว",
          text: "ไปกินมาแล้ว อร่อยมาก 39 บาท",
          languageGuess: "th",
        },
      ],
      newId: () => "m1",
    })

    expect(report.mentions).toBe(1)
    expect(report.invalid).toBe(0)
    expect(sink.rows[0]?.domainId).toBe("travel")
    expect(sink.rows[0]?.packVersion).toBe(travelPack.version)
    expect(sink.rows[0]?.payload).toMatchObject({ localName: "ร้านลุงไสว", category: "food" })
  })

  it("groups by language, so one call is one language", () => {
    expect(travelPack.extract.batchBy({ languageGuess: "th" } as never)).toBe("th")
    expect(travelPack.extract.batchBy({ languageGuess: null } as never)).toBe("unknown")
  })
})
