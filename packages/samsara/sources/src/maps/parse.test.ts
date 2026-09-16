import { describe, expect, it } from "vitest"
import type { Capture } from "../adapter.js"
import { entityUrl, parseMaps } from "./parse.js"
import type { MapsEntityNode, MapsPayload, MapsReviewNode, MapsSurface } from "./types.js"

/**
 * Hand-built payloads, and the header on `tiktok/parse.test.ts` applies here too:
 * these establish what the parser *does*, not that the shape it expects is the
 * shape Google sends. Only `fixture.test.ts` can do the second thing, and it does
 * not exist yet because no session has been paid for.
 *
 * For this adapter the two tests split unusually cleanly, because `inpage.ts` did
 * the extraction: everything below is a judgement made from strings, and a string
 * is a string whether it came from Google or from this file. What a real capture
 * will settle is whether those strings arrive at all.
 */

const REVIEWS_URL =
  "https://www.google.com/maps/@10.77,106.69,17z/data=!4m6!3m5!1s0x31752f3e:0xb2a1c9!8m2"

function review(over: Partial<MapsReviewNode> = {}): MapsReviewNode {
  return {
    reviewId: "r1",
    authorName: "Ngọc Anh",
    authorHref: "https://www.google.com/maps/contrib/104512/reviews",
    authorMeta: "Local Guide · 42 bài đánh giá",
    ratingLabel: "5 sao",
    relativeTime: "2 tháng trước",
    text: "Bánh mì ở đây rất ngon, chủ tiệm dễ thương.",
    fragment: null,
    photoRefs: [],
    helpfulLabel: null,
    ownerReply: null,
    ...over,
  }
}

function entity(over: Partial<MapsEntityNode> = {}): MapsEntityNode {
  return {
    href: REVIEWS_URL,
    name: "Tiệm Bánh Ngọc",
    ratingLabel: "4,6 sao",
    reviewCountLabel: "231 bài đánh giá",
    detailLines: ["Tiệm bánh · 12 Đường Nguyễn Huệ", "Mở cửa · Đóng cửa lúc 21:00"],
    ...over,
  }
}

function capture(
  over: Partial<MapsPayload> = {},
  surface: MapsSurface = "reviews",
  url = REVIEWS_URL,
): Capture<MapsPayload> {
  return {
    sourceId: `maps.${surface}`,
    query: surface === "reviews" ? url : "bánh mì",
    url,
    capturedAt: new Date("2026-09-13T00:00:00Z"),
    payload: {
      surface,
      reviews: [],
      entities: [],
      state: null,
      stateLength: null,
      pageTitle: "Google Maps",
      tabLabels: [],
      tabOpened: null,
      scrolls: 0,
      nodeCounts: {},
      stateKeys: [],
      stateCandidates: [],
      observedPaths: [],
      observedAvatarsSkipped: 0,
      strategies: { state: false, reviews: 0, entities: 0 },
      ...over,
    },
  }
}

describe("identity", () => {
  it("is the feature id, converted to the canonical link", () => {
    expect(entityUrl(REVIEWS_URL)).toBe("https://maps.google.com/?cid=11706825")
  })

  /**
   * The test this adapter most needed writing.
   *
   * Maps writes a viewport and a session-shaped `data=` segment into the address,
   * so two personas looking at the same entity get two different URLs. P1.8's entire
   * measurement is URL overlap between two personas — so this would not have failed
   * loudly. It would have reported zero overlap and read like a finding.
   */
  it("is the same for two personas looking at the same entity", () => {
    const fromSg =
      "https://www.google.com/maps/@10.77,106.69,17z/data=!4m6!1s0x31752f3e:0xb2a1c9!8m2?hl=vi"
    const fromUs =
      "https://www.google.com/maps/@10.12,106.11,15z/data=!3m1!4b1!4m6!1s0x31752f3e:0xb2a1c9?hl=en"
    expect(entityUrl(fromSg)).toBe(entityUrl(fromUs))
  })

  it("reads the hex in either case", () => {
    expect(entityUrl("https://www.google.com/maps/x/data=!1s0X31752F3E:0XB2A1C9")).toBe(
      "https://maps.google.com/?cid=11706825",
    )
  })

  it("handles an id far past what a number can hold", () => {
    // Feature ids are 64-bit. `Number` would round this one and two different
    // entities would collapse into the same row.
    expect(entityUrl("https://www.google.com/maps/x/data=!1s0x1:0x7e14a0d3f9")).toBe(
      "https://maps.google.com/?cid=541511963641",
    )
  })

  it("falls back to the address with its volatile half removed", () => {
    // Not stable across viewpoints, and documented as the weaker answer. A URL that
    // differs is still better evidence than no item at all.
    expect(entityUrl("https://www.google.com/maps/dir/A/B/data=!3m1!4b1")).toBe(
      "https://www.google.com/maps/dir/A/B",
    )
  })

  it("resolves a relative href the way the browser would have", () => {
    expect(entityUrl("/maps/x/data=!1s0x1:0xb2a1c9")).toBe("https://maps.google.com/?cid=11706825")
  })
})

