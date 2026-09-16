import { describe, expect, it } from "vitest"
import { readFixture } from "../fixture.js"
import { REDACTED_KEYS } from "./capture.js"
import { createTikTokAdapter } from "./index.js"
import type { TikTokPayload } from "./types.js"

/**
 * The parser, run against bytes TikTok actually sent.
 *
 * Everything in `parse.test.ts` is a tree I wrote, and its header says what that
 * can and cannot prove: a hand-built tree shows the predicate accepts what I
 * *think* an item looks like. This file is the other half. One browser session
 * was spent from a Singapore egress with a `vi-VN` persona, on 2026-09-13, asking
 * `bánh mì`; the capture is checked in; every assertion below is about what came
 * back rather than about what I expected to come back.
 *
 * That distinction is sharper for TikTok than for any other adapter here, because
 * this parser recognises items **structurally** — a digit `id`, a string `desc`,
 * an author or stats block — and a structural matcher is the kind that passes its
 * author's tests and returns hashtags in production.
 *
 * **The fixture is not a screenshot of a website.** It is the redacted payload,
 * and `capture.ts`'s `REDACTED_KEYS` is what did the redacting. The last test
 * here re-runs that audit against the file, because the list grows every time
 * somebody reads a real page and a fixture that was clean against the old list
 * has not been checked against the new one.
 */

const DIR = new URL("./__fixtures__", import.meta.url).pathname
const NAME = "tiktok-search-vi-VN-2026-09-13"

const capture = readFixture<TikTokPayload>(DIR, NAME)
const items = createTikTokAdapter("search").parse(capture)

describe("the recorded search capture", () => {
  it("is the session it says it is", () => {
    expect(capture.sourceId).toBe("tiktok.search")
    expect(capture.query).toBe("bánh mì")
    expect(capture.url).toContain("lang=vi")
    expect(capture.refusedBy).toBeUndefined()
  })

  it("carries the viewpoint through to TikTok, which is the measurement", () => {
    // P1.0's open question for this adapter was whether the rented egress and the
    // persona locale reach the source at all — TikTok takes region from the IP and
    // has no URL parameter for it. They do: TikTok answered as Singapore, in
    // Vietnamese, and said so in the state it shipped back.
    const scope = (capture.payload.state as Record<string, Record<string, unknown>>)
      .__DEFAULT_SCOPE__ as Record<string, Record<string, unknown>>
    expect(scope["webapp.app-context"]).toMatchObject({
      language: "vi-VN",
      region: "SG",
      clusterRegion: "ALL_SG",
    })
  })

  it("holds both strategies, which is why it holds anything", () => {
    // The document carried the state *and* the page made one item API call. The
    // state alone parses to nothing on this surface — search is rendered entirely
    // client-side — so a capture that took only the first strategy would have been
    // a successful session with no results, which is the failure this payload shape
    // exists to prevent.
    expect(capture.payload.strategies).toEqual({ state: true, intercepted: 1 })
    expect(capture.payload.intercepted[0]?.path).toBe("/api/search/general/full/")
    expect(capture.payload.tiles).toBe(14)
  })

  it("recorded the traffic it did not keep", () => {
    // 104 distinct paths, one of which was the endpoint on the list. The other 103
    // are why `observedPaths` exists: when this stops matching, the list tells the
    // next person whether TikTok went quiet or merely moved.
    expect(capture.payload.observedPaths.length).toBeGreaterThan(50)
    expect(capture.payload.observedPaths).toContain("/api/search/general/full/")
    for (const path of capture.payload.observedPaths) {
      expect(path).not.toContain("?")
    }
  })
})

