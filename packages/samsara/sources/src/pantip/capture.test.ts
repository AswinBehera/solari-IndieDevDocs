import { silentLogger } from "@samsara/kernel"
import { describe, expect, it } from "vitest"
import type { CaptureContext } from "../adapter.js"
import {
  buildForumUrl,
  buildPantipUrl,
  buildTagUrl,
  buildTopicUrl,
  capturePantip,
  type PantipCaptureOptions,
  type PantipPage,
  type PantipResponse,
  SHAPE_REDACTIONS,
} from "./capture.js"
import { type PantipPageRead, scrollPantipPage } from "./inpage.js"

/**
 * A page that was never loaded.
 *
 * `evaluate` dispatches on the **identity** of the function it is handed, which is
 * available because this test imports the same module `capture.ts` does. It matters
 * here because the scroll loop and the read are two different in-page functions in a
 * fixed order, and a fake that ignored which one it was asked for could not tell
 * "scrolled twice, then read" from "read, then never scrolled".
 *
 * What those functions do against Pantip's markup is `inpage.test.ts`'s job.
 */
function fakePage(
  read: Partial<PantipPageRead> = {},
  options: { href?: string; heights?: number[] } = {},
) {
  const visited: string[] = []
  const calls: string[] = []
  let handler: ((response: PantipResponse) => void) | null = null
  let scroll = 0

  const here = () => options.href ?? visited[visited.length - 1] ?? ""

  const page = {
    async goto(url: string) {
      visited.push(url)
      return null
    },
    url: here,
    async evaluate(fn: unknown, arg?: unknown) {
      if (fn === scrollPantipPage) {
        const heights = options.heights ?? [100, 200, 200]
        const height = heights[Math.min(scroll, heights.length - 1)] ?? 0
        scroll += 1
        calls.push(`scroll:${height}`)
        return height
      }
      calls.push(`read:${JSON.stringify(arg)}`)
      return {
        topics: [],
        posts: [],
        state: null,
        stateLength: null,
        stateKeys: [],
        stateCandidates: [],
        nodeCounts: {},
        fragmentsStored: 0,
        wall: null,
        title: "Pantip",
        href: here(),
        ...read,
      }
    },
    on(_event: "response", fn: (response: PantipResponse) => void) {
      handler = fn
    },
    off() {
      handler = null
    },
    async waitForTimeout() {},
  }

  const respond = (url: string) => {
    handler?.({ url: () => url, status: () => 200 })
  }
  return { page: page as unknown as PantipPage, visited, calls, respond }
}

/**
 * A persona this adapter reads no field of.
 *
 * Deliberately not a Thai one, and the reason is the point rather than a dodge:
 * `buildPantipUrl` takes no viewpoint parameter at all, so which persona is in the
 * context changes nothing this file can assert. Everything the source will see
 * arrives through the egress address and the browser's own headers. The seam check
 * also forbids the name of Thailand's only timezone anywhere under
 * `packages/samsara`, which is the rule working as intended on a file that has no
 * need of it.
 */