describe("a review", () => {
  it("is addressed by the entity it is on and its own id", () => {
    const [draft] = parseMaps(capture({ reviews: [review()] }))
    expect(draft?.url).toBe("https://maps.google.com/?cid=11706825#r1")
  })

  it("has no title, because a review has none", () => {
    // The rating label would fit the field's shape and not its meaning. A `title`
    // that means the byline here and the headline everywhere else is worse than a
    // null — the same call `tiktok/parse.ts` makes about a caption.
    const [draft] = parseMaps(capture({ reviews: [review()] }))
    expect(draft?.title).toBeNull()
  })

  it("keeps the sentence in its own script", () => {
    const [draft] = parseMaps(capture({ reviews: [review()] }))
    expect(draft?.text).toBe("Bánh mì ở đây rất ngon, chủ tiệm dễ thương.")
    expect(draft?.languageGuess).toBe("vi")
  })

  it("admits it cannot read a short caption, rather than guessing", () => {
    // `language.ts` documents this exactly: every accent in `bánh mì ngon quá` is
    // plain Latin-1 and shared with Spanish. A null is an admission; a wrong
    // `languageGuess` is a claim.
    const [draft] = parseMaps(capture({ reviews: [review({ text: "Bánh mì ngon quá" })] }))
    expect(draft?.languageGuess).toBeNull()
  })

  it("reads the helpful count as likes and leaves the rest unknown", () => {
    const [draft] = parseMaps(capture({ reviews: [review({ helpfulLabel: "Hữu ích (3)" })] }))
    expect(draft?.engagement).toEqual({ views: null, likes: 3, comments: null })
  })

  it("reports no engagement at all rather than three zeroes", () => {
    const [draft] = parseMaps(capture({ reviews: [review()] }))
    expect(draft?.engagement).toBeNull()
  })

  it("unwraps a painted image and passes a plain one through", () => {
    const [draft] = parseMaps(
      capture({
        reviews: [
          review({
            photoRefs: [
              "https://lh5.googleusercontent.com/p/one",
              'background-image: url("https://lh5.googleusercontent.com/p/two=w300");',
              "background-color: rgb(255, 255, 255)",
            ],
          }),
        ],
      }),
    )
    expect(draft?.mediaRefs).toEqual([
      "https://lh5.googleusercontent.com/p/one",
      "https://lh5.googleusercontent.com/p/two=w300",
    ])
  })

  it("keeps a review that is only a rating", () => {
    // Tempting to drop: a rating with no words is not the native-script evidence
    // this adapter exists to collect. `adapter.ts` is the reason not to — the
    // adapter "does not score, filter, rank, deduplicate, or decide what is
    // interesting", and whether a bare rating is worth anything is a pack's opinion,
    // formed downstream where it can be changed without re-reading a page.
    const [draft] = parseMaps(capture({ reviews: [review({ text: null })] }))
    expect(draft?.text).toBe("")
    expect(draft?.url).toContain("#r1")
  })

  it("drops a review with no id, because it would collide with every other one", () => {
    const drafts = parseMaps(capture({ reviews: [review({ reviewId: null }), review()] }))
    expect(drafts).toHaveLength(1)
  })

  it("keeps encounter order and drops a repeat", () => {
    // Encounter order is rank order, which is what P1.8 measures over.
    const drafts = parseMaps(
      capture({
        reviews: [review({ reviewId: "a" }), review({ reviewId: "b" }), review({ reviewId: "a" })],
      }),
    )
    expect(drafts.map((d) => d.url.split("#")[1])).toEqual(["a", "b"])
  })
})

