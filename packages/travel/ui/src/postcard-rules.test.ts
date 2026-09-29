import { describe, expect, it } from "vitest"
import {
  checklistCount,
  factorLabel,
  linkKind,
  linkLine,
  localPercent,
  photoLine,
  priceRows,
  priceSpread,
  sourceBadge,
  stateTag,
  whyRows,
} from "./postcard-rules"

describe("sourceBadge", () => {
  it("stamps the platform, not the page the crawler read", () => {
    expect(sourceBadge("pantip.forum").label).toBe("PANTIP")
    expect(sourceBadge("pantip.topic").label).toBe("PANTIP")
    expect(sourceBadge("youtube.search").label).toBe("YOUTUBE")
    expect(sourceBadge("maps.reviews").label).toBe("GMAPS")
  })

  it("still stamps a platform it has no colour for", () => {
    expect(sourceBadge("wongnai.review").label).toBe("WONGNAI")
  })
})

describe("stateTag", () => {
  it("has the canvas's three states", () => {
    expect(stateTag("fresh").label).toBe("FRESH")
    expect(stateTag("stale").className).toContain("signal-red")
    expect(stateTag("pinned").className).toContain("accent-gold")
  })
})

describe("localPercent and whyRows", () => {
  const scores = {
    local: {
      value: 0.716,
      because: [
        { factor: "sourceDiversity", contribution: 0.1, evidenceIds: [] },
        { factor: "nativeLanguageShare", contribution: 0.42, evidenceIds: [] },
      ],
    },
  }

  it("rounds the local score to a whole percentage, or says nothing scored it", () => {
    expect(localPercent({ scores })).toBe(72)
    expect(localPercent({ scores: {} })).toBeNull()
  })

  it("explains the score strongest factor first, in words", () => {
    expect(whyRows({ scores })).toEqual([
      { label: "Written in Thai", points: "+42" },
      { label: "Different sources saying so", points: "+10" },
    ])
  })

  it("has words for every factor the travel pack writes", () => {
    for (const name of [
      "nativeLanguageShare",
      "creatorLocalShare",
      "sourceDiversity",
      "engagementRatio",
      "nonNativeLanguageShare",
      "visitorCreatorShare",
      "listicleQuotes",
      "listicleSources",
    ]) {
      // A known label never looks like the camelCase fallback.
      expect(factorLabel(name)).not.toBe(
        name
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .replace(/^./, (c) => c.toUpperCase()),
      )
    }
  })

  it("knows a factor however its name is spelled", () => {
    expect(factorLabel("native-language share")).toBe("Written in Thai")
    expect(factorLabel("creator_local_share")).toBe("Creators who read as local")
  })

  it("names a factor it does not know by splitting its capitals", () => {
    expect(factorLabel("creatorPostingCadence")).toBe("Creator posting cadence")
  })
})

describe("linkKind", () => {
  it.each([
    ["https://www.tiktok.com/@kin.yaowarat/video/7401182934", "tiktok"],
    ["https://vt.tiktok.com/ZS123/", "tiktok"],
    ["https://youtu.be/abc", "youtube"],
    ["https://www.agoda.com/mandarin-oriental-bangkok/hotel/bangkok-th.html", "agoda"],
    ["https://www.booking.com/hotel/th/x.html", "booking"],
    ["https://maps.app.goo.gl/abc", "maps"],
    ["https://www.google.com/maps/place/x", "maps"],
    ["https://nottiktok.com/x", "other"],
    ["not a url", "other"],
  ])("reads %s as %s", (url, kind) => {
    expect(linkKind(url)).toBe(kind)
  })

  it("does not offer to do what is not built", () => {
    expect(linkLine("tiktok")).toContain("kept as a link")
  })
})

describe("checklistCount and photoLine", () => {
  it("counts what is done", () => {
    expect(
      checklistCount([
        { text: "a", done: true },
        { text: "b", done: false },
      ]),
    ).toBe("1 OF 2")
    expect(checklistCount([])).toBe("EMPTY")
  })

  it("says what the photo's metadata gave", () => {
    expect(photoLine({ lat: 1, lng: 2 }, null)).toBe("GEO ✓ · NO TIME")
    expect(photoLine(null, "2026-11-15T09:00:00Z")).toBe("NO GEO · TIME ✓")
  })
})

describe("priceRows", () => {
  const obs = [
    { country: "us", payload: { status: "price", displayed: "$546", usd: 546 } },
    { country: "in", payload: { status: "price", displayed: "Rs. 47,377", usd: 493.15 } },
    { country: "de", payload: { status: "no_price" } },
    { country: "jp", payload: { status: "price", displayed: "¥91,414", usd: null } },
    { country: "au", payload: { status: "blocked", wall: "captcha" } },
  ]
  it("orders priced rows cheapest first and highlights only a converted cheapest", () => {
    const rows = priceRows(obs)
    expect(rows.map((r) => r.country)).toEqual(["in", "us", "au", "de", "jp"])
    expect(rows.filter((r) => r.cheapest).map((r) => r.country)).toEqual(["in"])
  })
  it("names the reason for a row with no figure", () => {
    const rows = priceRows(obs)
    expect(rows.find((r) => r.country === "au")?.label).toBe("blocked (captcha)")
    expect(rows.find((r) => r.country === "de")?.label).toBe("no price shown")
  })
  it("reports the spread honestly, and nothing for fewer than two figures", () => {
    expect(priceSpread(priceRows(obs))).toBe("Highest is 11% above the lowest.")
    expect(priceSpread(priceRows(obs.slice(0, 1)))).toBeNull()
  })
})
