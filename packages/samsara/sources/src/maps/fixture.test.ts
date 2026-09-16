import { describe, expect, it } from "vitest"
import { readFixture } from "../fixture.js"
import { AVATAR_PATH, SHAPE_REDACTIONS } from "./capture.js"
import { createMapsAdapter } from "./index.js"
import type { MapsPayload } from "./types.js"

/**
 * The parser, run against bytes Maps actually sent — and a capture that came back
 * with nothing in it.
 *
 * One session from a Singapore egress with a `th-TH` persona on 2026-09-13, asking
 * `อารีย์`, 0.270 billed minutes. It is kept, and this file exists, because a
 * refused capture is evidence and the alternative is paying for the same lesson
 * twice. Three things were wrong, and none of them was the thing I was worried
 * about:
 *
 * 1. **Maps answered instead of listing.** `/maps/search/อารีย์` ended on one
 *    entity's own page. Every structural signal — no result cards, no blob — said
 *    refused, and nothing had gone wrong.
 * 2. **All three names for the blob were wrong.** `stateKeys` came back empty, so
 *    `APP_INITIALIZATION_STATE`, `APP_OPTIONS` and `_pageData` are none of them what
 *    this build calls it. `stateCandidates` was added *after* this capture and is
 *    therefore empty in it; the next session is the one that answers the question.
 * 3. **`gl` did not survive.** It was sent and the landing URL does not carry it.
 *    The same shape as P1.3's `persist_gl` finding, on a different source.
 *
 * What this file cannot prove is the thing a fixture is normally for: no review or
 * result card has ever been read by this parser, so every selector in `inpage.ts` is
 * still a guess. The assertions below are about a page with no items on it, and they
 * say so.
 */

const DIR = new URL("./__fixtures__", import.meta.url).pathname
const NAME = "maps-search-th-TH-2026-09-13"

const capture = readFixture<MapsPayload>(DIR, NAME)
const items = createMapsAdapter("search").parse(capture)

describe("the recorded search capture", () => {
  it("is the session it says it is", () => {
    expect(capture.sourceId).toBe("maps.search")
    expect(capture.query).toBe("อารีย์")
    expect(capture.payload.surface).toBe("search")
  })

  it("records the address it ended on, which is where the whole answer was", () => {
    // Asked for `/maps/search/`, ended somewhere else entirely. Storing the final
    // URL rather than the requested one is what makes this capture readable at all.
    expect(capture.url).not.toContain("/maps/search/")
    expect(capture.url).toMatch(/0x[0-9a-f]+:0x[0-9a-f]+/i)
  })

  it("kept the language hint and lost the region one", () => {
    // `hl` survives; `gl` was sent and is not in the landing URL. Worth an assertion
    // rather than a note, because the day Maps starts honouring it is the day this
    // test fails and tells somebody.
    expect(capture.url).toContain("hl=th")
    expect(capture.url).not.toContain("gl=sg")
  })

  it("came back with no cards, no reviews and no blob", () => {
    expect(capture.payload.entities).toHaveLength(0)
    expect(capture.payload.reviews).toHaveLength(0)
    expect(capture.payload.state).toBeNull()
    // The finding, as data: three guesses at the blob's name, none of them present.
    expect(capture.payload.stateKeys).toEqual([])
  })

  it("is not called a refusal, because Maps did answer", () => {
    // Recorded as a refusal at the time. The rule that produced it was corrected by
    // this capture, and the file is the reason the correction is testable.
    expect(capture.refusedBy).toContain("no result card and no state")
    const fresh = createMapsAdapter("search")
    expect(fresh.id).toBe("maps.search")
  })

  it("yields the entity Maps resolved to, which is what makes the session worth its cost", () => {
    expect(items).toHaveLength(1)
    const [only] = items
    expect(only?.url).toBe("https://maps.google.com/?cid=7848097478468591393")
    // The tab title, minus the product's own name, in Thai.
    expect(only?.title).toBe("ซ. พหลโยธิน 7")
    expect(only?.languageGuess).toBe("th")
    // No card, so no text and no counts. Nulls rather than zeroes: nobody said this
    // entity has no reviews, we simply never saw a number.
    expect(only?.text).toBe("")
    expect(only?.engagement).toBeNull()
  })

  it("is a url `maps.reviews` can be handed", () => {
    // The whole reason the search surface exists. A chained reviews capture takes
    // this string as its query, and `buildReviewsUrl` will accept it.
    const [only] = items
    expect(() => new URL(only?.url ?? "")).not.toThrow()
    expect(new URL(only?.url ?? "").hostname).toMatch(/(^|\.)google\.[a-z.]+$/)
  })
})

