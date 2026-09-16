import type { Capture, CaptureContext } from "../adapter.js"
import { BASE_REDACTIONS, redactContacts, redactShapes } from "../redact.js"
import { type PantipPageRead, readPantipPage, scrollPantipPage } from "./inpage.js"
import type { PantipPayload, PantipSurface } from "./types.js"

/**
 * The half that spends, on the first source that gives something back for it.
 *
 * Three surfaces, two shapes of page, one parser. `pantip.forum` takes a board id,
 * `pantip.tag` takes a tag, and both return a listing; `pantip.topic` takes a topic
 * and returns the writing. The chaining is the caller's, on the same reasoning the
 * Maps pair is split under: a `capture()` that listed a board and then opened every
 * topic on it is one session whose length is a function of a page nobody has loaded,
 * and the budget guard meters sessions.
 *
 * **The board id and the tag are parameters, and this file names neither.** The plan
 * says so for the engine's sake, and the seam enforces it: a list of boards belongs
 * in a job payload, where a human chose it and can change it without a deploy.
 *
 * **The tag surface is an addition to the plan's letter, and a small one.** P1.5's
 * brief and this one both aim at Thai-language areas, and an area on Pantip is a tag
 * rather than a board — the boards are named after streets in the capital and have
 * nothing to do with what a thread is about. It costs one URL builder and shares the
 * listing parser exactly.
 *
 * **Nothing here sets a viewpoint parameter, because Pantip has none.** No `hl`, no
 * `gl`, no `lang`. The persona reaches this source through the egress address and
 * the browser's own locale headers and in no other way, which makes it the cleanest
 * test in the set of whether a rented egress is worth anything on its own — and the
 * one adapter where P1.0's "query language dominates" finding cannot apply, since
 * every query and every answer is in one language.
 */

/** The slice of Playwright's `Page` this adapter uses — and the fake must fake. */
export interface PantipPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  url(): string
  evaluate<R>(fn: () => R): Promise<R>
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>
  on(event: "response", handler: (response: PantipResponse) => void): void
  off?(event: "response", handler: (response: PantipResponse) => void): void
  waitForTimeout?(ms: number): Promise<void>
}

export interface PantipResponse {
  url(): string
  status(): number
}

export interface PantipCaptureOptions {
  timeoutMs?: number
  settleMs?: number
  maxScrolls?: number
  maxFragments?: number
  fragmentChars?: number
}

/**
 * Server-rendered HTML, so the read does not wait on an XHR the way Maps and TikTok
 * do. Not zero: a listing hydrates, and reading during hydration reads half a list.
 */
export const DEFAULT_SETTLE_MS = 1_200

/** A listing pages as you scroll. Four rounds is a screenful or two of a busy board. */
export const MAX_SCROLLS = 4

/**
 * How much of the page to keep verbatim, and why keeping any of it is new here.
 *
 * Every other adapter in this package stores what it managed to extract, and P1.5
 * measured the price of that: when a selector is wrong, the bytes cannot tell you
 * what the right one was, so correcting it costs a browser session. Pantip is
 * server-rendered plain HTML, which makes a middle path available — store the
 * extracted fields *and* the markup each one came from, and a wrong selector becomes
 * a re-parse of bytes we already hold.
 *
 * Capped hard, because the same session that makes a fixture useful makes it
 * unreadable if it is a megabyte: 30 fragments at 3,000 characters is about 90 KB,
 * against `fixture.ts`'s standing warning that a 2 MB fixture is one nobody reviews.
 * Scripts, styles and frames are stripped in the page before the fragment is taken —
 * the markup around a post is content, and an inline script inside it is where a
 * token would be.
 */
export const MAX_FRAGMENTS = 30
export const FRAGMENT_CHARS = 3_000

/** See `observedPaths`. Enough to show the shape of the traffic, not its volume. */
const MAX_OBSERVED_PATHS = 120

/**
 * Pantip's redactions are exactly the shared ones, and that is the finding.
 *
 * They live in `../redact.ts` because this adapter is where they were earned: the
 * first `pantip.tag` session came back with the session's own egress IPv6 inside a
 * doubly base64-encoded field, invisible to every pattern that existed at the time.
 * Nothing in that shape is specific to this site, so nothing in the fix is either.
 * See that file for the two principles and for what they are allowed to damage.
 *
 * Site-specific shapes would be appended here. Pantip has none that have been
 * measured; the day one turns up, it goes in this array and not in the shared file.
 */
export const SHAPE_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [...BASE_REDACTIONS]

