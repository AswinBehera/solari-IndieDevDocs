import type { FxRates, ProbeAdapter, ProbeCapture, ProbeContext } from "@samsara/probe"
import {
  PRICE_SOURCE_ID,
  type PriceSite,
  parseStayUrl,
  readCaveats,
  readPrice,
  readWall,
  type StayTarget,
} from "./parse.js"

/**
 * The Booking and Agoda probes (P3.2): what one country is shown for one property.
 *
 * **Three outcomes, all stored.** `price` (a figure was read), `no_price` (a real
 * property page with no figure: sold out, or the price renders later than we waited)
 * and `blocked` (a wall). The plan's acceptance is "a price or an explicit
 * Blocked/NoPrice", and this is where that is decided. The screenshot is taken in
 * every case, before anything is read, so a wrong reading can always be checked
 * against the picture.
 *
 * **Selectors are guesses and the payload says which one hit.** `source` records
 * whether the figure came from a price element or from a scan of the visible text,
 * so the first live captures show which guess is holding rather than only that
 * something was read. The scan is the fallback because it survives a redesign; it
 * is also the one more likely to read a price that is not the room's.
 */

/** The slice of Playwright's `Page` this uses, which is also the slice a fake must fake. */
export interface PricePage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  url(): string
  title(): Promise<string>
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>
  screenshot(options?: { type?: "png"; fullPage?: boolean }): Promise<Uint8Array>
  waitForTimeout?(ms: number): Promise<void>
}

export interface PricePayload {
  status: "price" | "no_price" | "blocked"
  site: PriceSite
  country: string
  finalUrl: string
  title: string
  /** The price string exactly as displayed, and what it was read from. */
  displayed: string | null
  source: "element" | "text-scan" | null
  amount: number | null
  currency: string | null
  caveats: string[]
  wall: string | null
  /** Text around a scan hit, so a figure that was not a room price can be seen to be one. */
  context: string | null
  /** Added by `normalise`, never in place of the raw figure. */
  usd?: number | null
}

/** Elements a price is known to sit in, most specific first. Guesses; see the header. */
const PRICE_SELECTORS: Record<PriceSite, string[]> = {
  booking: [
    ".prc-no-css",
    '[data-testid="price-and-discounted-price"]',
    '[data-testid="price-for-x-nights"]',
    ".prco-valign-middle-helper",
  ],
  agoda: [
    '[data-selenium="display-price"]',
    '[data-element-name="final-price"]',
    '[data-ppapi="room-price"]',
  ],
}

const SETTLE_MS = 3_000
const POLL_MS = 1_500
const MAX_WAIT_MS = 35_000
const MAX_TEXT = 20_000

