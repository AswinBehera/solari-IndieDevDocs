import type { Capture, CaptureContext } from "../adapter.js"
import { readTikTokState, type TikTokPageRead } from "./inpage.js"
import type { InterceptedBody, TikTokPayload, TikTokSurface } from "./types.js"

/**
 * The half that spends, on the surface this project expects to be refused by.
 *
 * The plan names TikTok as "the surface most likely to gate on IP geolocation, so
 * this is where the gap shows up if it shows up; report it as a gap rather than
 * working around it." That sentence is the design brief for this file, and it
 * rules out more than it rules in.
 *
 * **Nothing here tries to get past a wall.** No captcha solving, no signature
 * forging, no rotating through personas until one is let through, no headful
 * fingerprint theatre beyond the viewpoint the persona already carries. A refusal
 * is the measurement. P1.0 established that query language is the dominant signal
 * and egress is worth about as much as waiting five minutes; the open question
 * TikTok answers is whether that holds on a surface that actually enforces
 * geography. Working around the enforcement would delete the answer and replace it
 * with the sound of our own cleverness.
 *
 * So this distinguishes *which* wall it hit — login, captcha, region — and carries
 * that in `refusedBy`. Three refusals mean three different things: a login wall is
 * a product decision that applies to everyone, a captcha is a judgement about this
 * session, and a region block is the finding. Collapsing them to `blocked` would
 * make the interesting one unrecoverable from the row.
 *
 * **Two strategies, both always on.** The embedded state and the API responses fail
 * on different days and cost nothing to collect together — the response listener is
 * passive. See `types.ts`.
 */

/** The slice of Playwright's `Page` this adapter uses — and a fake must fake. */
export interface TikTokPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  url(): string
  evaluate<R>(fn: () => R): Promise<R>
  /** Passive. Registered before `goto` so the first response is not missed. */
  on(event: "response", handler: (response: TikTokResponse) => void): void
  off?(event: "response", handler: (response: TikTokResponse) => void): void
  waitForTimeout?(ms: number): Promise<void>
}

export interface TikTokResponse {
  url(): string
  status(): number
  json(): Promise<unknown>
}

/**
 * API paths whose bodies carry items. Matched as substrings of the pathname, so a
 * version bump from `/api/search/general/full/` to `.../v2/` still matches.
 *
 * Deliberately short. Every extra path is more public bytes in a fixture and more
 * chance of storing something that is about the session rather than the query.
 */
const ITEM_ENDPOINTS = [
  "/api/search/general",
  "/api/search/item",
  "/api/explore/item_list",
  "/api/recommend/item_list",
  "/api/post/item_list",
]

/**
 * Keys removed from the stored payload, wherever they appear.
 *
 * The same distinction as YouTube's: this is redaction by key name, not a
 * narrowing of the payload to the part the parser wants. TikTok's state carries
 * more session identity than YouTube's — `webIdLastTime`, the device id, an abuse
 * token, the whole `AppContext` — and this repository is public.
 */
/**
 * Exported for `fixture.test.ts`, which walks the checked-in capture and asserts
 * that not one of these names survives in it. That is the part of the audit worth
 * automating: the list grows every time a real page is read, and a fixture that
 * was clean against the old list is not clean against the new one.
 */
