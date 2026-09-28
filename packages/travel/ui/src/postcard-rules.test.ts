import { describe, expect, it } from "vitest"
import {
  checklistCount,
  factorLabel,
  linkKind,
  linkLine,
  localPercent,
  photoLine,
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
    expect(linkLine("tiktok")).toContain("not wired up yet")
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
