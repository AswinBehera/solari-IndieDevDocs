import { describe, expect, it } from "vitest"
import { aiShare, estimateCost, formatFact, isStale, paramsChanged, sha256Hex } from "./derive.js"
import { blockIdsIn } from "./index.js"
import type { FactRecord } from "./model.js"

let n = 0
const fact = (subject: string, key: FactRecord["key"], value: unknown): FactRecord => ({
  id: `f${++n}`,
  blockId: "b",
  runId: "r",
  receiptId: "rc",
  subject,
  key,
  value,
  locator: {},
  createdAt: "2026-09-30T00:00:00Z",
})

describe("aiShare", () => {
  it("counts disclosures and leaves unread pages out of the denominator", () => {
    const facts = [
      fact("app:1", "name", "Alpha"),
      fact("app:1", "ai.disclosure", { disclosed: true, text: "art" }),
      fact("app:2", "ai.disclosure", { disclosed: false }),
      fact("app:3", "ai.disclosure", { disclosed: false }),
      fact("app:4", "unavailable", { reason: "blocked" }),
    ]
    const { value, from } = aiShare(facts)
    expect(value).toMatchObject({ disclosed: 1, total: 3, unread: 1, pct: 33.3 })
    expect(value.disclosedApps).toEqual([{ appid: 1, name: "Alpha" }])
    expect(from).toHaveLength(3)
  })

  it("is zero, not NaN, with nothing read", () => {
    expect(aiShare([]).value.pct).toBe(0)
  })
})

describe("formatFact", () => {
  it("prints prices, discounts and reviews for a sentence", () => {
    expect(formatFact({ key: "price", value: { currency: "USD", final: 1499, initial: 1499, discountPercent: 0 } })).toBe("$14.99")
    expect(formatFact({ key: "price", value: { currency: "USD", final: 749, initial: 1499, discountPercent: 50 } })).toBe(
      "$7.49 (50% off $14.99)",
    )
    expect(formatFact({ key: "reviews", value: { total: 1200, positive: 1080, negative: 120, label: "Very Positive" } })).toBe(
      "1,200 reviews, 90% positive",
    )
  })
})

describe("isStale", () => {
  it("is stale when the source finished after this run started", () => {
    expect(
      isStale({ lastRunId: "r" }, { startedAt: "2026-09-30T10:00:00Z" }, { endedAt: "2026-09-30T11:00:00Z", outcome: "ok" }),
    ).toBe(true)
    expect(
      isStale({ lastRunId: "r" }, { startedAt: "2026-09-30T12:00:00Z" }, { endedAt: "2026-09-30T11:00:00Z", outcome: "ok" }),
    ).toBe(false)
  })

  it("is never stale before its first run", () => {
    expect(isStale({ lastRunId: null }, null, { endedAt: "2026-09-30T11:00:00Z", outcome: "ok" })).toBe(false)
  })
})

describe("estimateCost", () => {
  it("says a derived block is free", () => {
    expect(estimateCost("slop_share", 20).minutes).toBe(0)
    expect(estimateCost("store_snapshot", 20).browserPages).toBe(20)
  })
})

describe("sha256Hex", () => {
  it("matches the known digest of the empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })
})

describe("blockIdsIn", () => {
  it("finds block atoms anywhere in the tree, once each", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "researchBlock", attrs: { blockId: "a" } },
        { type: "paragraph", content: [{ type: "text", text: "x" }] },
        { type: "researchBlock", attrs: { blockId: "a" } },
        { type: "researchBlock", attrs: { blockId: "b" } },
      ],
    }
    expect(blockIdsIn(doc)).toEqual(["a", "b"])
  })
})

describe("paramsChanged", () => {
  it("ignores pruning and tag order, and notices new tags", () => {
    const run = { tagIds: [492, 87918], sort: "relevance", limit: 12, exclude: [] }
    expect(paramsChanged("comparables", run, { ...run, exclude: [1], limit: 5 })).toBe(false)
    expect(paramsChanged("comparables", run, { ...run, tagIds: [87918, 492] })).toBe(false)
    expect(paramsChanged("comparables", run, { ...run, tagIds: [492, 1716] })).toBe(true)
    expect(paramsChanged("comparables", run, { ...run, sort: "reviews" })).toBe(true)
    expect(paramsChanged("store_snapshot", { source: "a" }, { source: "b" })).toBe(true)
  })
})
