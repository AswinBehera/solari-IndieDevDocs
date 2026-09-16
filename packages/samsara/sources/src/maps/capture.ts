import type { Capture, CaptureContext } from "../adapter.js"
import { BASE_REDACTIONS, redactContacts, redactShapes } from "../redact.js"
import {
  clickMapsTab,
  expandMapsReviews,
  type MapsPageRead,
  readMapsPage,
  scrollMapsPane,
} from "./inpage.js"
// The identity regex, and only the regex. `capture` does not parse — but it does have
// to tell "Maps refused" apart from "Maps resolved", and that difference is a feature
// id in the landing address. One shared pattern rather than two that drift.
import { FEATURE_ID } from "./parse.js"
import type { MapsPayload, MapsSurface } from "./types.js"

/**
 * The half that spends, on the surface that has no names in it.
 *
 * Two adapters over one parser, and the split is about cost rather than neatness.
 * The plan asks for reviews across a caller-supplied list of areas, and the obvious
 * adapter loops: search the area, take the top results, open each one, scroll each
 * one. That is one `capture()` call whose length is a function of a page nobody has
 * loaded yet — a cost the kernel's meters cannot see coming, because they meter a
 * session and this would be one session of unbounded length. Split in two, the
 * chaining belongs to the caller (the same decision P1.1 made about keepalive
 * pages: a list is a job-payload argument, never a constant inside the engine), the
 * budget guard sees each session, and a failure at the eighth entity loses one
 * capture rather than ten.
 *
 * `maps.reviews` therefore takes an **entity URL as its query**. That is not a
 * shortcut: it is the output of a previous `maps.search` capture, which means the
 * navigation target is data this project already archived rather than a literal in
 * this file. It is also why nothing here spells Google's own noun for an entity —
 * see `parse.ts`, which does not spell it either.
 *
 * **Three guesses live in this file and each one records what it saw.** Which tab
 * is the reviews tab, whether `data-review-id` still anchors a review, and whether
 * the blob is still called `APP_INITIALIZATION_STATE`. Under P1.4's rule a wrong
 * guess costs a browser session, so three guesses would cost three. `tabLabels`,
 * `nodeCounts` and `stateKeys` are in the payload so that **one** capture answers
 * all three — including a capture that failed, which is the one that most needs to.
 */

/** The slice of Playwright's `Page` this adapter uses — and the fake must fake. */
export interface MapsPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  url(): string
  evaluate<R>(fn: () => R): Promise<R>
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>
  /** Passive. No response is missed. */
  on(event: "response", handler: (response: MapsResponse) => void): void
  off?(event: "response", handler: (response: MapsResponse) => void): void
  waitForTimeout?(ms: number): Promise<void>
}

export interface MapsResponse {
  url(): string
  status(): number
}

export interface MapsCaptureOptions {
  timeoutMs?: number
  /** How long to let the surface render after `domcontentloaded`, and between scrolls. */
  settleMs?: number
  /** Upper bound on scroll rounds. Each one is billed time; see `MAX_SCROLLS`. */
  maxScrolls?: number
  /** Which tab to open on the reviews surface. See `clickMapsTab`. */
  reviewTabIndex?: number
}

/**
 * Maps renders from XHR after `domcontentloaded`, like TikTok and unlike YouTube,
 * so a capture that reads immediately reads a shell.
 */
export const DEFAULT_SETTLE_MS = 2_500

/**
 * Scrolling is the only way to get past the first handful of reviews, and every
 * round is billed. Ten rounds at the default settle is about twenty-five seconds —
 * around 0.4 of a minute against a 4,000-minute ceiling, for something like fifty
 * reviews. The loop also stops early when the pane stops growing, so a short entity
 * costs a short session.
 */
export const MAX_SCROLLS = 10

/** Maps' tab strip is Overview, Reviews, About. A guess; `tabLabels` records the truth. */
export const DEFAULT_REVIEW_TAB_INDEX = 1

/** See `observedPaths`. Enough to show the shape of the traffic, not its volume. */
const MAX_OBSERVED_PATHS = 120