export const priceAdapter: ProbeAdapter<StayTarget, PricePayload> = {
  id: PRICE_SOURCE_ID as never,

  parseUrl(url) {
    const r = parseStayUrl(url, new Date())
    return r.ok ? { ok: true, parsed: r.parsed } : r
  },

  async probe(ctx: ProbeContext, target): Promise<ProbeCapture<PricePayload>> {
    const page = ctx.page as PricePage
    const { site } = target.parsed
    // A slow route must still produce its screenshot and its `no_price`: a navigation
    // that runs into the session deadline throws away the picture along with the wait.
    // 30 s here plus the 35 s price wait stays inside the engine's 90 s deadline.
    let navigationNote: string | null = null
    try {
      await page.goto(target.parsed.url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    } catch (e) {
      navigationNote = `navigation did not settle: ${e instanceof Error ? e.message.slice(0, 80) : "unknown"}`
    }
    // Prices render from XHR after `domcontentloaded`, so a read now reads a shell.
    // Poll for a price element rather than sleeping a fixed time: the fixed sleep
    // photographed a loading skeleton on the first live run.
    const pause = (ms: number) =>
      page.waitForTimeout ? page.waitForTimeout(ms) : new Promise((r) => setTimeout(r, ms))
    const probeElements = () =>
      page.evaluate(
        (sels: string[]) =>
          sels.some((sel) =>
            Array.from(document.querySelectorAll(sel)).some((el) =>
              /\d/.test((el as HTMLElement).innerText ?? ""),
            ),
          ) ||
          Array.from(document.querySelectorAll("div,span"))
            .slice(0, 4000)
            .some((el) =>
              /^from\s+\S{1,4}\s?[\d,.]+$/i.test(
                ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim(),
              ),
            ),
        PRICE_SELECTORS[site],
      )
    await pause(SETTLE_MS)
    for (let waited = SETTLE_MS; waited < MAX_WAIT_MS; waited += POLL_MS) {
      if (ctx.signal.aborted || (await probeElements().catch(() => false))) break
      await pause(POLL_MS)
    }

    // Picture first: it is the evidence, and it must exist even if reading throws.
    const screenshot = await page.screenshot({ type: "png" })
    const title = await page.title()
    const read = await page.evaluate(
      ({ selectors, max }: { selectors: string[]; max: number }) => {
        const texts: string[] = []
        for (const sel of selectors) {
          for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 5)) {
            const t = (el as HTMLElement).innerText?.trim()
            if (t) texts.push(t)
          }
        }
        // Agoda splits currency and figure across spans, so no single element
        // matches a selector; its price is the short "from <price>" label instead.
        for (const el of Array.from(document.querySelectorAll("div,span")).slice(0, 4000)) {
          const t = ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim()
          if (t.length < 40 && /^from\s+\S{1,4}\s?[\d,.]+$/i.test(t))
            texts.push(t.replace(/^from\s+/i, ""))
        }
        return { elements: texts, body: (document.body?.innerText ?? "").slice(0, max) }
      },
      { selectors: PRICE_SELECTORS[site], max: MAX_TEXT },
    )

    const wall = readWall(`${title}\n${read.body.slice(0, 2_000)}`)
    let displayed = null as ReturnType<typeof readPrice>
    let source: PricePayload["source"] = null
    let context: string | null = null
    for (const t of read.elements) {
      displayed = readPrice(t)
      if (displayed) {
        source = "element"
        break
      }
    }
    // Agoda's page is full of calendar and filter numbers; a scan there reads a
    // calendar cell as a price (seen live: "USD2"), so Agoda answers from elements only.
    if (!displayed && !wall && site === "booking") {
      displayed = readPrice(read.body)
      if (displayed) {
        source = "text-scan"
        const at = read.body.indexOf(displayed.raw)
        context = read.body
          .slice(Math.max(0, at - 80), at + displayed.raw.length + 80)
          .replace(/\s+/g, " ")
      }
    }

    // A redirect to a list or a city page carries prices that are not this property's.
    const offProperty = !parseStayUrl(page.url(), new Date()).ok
    if (offProperty && !wall) {
      displayed = null
      source = null
      context = null
    }
    const status: PricePayload["status"] = wall ? "blocked" : displayed ? "price" : "no_price"
    return {
      payload: {
        status,
        site,
        country: ctx.country,
        finalUrl: page.url(),
        title,
        displayed: displayed?.raw ?? null,
        source,
        amount: displayed?.amount ?? null,
        currency: displayed?.currency ?? null,
        caveats: readCaveats(read.body),
        wall,
        context,
      },
      screenshot,
      ...(wall
        ? { notes: `blocked: ${wall}` }
        : offProperty
          ? { notes: "redirected off the property page" }
          : {}),
    }
  },

  normalise(payload: PricePayload, rates: FxRates): PricePayload {
    if (payload.amount === null || payload.currency === null) return { ...payload, usd: null }
    const perUnit = rates[payload.currency]
    return { ...payload, usd: perUnit ? Math.round(payload.amount * perUnit * 100) / 100 : null }
  },
}
