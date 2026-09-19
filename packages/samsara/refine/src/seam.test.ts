import type { MeterId } from "@samsara/core"
import { BudgetGuard, MemoryCounterStore } from "@samsara/kernel"
import { definePrompt, fakeChatClient, LlmClient, type LlmConfig } from "@samsara/llm"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { creatorPack } from "./__fixtures__/creator.js"
import { ENVELOPE_INSTRUCTIONS, extract, ITEMS_VARIABLE } from "./extract.js"
import { MemoryMentionSink } from "./memory.js"
import { type DomainPack, PackRegistry } from "./pack.js"
import type { ExtractItem } from "./ports.js"

/**
 * P2.8's seam proof, or the half of it that can exist yet.
 *
 * The acceptance ADR-0009 actually asks for is a number, not a feeling: running a
 * second, non-travel pack through the pipeline must require **zero edits under
 * `packages/samsara/` other than adding the fixture**. Anything above zero means
 * the contract is shaped around the first vertical and should be revised now,
 * while there is one consumer, rather than in Phase 3 when there are three.
 *
 * Only the extract stage exists, so only extract is proven here. This file is
 * written to grow: P2.3, P2.4 and P2.5 each add a stage, and each should add its
 * assertions below rather than repeat this setup. That is deliberate — P2.8 as a
 * one-time run would prove the seam on the day it was run and never again, which
 * is the property a convention has and a check does not.
 *
 * Result for the extract stage: **zero edits.** The fixture compiled and ran
 * against the engine as it stood. See STATUS for the one bug the *first* pack
 * found, which is the counter-example that makes this result worth stating.
 */

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

const llm = (chat: ReturnType<typeof fakeChatClient>) =>
  new LlmClient({
    chat,
    config,
    budget: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS }),
    sleep: async () => {},
  })

/** Refs are the engine's to mint, so the fake answers whatever it was handed. */
const refsIn = (user: string) => [...user.matchAll(/ref:\s*(\S+)/g)].map((m) => m[1] as string)

const creatorAnswer = (user: string) =>
  JSON.stringify({
    items: refsIn(user).map((ref) => ({
      ref,
      mentions: [
        {
          confidence: 0.8,
          mention: {
            handle: "@chi_hai_food",
            platform: "youtube",
            channelUrl: "https://example.invalid/c/chi-hai",
            postsPerWeek: 3,
            quote: "kênh này review rất thật",
          },
        },
      ],
    })),
  })

/** Two sources, so a `batchBy` on `sourceId` has something to separate. */
function corpus(): ExtractItem[] {
  return [
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `a${i}`,
      sourceId: "fake.search",
      url: `https://example.invalid/a/${i}`,
      title: `bài ${i}`,
      text: "Xem kênh này đi, review rất thật.",
      languageGuess: "vi",
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      id: `b${i}`,
      sourceId: "fake.forum",
      url: `https://example.invalid/b/${i}`,
      title: `chủ đề ${i}`,
      text: "Mình theo dõi kênh đó lâu rồi.",
      languageGuess: "vi",
    })),
  ]
}