export const REDACTED_KEYS = new Set([
  "webIdLastTime",
  "odinId",
  "deviceId",
  "msToken",
  "verifyFp",
  "sessionId",
  "AppContext",
  "abTestVersion",
  "expIds",
  "sid_guard",
  "sid_tt",
  "secUid",
  "cookieLGWInfo",
  "installId",
  "csrfToken",
  // Added after reading the first real capture, which is what the recorder's
  // closing warning tells you to do and why it says the list is not a guarantee.
  // Every one of these was in `webapp.app-context` or `webapp.biz-context` of a
  // 232 KB search capture, and none of them was on the list written from the
  // documentation:
  //
  //   wid                7684911565829113361
  //   encryptedWebid     1|2uJk3ZqTAvkjw4xDRi024YK53oWO5uKzolyAUEVcuJQ|…
  //   webIdCreatedTime   1789282909
  //   nonce              if6Z1KmP25w84XQ4lCPKJ
  //   requestId          65884612789282909590
  //   hashedIP           24baa46e
  //   userAgent          Mozilla/5.0 (X11; Linux x86_64) … Chrome/151.0.0.0
  //   apiKeys            { firebase: "AIzaSy…" }
  //
  // `hashedIP` is a hash of the egress address this project rented. `userAgent` is
  // the provider's exact browser fingerprint, which is a thing a source would like
  // to know about us and not a thing to publish. `apiKeys` is TikTok's own vendor
  // key; it is served to every visitor and is still not ours to republish.
  "wid",
  "encryptedWebid",
  "webIdCreatedTime",
  "nonce",
  "requestId",
  "hashedIP",
  "userAgent",
  "apiKeys",
  // Not identity — 303 KB of the 351 KB capture was this one key, a complete UI
  // string table in the persona's language. The `responseContext` precedent from
  // the YouTube adapter applies exactly: dropping a named key that is large and
  // that no parser reads is redaction, not narrowing, and the difference is
  // whether a future layout change needs a new parser or a new session.
  "webapp.i18n-translation",
  // Added after reading the *second* real capture — the first one that carried
  // items, and therefore the first that carried an API response body. The state
  // was clean by then; none of these is in the state.
  //
  // A live Apple Music developer JWT, issued to TikTok, sitting three levels
  // inside every music object:
  //
  //   item.music.tt2dsp.tt_to_dsp_song_infos[].token.apple_music_token
  //     .developer_token = "eyJhbGciOiJFUzI1NiIsImtpZCI6…"
  //
  // It is signed, it has an expiry, and it is not ours. `tt2dsp` goes as a block
  // rather than the leaf alone, because the block is a cross-link table to music
  // services and the next one to appear in it will be Spotify's.
  "tt2dsp",
  "apple_music_token",
  "developer_token",
  // Request tracking, exactly YouTube's `trackingParams` by another name. These
  // identify our request to TikTok's logging, and they are in every response.
  "log_pb",
  "logid",
  "impr_id",
  "search_request_id",
  "backendSourceEventTracking",
  // Session-signed media URLs, carrying `x-signature`, `x-expires` and a
  // parameter blob that encodes the client they were issued for. They are also
  // the largest thing in the response.
  //
  // Dropped only after checking `parse.ts`: `readMedia` reads `cover`,
  // `originCover` and `dynamicCover` and nothing else, so no draft loses a field.
  // The three cover URLs are signed too and are *kept*, because they are what
  // `mediaRefs` is — the redaction list exists to remove what a capture should
  // never have carried, not to remove the harvest.
  "playAddr",
  "downloadAddr",
  "bitrateInfo",
  // The account bio, and the only entry here that is not about a secret. See the
  // note below, which used to argue the other way.
  "signature",
])

