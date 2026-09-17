import type { MeterId } from "@samsara/core"
import { BudgetGuard, MemoryCounterStore } from "@samsara/kernel"
import {
  definePrompt,
  type FakeReply,
  type FakeResponder,
  fakeChatClient,
  LlmClient,
  type LlmConfig,
} from "@samsara/llm"
import { beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { ENVELOPE_INSTRUCTIONS, extract } from "./extract.js"
import { MemoryMentionSink } from "./memory.js"
import type { DomainPack } from "./pack.js"
import type { ExtractItem } from "./ports.js"

const mentionSchema = z.object({ name: z.string().min(1), kind: z.string().min(1) })
type Mention = z.infer<typeof mentionSchema>

const prompt = definePrompt({
  id: "test/extract",
  version: "1",
  system: `find things\n\n${ENVELOPE_INSTRUCTIONS}`,
  template: "read these:\n\n{{items}}",
})

const pack = (over: Partial<DomainPack<Mention>["extract"]> = {}): DomainPack<Mention> => ({
  id: "test",
  version: "1",
  extract: {
    mentionSchema,
    prompt,
    batchBy: (item) => item.languageGuess ?? "?",
    ...over,
  },
})

const item = (id: string, over: Partial<ExtractItem> = {}): ExtractItem => ({
  id,
  sourceId: "forum.topic",
  url: `https://example.invalid/${id}`,
  title: `title ${id}`,
  text: `body ${id}`,
  languageGuess: "th",
  ...over,
})

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

let sink: MemoryMentionSink
let ids: number

beforeEach(() => {
  sink = new MemoryMentionSink()
  ids = 0
})

const newId = () => `m${++ids}`

const harness = (script: readonly FakeReply[] | FakeResponder) => {
  const chat = fakeChatClient(script)
  return {
    chat,
    llm: new LlmClient({
      chat,
      config,
      budget: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS }),
      sleep: async () => {},
      random: () => 0,
    }),
  }
}

/** An envelope answering `ref` with one mention per name. */
const answer = (entries: Record<string, readonly (Mention | unknown)[]>): string =>
  JSON.stringify({
    items: Object.entries(entries).map(([ref, mentions]) => ({
      ref,
      mentions: mentions.map((mention) => ({ confidence: 0.9, mention })),
    })),
  })

