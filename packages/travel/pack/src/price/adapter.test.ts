import { describe, expect, it } from "vitest"
import { createPriceAdapter, type PricePage, type PricePayload, priceAdapter } from "./adapter.js"
import type { PageVerdict } from "./jev.js"
import { parseStayUrl } from "./parse.js"

const NOW = new Date("2026-09-29T00:00:00Z")
const parsed = (url: string) => {
  const r = parseStayUrl(url, NOW)
  if (!r.ok) throw new Error(r.reason)
  return r.parsed
}

function page(over: {
  title?: string
  elements?: string[]
  body?: string
  url?: string
}): PricePage {
  return {
    async goto() {},
    url: () => over.url ?? "https://www.booking.com/hotel/th/x.html",
    async title() {
      return over.title ?? "The X, Bangkok"
    },
    async evaluate() {
      return { elements: over.elements ?? [], body: over.body ?? "" } as never
    },
    async screenshot() {
      return new Uint8Array([137, 80, 78, 71])
    },
    waitForTimeout: async () => {},
  }
}

const run = (p: PricePage, url = "https://www.booking.com/hotel/th/x.html", country = "us") =>
  priceAdapter.probe(
    { page: p, country, signal: new AbortController().signal },
    { url, parsed: parsed(url) },
  )

describe("the price probe", () => {
  it("reads a price from a price element and says so", async () => {
    const r = await run(page({ elements: ["THB 4,500"], body: "Taxes and fees not included" }))
    expect(r.payload).toMatchObject({
      status: "price",
      amount: 4500,
      currency: "THB",
      source: "element",
    })
    expect(r.payload.caveats).toEqual(["taxes and fees may be extra"])
    expect(r.screenshot.length).toBeGreaterThan(0)
  })
  it("falls back to the visible text and records that it did", async () => {
    const r = await run(page({ body: "Deluxe room from US$ 129.50 per night" }))
    expect(r.payload).toMatchObject({
      status: "price",
      amount: 129.5,
      currency: "USD",
      source: "text-scan",
    })
  })
  it("reports a wall as blocked and never scans it for a price", async () => {
    const r = await run(page({ title: "Access denied", body: "Request blocked. US$ 5 fee" }))
    expect(r.payload).toMatchObject({ status: "blocked", amount: null, wall: "access denied" })
    expect(r.notes).toContain("blocked")
    expect(r.screenshot.length).toBeGreaterThan(0)
  })
  it("reports a property page with no figure as no_price", async () => {
    const r = await run(page({ body: "Sold out on your dates" }))
    expect(r.payload).toMatchObject({ status: "no_price", displayed: null })
  })
  it("reports no_price when the site redirected to a list page", async () => {
    const r = await run(
      page({ url: "https://www.booking.com/city/th/bangkok.html", body: "Hotels from US$ 62" }),
    )
    expect(r.payload).toMatchObject({ status: "no_price", amount: null })
    expect(r.notes).toContain("redirected")
  })
  it("normalises to USD and keeps the raw figure", () => {
    const base = {
      status: "price",
      site: "booking",
      country: "th",
      finalUrl: "",
      title: "",
      displayed: "THB 3,200",
      source: "element",
      amount: 3200,
      currency: "THB",
      caveats: [],
      wall: null,
      context: null,
    } satisfies PricePayload
    const out = priceAdapter.normalise?.({ ...base }, { THB: 0.03125, USD: 1 })
    expect(out).toMatchObject({ amount: 3200, currency: "THB", usd: 100 })
    expect(priceAdapter.normalise?.({ ...base, currency: "MYR" }, { USD: 1 })).toMatchObject({
      usd: null,
    })
  })
})

describe("the price probe with a page judge", () => {
  const judged = (verdict: PageVerdict | null, p: PricePage) => {
    const url = "https://www.booking.com/hotel/th/x.html"
    return createPriceAdapter({ judge: async () => verdict }).probe(
      { page: p, country: "jp", signal: new AbortController().signal },
      { url, parsed: parsed(url) },
    )
  }
  it("calls a wall the regex cannot read a wall when the judge is sure", async () => {
    const r = await judged(
      { wall: 0.97, property: 0.02, priceVisible: 0.01 },
      page({
        title: "アクセスが拒否されました",
        body: "ご利用のネットワークからのアクセスは制限されています",
      }),
    )
    expect(r.payload).toMatchObject({ status: "blocked", wall: "judge" })
    expect(r.payload.judge?.wall).toBe(0.97)
  })
  it("drops a text-scan figure on a page the judge says shows no stay price", async () => {
    const r = await judged(
      { wall: 0.02, property: 0.95, priceVisible: 0.05 },
      page({ body: "Guests paid on average US$ 129 last year" }),
    )
    expect(r.payload).toMatchObject({ status: "no_price", source: null })
  })
  it("keeps an element price whatever the judge thinks of the text", async () => {
    const r = await judged(
      { wall: 0.02, property: 0.95, priceVisible: 0.05 },
      page({ elements: ["THB 4,500"] }),
    )
    expect(r.payload).toMatchObject({ status: "price", amount: 4500, source: "element" })
  })
  it("leaves the regex standing when the judge does not answer", async () => {
    const r = await judged(null, page({ elements: ["THB 4,500"] }))
    expect(r.payload).toMatchObject({ status: "price", judge: null })
  })
  it("treats a page the judge is sure is not a property as off the property", async () => {
    const r = await judged(
      { wall: 0.02, property: 0.05, priceVisible: 0.9 },
      page({ elements: ["THB 4,500"] }),
    )
    expect(r.payload.status).toBe("no_price")
    expect(r.notes).toBe("redirected off the property page")
  })
})
