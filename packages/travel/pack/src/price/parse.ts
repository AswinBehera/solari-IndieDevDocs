/**
 * The pure half of the price probes (P3.2): what a URL says, and what a price string
 * says. No page, no clock, no network, so both are tested against strings.
 */

/** The probe source id every stay target is stored under. */
export const PRICE_SOURCE_ID = "price.stay"

export type PriceSite = "booking" | "agoda"

export interface StayTarget {
  site: PriceSite
  /** The URL with its dates and party normalised in, which is what is actually loaded. */
  url: string
  checkIn: string
  checkOut: string
  adults: number
}

export type ParseResult = { ok: true; parsed: StayTarget } | { ok: false; reason: string }

const DAY_MS = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)

/** Default stay: a month out, one night, two adults. A price with no dates is no price. */
export function defaultStay(now: Date): { checkIn: string; checkOut: string; adults: number } {
  const start = new Date(now.getTime() + 30 * DAY_MS)
  return { checkIn: iso(start), checkOut: iso(new Date(start.getTime() + DAY_MS)), adults: 2 }
}

const validDay = (s: string | null): s is string =>
  s !== null && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(new Date(`${s}T00:00:00Z`)) === s

/**
 * Booking and Agoda property URLs, and nothing else. A search page, a city page or a
 * shortened link is refused by name here, because probing one would spend eight
 * sessions to photograph a list.
 */
export function parseStayUrl(raw: string, now: Date): ParseResult {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: "not a URL" }
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { ok: false, reason: "not a web URL" }
  const host = u.hostname.replace(/^www\./, "")
  const dflt = defaultStay(now)
  const q = u.searchParams

  if (/(^|\.)booking\.com$/.test(host)) {
    if (
      !/\/hotel\/[a-z]{2}\/[^/]+\.[a-z-]+\.html$|\/hotel\/[a-z]{2}\/[^/]+\.html$/.test(u.pathname)
    ) {
      return { ok: false, reason: "not a Booking property page (expected /hotel/<cc>/<name>.html)" }
    }
    const checkIn = validDay(q.get("checkin")) ? (q.get("checkin") as string) : dflt.checkIn
    const checkOut = validDay(q.get("checkout")) ? (q.get("checkout") as string) : dflt.checkOut
    const adults = clampAdults(q.get("group_adults"), dflt.adults)
    const out = new URL(`https://www.booking.com${u.pathname}`)
    out.searchParams.set("checkin", checkIn)
    out.searchParams.set("checkout", checkOut)
    out.searchParams.set("group_adults", String(adults))
    out.searchParams.set("no_rooms", "1")
    out.searchParams.set("group_children", "0")
    return { ok: true, parsed: { site: "booking", url: out.toString(), checkIn, checkOut, adults } }
  }

  if (/(^|\.)agoda\.com$/.test(host)) {
    if (!/\/[^/]+\/hotel\/[^/]+\.html$/.test(u.pathname)) {
      return {
        ok: false,
        reason: "not an Agoda property page (expected /<name>/hotel/<city>.html)",
      }
    }
    const checkIn = validDay(q.get("checkIn")) ? (q.get("checkIn") as string) : dflt.checkIn
    // Agoda's own links carry the stay as `los` (nights), not a checkout date.
    const los = Number(q.get("los"))
    const checkOut = validDay(q.get("checkOut"))
      ? (q.get("checkOut") as string)
      : validDay(q.get("checkIn")) && Number.isInteger(los) && los >= 1 && los <= 30
        ? new Date(Date.parse(checkIn) + los * DAY_MS).toISOString().slice(0, 10)
        : dflt.checkOut
    const adults = clampAdults(q.get("adults"), dflt.adults)
    // The language segment is stripped: it picks the site's locale, and the probe's
    // whole point is that the viewpoint, not the URL, decides what is shown.
    const out = new URL(
      `https://www.agoda.com${u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "")}`,
    )
    out.searchParams.set("checkIn", checkIn)
    out.searchParams.set(
      "los",
      String(Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / DAY_MS))),
    )
    out.searchParams.set("adults", String(adults))
    out.searchParams.set("rooms", "1")
    out.searchParams.set("children", "0")
    return { ok: true, parsed: { site: "agoda", url: out.toString(), checkIn, checkOut, adults } }
  }

  return { ok: false, reason: "only Booking and Agoda property pages are supported" }
}