/**
 * A contributor's profile photo, recognised on the *network* side rather than in the
 * DOM. The same rule as the avatar guard in `inpage.ts`, and it is written out twice
 * on purpose: the in-page function is serialised into `page.evaluate`, so it cannot
 * close over anything declared here. `capture.test.ts` asserts the two agree.
 *
 * This exists because the first version of the avatar guard was correct and still
 * leaked. `readMapsPage` kept five photographs out of `photoRefs`, and six of them
 * arrived in `observedPaths` anyway — `onResponse` sees the same image as a
 * response and had no opinion about it. The fixture test that certified the file
 * "carries no photograph of a contributor" matched `googleusercontent.com/a-?/`
 * against the whole document and passed, because `pathOf` had already thrown the
 * hostname away. Three guards, one subject, two representations, and the assertion
 * was written against the representation that was not there.
 *
 * So the rule is anchored on the path and the host is optional, which is what makes
 * it true of both forms. And, as everywhere else here, the exclusion is counted:
 * `observedAvatarsSkipped` is the part that can be checked.
 */
export const AVATAR_PATH = /^(?:https?:\/\/[^/]*googleusercontent\.com)?\/a-?\//

/**
 * Redaction here is by **shape**, not by key name, and that is a real weakening
 * worth stating rather than glossing.
 *
 * Every other adapter in this package redacts a keyed tree, where a name is a
 * reliable handle on a value. The one opaque thing a Maps capture stores is a
 * *string* — the blob — and a string has no names in it. So the only available
 * filter is a pattern, and a pattern denylist is the weaker instrument: it cannot
 * find the first instance of anything, and it can eat content.
 *
 * The shared half of the list is in `../redact.ts`, and it was rewritten by a
 * Pantip capture rather than a Maps one: the shape that mattered turned out to be a
 * long opaque base64 run hiding **our own egress address**, which is a thing any
 * site can hand back and therefore not a thing any one adapter should own the rule
 * for. What stays here is Google's own key formats, which nothing else will meet.
 *
 * `fixture.test.ts` greps the committed bytes for the same shapes, because a
 * denylist that runs once at capture time is not a check.
 */
export const SHAPE_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  ...BASE_REDACTIONS,
  // Google API keys and OAuth tokens. Browser API keys are served to every visitor
  // and are still not ours to republish.
  [/AIza[0-9A-Za-z_-]{35}/g, "[redacted-key]"],
  [/ya29\.[0-9A-Za-z_-]{20,}/g, "[redacted-token]"],
  // The `SAPISIDHASH` family, which is a signature over the visitor's cookies.
  [/SAPISIDHASH\s+[0-9A-Za-z_-]+/g, "[redacted-hash]"],
]

export function buildSearchUrl(
  query: string,
  persona: { locale: string; country: string },
): string {
  const url = new URL(`https://www.google.com/maps/search/${encodeURIComponent(query)}`)
  return withViewpoint(url, persona)
}

/**
 * The reviews surface navigates to the URL it was handed.
 *
 * Validated rather than trusted: a query that is not a Google Maps URL would send a
 * billed session to an arbitrary host, and an adapter that will navigate anywhere
 * on request is a proxy with our egress address on it.
 */
export function buildReviewsUrl(
  query: string,
  persona: { locale: string; country: string },
): string {
  const url = new URL(query)
  if (url.protocol !== "https:" || !/(^|\.)google\.[a-z.]+$/.test(url.hostname)) {
    throw new Error(`maps.reviews expects a Google URL as its query, got ${url.hostname}`)
  }
  return withViewpoint(url, persona)
}

/**
 * `hl` and `gl` — the pair P1.0 measured. Google Maps honours both, unlike TikTok,
 * which takes `lang` and gets its region from the egress address alone.
 */
function withViewpoint(url: URL, persona: { locale: string; country: string }): string {
  url.searchParams.set("hl", (persona.locale.split("-")[0] ?? persona.locale).toLowerCase())
  url.searchParams.set("gl", persona.country.toLowerCase())
  return url.toString()
}