describe("extract", () => {
  it("writes one row per mention, with the engine's columns filled in", async () => {
    const { llm } = harness([
      answer({
        "1": [
          { name: "a", kind: "x" },
          { name: "b", kind: "y" },
        ],
      }),
    ])

    const report = await extract({ pack: pack(), llm, sink, items: [item("r1")], newId })

    expect(report.mentions).toBe(2)
    expect(sink.rows).toHaveLength(2)
    expect(sink.rows[0]).toEqual({
      id: "m1",
      rawItemId: "r1",
      domainId: "test",
      packVersion: "1",
      payload: { name: "a", kind: "x" },
      entityId: null,
      resolution: "pending",
      confidence: 0.9,
    })
  })

  it("renders every item into the prompt's items variable, with its ref", async () => {
    const { chat, llm } = harness([answer({ "1": [], "2": [] })])

    await extract({ pack: pack(), llm, sink, items: [item("r1"), item("r2")], newId })

    const user = chat.requests[0]?.user ?? ""
    expect(user).toContain("read these:")
    // The ref is on its own labelled line. A real model read the packed one-line
    // header as a single field and echoed the source id as the ref; see renderItem.
    expect(user).toContain("--- ref: 1\nsource: forum.topic (th)")
    expect(user).toContain("--- ref: 2\nsource: forum.topic (th)")
    expect(user).toContain("body r1")
  })

  it("attributes each answer to the item whose ref it carries", async () => {
    const { llm } = harness([
      answer({ "2": [{ name: "second", kind: "x" }], "1": [{ name: "first", kind: "x" }] }),
    ])

    await extract({ pack: pack(), llm, sink, items: [item("r1"), item("r2")], newId })

    expect(sink.byItem("r1")[0]?.payload).toEqual({ name: "first", kind: "x" })
    expect(sink.byItem("r2")[0]?.payload).toEqual({ name: "second", kind: "x" })
  })

  it('accepts a numeric ref, because a model handed "1" will sometimes return 1', async () => {
    const { llm } = harness([
      JSON.stringify({
        items: [{ ref: 1, mentions: [{ confidence: 0.5, mention: { name: "a", kind: "x" } }] }],
      }),
    ])

    const report = await extract({ pack: pack(), llm, sink, items: [item("r1")], newId })
    expect(report.mentions).toBe(1)
    expect(sink.byItem("r1")).toHaveLength(1)
  })

  it("drops an answer filed against a ref nobody asked for, and counts it", async () => {
    // The failure that would otherwise be silent: a mention attributed to the
    // wrong item is worse than a mention lost, because nothing downstream can
    // tell. `mentions.raw_item_id` is NOT NULL and this is what defends it.
    const { llm } = harness([
      answer({ "1": [{ name: "real", kind: "x" }], "9": [{ name: "invented", kind: "x" }] }),
    ])

    const report = await extract({ pack: pack(), llm, sink, items: [item("r1")], newId })

    expect(report.unknownRefs).toBe(1)
    expect(report.mentions).toBe(1)
    expect(sink.rows.every((row) => row.rawItemId === "r1")).toBe(true)
  })

  it("counts the items the model never answered for", async () => {
    const { llm } = harness([answer({ "1": [{ name: "a", kind: "x" }] })])

    const report = await extract({
      pack: pack(),
      llm,
      sink,
      items: [item("r1"), item("r2"), item("r3")],
      newId,
    })

    expect(report.sent).toBe(3)
    expect(report.answered).toBe(1)
    expect(sink.byItem("r2")).toHaveLength(0)
  })

  it("counts a ref answered twice rather than silently keeping both", async () => {
    const { llm } = harness([
      JSON.stringify({
        items: [
          { ref: "1", mentions: [{ confidence: 0.9, mention: { name: "a", kind: "x" } }] },
          { ref: "1", mentions: [{ confidence: 0.9, mention: { name: "b", kind: "x" } }] },
        ],
      }),
    ])

    const report = await extract({ pack: pack(), llm, sink, items: [item("r1")], newId })

    expect(report.duplicateRefs).toBe(1)
    expect(report.answered).toBe(1)
    expect(report.mentions).toBe(2)
  })

  it("lets one malformed mention cost one mention, not the batch", async () => {
    // The whole reason the envelope is validated loosely and each mention
    // strictly. Validating the batch as a unit would discard the two good
    // answers *and* retry the call, re-sending every item's text.
    const { chat, llm } = harness([
      answer({
        "1": [{ name: "good", kind: "x" }, { name: 42 }],
        "2": [{ name: "also good", kind: "y" }],
      }),
    ])

    const report = await extract({
      pack: pack(),
      llm,
      sink,
      items: [item("r1"), item("r2")],
      newId,
    })

    expect(report.invalid).toBe(1)
    expect(report.mentions).toBe(2)
    expect(chat.calls).toBe(1)
  })
})

describe("the split", () => {
  it("halves a failed batch instead of retrying it whole", async () => {
    // P2.1 meters every attempt, so retrying a batch of four re-sends four
    // items' text three times to fail. Splitting isolates the poison and
    // extracts everything around it.
    const items = [item("r1"), item("r2"), item("r3"), item("r4")]
    const sizes: number[] = []
    const { chat, llm } = harness((req) => {
      const n = (req.user.match(/^--- /gm) ?? []).length
      sizes.push(n)
      if (n > 1) return "not json at all"
      const ref = req.user.match(/^--- (\d+)/m)?.[1] ?? "1"
      return answer({ [ref]: [{ name: `from ${n}`, kind: "x" }] })
    })

    const report = await extract({
      pack: pack({ batchSize: 4 }),
      llm,
      sink,
      items,
      newId,
    })

    // 4, then 2 + 2, then 1 + 1 + 1 + 1.
    expect(sizes).toEqual([4, 2, 1, 1, 2, 1, 1])
    expect(report.batches).toBe(1)
    expect(report.calls).toBe(7)
    // The point of the assertion: seven calls, not the nineteen that three
    // attempts per multi-item batch would have cost.
    expect(chat.calls).toBe(7)
    expect(report.mentions).toBe(4)
  })

  it("gives up on a single item and records the failure kind", async () => {
    const { chat, llm } = harness(() => "still not json")

    const report = await extract({ pack: pack(), llm, sink, items: [item("r1")], newId })

    expect(report.mentions).toBe(0)
    expect(report.failures).toEqual([{ kind: "upstream", count: 1 }])
    // A lone item has nothing left to split, so it gets the ordinary retry policy.
    expect(chat.calls).toBe(3)
  })
})