/** Board ids are slugs. Anything else is a path, and a path is a navigation target. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/
/** The numeric form of a topic, which is the only form this adapter mints. */
const TOPIC_NUMBER = /^\d{1,12}$/

export function buildForumUrl(boardId: string): string {
  if (!BOARD_ID.test(boardId)) {
    throw new Error(`pantip.forum expects a board id, got ${boardId.slice(0, 40)}`)
  }
  return `https://pantip.com/forum/${boardId}`
}

export function buildTagUrl(tag: string): string {
  const trimmed = tag.trim()
  if (trimmed.length === 0) throw new Error("pantip.tag expects a tag")
  return `https://pantip.com/tag/${encodeURIComponent(trimmed)}`
}

/**
 * A topic id, or a Pantip URL carrying one.
 *
 * Validated rather than trusted, for the reason `maps/capture.ts` gives: an adapter
 * that will navigate anywhere on request is a proxy with our egress address on it.
 * The query string and fragment are dropped — a topic link copied out of a listing
 * carries whatever tracking the listing attached to it, and none of it identifies
 * the topic.
 */
export function buildTopicUrl(query: string): string {
  const trimmed = query.trim()
  if (TOPIC_NUMBER.test(trimmed)) return `https://pantip.com/topic/${trimmed}`
  const url = new URL(trimmed)
  if (url.protocol !== "https:" || !/(^|\.)pantip\.com$/.test(url.hostname)) {
    throw new Error(`pantip.topic expects a Pantip URL or a topic id, got ${url.hostname}`)
  }
  return `${url.origin}${url.pathname}`
}

export function buildPantipUrl(surface: PantipSurface, query: string): string {
  if (surface === "forum") return buildForumUrl(query)
  if (surface === "tag") return buildTagUrl(query)
  return buildTopicUrl(query)
}

export async function capturePantip(
  ctx: CaptureContext,
  query: string,
  surface: PantipSurface,
  options: PantipCaptureOptions = {},
): Promise<Capture<PantipPayload>> {
  const page = ctx.page as PantipPage
  const url = buildPantipUrl(surface, query)

  const observed = new Set<string>()
  const onResponse = (response: PantipResponse) => {
    if (observed.size >= MAX_OBSERVED_PATHS) return
    observed.add(pathOf(response.url()))
  }

  const settle = options.settleMs ?? DEFAULT_SETTLE_MS
  const pause = async () => {
    if (settle > 0 && page.waitForTimeout) await page.waitForTimeout(settle)
  }

  let scrolls = 0
  page.on("response", onResponse)
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 30_000 })
    await pause()

    // Stops when the page stops growing rather than always paying for the cap. A
    // height that does not change means there is nothing more to load, and a scroll
    // round that buys nothing is billed exactly like one that does.
    let lastHeight = -1
    const cap = options.maxScrolls ?? MAX_SCROLLS
    for (let round = 0; round < cap; round += 1) {
      const height = await page.evaluate(scrollPantipPage)
      scrolls += 1
      if (height === lastHeight) break
      lastHeight = height
      await pause()
    }
  } finally {
    page.off?.("response", onResponse)
  }

  const read = await page.evaluate(readPantipPage, {
    maxFragments: options.maxFragments ?? MAX_FRAGMENTS,
    fragmentChars: options.fragmentChars ?? FRAGMENT_CHARS,
  })

  const payload: PantipPayload = {
    surface,
    topics: read.topics.map((topic) => ({
      ...topic,
      // A title is prose. The sidebar of this board's first topic capture carried
      // "มีเบอร์ 027009089 โทรเข้ามาค่ะ" — *a number 027009089 called me* — and the
      // excerpt below it, which is the same sentence, came back redacted while the
      // title did not. Somebody's number, published by somebody else, kept because
      // of which field it landed in.
      title: scrubProse(topic.title),
      excerpt: scrubProse(topic.excerpt),
      fragment: scrub(topic.fragment),
    })),
    posts: read.posts.map((post) => ({
      ...post,
      text: scrubProse(post.text),
      fragment: scrub(post.fragment),
    })),
    // The topic's own title, by the same argument, and on a topic surface it is the
    // one field guaranteed to be somebody's sentence.
    // `scrubProse` returns null only for a null and a read always has a title, so the
    // fallback is unreachable; it is `""` rather than `read.title` so that the
    // unreachable branch drops the value instead of restoring the raw one.
    pageTitle: scrubProse(read.title) ?? "",
    state: scrub(read.state),
    stateLength: read.stateLength,
    stateKeys: read.stateKeys,
    stateCandidates: read.stateCandidates,
    nodeCounts: read.nodeCounts,
    observedPaths: [...observed].sort(),
    scrolls,
    fragmentsStored: read.fragmentsStored,
    strategies: {
      state: read.state !== null,
      topics: read.topics.length,
      posts: read.posts.length,
    },
  }

  const capture: Capture<PantipPayload> = {
    sourceId: `pantip.${surface}`,
    query,
    url: read.href || url,
    capturedAt: new Date(),
    payload,
  }

  const refusedBy = refusal(read, surface)
  return refusedBy ? { ...capture, refusedBy } : capture
}