// A near-miss worth recording, because it would have typechecked, passed every
// test, and quietly destroyed data:
//
// `userInfo` is ambiguous: the viewer at the top level of `SIGI_STATE`, and a
// *result* in the search API's user results. Redacting by key name cannot tell
// those apart, and the viewer is already covered by `deviceId`, `odinId` and
// `webIdLastTime`. A denylist entry that is right half the time is not a
// half-measure; it is a silent data loss with a good reason attached.
//
// And one reversal, because the reasoning that saved `signature` from this list was
// checked against the code a session later and did not survive it.
//
// `signature` is not a request signature; on a TikTok author object it is the
// account's **bio**. It was taken off the first draft of this list on the grounds
// that free text in the local language "is exactly the kind of evidence this project
// harvests". That sentence was about an intention. `parse.ts` reads `uniqueId` and
// nothing else off an author, and no other file in the repository mentions the field
// — so across two captures the bio was harvested by nobody and published by us.
//
// What it did carry, measured on the one recorded fixture: two creators' email
// addresses and a mobile number, in a public repository, belonging to people who
// posted a video about a sandwich. Shape redaction was written and tried first and
// is the reason this entry exists rather than that one — it caught two of the four.
// The two it missed were an address spelled in Mathematical Bold and a number
// written with `l` for one and `O` for zero, both perfectly legible to the human
// the author meant to reach. A bio is prose a person controls, and a pattern that
// has to recognise every way a person might write their own phone number is a
// pattern that will be wrong quietly and forever.
//
// The asymmetry decides it. An uncollected bio costs one browser session to collect
// again, roughly half a minute against a four-thousand-minute budget. A stranger's
// address in a public git history cannot be taken back at any price. When P1.8 wants
// a bio as a locality signal it can ask for one, and this line is where it says so.

const MAX_DEPTH = 40

export interface TikTokCaptureOptions {
  timeoutMs?: number
  /**
   * How long to let the page make its API calls after `domcontentloaded`.
   *
   * Unlike YouTube — whose data is in the first document, so the settle is zero —
   * TikTok frequently renders its list from an XHR, and a capture that leaves
   * immediately catches the document and none of the calls. This is a real cost on
   * a per-minute clock, which is why it is a named constant with a comment rather
   * than a number inside an await: three seconds across a twenty-run recording
   * window is a minute of billed time, and somebody should be able to see that.
   */
  settleMs?: number
}

export const DEFAULT_SETTLE_MS = 3_000

/** See `observed`. Enough to show the shape of a page's traffic, not its volume. */
const MAX_OBSERVED_PATHS = 120

export function buildSearchUrl(query: string, persona: { locale: string }): string {
  const url = new URL("https://www.tiktok.com/search")
  url.searchParams.set("q", query)
  // `lang` is the only viewpoint parameter TikTok honours in the URL. There is no
  // `gl` equivalent: region comes from the egress IP, which is exactly why this
  // adapter is the one that tests ADR-0015's compromise rather than assuming it.
  url.searchParams.set("lang", localeToLang(persona.locale))
  return url.toString()
}

export function buildExploreUrl(persona: { locale: string }): string {
  const url = new URL("https://www.tiktok.com/explore")
  url.searchParams.set("lang", localeToLang(persona.locale))
  return url.toString()
}

/** `vi-VN` → `vi`. */
function localeToLang(locale: string): string {
  return (locale.split("-")[0] ?? locale).toLowerCase()
}