function clampAdults(raw: string | null, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : fallback
}

// ---------------------------------------------------------------------------

/** Symbol or code to ISO 4217. Deliberately short: an unknown one is reported, not guessed. */
const SYMBOLS: Record<string, string> = {
  $: "USD",
  US$: "USD",
  "£": "GBP",
  "€": "EUR",
  "฿": "THB",
  THB: "THB",
  "¥": "JPY",
  "￥": "JPY",
  "JP¥": "JPY",
  円: "JPY",
  "₹": "INR",
  "Rs.": "INR",
  A$: "AUD",
  AU$: "AUD",
  S$: "SGD",
  SGD: "SGD",
  USD: "USD",
  GBP: "GBP",
  EUR: "EUR",
  JPY: "JPY",
  INR: "INR",
  AUD: "AUD",
}

export interface DisplayedPrice {
  raw: string
  amount: number
  /** Null when the symbol is not one we know: the raw string is kept and nothing is guessed. */
  currency: string | null
}

const AMOUNT = "\\d{1,3}(?:[,.\\s\\u00a0]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?"
const SYM = "US\\$|JP¥|AU\\$|A\\$|S\\$|Rs\\.|[$£€฿¥￥₹円]|THB|SGD|USD|GBP|EUR|JPY|INR|AUD"
const BEFORE = new RegExp(`(${SYM})\\s?(${AMOUNT})`)
const AFTER = new RegExp(`(${AMOUNT})\\s?(${SYM})`)

/** "1,234.50" and "1.234,50" both mean 1234.5; "1,234" and "1.234" mean 1234. */
export function toNumber(s: string): number {
  const t = s.replace(/[\s ]/g, "")
  const lastComma = t.lastIndexOf(",")
  const lastDot = t.lastIndexOf(".")
  const sep = Math.max(lastComma, lastDot)
  if (sep === -1) return Number(t)
  const frac = t.length - sep - 1
  // Three digits after the only separator of its kind is a thousands group.
  if (frac === 3 && (t.match(/[.,]/g) ?? []).length === 1) return Number(t.replace(/[.,]/g, ""))
  return Number(`${t.slice(0, sep).replace(/[.,]/g, "")}.${t.slice(sep + 1)}`)
}

/** The first price in a string, or null. Currency symbol on either side. */
export function readPrice(text: string): DisplayedPrice | null {
  const b = BEFORE.exec(text)
  const a = AFTER.exec(text)
  const hit = b && a ? (b.index <= a.index ? "b" : "a") : b ? "b" : a ? "a" : null
  if (hit === null) return null
  const [sym, num] = hit === "b" ? [b?.[1], b?.[2]] : [a?.[2], a?.[1]]
  const amount = toNumber(num ?? "")
  if (!Number.isFinite(amount) || amount <= 0) return null
  return {
    raw: (hit === "b" ? b?.[0] : a?.[0]) ?? "",
    amount,
    currency: SYMBOLS[sym ?? ""] ?? null,
  }
}

/** Phrases that change what a displayed price means, kept verbatim for the reader. */
const CAVEATS: [RegExp, string][] = [
  [
    /(taxes|tax)\s+(and|&)\s+(fees|charges)\s+(not\s+)?included|excludes?\s+taxes|\+\s?taxes/i,
    "taxes and fees may be extra",
  ],
  [
    /member|sign in to (see|unlock)|genius|loyalty|logged.?in/i,
    "a member or sign-in rate may apply",
  ],
  [/mobile.only|app.only/i, "an app-only rate may apply"],
  [/limited.time|only \d+ (left|rooms?)/i, "a limited-availability price"],
]

export function readCaveats(text: string): string[] {
  return CAVEATS.filter(([re]) => re.test(text)).map(([, label]) => label)
}

/** A page that is a wall rather than a property. Checked against title and visible text. */
const WALLS: [RegExp, string][] = [
  [
    /captcha|are you a robot|verify (that )?you('| a)re (not )?a? ?human|press (&|and) hold/i,
    "captcha",
  ],
  [/access denied|request blocked|unusual traffic|temporarily blocked/i, "access denied"],
  [/not available in your (country|region)|unavailable in your region/i, "region block"],
]

export function readWall(text: string): string | null {
  for (const [re, label] of WALLS) if (re.test(text)) return label
  return null
}