/**
 * What counts as a refusal, and what does not.
 *
 * **Zero is not a refusal.** A quiet tag and a topic nobody answered are honest
 * zeroes; the orchestrator has an `empty` outcome for them, and folding them into
 * `blocked` would degrade a persona over a typo and make a real block
 * indistinguishable from a real absence.
 *
 * The structural clauses are about *reaching the page*. A topic capture holding
 * listing rows and no posts never left the board — a different bug from a topic that
 * would not load, and one that would otherwise be reported as an empty topic.
 *
 * A login wall is a refusal even though it is not aimed at us, on the precedent set
 * for TikTok: it degrades a persona that did nothing wrong, and that is an admitted
 * cost, taken because a harvest that silently returns nothing from behind a wall is
 * worse than one that says it was stopped.
 */
/**
 * A Next.js 404 as it appears in the payload it still ships.
 *
 * The site renders "not found" as a 200 with a flag in the state blob, so the
 * signal is `"notFound":true` and nothing else — no status code reaches this
 * function, and the page title is in Thai.
 */
const NOT_FOUND = /"notFound"\s*:\s*true/

function refusal(read: PantipPageRead, surface: PantipSurface): string | undefined {
  if (read.wall === "captcha") return "captcha"
  if (read.wall === "login") return "login-wall"
  const host = hostOf(read.href)
  if (host.length > 0 && !host.includes("pantip.")) return `redirected to ${host}`

  /**
   * The 404 clause, and it is the one the first real session paid for.
   *
   * `pantip.tag "อารีย์"` returned a page whose title was "ไม่พบหน้านี้" — this page
   * was not found — and whose state said `notFound: true`. Every refusal clause
   * below let it through, because they all treat "a state blob was read" as evidence
   * that the page was real, and on a Next.js site `__NEXT_DATA__` is served by the
   * 404 as faithfully as by anything else. So the capture reported zero items and
   * `refused: no`: a tag that does not exist, and a listing with nothing in it,
   * telling exactly the same story. That is the P1.5 Maps finding inverted — there,
   * a real page was called a refusal; here, a refusal was called a real page — and
   * it is the worse direction, because an honest zero is the one nobody investigates.
   *
   * Guarded on having found nothing, not on the flag alone: if rows or posts came
   * back, the page rendered something, and a `notFound` buried in a sub-resource's
   * props is not a reason to throw away what was measured.
   */
  if (
    read.state !== null &&
    NOT_FOUND.test(read.state) &&
    read.posts.length === 0 &&
    read.topics.length === 0
  ) {
    return `not found (title: ${read.title || "none"})`
  }
  if (surface === "topic") {
    if (read.posts.length === 0 && read.topics.length > 0) {
      return `still on a listing (${read.topics.length} row(s), no post)`
    }
    if (read.posts.length === 0 && read.state === null) {
      return `no post and no state (title: ${read.title || "none"})`
    }
  }
  if (surface !== "topic" && read.topics.length === 0 && read.state === null) {
    return `no topic link and no state (title: ${read.title || "none"})`
  }
  return undefined
}

/**
 * A field somebody wrote, as opposed to a field the page emitted.
 *
 * The split exists because one rule cannot cross it. `scrub` runs the shape list
 * over anything, including a state blob full of resource ids; `scrubProse` adds the
 * contact rules, which read a long run of digits as a phone number and would eat
 * those ids. Markup goes through `scrub` for the same reason — an `href` is not
 * prose however much of it is words.
 */
const scrub = (value: string | null): string | null => redactShapes(value, SHAPE_REDACTIONS)
const scrubProse = (value: string | null): string | null => redactContacts(value, SHAPE_REDACTIONS)

function pathOf(href: string): string {
  try {
    return new URL(href).pathname
  } catch {
    return href
  }
}

function hostOf(href: string): string {
  try {
    return new URL(href).host
  } catch {
    return href.slice(0, 40)
  }
}