describe("a result card", () => {
  it("is a draft addressed by the same identity a review would use", () => {
    const [draft] = parseMaps(
      capture({ entities: [entity()] }, "search", "https://www.google.com/maps/search/x"),
    )
    expect(draft?.url).toBe("https://maps.google.com/?cid=11706825")
    expect(draft?.title).toBe("Tiệm Bánh Ngọc")
  })

  it("carries the lines the card actually showed", () => {
    const [draft] = parseMaps(
      capture({ entities: [entity()] }, "search", "https://www.google.com/maps/search/x"),
    )
    expect(draft?.text).toBe("Tiệm bánh · 12 Đường Nguyễn Huệ · Mở cửa · Đóng cửa lúc 21:00")
  })

  it("files the review count under comments, which is the least wrong slot", () => {
    const [draft] = parseMaps(
      capture({ entities: [entity()] }, "search", "https://www.google.com/maps/search/x"),
    )
    expect(draft?.engagement).toEqual({ views: null, likes: null, comments: 231 })
  })

  it("does not read the rating as a count", () => {
    // `4,6` is a rating, not four thousand six hundred. `counts.ts` refuses a
    // separator with fewer than three digits after it rather than guessing, which
    // is what keeps this honest.
    const [draft] = parseMaps(
      capture(
        { entities: [entity({ reviewCountLabel: null })] },
        "search",
        "https://www.google.com/maps/search/x",
      ),
    )
    expect(draft?.engagement).toBeNull()
  })

  it("drops a card with no link, because there is nothing to call it", () => {
    const drafts = parseMaps(
      capture(
        { entities: [entity({ href: null })] },
        "search",
        "https://www.google.com/maps/search/x",
      ),
    )
    expect(drafts).toHaveLength(0)
  })
})

describe("both at once", () => {
  it("parses whatever the capture holds, whichever surface it says it is", () => {
    // `readMapsPage` reads both on every capture, so a reviews capture that never
    // left the result list still has its cards parsed rather than silently dropped —
    // the refusal on it says what happened, and the items are still evidence.
    const drafts = parseMaps(
      capture({
        reviews: [review({ reviewId: "a" })],
        entities: [entity({ href: "https://www.google.com/maps/x/data=!1s0x1:0x7e14a0d3f9" })],
      }),
    )
    expect(drafts).toHaveLength(2)
    expect(drafts[0]?.url).toContain("#a")
    expect(drafts[1]?.url).toBe("https://maps.google.com/?cid=541511963641")
  })

  it("is pure: the same capture parses the same way twice", () => {
    const one = capture({ reviews: [review()], entities: [entity()] })
    expect(parseMaps(one)).toEqual(parseMaps(one))
  })
})

describe("a search Maps answered instead of listing", () => {
  // The path segment Google puts before an entity's name is a word the seam check
  // forbids; it is left out of this synthetic address because nothing here reads it.
  // The real spelling is in `__fixtures__`, where it arrived rather than being typed.
  const RESOLVED =
    "https://www.google.com/maps/x/@13.78,100.54,17z/" +
    "data=!4m6!3m5!1s0x30e29c1d21df5953:0x6cea0b135ec25f21!8m2!3d13.78!4d100.54?hl=th"

  it("yields the entity in the address when there were no cards to read", () => {
    const drafts = parseMaps(
      capture({ pageTitle: "ซ. พหลโยธิน 7 - Google Maps" }, "search", RESOLVED),
    )
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.url).toBe("https://maps.google.com/?cid=7848097478468591393")
    expect(drafts[0]?.title).toBe("ซ. พหลโยธิน 7")
    expect(drafts[0]?.text).toBe("")
    // Nobody told us this entity has no reviews. We never saw a number.
    expect(drafts[0]?.engagement).toBeNull()
  })

  it("keeps a title it does not recognise rather than truncating it by a guess", () => {
    const drafts = parseMaps(
      capture({ pageTitle: "Ari — a name with a dash in it" }, "search", RESOLVED),
    )
    expect(drafts[0]?.title).toBe("Ari — a name with a dash in it")
  })

  it("says nothing when there is no title to say it with", () => {
    const drafts = parseMaps(capture({ pageTitle: "Google Maps" }, "search", RESOLVED))
    expect(drafts[0]?.title).toBeNull()
  })

  it("stays quiet when the page did have cards on it", () => {
    // The fallback is for a page with nothing to read, not a second opinion about a
    // page that listed results. Two drafts for one search would double-count.
    const drafts = parseMaps(capture({ entities: [entity()] }, "search", RESOLVED))
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.title).toBe("Tiệm Bánh Ngọc")
  })

  it("stays quiet on the reviews surface, where the entity is the question", () => {
    // A reviews capture's URL is always an entity, so this rule would turn every
    // review-less entity into an item that looks like a search result.
    const drafts = parseMaps(capture({ reviews: [] }, "reviews", RESOLVED))
    expect(drafts).toHaveLength(0)
  })

  it("does not duplicate an entity a card already produced", () => {
    const drafts = parseMaps(
      capture({ entities: [entity({ href: RESOLVED })] }, "search", RESOLVED),
    )
    expect(drafts).toHaveLength(1)
  })
})
