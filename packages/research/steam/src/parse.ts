/**
 * Steam responses in, typed values out, and each value says where in the
 * response it was read.
 *
 * That second half is the point of the file. A fact in a document is only as good
 * as the pointer back to its receipt: a JSON path into a stored API response, or a
 * quote (and, from a browser, a box on a screenshot) on a stored page. Parsers are
 * pure, so re-reading an old receipt with a better parser costs nothing.
 *
 * The store page has no stable API, so its parser reads markup by id and class.
 * When Valve changes the markup it fails as "not found", never as a wrong value,
 * and the fixtures in `fixtures/` pin the markup it was written against.
 */

/** Where in a receipt a value was read. `box` is filled in by a browser capture. */
export interface Locator {
  /** JSONPath-ish, `$.413150.data.price_overview.final`, into a JSON receipt. */
  path?: string
  /** Text as it appears on the page, whitespace collapsed. */
  quote?: string
  /** The CSS selector of the element the quote was read from. */
  selector?: string
  /** Pixels on the receipt's screenshot. */
  box?: { x: number; y: number; width: number; height: number }
}

export interface Located<T> {
  value: T
  at: Locator
}

// ---- appdetails ---------------------------------------------------------------

export interface AppDetails {
  appid: number
  name: Located<string>
  type: string
  isFree: Located<boolean>
  developers: Located<string[]>
  publishers: Located<string[]>
  /** Null when free or unpriced (unreleased). Cents in `currency`. */
  price: Located<{ currency: string; initial: number; final: number; discountPercent: number }> | null
  releaseDate: Located<{ comingSoon: boolean; date: string }>
  genres: Located<string[]>
  shortDescription: string
  headerImage: string | null
}

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/**
 * `null` when Steam says `success: false`: a delisted, region-locked or mistyped
 * app. That is an answer, and the caller records it as one.
 */
export function parseAppDetails(json: unknown, appid: number): AppDetails | null {
  const entry = obj(obj(json)?.[String(appid)])
  if (!entry || entry.success !== true) return null
  const d = obj(entry.data)
  if (!d) return null
  const base = `$.${appid}.data`
  const names = (v: unknown, key: string): string[] =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === "string" ? x : str(obj(x)?.[key]))).filter((x) => x !== null)
      : []
  const po = obj(d.price_overview)
  const rd = obj(d.release_date)
  return {
    appid,
    name: { value: str(d.name) ?? "", at: { path: `${base}.name` } },
    type: str(d.type) ?? "unknown",
    isFree: { value: d.is_free === true, at: { path: `${base}.is_free` } },
    developers: { value: names(d.developers, ""), at: { path: `${base}.developers` } },
    publishers: { value: names(d.publishers, ""), at: { path: `${base}.publishers` } },
    price:
      po && num(po.final) !== null
        ? {
            value: {
              currency: str(po.currency) ?? "USD",
              initial: num(po.initial) ?? (num(po.final) as number),
              final: num(po.final) as number,
              discountPercent: num(po.discount_percent) ?? 0,
            },
            at: { path: `${base}.price_overview` },
          }
        : null,
    releaseDate: {
      value: { comingSoon: rd?.coming_soon === true, date: str(rd?.date) ?? "" },
      at: { path: `${base}.release_date` },
    },
    genres: { value: names(d.genres, "description"), at: { path: `${base}.genres` } },
    shortDescription: decodeEntities(str(d.short_description) ?? ""),
    headerImage: str(d.header_image),
  }
}

// ---- appreviews ---------------------------------------------------------------

export interface ReviewSummary {
  total: Located<number>
  positive: number
  negative: number
  /** Steam's own label, "Very Positive" and so on. */
  label: Located<string>
}

export function parseReviewSummary(json: unknown): ReviewSummary | null {
  const root = obj(json)
  const q = obj(root?.query_summary)
  if (!root || root.success !== 1 || !q) return null
  const positive = num(q.total_positive) ?? 0
  const negative = num(q.total_negative) ?? 0
  return {
    total: { value: num(q.total_reviews) ?? positive + negative, at: { path: "$.query_summary" } },
    positive,
    negative,
    label: {
      value: str(q.review_score_desc) ?? "",
      at: { path: "$.query_summary.review_score_desc" },
    },
  }
}

// ---- search -------------------------------------------------------------------

export interface SearchRow {
  appid: number
  name: string
  /** As the store prints it: "Feb 26, 2016", "Coming soon", "Q2 2027". */
  released: string
  /** Cents, from `data-price-final`. Null when the row has no price (free, unreleased). */
  priceFinal: number | null
  tagIds: number[]
  /** The review tooltip, "Very Positive<br>94% of the 1,203 user reviews…". */
  reviewTooltip: string | null
  at: Locator
}

export interface SearchPage {
  total: number
  rows: SearchRow[]
}

