import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  decodeEntities,
  parseAppDetails,
  parseReviewSummary,
  parseSearch,
  parseStorePage,
  reviewShareFromTooltip,
} from "./parse.js"

// Real responses, fetched 2026-09-30. They pin the markup the parsers were written against.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

describe("parseAppDetails", () => {
  it("reads price, people and dates, each with its path", () => {
    const d = parseAppDetails(JSON.parse(fixture("appdetails-413150.json")), 413150)
    expect(d?.name.value).toBe("Stardew Valley")
    expect(d?.developers.value).toEqual(["ConcernedApe"])
    expect(d?.price?.value.final).toBe(1499)
    expect(d?.price?.at.path).toBe("$.413150.data.price_overview")
    expect(d?.genres.value).toContain("Indie")
    expect(d?.releaseDate.value.comingSoon).toBe(false)
  })

  it("answers null for an app Steam will not describe", () => {
    expect(parseAppDetails({ "1": { success: false } }, 1)).toBeNull()
  })
})

describe("parseReviewSummary", () => {
  it("reads the totals and Steam's label", () => {
    const r = parseReviewSummary(JSON.parse(fixture("reviews-413150.json")))
    expect(r?.total.value).toBe(1041189)
    expect(r?.label.value).toBe("Overwhelmingly Positive")
    expect(r?.positive).toBeGreaterThan(r?.negative ?? 0)
  })
})

describe("parseSearch", () => {
  it("reads a row per game with its app id, price and tags", () => {
    const page = parseSearch(JSON.parse(fixture("search-492-87918.json")))
    expect(page?.total).toBeGreaterThan(100)
    expect(page?.rows.length).toBe(25)
    const stardew = page?.rows.find((r) => r.appid === 413150)
    expect(stardew?.name).toBe("Stardew Valley")
    expect(stardew?.priceFinal).toBe(1499)
    expect(stardew?.tagIds).toContain(87918)
    expect(reviewShareFromTooltip(stardew?.reviewTooltip ?? "")?.pct).toBeGreaterThan(90)
  })
})

describe("parseStorePage", () => {
  it("quotes a disclosure verbatim", () => {
    const p = parseStorePage(fixture("store-2456740.html"))
    expect(p.gated).toBe(false)
    expect(p.ai.disclosed).toBe(true)
    if (p.ai.disclosed) {
      expect(p.ai.text).toMatch(/^Players can generate unique textures/)
      expect(p.ai.at.selector).toBe("#game_area_content_descriptors")
    }
    expect(p.tags.value[0]).toBe("Life Sim")
    expect(p.releaseDate).toBe("Mar 27, 2025")
    expect(p.developers).toEqual(["inZOI Studio"])
  })

  it("says so when there is no disclosure, rather than saying nothing", () => {
    const p = parseStorePage(fixture("store-413150.html"))
    expect(p.ai.disclosed).toBe(false)
    expect(p.ai.at.quote).toMatch(/No "AI Generated Content Disclosure" section/)
    expect(p.tags.value).toContain("Farming Sim")
  })

  it("notices an age gate instead of reading it as a page without a disclosure", () => {
    expect(parseStorePage('<div id="app_agegate">').gated).toBe(true)
  })
})

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("Tom &amp; Jerry&#39;s &#x2122;")).toBe("Tom & Jerry's ™")
  })
})
