import { describe, expect, it } from "vitest"
import {
  aiShare,
  estimateCost,
  evidenceMoves,
  formatFact,
  isStale,
  laneOf,
  laneReviews,
  negativeReviews,
  recentReviews,
  reviewTrend,
  neighbourTags,
  paramsChanged,
  sha256Hex,
} from "./derive.js"
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
    expect(
      formatFact({
        key: "price",
        value: { currency: "USD", final: 1499, initial: 1499, discountPercent: 0 },
      }),
    ).toBe("$14.99")
    expect(
      formatFact({
        key: "price",
        value: { currency: "USD", final: 749, initial: 1499, discountPercent: 50 },
      }),
    ).toBe("$7.49 (50% off $14.99)")
    expect(
      formatFact({
        key: "reviews",
        value: { total: 1200, positive: 1080, negative: 120, label: "Very Positive" },
      }),
    ).toBe("1,200 reviews, 90% positive")
  })
})

describe("isStale", () => {
  it("is stale when the source finished after this run started", () => {
    expect(
      isStale(
        { lastRunId: "r" },
        { startedAt: "2026-09-30T10:00:00Z" },
        { endedAt: "2026-09-30T11:00:00Z", outcome: "ok" },
      ),
    ).toBe(true)
    expect(
      isStale(
        { lastRunId: "r" },
        { startedAt: "2026-09-30T12:00:00Z" },
        { endedAt: "2026-09-30T11:00:00Z", outcome: "ok" },
      ),
    ).toBe(false)
  })

  it("is never stale before its first run", () => {
    expect(
      isStale({ lastRunId: null }, null, { endedAt: "2026-09-30T11:00:00Z", outcome: "ok" }),
    ).toBe(false)
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

describe("niche breadth", () => {
  const row = (
    appid: number,
    tagIds: number[],
    priceFinal: number | null,
    reviewCount: number | null,
  ) => ({
    appid,
    name: `G${appid}`,
    priceFinal,
    tagIds,
    reviewPct: reviewCount === null ? null : 90,
    reviewCount,
  })

  it("keeps a tag nearly every game shares out of the lanes, and never names an unknown tag", () => {
    const rows = [
      row(1, [492, 4182, 1643], null, null),
      row(2, [492, 4182, 1643], null, null),
      row(3, [492, 4182, 7208], null, null),
      row(4, [492, 4182, 666], null, null),
      row(5, [492, 1643, 666], null, null),
    ]
    const names: Record<number, string> = {
      4182: "Singleplayer",
      1643: "Building",
      7208: "Crafting",
    }
    const n = neighbourTags(rows, [492], (id) => names[id] ?? null, 6)
    expect(n.baseline.map((t) => t.name)).toEqual(["Singleplayer"])
    expect(n.lanes).toEqual([
      { id: 1643, name: "Building", carry: 3 },
      { id: 7208, name: "Crafting", carry: 1 },
    ])
  })

  it("takes medians over paid games only, and lists the most reviewed first", () => {
    const lane = laneOf({
      relation: "narrower",
      tagIds: [492, 1643],
      pivot: { id: 1643, name: "Building" },
      overlap: { carry: 3, of: 5 },
      total: 40,
      rows: [row(1, [], 0, 10), row(2, [], 999, 500), row(3, [], 1999, null), row(4, [], 1499, 50)],
    })
    expect(lane).toMatchObject({ sampled: 4, medianPriceCents: 1499, medianReviews: 50 })
    expect(lane.top.map((t) => t.appid)).toEqual([2, 4, 1])
    expect(formatFact({ key: "lane", value: lane })).toBe("40 games with Building")
  })
})

describe("evidenceMoves", () => {
  const at = (id: string, runId: string, value: unknown): FactRecord => ({
    ...fact("set", "matches", value),
    id,
    runId,
  })

  it("reports a fact whose block now reads something else, and not one it reads the same", () => {
    const held = at("a", "r1", 222)
    const moved = { ...at("b", "r1", 8), subject: "app:1" }
    const latest = [at("a2", "r2", 222), { ...at("b2", "r2", 9), subject: "app:1" }]
    expect(evidenceMoves([held, moved], () => "r2", latest)).toEqual([
      { factId: "b", now: expect.objectContaining({ id: "b2", value: 9 }) },
    ])
  })

  it("is quiet while the block has not run again, and says gone when the reading vanished", () => {
    const f = at("a", "r1", 222)
    expect(evidenceMoves([f], () => "r1", [])).toEqual([])
    expect(evidenceMoves([f], () => "r2", [])).toEqual([{ factId: "a", now: null }])
  })
})

describe("review signals", () => {
  const day = 86_400
  const r = (votedUp: boolean, minutes: number | null, language = "english", created = 0, refunded = false) => ({
    votedUp,
    minutesAtReview: minutes,
    language,
    created,
    refunded,
  })

  it("reads the recent score and the hours positive reviewers had played", () => {
    const v = recentReviews([r(true, 600, "english", 10 * day), r(true, 1200), r(false, 30, "english", 4 * day)])
    expect(v).toEqual({ sampled: 3, positive: 2, pct: 67, spanDays: 6, medianHoursUp: 15 })
  })

  it("counts negatives inside the refund window, and ignores a positive that slipped in", () => {
    const v = negativeReviews([r(false, 45, "english", 0, true), r(false, 119), r(false, 120), r(true, 5), r(false, null)])
    expect(v).toMatchObject({ sampled: 4, early: 2, refunded: 1, medianHours: 2 })
  })

  it("only compares games with enough recent reviews and an all-time score", () => {
    const recent = (pct: number, sampled = 100) => ({ ...recentReviews([]), pct, sampled })
    const t = reviewTrend([
      { appid: 1, name: "Down", recent: recent(80), allTimePct: 90 },
      { appid: 2, name: "Up", recent: recent(96), allTimePct: 90 },
      { appid: 3, name: "Steady", recent: recent(88), allTimePct: 90 },
      { appid: 4, name: "Too few", recent: recent(50, 12), allTimePct: 90 },
      { appid: 5, name: "No score", recent: recent(50), allTimePct: null },
    ])
    expect(t.judged).toBe(3)
    expect(t.lower.map((g) => g.name)).toEqual(["Down"])
    expect(t.higher.map((g) => g.name)).toEqual(["Up"])
  })

  it("pools the lane, every sampled review once", () => {
    const lane = laneReviews(
      [[r(true, 600), r(true, 60, "schinese")], [r(true, 1200), r(false, 10)]],
      [[r(false, 30), r(false, 300)], [r(false, 90, "english", 0, true)]],
    )
    expect(lane.hours).toMatchObject({ medianHoursUp: 10, medianHoursDown: 1.5, up: 3, down: 3 })
    // 600, 60, 1200 minutes up; 30, 300, 90 down. An edge belongs to the bucket above it.
    expect(lane.hours.buckets?.map((b) => [b.up, b.down])).toEqual([
      [0, 1],
      [1, 1],
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 0],
      [0, 0],
    ])
    expect(lane.early).toEqual({ early: 2, of: 3, pct: 67, refunded: 1 })
    expect(lane.languages.top[0]).toEqual({ language: "english", n: 3 })
  })

  it("prints a chip a sentence can hold", () => {
    expect(formatFact(fact("set", "review.early", { early: 2, of: 3, pct: 67, refunded: 1 }))).toBe(
      "67% of negative reviews under 2 h",
    )
    expect(
      formatFact(fact("set", "review.languages", { sampled: 4, top: [{ language: "schinese", n: 1 }] })),
    ).toBe("Simplified Chinese 25%")
  })
})
