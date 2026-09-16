import { describe, expect, it } from "vitest"
import { readFixture } from "../fixture.js"
import { SHAPE_REDACTIONS } from "./capture.js"
import { createPantipAdapter } from "./index.js"
import type { PantipPayload } from "./types.js"

/**
 * The parser, run against bytes Pantip actually sent — and the most expensive 0.22
 * minutes this project has spent, measured in what it changed rather than in items.
 *
 * One session from a Singapore egress with a `th-TH` persona on 2026-09-13, asking
 * the tag `อารีย์`. It returned zero items and reported `refused: no`, and both of
 * those were wrong in ways nothing in the test suite could have found:
 *
 * 1. **It was a 404.** The title says ไม่พบหน้านี้ — this page was not found — and
 *    the state blob says `notFound: true`. Pantip is a Next.js site, so a page that
 *    does not exist still ships `__NEXT_DATA__`, and every refusal clause read "a
 *    blob was read" as "the page was real". The tag simply does not exist. A missing
 *    tag and a quiet one told exactly the same story, which is the failure mode an
 *    honest zero is supposed to be protected from.
 * 2. **It carried our own egress IP address.** `props.initialProps.ptData` was 568
 *    characters of base64 holding more base64 holding `{ipa, ipv6, ipx, …}`, and the
 *    value was this session's rented IPv6, five times over. Not Pantip's secret —
 *    a piece of our infrastructure, handed back by the page, in a form no pattern in
 *    the redaction list could see. It would have gone into a public repository inside
 *    a file whose whole ritual is that a person reads it first.
 * 3. **`stateCandidates` was empty**, on a page with a state blob, because it was
 *    built from `Object.keys(window)`. The diagnostic P1.5 paid a session to add did
 *    not work, and this is the session that found out.
 * 4. **`stateKeys` said `__NEXT_DATA__`** when that global was the script *element*.
 *    The guard caught it and the fallback read the tag; the label made a near miss
 *    look like a hit.
 *
 * Every one of those is fixed, and this file is the reason each fix is testable
 * rather than asserted. What it still cannot prove is the thing a fixture is
 * normally for: no listing row and no post has ever been read by this parser, so
 * every selector in `inpage.ts` is still a guess, and `nodeCounts` below is a row of
 * zeroes rather than a measurement.
 *
 * **The file was scrubbed after the fact, not re-recorded.** `tools/scrub-fixture.ts`
 * ran the corrected rules over the bytes already on disk, which is the same file a
 * second session would have produced and costs nothing. The `committed file` block
 * below is what keeps that claim honest.
 */

const DIR = new URL("./__fixtures__", import.meta.url).pathname

const capture = readFixture<PantipPayload>(DIR, "pantip-tag-th-TH-2026-09-13")
const items = createPantipAdapter("tag").parse(capture)

/**
 * The second capture, and the first one in this project that a parser got anything
 * out of: `pantip.forum food` — ก้นครัว, the cooking board — from the same viewpoint,
 * 0.448 billed minutes, 259 rows.
 *
 * The board was not a guess. It came out of the *failed* tag capture's state blob,
 * whose `header.roomLists` lists every real board with its slug, so the target for
 * the next session cost nothing to find. That is the second time reading a
 * disappointing capture closely has been worth more than the capture was.
 *
 * It took three sessions to get here and each one was a different lesson, which is
 * the thing this file exists to keep:
 *
 * 1. The first returned 259 titles, 259 hrefs and **six null fields on every row**.
 *    Not wrong selectors: a wrong scope. `closest("li, article, tr, div[class]")`
 *    stopped at `<div class="pt-list-item__title">`, so every field was searched for
 *    inside the title. The row is now found structurally — climb while the ancestor
 *    belongs to this topic alone — which uses no class names at all.
 * 2. All thirty stored fragments were cropped to that same wrong scope, so the bytes
 *    could not explain their own nulls. A fragment is meant to make a wrong guess a
 *    re-parse instead of a session, and it cannot do that for the one kind of wrong
 *    guess that also crops the fragment. Fragments now come from one level above the
 *    row, which is what made findings 3 and 4 free.
 * 3. `<span title="9 กันยายน 2569 เวลา 23:58 น.">9 ก.ย.</span>` — no `abbr`, no
 *    `<time>`, no class with "date" in it, so four guesses missed and the attribute
 *    turned out to hold the better value anyway.
 * 4. Counts read as `"message39"`, because Material Icons puts the glyph's *name* in
 *    the element's text. Harmless with today's icons and silently wrong with the
 *    next ones: `parseCount("thumb_up_2 12")` is 212.
 *
 * Findings 3 and 4 were read out of fragment bytes already on disk and cost no
 * session at all. That is the mechanism working, one iteration after it failed to.
 */
const forum = readFixture<PantipPayload>(DIR, "pantip-forum-th-TH-2026-09-13")
const forumItems = createPantipAdapter("forum").parse(forum)