const PERSONA = { id: "p1", country: "sg", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" }

function ctx(page: PantipPage): CaptureContext {
  return { page, persona: PERSONA, logger: silentLogger, signal: new AbortController().signal }
}

/** No settle anywhere in this file: a test must not sit on a clock. */
const FAST: PantipCaptureOptions = { settleMs: 0 }

function topicNode(over: Record<string, unknown> = {}) {
  return {
    href: "/topic/43210987",
    title: "หัวข้อ",
    authorName: null,
    authorHref: null,
    tagLabels: [],
    timeLabel: null,
    voteLabel: null,
    commentLabel: null,
    viewLabel: null,
    excerpt: null,
    fragment: null,
    ...over,
  }
}

function postNode(over: Record<string, unknown> = {}) {
  return {
    role: "opening" as const,
    postId: null,
    authorName: null,
    authorHref: null,
    timeLabel: null,
    text: null,
    mediaRefs: [],
    voteLabel: null,
    fragment: null,
    ...over,
  }
}

describe("the url", () => {
  it("takes the board id as a parameter and refuses a path", () => {
    // The plan says board ids are a parameter, and the seam says this package may
    // not name one. A slug is a parameter; `../../admin` is a navigation target.
    expect(buildForumUrl("food")).toBe("https://pantip.com/forum/food")
    expect(() => buildForumUrl("../admin")).toThrow(/board id/)
    expect(() => buildForumUrl("food/hot")).toThrow(/board id/)
  })

  it("encodes a Thai tag rather than putting it in the path raw", () => {
    expect(buildTagUrl("อารีย์")).toBe(`https://pantip.com/tag/${encodeURIComponent("อารีย์")}`)
    expect(() => buildTagUrl("   ")).toThrow(/tag/)
  })

  it("accepts a topic id or a Pantip address, and drops the tracking on it", () => {
    // A topic link copied out of a listing carries whatever the listing attached to
    // it, and none of it identifies the topic.
    expect(buildTopicUrl("43210987")).toBe("https://pantip.com/topic/43210987")
    expect(buildTopicUrl("https://pantip.com/topic/43210987?ref=recommend#comment-4")).toBe(
      "https://pantip.com/topic/43210987",
    )
  })

  it("refuses to navigate anywhere that is not Pantip", () => {
    // `pantip.topic` navigates to its query, and the query arrives from a previous
    // capture. An adapter that will go anywhere on request is a proxy with this
    // project's egress address on it.
    expect(() => buildTopicUrl("https://example.com/topic/1")).toThrow(/expects a Pantip URL/)
    expect(() => buildTopicUrl("http://pantip.com/topic/1")).toThrow(/expects a Pantip URL/)
    expect(() => buildTopicUrl("https://pantip.com.evil.test/topic/1")).toThrow(/expects/)
  })

  it("sets no viewpoint parameter, because Pantip has none", () => {
    // No `hl`, no `gl`. The persona reaches this source through the egress address
    // and the browser's own headers and in no other way — which makes it the
    // cleanest test in the set of whether a rented egress is worth anything alone.
    for (const url of [buildPantipUrl("forum", "food"), buildPantipUrl("tag", "อารีย์")]) {
      expect(new URL(url).search).toBe("")
    }
  })
})

describe("what the session spends", () => {
  it("stops scrolling when the page stops growing", async () => {
    // Every round is billed, and a round that buys nothing costs exactly as much as
    // one that does — so the loop watches the height rather than a counter.
    const { page } = fakePage({ topics: [topicNode()] }, { heights: [100, 200, 200, 300] })
    const capture = await capturePantip(ctx(page), "food", "forum", FAST)
    expect(capture.payload.scrolls).toBe(3)
  })

  it("never scrolls past the cap, however much the page grows", async () => {
    const heights = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const { page } = fakePage({ topics: [topicNode()] }, { heights })
    const capture = await capturePantip(ctx(page), "food", "forum", {
      settleMs: 0,
      maxScrolls: 3,
    })
    expect(capture.payload.scrolls).toBe(3)
  })

  it("reads once, after the scrolling, and hands the limits across", async () => {
    const { page, calls } = fakePage({ topics: [topicNode()] }, { heights: [100, 100] })
    await capturePantip(ctx(page), "food", "forum", {
      settleMs: 0,
      maxFragments: 5,
      fragmentChars: 99,
    })
    expect(calls.filter((call) => call.startsWith("read:"))).toHaveLength(1)
    expect(calls[calls.length - 1]).toBe(`read:{"maxFragments":5,"fragmentChars":99}`)
  })

  it("keeps the paths the page asked for, without the query strings", async () => {
    const { page, respond } = fakePage({ topics: [topicNode()] })
    const pending = capturePantip(ctx(page), "food", "forum", FAST)
    respond("https://pantip.com/api/forum/food?token=secret")
    respond("https://pantip.com/api/forum/food?page=2")
    respond("https://f.ptcdn.info/1.jpg")
    const capture = await pending
    expect(capture.payload.observedPaths).toEqual(["/1.jpg", "/api/forum/food"])
    expect(JSON.stringify(capture.payload.observedPaths)).not.toContain("secret")
  })

  it("reports the read as strategies, so an empty capture still says what happened", async () => {
    const { page } = fakePage({
      topics: [topicNode()],
      posts: [postNode()],
      state: "{}",
      nodeCounts: { 'a[href*="/topic/"]': 1 },
      fragmentsStored: 1,
    })
    const capture = await capturePantip(ctx(page), "43210987", "topic", FAST)
    expect(capture.payload.strategies).toEqual({ state: true, topics: 1, posts: 1 })
    expect(capture.payload.fragmentsStored).toBe(1)
    expect(capture.payload.nodeCounts['a[href*="/topic/"]']).toBe(1)
  })
})

describe("what counts as a refusal", () => {
  async function refusal(read: Partial<PantipPageRead>, surface: "forum" | "tag" | "topic") {
    const { page } = fakePage(read, { href: "https://pantip.com/x" })
    const query = surface === "topic" ? "43210987" : "food"
    return (await capturePantip(ctx(page), query, surface, FAST)).refusedBy
  }

  it("names the wall it hit", async () => {
    expect(await refusal({ wall: "captcha" }, "forum")).toBe("captcha")
    // A login wall is not aimed at us, and it is still a refusal: it degrades a
    // persona that did nothing wrong, which is an admitted cost taken because a
    // harvest that silently returns nothing from behind a wall is worse.
    expect(await refusal({ wall: "login" }, "forum")).toBe("login-wall")
  })

  it("says where it ended up when it ended up somewhere else", async () => {
    const { page } = fakePage({ topics: [topicNode()] }, { href: "https://consent.example.test/x" })
    const capture = await capturePantip(ctx(page), "food", "forum", FAST)
    expect(capture.refusedBy).toBe("redirected to consent.example.test")
  })

  it("knows a topic capture that never left the board", async () => {
    // Listing rows and no posts is a different bug from a topic that would not
    // load, and it would otherwise be reported as an empty topic.
    expect(await refusal({ topics: [topicNode(), topicNode({ href: "/topic/2" })] }, "topic")).toBe(
      "still on a listing (2 row(s), no post)",
    )
  })

  it("reports the title it did land on when there was nothing to read", async () => {
    expect(await refusal({ title: "ไม่พบกระทู้" }, "topic")).toBe(
      "no post and no state (title: ไม่พบกระทู้)",
    )
    expect(await refusal({ title: "" }, "tag")).toBe("no topic link and no state (title: none)")
  })

  it("does not call an honest zero a refusal", async () => {
    // A quiet tag and a topic nobody answered are honest zeroes. The orchestrator
    // has an `empty` outcome for them, and folding them into `blocked` would
    // degrade a persona over a typo and make a real block indistinguishable from a
    // real absence.
    expect(await refusal({ topics: [], state: "{}" }, "tag")).toBeUndefined()
    expect(await refusal({ posts: [postNode()] }, "topic")).toBeUndefined()
  })

  it("calls a 404 a refusal, which cost a session to learn", async () => {
    // The first real `pantip.tag` capture. Pantip is a Next.js site, so a page that
    // does not exist is a 200 carrying `__NEXT_DATA__` like any other, and every
    // clause above reads "a state blob was read" as "the page was real". It reported
    // zero items and `refused: no` — a tag that does not exist telling exactly the
    // same story as a tag nobody posts in. That is the P1.5 Maps finding inverted,
    // and the worse direction: an honest zero is the one nobody investigates.
    const state = JSON.stringify({ props: { initialProps: { pageProps: { notFound: true } } } })
    expect(await refusal({ state, title: "ไม่พบหน้านี้ - Pantip" }, "tag")).toBe(
      "not found (title: ไม่พบหน้านี้ - Pantip)",
    )
    // Every surface, because the flag is the site's and not a surface's. (The fake
    // page's default title stands in for the one a real 404 would carry.)
    expect(await refusal({ state }, "forum")).toBe("not found (title: Pantip)")
    expect(await refusal({ state }, "topic")).toBe("not found (title: Pantip)")
  })

  it("does not call a page a 404 because the flag is false, or because rows came back", async () => {
    // Two guards on the clause, and both are load-bearing. `notFound: false` is on
    // every page that *did* resolve, so matching the key alone would refuse the
    // entire site. And a page that rendered rows rendered something, whatever a
    // sub-resource's props say about itself — the measurement is worth more than
    // the flag.
    const no = JSON.stringify({ props: { pageProps: { notFound: false } } })
    expect(await refusal({ state: no }, "tag")).toBeUndefined()
    const yes = JSON.stringify({ props: { pageProps: { notFound: true } } })
    expect(await refusal({ state: yes, topics: [topicNode()] }, "tag")).toBeUndefined()
    expect(await refusal({ state: yes, posts: [postNode()] }, "topic")).toBeUndefined()
  })
})

describe("what leaves the page", () => {
  it("scrubs by shape on every field that stores markup or a blob", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"
    const { page } = fakePage({
      topics: [
        topicNode({ excerpt: `x ${jwt}`, fragment: `<input name="csrf_token" value="s3cr3t">` }),
      ],
      posts: [
        postNode({
          text: `Bearer abcdefghijklmnopqrstuvwx`,
          fragment: `<a href="/x?sid=abc123">y</a>`,
        }),
      ],
      state: `{"t":"${jwt}"}`,
    })
    const capture = await capturePantip(ctx(page), "43210987", "topic", FAST)
    const [topic] = capture.payload.topics
    const [post] = capture.payload.posts
    expect(topic?.excerpt).toBe("x [redacted-jwt]")
    expect(topic?.fragment).toContain("[redacted]")
    expect(topic?.fragment).not.toContain("s3cr3t")
    expect(post?.text).toBe("Bearer [redacted]")
    expect(post?.fragment).toBe(`<a href="/x?sid=[redacted]">y</a>`)
    expect(capture.payload.state).not.toContain("eyJhbGciOiJIUzI1NiJ9")
  })

  it("is a pattern list, which is the weaker instrument, and only guards what nothing reads", () => {
    // The argument for shape redaction is that a false positive is free here: the
    // blob and the fragments are write-only today. The day something parses a
    // fragment that stops being true and the argument has to be made again.
    expect(SHAPE_REDACTIONS.length).toBeGreaterThan(0)
    const unnamed = "sessionid=9f8e7d6c5b4a39281706"
    let out = unnamed
    for (const [pattern, replacement] of SHAPE_REDACTIONS) out = out.replace(pattern, replacement)
    expect(out).toBe(unnamed)
  })

  it("carries the address it landed on, not the one it asked for", async () => {
    const { page } = fakePage(
      { topics: [topicNode()] },
      { href: "https://pantip.com/tag/%E0%B8%AD%E0%B8%B2%E0%B8%A3%E0%B8%B5%E0%B8%A2%E0%B9%8C?p=2" },
    )
    const capture = await capturePantip(ctx(page), "อารีย์", "tag", FAST)
    expect(capture.url).toContain("?p=2")
    expect(capture.sourceId).toBe("pantip.tag")
    expect(capture.query).toBe("อารีย์")
  })
})
