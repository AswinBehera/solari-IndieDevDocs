import { silentLogger } from "@samsara/kernel"
import { describe, expect, it } from "vitest"
import type { CaptureContext } from "../adapter.js"
import {
  buildExploreUrl,
  buildSearchUrl,
  captureTikTok,
  type TikTokPage,
  type TikTokResponse,
} from "./capture.js"
import type { TikTokPageRead } from "./inpage.js"

/**
 * A page that was never opened.
 *
 * `evaluate` is handed the real `readTikTokState` and ignores it, returning what
 * the test says the page contained. That is the honest boundary for this half:
 * everything `readTikTokState` does happens inside a browser, and a fake `document`
 * would be testing my model of a DOM rather than a DOM. What *is* testable here is
 * everything around it — which URL was asked for, which responses were kept, what
 * was stripped, and what counts as a refusal.
 *
 * That reasoning has one hole, and the first live capture found it: it is also the
 * reason nothing checked what `readTikTokState` *returns*. `inpage.test.ts` now
 * covers the part of that function which depends on no page in particular.
 */

function fakePage(read: Partial<TikTokPageRead>, responses: FakeResponse[] = []) {
  const handlers: ((response: TikTokResponse) => void)[] = []
  const visited: string[] = []
  let offCalls = 0

  const page: TikTokPage = {
    async goto(url: string) {
      visited.push(url)
      // Fired during `goto`, as Playwright does: a listener registered afterwards
      // would miss every response, which is why registration order is load-bearing
      // in `captureTikTok` and asserted below.
      for (const response of responses) {
        for (const handler of handlers) handler(response)
      }
      return null
    },
    url: () => visited[visited.length - 1] ?? "",
    async evaluate<R>(): Promise<R> {
      return {
        state: null,
        wall: null,
        title: "",
        href: "https://www.tiktok.com/search?q=x",
        tiles: 0,
        ...read,
      } as R
    },
    on(_event, handler) {
      handlers.push(handler)
    },
    off() {
      offCalls += 1
    },
  }
  return {
    page,
    visited,
    get offCalls() {
      return offCalls
    },
  }
}

interface FakeResponse extends TikTokResponse {}

function response(
  url: string,
  status: number,
  body: unknown | (() => Promise<unknown>),
): FakeResponse {
  return {
    url: () => url,
    status: () => status,
    json: () =>
      typeof body === "function" ? (body as () => Promise<unknown>)() : Promise.resolve(body),
  }
}

