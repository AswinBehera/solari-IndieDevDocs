/// <reference lib="dom" />
import { AGE_COOKIES, AI_SECTION_SELECTOR } from "@rd/steam"

/**
 * One store page in a cloud browser: its HTML, a full-page screenshot, and where
 * on that screenshot the two things we cite sit — the AI disclosure and the tag
 * strip — so the receipt viewer can draw a box around the sentence a fact quotes.
 *
 * Typed against the four page methods it uses rather than Playwright, which the
 * kernel keeps out of every package's types (its `newPage()` returns `unknown`).
 */

export interface PageLike {
  context(): { addCookies(cookies: object[]): Promise<void> }
  goto(
    url: string,
    opts: { waitUntil: "domcontentloaded" | "load"; timeout: number },
  ): Promise<unknown>
  content(): Promise<string>
  screenshot(opts: { fullPage: boolean; type: "jpeg"; quality: number }): Promise<Uint8Array>
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>
  setViewportSize?(size: { width: number; height: number }): Promise<void>
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface PageCapture {
  html: string
  screenshot: Uint8Array
  boxes: { ai: Box | null; tags: Box | null }
}

/** The page's own coordinates, so a box lines up with a full-page screenshot. */
function measure(selectors: string[]): (Box | null)[] {
  return selectors.map((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    // The disclosure shares its container with the mature-content note; box the
    // part under the AI heading when there is one.
    const heading = [...el.querySelectorAll("h2")].find((h) =>
      (h.textContent ?? "").includes("AI Generated Content"),
    )
    const target = heading?.parentElement ?? el
    const r = target.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }
  })
}

export async function captureStorePage(page: PageLike, url: string): Promise<PageCapture> {
  await page
    .context()
    .addCookies(AGE_COOKIES.map((c) => ({ ...c, domain: "store.steampowered.com", path: "/" })))
  await page.setViewportSize?.({ width: 1280, height: 900 })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
  const html = await page.content()
  const [ai, tags] = await page.evaluate(measure, [AI_SECTION_SELECTOR, ".glance_tags"])
  // JPEG at 60: a store page is ~6,000 px tall, and a PNG of it is several MB.
  const screenshot = await page.screenshot({ fullPage: true, type: "jpeg", quality: 60 })
  return { html, screenshot, boxes: { ai: ai ?? null, tags: tags ?? null } }
}