describe("batching", () => {
  it("never mixes two grouping keys in one call", async () => {
    const { chat, llm } = harness(() => answer({ "1": [], "2": [] }))

    await extract({
      pack: pack({ batchSize: 20 }),
      llm,
      sink,
      items: [item("r1"), item("r2", { languageGuess: "en" }), item("r3")],
      newId,
    })

    expect(chat.calls).toBe(2)
    const langs = chat.requests.map((req) => [...req.user.matchAll(/^source: \S+ \((\S+)\)$/gm)])
    for (const call of langs) {
      expect(call.length).toBeGreaterThan(0)
      expect(new Set(call.map((m) => m[1])).size).toBe(1)
    }
  })

  it("chunks a group at batchSize", async () => {
    const { chat, llm } = harness(() => answer({}))

    const report = await extract({
      pack: pack({ batchSize: 2 }),
      llm,
      sink,
      items: [item("r1"), item("r2"), item("r3"), item("r4"), item("r5")],
      newId,
    })

    expect(report.batches).toBe(3)
    expect(chat.calls).toBe(3)
  })

  it("truncates a long item and says so in the prompt", async () => {
    const { chat, llm } = harness([answer({})])

    await extract({
      pack: pack({ maxItemChars: 10 }),
      llm,
      sink,
      items: [item("r1", { text: "x".repeat(500) })],
      newId,
    })

    const user = chat.requests[0]?.user ?? ""
    expect(user).toContain("[truncated]")
    expect(user).not.toContain("x".repeat(20))
  })
})

describe("re-running", () => {
  it("skips items this pack version has already extracted", async () => {
    const { chat, llm } = harness([
      answer({ "1": [{ name: "a", kind: "x" }] }),
      answer({ "1": [{ name: "b", kind: "x" }] }),
    ])
    const items = [item("r1")]

    await extract({ pack: pack(), llm, sink, items, newId })
    const second = await extract({ pack: pack(), llm, sink, items, newId })

    expect(second.skipped).toBe(1)
    expect(second.sent).toBe(0)
    expect(chat.calls).toBe(1)
  })

  it("re-extracts after a version bump, because that is what a bump means", async () => {
    const { chat, llm } = harness([
      answer({ "1": [{ name: "a", kind: "x" }] }),
      answer({ "1": [{ name: "b", kind: "x" }] }),
    ])
    const items = [item("r1")]

    await extract({ pack: pack(), llm, sink, items, newId })
    const bumped: DomainPack<Mention> = { ...pack(), version: "2" }
    const second = await extract({ pack: bumped, llm, sink, items, newId })

    expect(second.skipped).toBe(0)
    expect(second.mentions).toBe(1)
    expect(chat.calls).toBe(2)
    expect(sink.rows.map((row) => row.packVersion)).toEqual(["1", "2"])
  })

  it("makes no call at all when everything is already done", async () => {
    const { chat, llm } = harness([answer({ "1": [{ name: "a", kind: "x" }] })])
    const items = [item("r1")]

    await extract({ pack: pack(), llm, sink, items, newId })
    const second = await extract({ pack: pack(), llm, sink, items, newId })

    expect(second.calls).toBe(0)
    expect(chat.calls).toBe(1)
  })
})

describe("the contract with the pack", () => {
  it("refuses a prompt that left the envelope instructions out, before spending", async () => {
    const { chat, llm } = harness(() => answer({}))
    const bare = definePrompt({ id: "test/bare", version: "1", template: "read {{items}}" })

    await expect(
      extract({ pack: pack({ prompt: bare }), llm, sink, items: [item("r1")], newId }),
    ).rejects.toThrow(/ENVELOPE_INSTRUCTIONS/)
    expect(chat.calls).toBe(0)
  })
})

describe("the wire", () => {
  it("sends the mention shape to the provider while validating loosely here", async () => {
    // Strict on the wire, lenient on the way in. Handing the provider the loose
    // envelope would tell it the shape of the container and leave it to guess
    // the only field that varies.
    const { chat, llm } = harness([answer({ "1": [] })])

    await extract({ pack: pack(), llm, sink, items: [item("r1")], newId })

    const format = chat.requests[0]?.format
    expect(format?.kind).toBe("schema")
    const wire = JSON.stringify(format)
    expect(wire).toContain("confidence")
    expect(wire).toContain("kind")
    expect(wire).toContain("name")
  })

  it("routes under the pack's domain id and the extract task", async () => {
    const { chat, llm } = harness([answer({ "1": [] })])

    await extract({ pack: pack(), llm, sink, items: [item("r1")], newId })

    expect(chat.requests[0]?.model).toBe("vendor/cheap")
  })
})
