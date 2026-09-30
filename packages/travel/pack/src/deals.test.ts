import { describe, expect, it } from "vitest"
import { dealMention, groupDeals } from "./deals.js"
import { dealsPack } from "./deals-pack.js"

const code = (over: Record<string, unknown> = {}) => ({
  provider: "agoda",
  code: "agoda8th",
  offer: "ลด 8%",
  expires: null,
  conditions: null,
  quote: "ใช้โค้ด AGODA8TH ลดเพิ่ม 8% ค่ะ",
  ...over,
})

describe("dealMention", () => {
  it("upper-cases the code and keeps it when the quote contains it", () => {
    const r = dealMention.safeParse(code())
    expect(r.success && r.data.code).toBe("AGODA8TH")
  })

  it("refuses a code the quote does not contain", () => {
    expect(dealMention.safeParse(code({ code: "AGODA10" })).success).toBe(false)
  })

  it("refuses something that is not typeable as a code", () => {
    expect(dealMention.safeParse(code({ code: "ลด 8%", quote: "ลด 8% นะ" })).success).toBe(false)
  })
})

describe("dealsPack", () => {
  it("is its own domain with no resolver, so the chain stops after extraction", () => {
    expect(dealsPack.id).toBe("deals")
    expect(dealsPack.resolve).toBeUndefined()
  })
})

describe("groupDeals", () => {
  const item = { sourceId: "pantip.tag", url: "https://pantip.com/topic/1" }
  it("folds sightings of one code, newest first, and drops invalid payloads", () => {
    const rows = [
      { payload: code(), createdAt: "2026-09-29T00:00:00Z", item },
      {
        payload: code({ offer: null }),
        createdAt: "2026-09-30T00:00:00Z",
        item: { ...item, url: "https://pantip.com/topic/2" },
      },
      { payload: { nope: true }, createdAt: "2026-09-30T00:00:00Z", item },
      {
        payload: code({ provider: "booking", code: "BK500", quote: "BK500 ลด 500" }),
        createdAt: "2026-09-28T00:00:00Z",
        item,
      },
    ]
    const out = groupDeals(rows)
    expect(out.map((d) => [d.code, d.sightings])).toEqual([
      ["AGODA8TH", 2],
      ["BK500", 1],
    ])
    expect(out[0]?.seenOn.url).toBe("https://pantip.com/topic/2")
    expect(out[0]?.offer).toBe("ลด 8%")
    expect(groupDeals(rows, ["booking"]).map((d) => d.code)).toEqual(["BK500"])
  })
})