function context(page: TikTokPage): CaptureContext {
  return {
    page,
    persona: { id: "p1", country: "sg", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" },
    logger: silentLogger,
    signal: new AbortController().signal,
  }
}

const NO_SETTLE = { settleMs: 0 }

describe("buildSearchUrl", () => {
  it("carries the persona's language, which P1.0 measured as the dominant signal", () => {
    const url = new URL(buildSearchUrl("bánh mì", { locale: "vi-VN" }))
    expect(url.searchParams.get("q")).toBe("bánh mì")
    expect(url.searchParams.get("lang")).toBe("vi")
  })

  it("has no region parameter to carry, which is the finding rather than an omission", () => {
    // TikTok takes region from the egress IP. There is no `gl` to set, so this
    // adapter is the one that actually tests ADR-0015's `sg`-for-`th` compromise.
    const url = new URL(buildExploreUrl({ locale: "th-TH" }))
    expect(url.searchParams.get("lang")).toBe("th")
    expect([...url.searchParams.keys()]).toEqual(["lang"])
  })
})

describe("what the redaction list learned from a real page", () => {
  /**
   * These keys are not from TikTok's documentation — there is none. They are from
   * reading a 232 KB capture that the first list passed clean, which is the step
   * the recorder's closing warning exists to force.
   */
  it("strips the session identity that the first list missed", async () => {
    const state = {
      __DEFAULT_SCOPE__: {
        "webapp.app-context": {
          wid: "7684911565829113361",
          encryptedWebid: "1|2uJk3ZqTAvkjw4xDRi024YK53oWO5uKzolyAUEVcuJQ|1789282909|1142bbef",
          webIdCreatedTime: "1789282909",
          nonce: "if6Z1KmP25w84XQ4lCPKJ",
          requestId: "65884612789282909590",
          userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/151.0.0.0",
          language: "vi-VN",
          region: "SG",
        },
        "webapp.biz-context": { hashedIP: "24baa46e", apiKeys: { firebase: "AIzaSyDHGq" } },
        "webapp.i18n-translation": { Webapp: { some_key: "some string" } },
      },
    }
    const { page } = fakePage({ state })
    const capture = await captureTikTok(context(page), "bánh mì", "search", NO_SETTLE)
    const json = JSON.stringify(capture)

    for (const secret of [
      "7684911565829113361",
      "2uJk3ZqTAvkjw4xDRi024YK53oWO5uKzolyAUEVcuJQ",
      "1789282909",
      "if6Z1KmP25w84XQ4lCPKJ",
      "65884612789282909590",
      "24baa46e",
      "AIzaSyDHGq",
      "Chrome/151.0.0.0",
    ]) {
      expect(json).not.toContain(secret)
    }
    // The i18n table is 303 KB of the 351 KB and no parser reads it.
    expect(json).not.toContain("some string")
  })

  it("keeps the viewpoint, which is the whole measurement", async () => {
    // `language` and `region` are how a capture proves the persona reached the
    // source. Redacting the context wholesale would have taken them with it.
    const state = {
      __DEFAULT_SCOPE__: { "webapp.app-context": { language: "vi-VN", region: "SG", wid: "1" } },
    }
    const { page } = fakePage({ state })
    const capture = await captureTikTok(context(page), "bánh mì", "search", NO_SETTLE)
    const json = JSON.stringify(capture)

    expect(json).toContain("vi-VN")
    expect(json).toContain("SG")
  })
})

describe("what the redaction list learned from a page that had items", () => {
  /**
   * The second real capture was the first that came back with results, and
   * therefore the first that carried an API response body. Everything below was
   * in it. The state had been clean since the previous round; none of this is in
   * the state, which is the point — a list audited against one half of a payload
   * has been audited against one half of a payload.
   */
  const body = () => ({
    data: [
      {
        item: {
          id: "7197054038658092315",
          desc: "Bánh mì xoay @Pita ",
          author: { uniqueId: "nguyenrua", signature: "HÓNG HỚT ĐƯỜNG PHỐ" },
          video: {
            cover: "https://p16.tiktokcdn.com/cover.jpeg?x-expires=1&x-signature=COVERSIG",
            originCover: "https://p16.tiktokcdn.com/origin.jpeg",
            dynamicCover: "https://p16.tiktokcdn.com/dynamic.jpeg",
            playAddr: "https://v16.tiktokcdn.com/play?x-signature=PLAYSIG&bti=abcd",
            downloadAddr: "https://v16.tiktokcdn.com/dl?x-signature=DOWNLOADSIG",
            bitrateInfo: [{ PlayAddr: { UrlList: ["https://v16.tiktokcdn.com/b?x=BITRATESIG"] } }],
          },
          music: {
            title: "nhạc nền",
            tt2dsp: {
              tt_to_dsp_song_infos: [
                {
                  token: {
                    apple_music_token: { developer_token: "eyJhbGciOiJFUzI1NiJ9.APPLEJWT" },
                  },
                },
              ],
            },
          },
        },
        // Tracking, at three different depths and under three different spellings.
        log_pb: { impr_id: "20260913150906BDEE8335B52AC26AF2D3" },
        extra: { logid: "20260913150906BDEE8335B52AC26AF2D3" },
      },
    ],
    search_request_id: "SEARCHREQID",
    backendSourceEventTracking: "BACKENDTRACKING",
  })

  it("strips a third-party vendor credential out of the music object", async () => {
    const { page } = fakePage({}, [
      response("https://www.tiktok.com/api/search/general/full/?q=x", 200, body()),
    ])
    const capture = await captureTikTok(context(page), "bánh mì", "search", NO_SETTLE)

    // A live, signed, unexpired Apple Music developer token issued to TikTok. It
    // is not ours to republish, and this repository is public.
    expect(JSON.stringify(capture)).not.toContain("APPLEJWT")
  })

  it("strips the request tracking ids, wherever they are spelled", async () => {
    const { page } = fakePage({}, [
      response("https://www.tiktok.com/api/search/general/full/?q=x", 200, body()),
    ])
    const capture = await captureTikTok(context(page), "bánh mì", "search", NO_SETTLE)
    const json = JSON.stringify(capture)

    // YouTube's `trackingParams` by another name — these identify our request to
    // TikTok's own logging.
    for (const id of ["20260913150906BDEE8335B52AC26AF2D3", "SEARCHREQID", "BACKENDTRACKING"]) {
      expect(json).not.toContain(id)
    }
  })

  it("strips the signed playback URLs and keeps the covers, which are the harvest", async () => {
    const { page } = fakePage({}, [
      response("https://www.tiktok.com/api/search/general/full/?q=x", 200, body()),
    ])
    const capture = await captureTikTok(context(page), "bánh mì", "search", NO_SETTLE)
    const json = JSON.stringify(capture)

    for (const signature of ["PLAYSIG", "DOWNLOADSIG", "BITRATESIG"]) {
      expect(json).not.toContain(signature)
    }
    // The covers are signed too, and they stay. `parse.ts` reads `cover`,
    // `originCover` and `dynamicCover` to build `mediaRefs`; redacting them here
    // would not make the fixture safer, it would delete a field from every future
    // harvest. The redaction list removes what a capture should not have carried,
    // not what it was opened to collect.
    expect(json).toContain("COVERSIG")
    expect(json).toContain("origin.jpeg")
    expect(json).toContain("dynamic.jpeg")
  })

  it("leaves the record itself alone", async () => {
    const { page } = fakePage({}, [
      response("https://www.tiktok.com/api/search/general/full/?q=x", 200, body()),
    ])
    const capture = await captureTikTok(context(page), "bánh mì", "search", NO_SETTLE)
    const json = JSON.stringify(capture)

    // A denylist that ate the post would be a denylist nobody noticed was wrong
    // until the fixture tests started passing against nothing.
    expect(json).toContain("7197054038658092315")
    expect(json).toContain("Bánh mì xoay")
    expect(json).toContain("nhạc nền")
    // The bio is the one field in `body()` that is deliberately *not* here; see the
    // test below. The id, the description and the music title are the post.
    expect(json).not.toContain("HÓNG HỚT ĐƯỜNG PHỐ")
  })
})

describe("observedPaths", () => {
  it("lists every path the page asked for, not only the ones that were kept", async () => {
    const { page } = fakePage({}, [
      response("https://www.tiktok.com/api/search/general/?q=x&msToken=secret", 200, { data: [] }),
      response("https://www.tiktok.com/api/user/detail/?secUid=abc", 200, {}),
      response("https://v16.tiktokcdn.com/video/1.mp4", 200, {}),
    ])
    const capture = await captureTikTok(context(page), "bánh mì", "search", NO_SETTLE)

    expect(capture.payload.observedPaths).toEqual([
      "/api/search/general/",
      "/api/user/detail/",
      "/video/1.mp4",
    ])
    // The distinction the list exists for: three requests seen, one kept.
    expect(capture.payload.strategies.intercepted).toBe(1)
  })

  it("keeps no query strings, which is where the device ids are", async () => {
    const { page } = fakePage({}, [
      response("https://www.tiktok.com/api/user/detail/?msToken=secret&odinId=123", 200, {}),
    ])
    const capture = await captureTikTok(context(page), "x", "search", NO_SETTLE)

    expect(capture.payload.observedPaths).toEqual(["/api/user/detail/"])
    expect(JSON.stringify(capture)).not.toContain("msToken")
    expect(JSON.stringify(capture)).not.toContain("odinId")
  })
})

describe("the login bundle", () => {
  /**
   * P2.2's first Thai harvest, in one test. Three queries came back with items,
   * tiles and bodies all zero and `refusedBy: null` — an honest empty, according
   * to the capture, for a search page that was never served. The state was not
   * null, so the existing clause did not fire; it held TikTok's app-context
   * scopes and no item scope. The two text checks in `inpage.ts` did not fire
   * either, and could not have: they are English, and the viewpoint was `th-TH`.
   */
  const LOGIN_ASSET = "https://www.tiktok.com/obj/tiktok_web_login_static/webapp/main.js"

  it("refuses when nothing rendered, nothing answered, and the assets are the login bundle", async () => {
    const { page } = fakePage({ state: { "webapp.app-context": { region: "TH" } }, tiles: 0 }, [
      response(LOGIN_ASSET, 200, {}),
    ])
    const capture = await captureTikTok(context(page), "ร้านเด็ด เยาวราช", "search", NO_SETTLE)

    // The state strategy did read something, which is exactly why the older
    // `state === null` clause could not catch this.
    expect(capture.payload.strategies.state).toBe(true)
    expect(capture.refusedBy).toBe("login-wall")
  })

  it("does not refuse a page that rendered tiles, however its assets were served", async () => {
    const { page } = fakePage({ state: { "webapp.app-context": {} }, tiles: 12 }, [
      response(LOGIN_ASSET, 200, {}),
    ])
    const capture = await captureTikTok(context(page), "x", "search", NO_SETTLE)

    expect(capture.refusedBy).toBeUndefined()
  })

  it("does not refuse when the search api answered, however its assets were served", async () => {
    const { page } = fakePage({ state: null, tiles: 0 }, [
      response(LOGIN_ASSET, 200, {}),
      response("https://www.tiktok.com/api/search/general/?q=x", 200, {
        data: [{ item: { id: "123", desc: "x", stats: { playCount: 5 } } }],
      }),
    ])
    const capture = await captureTikTok(context(page), "x", "search", NO_SETTLE)

    expect(capture.refusedBy).toBeUndefined()
  })
})

describe("state that is not state", () => {
  /**
   * The live case, in one line. TikTok's state lives in a `<script>` whose `id`
   * makes it a global of the same name, so the first version of `readTikTokState`
   * came back holding the element. Across the evaluate boundary that serialised to
   * the string `ref: <Node>` — not null, so the refusal below stayed quiet, the
   * strategy was recorded as having worked, and the recorder wrote a 381-byte
   * fixture that read as a successful harvest of nothing.
   *
   * `inpage.ts` no longer returns a node. This asserts the second line of defence,
   * on this side of a serialiser nobody in this repository controls.
   */
  it("refuses a page whose state survived as something that is not an object", async () => {
    const { page } = fakePage({ state: "ref: <Node>" })
    const capture = await captureTikTok(context(page), "bánh mì", "search", { settleMs: 0 })

    expect(capture.payload.state).toBeNull()
    expect(capture.payload.strategies.state).toBe(false)
    expect(capture.refusedBy).toMatch(/no state and no item api response/)
  })

  it("still reports the strategy honestly when an api body arrived anyway", async () => {
    const { page } = fakePage({ state: "ref: <Node>" }, [
      response("https://www.tiktok.com/api/search/general/?q=x", 200, {
        data: [{ item: { id: "123", desc: "bánh mì", stats: { playCount: 5 } } }],
      }),
    ])
    const capture = await captureTikTok(context(page), "bánh mì", "search", { settleMs: 0 })

    expect(capture.payload.strategies.state).toBe(false)
    expect(capture.payload.strategies.intercepted).toBe(1)
    // Not a refusal: one strategy reading is a read.
    expect(capture.refusedBy).toBeUndefined()
  })
})

describe("captureTikTok", () => {
  it("keeps the item-list api bodies it saw", async () => {
    const fake = fakePage({}, [
      response("https://www.tiktok.com/api/search/general/full/?x=1", 200, { data: [1] }),
    ])
    const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    expect(capture.payload.intercepted).toHaveLength(1)
    expect(capture.payload.strategies.intercepted).toBe(1)
  })

  it("stores the api path without its query string, which carries device ids", async () => {
    const fake = fakePage({}, [
      response("https://www.tiktok.com/api/search/general/full/?msToken=secret", 200, {}),
    ])
    const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    expect(capture.payload.intercepted[0]?.path).toBe("/api/search/general/full/")
    expect(JSON.stringify(capture)).not.toContain("secret")
  })

  it("ignores responses that are not item lists, and ones that failed", async () => {
    const fake = fakePage({}, [
      response("https://www.tiktok.com/api/user/detail/", 200, { user: 1 }),
      response("https://www.tiktok.com/api/search/general/full/", 403, { blocked: 1 }),
    ])
    const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    expect(capture.payload.intercepted).toEqual([])
  })

  it("survives a response whose body is not json", async () => {
    // An async handler that rejects inside Playwright's synchronous `on` is an
    // unhandled rejection, which kills the session and loses the whole capture —
    // including the state, which may have been perfectly readable.
    const fake = fakePage({ state: { ItemModule: {} } }, [
      response("https://www.tiktok.com/api/explore/item_list/", 200, () =>
        Promise.reject(new Error("not json")),
      ),
    ])
    const capture = await captureTikTok(context(fake.page), "x", "explore", NO_SETTLE)
    expect(capture.payload.intercepted).toEqual([])
    expect(capture.payload.strategies.state).toBe(true)
    expect(capture.refusedBy).toBeUndefined()
  })

  it("stops listening when it is done", async () => {
    const fake = fakePage({ state: {} })
    await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    expect(fake.offCalls).toBe(1)
  })

  it("strips session identity from the stored state", async () => {
    const fake = fakePage({
      state: { AppContext: { deviceId: "d1" }, nested: { msToken: "t", keep: "yes" } },
    })
    const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    const json = JSON.stringify(capture)
    expect(json).not.toContain("msToken")
    expect(json).not.toContain("AppContext")
    expect(json).toContain("yes")
  })

  it("does not keep an author's bio, and the reversal is the point", async () => {
    // This test used to assert the opposite, on the reasoning that `signature` is
    // free text in the local language and therefore exactly what we harvest. The
    // reasoning was about an intention: `parse.ts` reads `uniqueId` off an author
    // and nothing else, so the bio was collected by us, published by us, and read
    // by nobody. What it did carry in the one recorded fixture was two people's
    // email addresses and a mobile number. See `REDACTED_KEYS`.
    const fake = fakePage({ state: { author: { signature: "quán ăn Sài Gòn" } } })
    const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    expect(JSON.stringify(capture)).not.toContain("quán ăn Sài Gòn")
  })

  it("keeps the handle the parser actually reads, which is what makes the drop safe", async () => {
    // The other half of the reversal. Dropping a field is only cheap while nothing
    // downstream wants it, and this asserts which field that is: if `parse.ts` ever
    // starts reading the bio, this pair of tests is where the argument reopens.
    const fake = fakePage({
      state: { author: { uniqueId: "nguyenrua", signature: "quán ăn Sài Gòn" } },
    })
    const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    expect(JSON.stringify(capture)).toContain("nguyenrua")
  })

  it("names which wall it hit, because three refusals mean three things", async () => {
    for (const [wall, expected] of [
      ["captcha", "captcha"],
      ["region", "region-block"],
      ["login", "login-wall"],
    ] as const) {
      const fake = fakePage({ wall, state: { some: "data" } })
      const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
      expect(capture.refusedBy).toBe(expected)
    }
  })

  it("archives the bytes of a refusal rather than discarding them", async () => {
    // A refused capture is the most valuable artefact a harvest produces, because
    // it is the evidence for what the viewpoint was refused by.
    const fake = fakePage({ wall: "region", state: { partial: true }, title: "unavailable" })
    const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    expect(capture.refusedBy).toBe("region-block")
    expect(capture.payload.state).toEqual({ partial: true })
    expect(capture.payload.pageTitle).toBe("unavailable")
  })

  it("reports a bounce off the host", async () => {
    const fake = fakePage({ href: "https://www.google.com/sorry/index" })
    const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    expect(capture.refusedBy).toBe("redirected to www.google.com")
  })

  it("refuses a page where neither strategy produced anything", async () => {
    // Not `empty`: a page we cannot read at all is not TikTok saying there is
    // nothing, it is us failing to hear what TikTok said.
    const fake = fakePage({ state: null, title: "TikTok" })
    const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    expect(capture.refusedBy).toContain("no state and no item api response")
  })

  it("does not call zero results a refusal", async () => {
    const fake = fakePage({ state: { ItemModule: {} }, tiles: 0 })
    const capture = await captureTikTok(
      context(fake.page),
      "nothingmatchesthis",
      "search",
      NO_SETTLE,
    )
    expect(capture.refusedBy).toBeUndefined()
  })

  it("records the url after redirects, which is where a bounce is visible", async () => {
    const fake = fakePage({ state: {}, href: "https://www.tiktok.com/login?redirect=search" })
    const capture = await captureTikTok(context(fake.page), "x", "search", NO_SETTLE)
    expect(capture.url).toBe("https://www.tiktok.com/login?redirect=search")
  })

  it("says which surface it was, so one parser can serve both", async () => {
    const fake = fakePage({ state: {} })
    const capture = await captureTikTok(context(fake.page), "", "explore", NO_SETTLE)
    expect(capture.sourceId).toBe("tiktok.explore")
    expect(capture.payload.surface).toBe("explore")
    expect(fake.visited[0]).toContain("/explore")
  })
})