describe("a second pack, over the same engine", () => {
  it("runs the extract stage with no engine change at all", async () => {
    const chat = fakeChatClient((req) => creatorAnswer(req.user))
    const sink = new MemoryMentionSink()

    const report = await extract({
      pack: creatorPack,
      llm: llm(chat),
      items: corpus(),
      sink,
      scope: { purpose: "refine" },
    })

    expect(report.invalid).toBe(0)
    expect(report.mentions).toBe(5)
    expect(sink.rows.every((row) => row.domainId === "creator")).toBe(true)
    // A numeric field and an enum survived the round trip. Travel's mentions are
    // all strings and nullable strings, so "the payload is strings" was exactly
    // the kind of assumption one pack could not have caught.
    expect(sink.rows[0]?.payload).toMatchObject({ platform: "youtube", postsPerWeek: 3 })
  })

  it("groups by whatever the pack said, which here is the source and not the language", async () => {
    // The sharp one. Section 8 motivates batching with "do not ask a model to read
    // Thai, English and Vietnamese in one breath", and a reader could conclude the
    // engine groups by language. It groups by `batchBy`. Every item here shares a
    // language and differs by source, so a language-grouping engine would send one
    // call and this pack would be silently mis-batched forever.
    const chat = fakeChatClient((req) => creatorAnswer(req.user))

    await extract({
      pack: creatorPack,
      llm: llm(chat),
      items: corpus(),
      sink: new MemoryMentionSink(),
      scope: { purpose: "refine" },
    })

    // Two calls is itself the proof: all five items share a language and the batch
    // size is 5, so an engine grouping by language would have sent exactly one.
    expect(chat.calls).toBe(2)

    // And the split is along the source, not merely into two of something. Refs
    // are engine-minted indices and carry no source, so this reads the `source:`
    // line `renderItem` writes into each item — which is also the reminder that
    // the item's URL is never sent to a provider at all.
    const from = (needle: string) =>
      chat.requests.filter((req) => req.user.includes(`source: ${needle}`))
    expect(from("fake.search")).toHaveLength(1)
    expect(from("fake.forum")).toHaveLength(1)
    expect(
      chat.requests.filter(
        (req) =>
          req.user.includes("source: fake.search") && req.user.includes("source: fake.forum"),
      ),
    ).toHaveLength(0)
    // Nothing rendered carries a URL, which is why the check above cannot use one.
    expect(chat.requests.every((req) => !req.user.includes("example.invalid"))).toBe(true)
  })

  it("keeps its own skip key, so two packs can read one corpus without hiding it from each other", async () => {
    // The property that only a second pack can demonstrate. `extractedIds` is
    // keyed on `(domainId, packVersion, rawItemId)`, so a corpus already read by
    // travel must still be unread as far as creator is concerned. Had the skip
    // been keyed on the item alone, the second vertical would have silently
    // extracted nothing and looked like a model that found no mentions.
    const sink = new MemoryMentionSink()
    const items = corpus()

    const first = await extract({
      pack: creatorPack,
      llm: llm(fakeChatClient((req) => creatorAnswer(req.user))),
      items,
      sink,
      scope: { purpose: "refine" },
    })
    expect(first.skipped).toBe(0)

    // Same items, same sink, a pack that differs only in id.
    const other: DomainPack<z.infer<typeof creatorPack.extract.mentionSchema>> = {
      ...creatorPack,
      id: "creator-two",
    }
    const second = await extract({
      pack: other,
      llm: llm(fakeChatClient((req) => creatorAnswer(req.user))),
      items,
      sink,
      scope: { purpose: "refine" },
    })

    expect(second.skipped).toBe(0)
    expect(second.mentions).toBe(5)

    // And the same pack twice *does* skip, which is what makes the above a
    // statement about the domain rather than about the skip being broken.
    const third = await extract({
      pack: creatorPack,
      llm: llm(fakeChatClient(() => "{}")),
      items,
      sink,
      scope: { purpose: "refine" },
    })
    expect(third.skipped).toBe(5)
    expect(third.sent).toBe(0)
  })
})

describe("the registry, holding two mention types at once", () => {
  it("takes packs whose mentions have nothing in common", () => {
    // `register` took a `DomainPack<never>` until the first real pack was
    // registered and could not be. This is the assertion that would have caught
    // it on the day it was written: two packs, two unrelated mention types, one
    // registry, no cast at either call site.
    const other: DomainPack<{ isbn: string }> = {
      id: "library",
      version: "1",
      extract: {
        mentionSchema: z.object({ isbn: z.string().min(1) }),
        prompt: definePrompt({
          id: "library/extract.mentions",
          version: "1",
          system: ENVELOPE_INSTRUCTIONS,
          template: `List the books.\n\n{{${ITEMS_VARIABLE}}}`,
        }),
        batchBy: () => "all",
      },
    }

    const registry = new PackRegistry()
    registry.register(creatorPack)
    registry.register(other)

    expect(registry.size).toBe(2)
    expect(registry.require("creator").version).toBe("1")
    expect(registry.require("library").extract.batchBy({} as ExtractItem)).toBe("all")
  })
})