describe("the committed file", () => {
  it("carries no credential shape, re-checked against the current patterns", () => {
    // The list grows every time somebody reads a real page, and a file that was clean
    // against the old patterns has not been checked against the new ones. This repo
    // is public; that is the whole reason this test is here rather than in a comment.
    const json = JSON.stringify(capture)
    for (const [pattern] of SHAPE_REDACTIONS) {
      expect(json).not.toMatch(new RegExp(pattern.source, pattern.flags.replace("g", "")))
    }
  })

  it("holds paths and never query strings", () => {
    // `observedPaths` is the diagnostic most likely to leak by accident: a Maps
    // request carries identity in its query string, not its path.
    for (const path of capture.payload.observedPaths) {
      expect(path).not.toContain("?")
    }
  })

  it("is small enough that a person will actually read it before committing it", () => {
    // `fixture.ts` warns that a 2 MB fixture is one nobody reviews. This one is 31 KB,
    // and almost all of it is the request log.
    expect(JSON.stringify(capture).length).toBeLessThan(200_000)
  })
})

/**
 * The reviews surface, measured for the first time.
 *
 * One session on 2026-09-13, Singapore egress, `th-TH` persona, 0.40665 billed
 * minutes, 40 KB, five reviews. Its query is not a search phrase but an entity URL
 * taken from the search capture above — the chained flow the two-surface split
 * exists for, run end to end for the first time.
 *
 * Seven of nine selector plans came back filled 5/5. The three findings:
 *
 * 1. **A broken selector silently disabled an exclusion.** `authorHref` uses
 *    `a[href*="/contrib/"]`; Google no longer wraps the reviewer's name in that
 *    link, so it matched nothing. Twenty lines below, the avatar filter was written
 *    against the *same* selector — so it stopped excluding, and said nothing. Five
 *    photographs of five named people went into a capture bound for a public
 *    repository, under a comment asserting they were filtered out. `inpage.ts` now
 *    carries a second guard and, more importantly, `avatarsSkipped` in
 *    `nodeCounts`: the difference between a filter that works and a filter that is
 *    merely present is a number somebody can read.
 * 2. **`helpfulLabel` and `ownerReply` are null and cannot be diagnosed.** There
 *    was no `fragment` on `MapsReviewNode`, so the bytes cannot distinguish "this
 *    café never replies to reviews" from "`.CDe7pd` is stale" — and those want
 *    opposite responses. They are recorded below as **unmeasured**, not as fixed,
 *    because editing a selector on no evidence produces something that looks like a
 *    fix until the next billed session. The field now exists; the next capture
 *    settles them for free.
 * 3. **`button[aria-label*='Helpful']` is English**, in the selector list of a
 *    system whose purpose is non-English viewpoints, run here against `th-TH`. A
 *    design defect whether or not it is the cause of finding 2 — which is itself
 *    only undecidable because of it.
 *
 * The committed bytes were edited twice after recording, both times to take a
 * photograph of a named person out of a public repository.
 *
 * The first edit removed the five avatar references from `photoRefs`. The second
 * came from auditing this file a second time and is the more useful of the two:
 * **six of the same photographs were still here**, in `observedPaths`, because that
 * field is built from network responses and the avatar guard runs in the DOM. The
 * test below certified the file clean by matching
 * `googleusercontent\.com/a-?/` over the whole document — and `pathOf` strips the
 * hostname, so the pattern could not match the thing it was looking for. A guard, a
 * second guard, and an assertion, all three about contributor photographs, and the
 * photographs were in a fourth place none of them looked.
 *
 * The six are now `[redacted-avatar]` rather than deleted, which is the one
 * deliberate difference from the first edit: the count stays legible. `capture.ts`
 * drops them at the source now and reports `observedAvatarsSkipped`, so a file
 * recorded after today will have neither the markers nor the paths.
 *
 * What the file cannot carry retroactively is `avatarsSkipped`,
 * `observedAvatarsSkipped` and `reviewFragments`, which did not exist when it was
 * written.
 */