export async function captureTikTok(
  ctx: CaptureContext,
  query: string,
  surface: TikTokSurface,
  options: TikTokCaptureOptions = {},
): Promise<Capture<TikTokPayload>> {
  const page = ctx.page as TikTokPage
  const url =
    surface === "search" ? buildSearchUrl(query, ctx.persona) : buildExploreUrl(ctx.persona)

  const intercepted: InterceptedBody[] = []
  const pending: Promise<void>[] = []
  // Every path the page asked for, whether or not it was one we wanted.
  //
  // `intercepted: 0` on its own cannot tell "the page made no API calls" apart
  // from "the page made API calls to endpoints not on the list", and those are a
  // dead session and a stale constant respectively. The first live capture of the
  // search surface came back with a rendered shell, zero tiles and zero
  // interceptions, and the question it could not answer was that one. Paths only —
  // `pathOf` drops the query string, which carries device and session ids.
  const observed = new Set<string>()

  const onResponse = (response: TikTokResponse) => {
    const path = pathOf(response.url())
    // Capped: a media-heavy page can issue hundreds of requests, and the point of
    // this list is to be read by a person.
    if (observed.size < MAX_OBSERVED_PATHS) observed.add(path)
    if (!ITEM_ENDPOINTS.some((endpoint) => path.includes(endpoint))) return
    if (response.status() !== 200) return
    // Collected into a promise list rather than awaited here: this handler is
    // called synchronously by Playwright and an async handler that throws inside
    // it is an unhandled rejection that kills the session, which would turn a
    // malformed API response into a lost capture.
    pending.push(
      response
        .json()
        .then((body) => {
          intercepted.push({ path, body: redact(body, 0) })
        })
        .catch(() => {
          // A body that is not JSON is not evidence of anything. Dropped silently
          // rather than recorded as an error, because the strategy count in the
          // payload already says how many bodies were actually collected.
        }),
    )
  }

  page.on("response", onResponse)
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 30_000 })
    // See `settleMs`. Skipped entirely when the caller asks for zero, which is what
    // every test does.
    const settle = options.settleMs ?? DEFAULT_SETTLE_MS
    if (settle > 0 && page.waitForTimeout) await page.waitForTimeout(settle)
    await Promise.all(pending)
  } finally {
    page.off?.("response", onResponse)
  }

  const read = await page.evaluate(readTikTokState)
  // Re-checked on this side of the evaluate boundary, and not merely `!== null`.
  // `inpage.ts` already refuses to return a DOM node, but what arrives here has
  // been through the provider's serialiser, and the first live capture proved what
  // a truthy non-object costs: it silences the refusal below and writes a fixture
  // that looks like a successful run. The check is two lines and the failure it
  // prevents is invisible.
  const state = isRecord(read.state) ? read.state : null

  const payload: TikTokPayload = {
    state: redact(state, 0),
    intercepted,
    pageTitle: read.title,
    surface,
    strategies: { state: state !== null, intercepted: intercepted.length },
    tiles: read.tiles,
    observedPaths: [...observed].sort(),
  }

  const capture: Capture<TikTokPayload> = {
    sourceId: `tiktok.${surface}`,
    query,
    url: read.href || url,
    capturedAt: new Date(),
    payload,
  }

  const refusedBy = refusal({ ...read, state }, intercepted.length)
  return refusedBy ? { ...capture, refusedBy } : capture
}

/**
 * What counts as a refusal here, and what does not.
 *
 * The three walls are named separately because they are three different facts.
 * A **region** block is the one this adapter exists to find: it is ADR-0015's
 * compromise failing in the open, and it must be legible in the stored row without
 * anyone re-reading the capture. A **captcha** is a judgement about this session
 * and feeds the persona's health. A **login** wall is a product decision that
 * applies to every logged-out visitor and says nothing about the viewpoint — it
 * degrades a persona that did nothing wrong, which is a real cost of reporting it,
 * and it is still the correct thing to record, because a harvest that silently
 * returns nothing from behind a login wall is worse.
 *
 * **Zero items is not a refusal**, as everywhere else in this package: the
 * orchestrator has an `empty` outcome, and a typo must not read as a block.
 *
 * The last clause is the interesting one. Both strategies coming back empty —
 * no embedded state *and* no API body — is not an honest zero. It means we were
 * served a page this adapter does not recognise at all, and calling that `empty`
 * would report "TikTok has nothing about this" when the truth is "we cannot read
 * what TikTok sent".
 */
function refusal(read: TikTokPageRead, bodies: number): string | undefined {
  if (read.wall === "captcha") return "captcha"
  if (read.wall === "region") return "region-block"
  if (read.wall === "login") return "login-wall"
  if (!read.href.includes("tiktok.com")) return `redirected to ${hostOf(read.href)}`
  if (read.state === null && bodies === 0) {
    return `no state and no item api response (title: ${read.title || "none"})`
  }
  return undefined
}

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

function redact(node: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || node === null || typeof node !== "object") return node
  if (Array.isArray(node)) return node.map((entry) => redact(entry, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(key)) continue
    out[key] = redact(value, depth + 1)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