export async function captureMaps(
  ctx: CaptureContext,
  query: string,
  surface: MapsSurface,
  options: MapsCaptureOptions = {},
): Promise<Capture<MapsPayload>> {
  const page = ctx.page as MapsPage
  const url =
    surface === "search" ? buildSearchUrl(query, ctx.persona) : buildReviewsUrl(query, ctx.persona)

  const observed = new Set<string>()
  let observedAvatarsSkipped = 0
  const onResponse = (response: MapsResponse) => {
    const path = pathOf(response.url())
    if (AVATAR_PATH.test(path)) {
      observedAvatarsSkipped += 1
      return
    }
    if (observed.size >= MAX_OBSERVED_PATHS) return
    observed.add(path)
  }

  const settle = options.settleMs ?? DEFAULT_SETTLE_MS
  const pause = async () => {
    if (settle > 0 && page.waitForTimeout) await page.waitForTimeout(settle)
  }

  let tabOpened: number | null = null
  let scrolls = 0

  page.on("response", onResponse)
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 30_000 })
    await pause()

    if (surface === "reviews") {
      tabOpened = await page.evaluate(
        clickMapsTab,
        options.reviewTabIndex ?? DEFAULT_REVIEW_TAB_INDEX,
      )
      await pause()
    }

    // Stops when the pane stops growing rather than always paying for the cap. A
    // height that does not change means the surface has nothing more to give, and
    // a scroll round that buys nothing is billed exactly like one that does.
    let lastHeight = -1
    const cap = options.maxScrolls ?? MAX_SCROLLS
    for (let round = 0; round < cap; round += 1) {
      const height = await page.evaluate(scrollMapsPane)
      scrolls += 1
      if (height === lastHeight) break
      lastHeight = height
      await pause()
    }

    if (surface === "reviews") {
      await page.evaluate(expandMapsReviews)
      await pause()
    }
  } finally {
    page.off?.("response", onResponse)
  }

  const read = await page.evaluate(readMapsPage)

  const payload: MapsPayload = {
    surface,
    reviews: read.reviews.map((review) => ({
      ...review,
      text: scrubProse(review.text),
      ownerReply: scrubProse(review.ownerReply),
      // Scrubbed like the other two, and for a stronger reason: a fragment is raw
      // markup, so it carries whatever the page put in its attributes — the one
      // field here most likely to hold a token nobody went looking for.
      fragment: scrub(review.fragment),
    })),
    entities: read.entities,
    state: scrub(read.state),
    stateLength: read.stateLength,
    pageTitle: read.title,
    tabLabels: read.tabLabels,
    tabOpened,
    scrolls,
    nodeCounts: read.nodeCounts,
    stateKeys: read.stateKeys,
    stateCandidates: read.stateCandidates,
    observedPaths: [...observed].sort(),
    observedAvatarsSkipped,
    strategies: {
      state: read.state !== null,
      reviews: read.reviews.length,
      entities: read.entities.length,
    },
  }

  const capture: Capture<MapsPayload> = {
    sourceId: `maps.${surface}`,
    query,
    url: read.href || url,
    capturedAt: new Date(),
    payload,
  }

  const refusedBy = refusal(read, surface, tabOpened)
  return refusedBy ? { ...capture, refusedBy } : capture
}

/**
 * What counts as a refusal, and — as everywhere else in this package — what does not.
 *
 * **Zero results is not a refusal.** An area with no matches and an entity with no
 * reviews are both honest zeroes, the orchestrator has an `empty` outcome for them,
 * and folding them into `blocked` would degrade a persona over a typo.
 *
 * The structural clauses are the interesting ones, and they are about *reaching the
 * page* rather than about what was on it. A reviews capture that found no tab strip
 * never got an entity panel; one that came back holding result cards is still on
 * the search page. Both are "we could not read what Google sent", which is a
 * different row and a different fix from "Google had nothing".
 */
function refusal(
  read: MapsPageRead,
  surface: MapsSurface,
  tabOpened: number | null,
): string | undefined {
  if (read.wall === "captcha") return "captcha"
  if (read.wall === "consent") return "consent-wall"
  if (!hostOf(read.href).includes("google.")) return `redirected to ${hostOf(read.href)}`
  if (surface === "reviews") {
    if (tabOpened === null) return `no tab strip (title: ${read.title || "none"})`
    if (read.reviews.length === 0 && read.entities.length > 0) {
      return `still on the result list (${read.entities.length} card(s), no review node)`
    }
  }
  if (surface === "search" && read.entities.length === 0 && read.state === null) {
    // Unless Maps answered the question by resolving it.
    //
    // A one-word area name is often not ambiguous enough to deserve a list: the first
    // real capture asked for `อารีย์` and was taken straight to one entity's own page,
    // which has no result cards on it and, on that build, no blob either. Every
    // structural signal said refused, and nothing had gone wrong — Maps had simply
    // answered, and the answer was in the address bar.
    //
    // The feature id is what makes that legible without reading the page, which is
    // the second time identity-by-id has paid for itself on a surface where nothing
    // can be read positionally.
    if (!FEATURE_ID.test(read.href)) {
      return `no result card and no state (title: ${read.title || "none"})`
    }
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