describe("what the parser makes of it", () => {
  it("finds the results and not the furniture", () => {
    // Thirteen items from a page whose API response held thirteen. The number is
    // pinned deliberately: a structural matcher that starts returning music tracks,
    // hashtags or related-search suggestions will return *more* than this, and a
    // matcher that goes stale will return fewer. Both directions are a failure and
    // a range assertion would catch neither.
    expect(items).toHaveLength(13)
  })

  it("addresses every draft to a real post", () => {
    for (const item of items) {
      expect(item.url).toMatch(/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d{15,}$/)
    }
    expect(new Set(items.map((item) => item.url)).size).toBe(items.length)
  })

  it("keeps the text in the language it was written in", () => {
    // Never translated at capture or parse time, and detected rather than assumed:
    // ten of the thirteen came back `vi`, one `en`, two undetectable because they
    // are an emoji and a two-word caption. That distribution is the evidence that
    // a Vietnamese persona on a Singapore egress is served Vietnamese results.
    const vietnamese = items.filter((item) => item.languageGuess === "vi")
    expect(vietnamese.length).toBeGreaterThanOrEqual(9)
    expect(items.find((item) => item.text.includes("Bánh mì xoay"))).toBeDefined()
  })

  it("reads engagement for all of them, and reads it as numbers", () => {
    for (const item of items) {
      expect(item.engagement).not.toBeNull()
      expect(item.engagement?.views).toBeGreaterThan(0)
    }
    // Spot-checked against the recorded body rather than merely "is a number":
    // `parseCount` exists because these arrive as `1.2M` on some surfaces, and a
    // parser that silently returns 1 for `1.2M` passes every shape test there is.
    const first = items[0]
    expect(first?.engagement).toEqual({ views: 120_100, likes: 639, comments: 155 })
  })

  it("keeps a media reference for every draft", () => {
    // The cover URLs are signed and they expire, and they are still kept — the
    // decision recorded next to `playAddr` in `REDACTED_KEYS`. This is the test
    // that fails if somebody redacts them for looking like credentials: the covers
    // are not a leak, they are what `mediaRefs` *is*.
    for (const item of items) {
      expect(item.mediaRefs.length).toBeGreaterThan(0)
    }
  })
})

describe("the bytes that are checked in", () => {
  it("carries no key the redaction list names", () => {
    // Re-audits the committed file against the current list rather than against
    // the list that was current when it was recorded. When somebody adds a key
    // after reading a new capture, this fails until the fixture is re-redacted —
    // which is the whole point, because the alternative is a public repository
    // holding bytes that today's code would never have written.
    const found: string[] = []
    const walk = (node: unknown, trail: string) => {
      if (Array.isArray(node)) {
        node.forEach((entry, index) => {
          walk(entry, `${trail}/${index}`)
        })
        return
      }
      if (node === null || typeof node !== "object") return
      for (const [key, value] of Object.entries(node)) {
        if (REDACTED_KEYS.has(key)) found.push(`${trail}/${key}`)
        walk(value, `${trail}/${key}`)
      }
    }
    walk(capture.payload, "payload")

    expect(found).toEqual([])
  })

  it("carries no way to contact anybody in it", () => {
    // The key walk above already covers `signature` by name, and this asserts the
    // same subject through a different representation, because the last three
    // defects in this repository were all a guard that covered one representation of
    // something and a leak through another. An address can also arrive in a video
    // description or a comment, which no denylist of key names is watching.
    //
    // Email shapes only. A phone pattern over the whole file would match the 273
    // ten-digit resource ids in it — see `CONTACT_SHAPES` in `redact.ts`, and the
    // reason it is applied by field name rather than everywhere.
    const json = JSON.stringify(capture)
    expect(json).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    const folded = [...json]
      .map((ch) => {
        const n = ch.normalize("NFKC")
        return n.length === 1 ? n : "\uFFFF"
      })
      .join("")
    expect(folded).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  })

  it("carries no bearer-shaped string", () => {
    // Belt and braces over the key-name walk above, and not a theoretical one: the
    // capture as recorded held a live Apple Music developer JWT, four levels inside
    // a music object, under a key no list written from TikTok's own vocabulary
    // would have contained. A denylist cannot find the next one of those. A shape
    // check at least notices it.
    const json = JSON.stringify(capture)
    expect(json).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/)
  })
})