describe("the recorded tag capture", () => {
  it("is the session it says it is", () => {
    expect(capture.sourceId).toBe("pantip.tag")
    expect(capture.query).toBe("อารีย์")
    expect(capture.payload.surface).toBe("tag")
    expect(capture.url).toContain("pantip.com/tag/")
  })

  it("is a page that does not exist, in both of the ways the page says so", () => {
    expect(capture.payload.pageTitle).toContain("ไม่พบหน้านี้")
    expect(capture.payload.state).toContain('"notFound":true')
    expect(capture.payload.topics).toHaveLength(0)
    expect(capture.payload.posts).toHaveLength(0)
  })

  it("was recorded before the 404 clause existed, and is refused by the current one", () => {
    // The capture on disk was written with `refusedBy` undefined — that is the
    // finding, preserved. Re-running the shipped adapter's judgement over the same
    // read is not possible from a fixture, so the closest available assertion is
    // that the clause which now exists would fire on these bytes.
    expect(capture.refusedBy).toBeUndefined()
    expect(/"notFound"\s*:\s*true/.test(capture.payload.state ?? "")).toBe(true)
  })

  it("yields nothing, and that is the correct answer for a page that is not there", () => {
    expect(items).toHaveLength(0)
  })

  it("kept the diagnostics that explain the zero", () => {
    // A row of zeroes is still a measurement: it says the selectors were run and the
    // page had nothing for them, which is different from the selectors never running.
    expect(capture.payload.strategies.state).toBe(true)
    expect(capture.payload.stateLength).toBeGreaterThan(20_000)
    expect(Object.values(capture.payload.nodeCounts).every((n) => n === 0)).toBe(true)
    expect(capture.payload.fragmentsStored).toBe(0)
    expect(capture.payload.scrolls).toBeGreaterThan(0)
  })

  it("shows both diagnostics that were broken when it was taken", () => {
    // Kept as evidence rather than repaired in the file. `stateCandidates` is empty
    // because `Object.keys` could not see past the window's own properties;
    // `stateKeys` names `__NEXT_DATA__` unlabelled because the element case had no
    // label yet. A later capture is what will show the fixes working — this one is
    // what shows why they exist.
    expect(capture.payload.stateCandidates).toEqual([])
    expect(capture.payload.stateKeys).toEqual(["__NEXT_DATA__", "script#__NEXT_DATA__"])
  })
})

describe("the committed file", () => {
  it("no longer carries the address it was recorded with", () => {
    // The specific bytes, named. This is the assertion the whole session paid for.
    const json = JSON.stringify(capture)
    expect(json).toContain("[redacted-opaque]")
    expect(json).not.toMatch(/(?:[0-9A-Fa-f]{1,4}:){3,}[0-9A-Fa-f]{1,4}/)
    expect(json).not.toContain('"ipv6"')
  })

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
    for (const path of capture.payload.observedPaths) {
      expect(path).not.toContain("?")
    }
  })

  it("is small enough that a person will actually read it before committing it", () => {
    // `fixture.ts` warns that a 2 MB fixture is one nobody reviews. This one is 23 KB
    // and was read end to end, which is how two of the four findings were found.
    expect(JSON.stringify(capture).length).toBeLessThan(200_000)
  })
})

