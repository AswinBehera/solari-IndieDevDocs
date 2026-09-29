import { describe, expect, it } from "vitest"
import { defaultStay, parseStayUrl, readCaveats, readPrice, readWall, toNumber } from "./parse.js"

const NOW = new Date("2026-09-29T00:00:00Z")

describe("parseStayUrl", () => {
  it("accepts a Booking property page and normalises dates and party into the URL", () => {
    const r = parseStayUrl(
      "https://www.booking.com/hotel/th/the-peninsula-bangkok.en-gb.html?aid=1&label=x",
      NOW,
    )
    expect(r.ok && r.parsed).toMatchObject({
      site: "booking",
      checkIn: "2026-10-29",
      checkOut: "2026-10-30",
      adults: 2,
    })
    expect(r.ok && r.parsed.url).toContain("checkin=2026-10-29")
    expect(r.ok && r.parsed.url).not.toContain("aid=")
  })
  it("keeps valid dates the URL already carries and repairs invalid ones", () => {
    const keep = parseStayUrl(
      "https://www.booking.com/hotel/jp/x.html?checkin=2026-12-01&checkout=2026-12-04&group_adults=3",
      NOW,
    )
    expect(keep.ok && keep.parsed).toMatchObject({
      checkIn: "2026-12-01",
      checkOut: "2026-12-04",
      adults: 3,
    })
    const bad = parseStayUrl("https://www.booking.com/hotel/jp/x.html?checkin=2026-02-31", NOW)
    expect(bad.ok && bad.parsed.checkIn).toBe(defaultStay(NOW).checkIn)
  })
  it("accepts an Agoda property page and drops the language segment", () => {
    const r = parseStayUrl(
      "https://www.agoda.com/th-th/the-siam-hotel/hotel/bangkok-th.html?cid=1",
      NOW,
    )
    expect(r.ok && r.parsed.site).toBe("agoda")
    expect(r.ok && r.parsed.url).toBe(
      "https://www.agoda.com/the-siam-hotel/hotel/bangkok-th.html?checkIn=2026-10-29&los=1&adults=2&rooms=1&children=0",
    )
  })
  it("refuses everything else by name", () => {
    for (const url of [
      "not a url",
      "ftp://booking.com/hotel/th/x.html",
      "https://www.booking.com/searchresults.html?ss=bangkok",
      "https://www.agoda.com/city/bangkok-th.html",
      "https://www.airbnb.com/rooms/1",
    ]) {
      expect(parseStayUrl(url, NOW).ok).toBe(false)
    }
  })
})

describe("readPrice", () => {
  it.each([
    ["THB 4,500", 4500, "THB"],
    ["฿4,500", 4500, "THB"],
    ["US$ 129.50", 129.5, "USD"],
    ["€1.234,50", 1234.5, "EUR"],
    ["12,800 円", 12800, "JPY"],
    ["£89", 89, "GBP"],
    ["A$ 210", 210, "AUD"],
  ])("reads %s", (text, amount, currency) => {
    expect(readPrice(`From ${text} per night`)).toMatchObject({ amount, currency })
  })
  it("keeps an unknown currency's amount and reports the currency as unknown", () => {
    expect(readPrice("MYR 300")).toBeNull()
    expect(readPrice("₫ 1.200.000")).toBeNull()
  })
  it("is null for text with no price", () => {
    expect(readPrice("Sold out on your dates")).toBeNull()
  })
})

describe("toNumber", () => {
  it("treats a lone three-digit group as thousands and a lone one-or-two as decimals", () => {
    expect(toNumber("1,234")).toBe(1234)
    expect(toNumber("1.234")).toBe(1234)
    expect(toNumber("12,50")).toBe(12.5)
    expect(toNumber("1 234,5")).toBe(1234.5)
  })
})

describe("caveats and walls", () => {
  it("names caveats in plain words", () => {
    expect(readCaveats("Genius member price. Taxes and fees not included")).toEqual([
      "taxes and fees may be extra",
      "a member or sign-in rate may apply",
    ])
  })
  it("recognises a wall and nothing else", () => {
    expect(readWall("Please verify you are a human")).toBe("captcha")
    expect(readWall("Request blocked")).toBe("access denied")
    expect(readWall("Deluxe room, free cancellation")).toBeNull()
  })
})