export function parseSearch(json: unknown): SearchPage | null {
  const root = obj(json)
  const html = str(root?.results_html)
  if (!root || html === null) return null
  const rows: SearchRow[] = []
  // One anchor per result. Split on the anchor's opening rather than matching it
  // whole: a row's markup nests divs, and a lazy `.*?</a>` would still be right
  // today and wrong the day Valve nests a link inside a row.
  for (const chunk of html.split(/<a\s+href="/).slice(1)) {
    const appid = Number(/data-ds-appid="(\d+)"/.exec(chunk)?.[1])
    const name = /<span class="title">([^<]*)<\/span>/.exec(chunk)?.[1]
    if (!Number.isFinite(appid) || !name) continue // a bundle or package row
    const price = /data-price-final="(\d+)"/.exec(chunk)?.[1]
    const tags = /data-ds-tagids="\[([\d,]*)\]"/.exec(chunk)?.[1]
    const tooltip = /search_review_summary[^"]*" data-tooltip-html="([^"]*)"/.exec(chunk)?.[1]
    const title = decodeEntities(name).trim()
    rows.push({
      appid,
      name: title,
      released: collapse(/<div class="search_released[^"]*">([^<]*)</.exec(chunk)?.[1] ?? ""),
      priceFinal: price === undefined ? null : Number(price),
      tagIds: tags ? tags.split(",").filter(Boolean).map(Number) : [],
      reviewTooltip: tooltip ? decodeEntities(tooltip) : null,
      at: { quote: title, selector: `a[data-ds-appid="${appid}"]` },
    })
  }
  return { total: num(root.total_count) ?? rows.length, rows }
}

// ---- store page ---------------------------------------------------------------

/** What the page says about AI, verbatim. Absent is a finding too, and says so. */
export type AiDisclosure =
  | { disclosed: true; text: string; at: Locator }
  | { disclosed: false; at: Locator }

export interface StorePage {
  /** The age gate or a login wall instead of the page: nothing below is readable. */
  gated: boolean
  title: string | null
  ai: AiDisclosure
  /** User-applied tags, in the store's order (most applied first). */
  tags: Located<string[]>
  releaseDate: string | null
  developers: string[]
}

export const AI_SECTION_SELECTOR = "#game_area_content_descriptors"
const AI_HEADING = "AI Generated Content Disclosure"

export function parseStorePage(html: string): StorePage {
  const gated = /id="app_agegate"|agegate_birthday_selector/.test(html)
  const title = /<div id="appHubAppName" class="apphub_AppName">([^<]*)</.exec(html)?.[1] ?? null

  // The disclosure shares its container id with the mature-content description, so
  // the heading is what identifies it, not the id.
  const heading = html.indexOf(`<h2>${AI_HEADING}</h2>`)
  let ai: AiDisclosure
  if (heading === -1) {
    ai = {
      disclosed: false,
      at: { quote: `No "${AI_HEADING}" section on the page`, selector: AI_SECTION_SELECTOR },
    }
  } else {
    const end = html.indexOf("</div>", heading)
    const section = html.slice(heading, end === -1 ? undefined : end)
    const italic = /<i>([\s\S]*?)<\/i>/.exec(section)?.[1]
    const text = collapse(decodeEntities(stripTags(italic ?? section.replace(AI_HEADING, ""))))
    ai = { disclosed: true, text, at: { quote: text, selector: AI_SECTION_SELECTOR } }
  }

  const tagBlock = /class="glance_tags popular_tags"[\s\S]*?<\/div>/.exec(html)?.[0] ?? ""
  const tags = [...tagBlock.matchAll(/class="app_tag"[^>]*>([^<]+)</g)]
    .map((m) => collapse(decodeEntities(m[1] ?? "")))
    .filter((t) => t && t !== "+")

  const release = /<div class="release_date">[\s\S]*?<div class="date">([^<]*)</.exec(html)?.[1]
  const devList = /id="developers_list">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ""
  const developers = [...devList.matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) =>
    collapse(decodeEntities(m[1] ?? "")),
  )

  return {
    gated,
    title: title ? collapse(decodeEntities(title)) : null,
    ai,
    tags: { value: tags, at: { quote: tags.slice(0, 5).join(", "), selector: ".glance_tags" } },
    releaseDate: release ? collapse(release) : null,
    developers,
  }
}

// ---- text ---------------------------------------------------------------------

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim()
const stripTags = (s: string): string => s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  trade: "™",
  reg: "®",
  copy: "©",
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** "94% of the 1,203 user reviews" out of a tooltip, as numbers. */
export function reviewShareFromTooltip(tooltip: string): { pct: number; count: number } | null {
  const m = /(\d+)% of the ([\d,]+) user reviews/.exec(tooltip)
  return m ? { pct: Number(m[1]), count: Number(m[2]?.replace(/,/g, "")) } : null
}