describe("the recorded forum capture", () => {
  it("is a real board, found in the failed capture's own state blob", () => {
    expect(forum.sourceId).toBe("pantip.forum")
    expect(forum.url).toBe("https://pantip.com/forum/food")
    expect(forum.payload.pageTitle).toContain("ก้นครัว")
    expect(forum.refusedBy).toBeUndefined()
  })

  it("reads every field the page actually carries", () => {
    // 254 of 259 on five fields. The five that are not are the promoted carousel at
    // the top of the board, whose rows carry a title and a picture and no byline —
    // so the gap is the page's, not the parser's, and the assertion says 254 rather
    // than 259 deliberately.
    const filled = (f: keyof (typeof forum.payload.topics)[number]) =>
      forum.payload.topics.filter((t) => {
        const v = t[f]
        return Array.isArray(v) ? v.length > 0 : v !== null && v !== ""
      }).length
    expect(forum.payload.topics).toHaveLength(259)
    expect(filled("authorName")).toBe(254)
    expect(filled("authorHref")).toBe(254)
    expect(filled("timeLabel")).toBe(254)
    expect(filled("voteLabel")).toBe(254)
    expect(filled("commentLabel")).toBe(254)
  })

  it("reads no views and no excerpt, because this listing has neither", () => {
    // Deliberately asserted as zero rather than left unmentioned. A board row shows
    // a title, an author, a date, votes and comments — there is no view count and no
    // preview text anywhere in the markup. The selectors stay, because a topic page
    // and another board may differ, but nobody should read these nulls as a defect
    // and go shopping for a fix.
    expect(forum.payload.topics.every((t) => t.viewLabel === null)).toBe(true)
    expect(forum.payload.topics.every((t) => t.excerpt === null)).toBe(true)
  })

  it("counts are clean of the icon that sits inside them", () => {
    // `<span class="pt-li_stats-comment"><i class="material-icons">message</i>39</span>`
    // used to read as `"message39"`. Every count in this file is digits and
    // separators only, which is the assertion that would have caught it.
    for (const topic of forum.payload.topics) {
      if (topic.voteLabel !== null) expect(topic.voteLabel).toMatch(/^[\d,.]+$/)
      if (topic.commentLabel !== null) expect(topic.commentLabel).toMatch(/^[\d,.]+$/)
    }
  })

  it("timestamps are absolute, not relative", () => {
    // The `title` attribute, carrying a year and a clock. A relative label is only
    // meaningful next to the day it was read on, and a fixture outlives that day.
    const stamped = forum.payload.topics.find((t) => t.timeLabel !== null)
    expect(stamped?.timeLabel).toMatch(/\d{4}/)
    expect(stamped?.timeLabel).toContain("น.")
  })

  it("fragments come from above the row, so the next scope error is readable", () => {
    // The fix for finding 2, asserted on real bytes: a fragment contains its own row
    // and at least one sibling row, which is what lets a row identified one level too
    // low be spotted without opening a browser.
    const withFragment = forum.payload.topics.filter((t) => t.fragment !== null)
    expect(withFragment.length).toBe(30)
    const [first] = withFragment
    expect(first?.fragment).toContain("pt-list-item")
    expect(first?.fragment).toMatch(/\/topic\/\d+[\s\S]*\/topic\/\d+/)
  })

  it("yields Thai items with engagement on them", () => {
    expect(forumItems).toHaveLength(259)
    expect(forumItems.filter((i) => i.languageGuess === "th").length).toBeGreaterThan(240)
    const scored = forumItems.filter((i) => i.engagement !== null)
    expect(scored).toHaveLength(254)
    // Views stay null rather than becoming zero. Nobody said these threads have no
    // readers; the page never showed a number.
    expect(scored.every((i) => i.engagement?.views === null)).toBe(true)
    expect(scored.some((i) => (i.engagement?.comments ?? 0) > 0)).toBe(true)
  })

  it("carries no listing thumbnail, which is a gap and not a defect", () => {
    // Written down because the bytes to close it are already paid for. The row's
    // picture is a CSS background — `<div class="pt-list-item__img" data-bg="https://
    // ptcdn.info/…jpg">` — and `mediaRefs` reads `<img src>`, which a listing row has
    // none of. Adding it is a payload field and a parse change rather than a fix, so
    // it is not being smuggled in here; whenever it is wanted, the fragments in this
    // file answer it without a session.
    expect(forumItems.every((i) => i.mediaRefs.length === 0)).toBe(true)
  })

  it("shows both repaired diagnostics working, which the tag capture could not", () => {
    // `stateCandidates` is no longer empty, so `for...in` reaches past the window's
    // own properties — the two names it found are browser constants on
    // `Window.prototype` rather than anything Pantip put there, which is exactly the
    // proof wanted: those are names `Object.keys` cannot see. And `stateKeys` now
    // says which entry was an element rather than a payload.
    expect(forum.payload.stateCandidates.length).toBeGreaterThan(0)
    expect(forum.payload.stateKeys[0]).toBe("__NEXT_DATA__ (element)")
  })
})

describe("the committed forum file", () => {
  it("had the shapes taken out of it that the tag capture taught us to look for", () => {
    // Two opaque blobs and a named value, redacted at capture time by rules that did
    // not exist when the first session ran. This is the first file in the project
    // written by the fixed list rather than repaired by it.
    const json = JSON.stringify(forum)
    expect(json).toContain("[redacted-opaque]")
    expect(json).not.toMatch(/(?:[0-9A-Fa-f]{1,4}:){3,}[0-9A-Fa-f]{1,4}/)
  })

  it("carries no credential shape, re-checked against the current patterns", () => {
    const json = JSON.stringify(forum)
    for (const [pattern] of SHAPE_REDACTIONS) {
      expect(json).not.toMatch(new RegExp(pattern.source, pattern.flags.replace("g", "")))
    }
  })

  it("holds paths and never query strings", () => {
    for (const path of forum.payload.observedPaths) expect(path).not.toContain("?")
  })

  it("is 259 KB, which is the largest file here anybody has actually read", () => {
    // `fixture.ts` warns that a 2 MB fixture is one nobody reviews. Most of this one
    // is 30 fragments of real markup, which is the part that earns its bytes: two of
    // the four findings above were read out of them for free.
    expect(JSON.stringify(forum).length).toBeLessThan(400_000)
  })
})