const REVIEWS = readFixture<MapsPayload>(DIR, "maps-reviews-th-TH-2026-09-13")
const reviewItems = createMapsAdapter("reviews").parse(REVIEWS)

describe("the recorded reviews capture", () => {
  it("was chained from an entity url rather than a search phrase", () => {
    expect(REVIEWS.sourceId).toBe("maps.reviews")
    expect(REVIEWS.query).toContain("cid=")
    expect(REVIEWS.payload.surface).toBe("reviews")
    // It navigated to the entity and the reviews tab opened. Asserted on the
    // feature id rather than the path word: the id is the thing that proves this
    // is one business's page and not a list, and the seam check declines to let
    // engine code carry the vendor's noun for it.
    expect(REVIEWS.url).toMatch(/0x[0-9a-f]+:0x[0-9a-f]+/i)
    expect(REVIEWS.url).not.toContain("/maps/search/")
    expect(REVIEWS.payload.tabOpened).toBe(1)
    expect(REVIEWS.payload.tabLabels).toHaveLength(3)
    expect(REVIEWS.refusedBy).toBeUndefined()
  })

  it("reads seven of nine fields off every review", () => {
    const rs = REVIEWS.payload.reviews
    expect(rs).toHaveLength(5)
    for (const field of [
      "reviewId",
      "authorName",
      "authorMeta",
      "ratingLabel",
      "relativeTime",
      "text",
    ] as const) {
      expect(rs.filter((r) => r[field] !== null)).toHaveLength(5)
    }
    expect(rs.filter((r) => r.photoRefs.length > 0)).toHaveLength(5)
  })

  it("records the other two as unmeasured rather than pretending they were fixed", () => {
    // Null for all five, with no fragment to say why. Left alone deliberately: see
    // finding 2 in the header. When this assertion starts failing, the next capture
    // has answered the question and the header paragraph can be deleted.
    const rs = REVIEWS.payload.reviews
    expect(rs.every((r) => r.helpfulLabel === null)).toBe(true)
    expect(rs.every((r) => r.ownerReply === null)).toBe(true)
    expect(rs.every((r) => r.fragment === null)).toBe(true)
  })

  it("deduplicates the buttons that carry their container's id", () => {
    // 52 nodes matched `[data-review-id]` and five reviews came out, which is the
    // dedup working, not a loss: every control inside a review repeats its id, and
    // document order puts the container first.
    expect(REVIEWS.payload.nodeCounts["[data-review-id]"]).toBe(52)
    expect(REVIEWS.payload.reviews).toHaveLength(5)
  })

  it("carries no photograph of a contributor, in either representation", () => {
    // The finding, as a test that costs nothing to run. `/a/` and `/a-/` are the
    // path prefixes Google serves profile images from.
    //
    // Both halves matter, and the second half is here because the first half alone
    // passed on a file that held six of them. A `photoRefs` entry is a whole URL
    // and a `observedPaths` entry is a path, so a host-anchored pattern is blind to
    // half the file. `AVATAR_PATH` is the rule that is true of both.
    const json = JSON.stringify(REVIEWS)
    expect(json).not.toMatch(/googleusercontent\.com\/a-?\//)
    for (const path of REVIEWS.payload.observedPaths) expect(path).not.toMatch(AVATAR_PATH)
    // And the review photos are still there — the guard did not eat the evidence.
    expect(json).toContain("grass-cs")
  })

  it("records that the avatar paths were redacted rather than absent", () => {
    // Redacted, not deleted, so the file still says how many there were. An empty
    // `observedPaths` and one with six photographs removed are different facts
    // about a capture, and a fixture that cannot tell them apart is worth less.
    const markers = REVIEWS.payload.observedPaths.filter((p) => p === "[redacted-avatar]")
    expect(markers).toHaveLength(6)
    // Recorded before the counter existed; see the header. This is the assertion
    // that will start failing when the file is re-recorded, which is the signal to
    // delete it and the markers together.
    expect(REVIEWS.payload.observedAvatarsSkipped).toBeUndefined()
  })

  it("keeps the localised strings verbatim and leaves the arithmetic to parse", () => {
    const [first] = REVIEWS.payload.reviews
    expect(first?.ratingLabel).toBe("5 ดาว")
    expect(first?.authorMeta).toContain("Local Guide")
    expect(first?.relativeTime).toContain("เดือน")
  })

  it("unwraps css into references the caller can actually dereference", () => {
    // `photoRefs` holds raw `style` values by design — unwrapping is interpretation
    // and belongs to `parse`. This asserts the handoff, not either half of it.
    expect(
      REVIEWS.payload.reviews.some((r) => r.photoRefs.some((p) => p.startsWith("backgroun"))),
    ).toBe(true)
    expect(reviewItems).toHaveLength(5)
    for (const item of reviewItems) {
      for (const ref of item.mediaRefs) expect(ref).toMatch(/^https:\/\//)
    }
  })

  it("gives every review a distinct url built from google's own identifier", () => {
    expect(new Set(reviewItems.map((i) => i.url)).size).toBe(5)
    for (const item of reviewItems) expect(item.url).toContain("#")
  })

  it("reads the reviews as thai", () => {
    for (const item of reviewItems) expect(item.languageGuess).toBe("th")
  })
})

/**
 * The opaque rule — "a long base64 run is something I cannot read, so redact it" —
 * is the only pattern here that is not tied to a recognisable credential format,
 * and it is deliberately not applied to the whole capture. `scrub` covers `text`,
 * `ownerReply`, `state` and `fragment`; it does not cover `photoRefs` or
 * `observedPaths`, because a googleusercontent photo path is a legitimate 120-plus
 * character base64 run and redacting it would destroy the value the field exists to
 * hold.
 *
 * So the check splits. Every *named* credential shape is forbidden everywhere in
 * the file. The opaque rule is asserted only over the fields that are scrubbed —
 * which is what it actually claims. The search fixture passed a blanket version of
 * this assertion, but only because it contains no photographs; stating the boundary
 * is better than passing by luck.
 */
const OPAQUE = SHAPE_REDACTIONS.filter(([, to]) => to === "[redacted-opaque]")
const NAMED = SHAPE_REDACTIONS.filter(([, to]) => to !== "[redacted-opaque]")
const unflagged = (p: RegExp): RegExp => new RegExp(p.source, p.flags.replace("g", ""))

describe("the committed reviews file", () => {
  it("carries no named credential shape anywhere in it", () => {
    const json = JSON.stringify(REVIEWS)
    for (const [pattern] of NAMED) expect(json).not.toMatch(unflagged(pattern))
  })

  it("carries no unreadable run in any field the scrubber actually covers", () => {
    const scrubbed: Array<string | null> = [REVIEWS.payload.state]
    for (const review of REVIEWS.payload.reviews) {
      scrubbed.push(review.text, review.ownerReply, review.fragment)
    }
    for (const value of scrubbed) {
      if (value === null) continue
      for (const [pattern] of OPAQUE) expect(value).not.toMatch(unflagged(pattern))
    }
  })

  it("still holds the long photo ids the opaque rule is kept away from", () => {
    // The other half of the boundary, asserted so that "clean" is never achieved by
    // quietly widening the scrubber until the evidence is gone too.
    const refs = REVIEWS.payload.reviews.flatMap((r) => [...r.photoRefs])
    expect(refs.some((ref) => /[A-Za-z0-9+/]{120,}/.test(ref))).toBe(true)
  })

  it("holds a base64 run that survives redaction on purpose", () => {
    // `reviewId` is 68 characters of base64 and the opaque rule's threshold is 120.
    // That gap is documented in `redact.test.ts` as rule 1's honest limit, and this
    // is the limit being useful: a public review identifier is not a secret, and a
    // rule aggressive enough to eat it would eat the photo URLs beside it.
    const [first] = REVIEWS.payload.reviews
    expect(first?.reviewId).toHaveLength(68)
    expect(first?.reviewId).not.toContain("[redacted")
  })

  it("holds paths and never query strings", () => {
    for (const path of REVIEWS.payload.observedPaths) expect(path).not.toContain("?")
  })

  it("is small enough that a person will actually read it before committing it", () => {
    expect(JSON.stringify(REVIEWS).length).toBeLessThan(200_000)
  })
})

/**
 * The search surface on a query that actually asks for a list.
 *
 * 0.21265 billed minutes, 76 KB, six businesses. Recorded because `maps.reviews`
 * takes an entity URL as its query and the only search fixture on hand had resolved
 * to a street rather than a business — so this capture exists to feed the one after
 * it, and it did: `cid=5348182387316994536` is where the reviews capture went.
 *
 * It also answers the two questions the first Maps capture left open. `stateKeys` is
 * still empty, so none of the three guessed names is the blob; `stateCandidates`,
 * added after that session precisely to settle this, comes back
 * `['PERSISTENT','TEMPORARY']` — browser constants living on `Window.prototype`,
 * which is proof the prototype-chain walk works and that `Object.keys` would have
 * missed them. Neither is the blob. The name remains unknown and is now known to be
 * unknown, which is the difference this capture bought.
 *
 * **Two defects, both fixed in `inpage.ts` and both still visible in these bytes.**
 * They are asserted below as recorded, not as corrected, because these are the bytes
 * the session produced and quietly editing derived values would turn a capture into
 * a drawing of one. (The reviews fixture *was* edited once — five contributor avatar
 * URLs removed — and the distinction is deliberate: that edit removed photographs of
 * named people from a public repository and moved the file toward what the corrected
 * adapter emits. Rewriting `detailLines` would be neither.) When these two
 * assertions fail, a re-recorded capture has replaced this one and both can go.
 */
const CAFES = readFixture<MapsPayload>(DIR, "maps-search-cafes-th-TH-2026-09-13")
const cafeItems = createMapsAdapter("search").parse(CAFES)

describe("the recorded cafes capture", () => {
  it("lists six businesses instead of resolving to one", () => {
    expect(CAFES.query).toBe("ร้านกาแฟ อารีย์")
    expect(CAFES.refusedBy).toBeUndefined()
    expect(CAFES.payload.entities).toHaveLength(6)
    expect(CAFES.payload.nodeCounts["a[href*=/maps/]"]).toBe(6)
    // A category query lists; a place name resolves. The difference is the query,
    // not the adapter, and the first Maps session spent 0.270 minutes learning it.
    expect(CAFES.url).toContain("/maps/search/")
  })

  it("walks the prototype chain for globals Object.keys cannot see", () => {
    expect(CAFES.payload.stateKeys).toEqual([])
    expect(CAFES.payload.stateCandidates).toEqual(["PERSISTENT", "TEMPORARY"])
    expect(CAFES.payload.state).toBeNull()
  })

  it("yields urls the reviews surface can be handed, which is what it was for", () => {
    expect(cafeItems).toHaveLength(6)
    for (const item of cafeItems) {
      expect(item.url).toMatch(/^https:\/\/maps\.google\.com\/\?cid=\d+$/)
      expect(item.languageGuess).toBe("th")
    }
    // The one that was: this capture fed `maps-reviews-th-TH-2026-09-13`.
    expect(cafeItems.map((i) => i.url)).toContain(
      "https://maps.google.com/?cid=5348182387316994536",
    )
  })

  it("records a wheelchair notice where a review count belongs — the defect, as recorded", () => {
    // `span + span[aria-label]` is positional and constrained nothing. Three of six
    // cards filed "no wheelchair accessible entrance" as `reviewCountLabel`. Fixed
    // in `inpage.ts` by requiring a digit; these bytes predate the fix.
    const wrong = CAFES.payload.entities.filter(
      (e) => e.reviewCountLabel === "ไม่มีทางเข้าที่รองรับเก้าอี้รถเข็น",
    )
    expect(wrong).toHaveLength(3)
    // What kept it from becoming a wrong number: `parseCount` refused it. The
    // containment was downstream luck, not a guard, which is why the guard exists.
    for (const item of cafeItems) expect(item.engagement).toBeNull()
  })

  it("stores each detail twice and welds two of them together — the second defect", () => {
    // A wrapper and its children both carry `W4Efsd`, so the wrapper contributed
    // its own `textContent`: an address and an opening time with no separator,
    // because the DOM had none either. Fixed by keeping leaves only.
    const [first] = CAFES.payload.entities
    expect(first?.detailLines).toContain("ร้านกาแฟ · 33 ซ. อารีย์ 3")
    expect(first?.detailLines?.some((l) => l.includes("3ปิดอยู่"))).toBe(true)
  })

  it("carries no named credential shape and no contributor photograph", () => {
    const json = JSON.stringify(CAFES)
    for (const [pattern] of NAMED) expect(json).not.toMatch(unflagged(pattern))
    expect(json).not.toMatch(/googleusercontent\.com\/a-?\//)
    for (const path of CAFES.payload.observedPaths) {
      expect(path).not.toContain("?")
      expect(path).not.toMatch(AVATAR_PATH)
    }
  })
})
