/**
 * Every Steam address this product reads, in one place, so the rules about them
 * live beside them.
 *
 * - **Store API** (`appdetails`, search): unofficial, and throttled at roughly 200
 *   requests per five minutes per address. `SteamClient` paces under that.
 * - **Reviews API** (`appreviews`): documented by Valve, cursor-paged.
 * - **Store page**: the only place the AI Generated Content Disclosure is shown.
 *   `appdetails` does not carry it, so a claim about AI use has to be read here.
 *
 * Not here, on purpose: SteamDB (its terms forbid scraping) and the Web API with a
 * key (its terms forbid reselling what it returns).
 */

export const STORE = "https://store.steampowered.com"

/** The store's age gate, answered as an adult. Without it a mature page is a form. */
export const AGE_COOKIES = [
  { name: "birthtime", value: "0" },
  { name: "lastagecheckage", value: "1-0-1990" },
  { name: "wants_mature_content", value: "1" },
] as const

export const ageCookieHeader = (): string =>
  AGE_COOKIES.map((c) => `${c.name}=${c.value}`).join("; ")

/** `cc` picks the store's region, and so the currency; `l` the language of the text. */
export const appDetailsUrl = (appid: number, cc = "us"): string =>
  `${STORE}/api/appdetails?appids=${appid}&cc=${cc}&l=english`

/** The summary only: `num_per_page=0` returns counts and no review bodies. */
export const reviewSummaryUrl = (appid: number): string =>
  `${STORE}/appreviews/${appid}?json=1&num_per_page=0&language=all&purchase_type=all`

/**
 * One page of reviews, newest first: `any` for what the game is getting now,
 * `negative` for enough complaints to say when players give up. All languages and
 * purchase types, so the sample is the store's, not ours.
 */
export const reviewPageUrl = (appid: number, type: "any" | "negative", count = 100): string =>
  `${STORE}/appreviews/${appid}?json=1&filter=recent&review_type=${type === "any" ? "all" : "negative"}` +
  `&language=all&purchase_type=all&num_per_page=${count}&cursor=*`

export const storePageUrl = (appid: number, cc = "us"): string =>
  `${STORE}/app/${appid}/?l=english&cc=${cc}`

export type SearchSort = "relevance" | "reviews" | "released"

const SORT: Record<SearchSort, string> = {
  relevance: "",
  reviews: "Reviews_DESC",
  released: "Released_DESC",
}

export interface SearchQuery {
  /** Steam tag ids, ANDed: a game must carry every one. */
  tagIds: number[]
  sort?: SearchSort
  start?: number
  /** The store answers at most 100 per page; 25 is what a person can prune. */
  count?: number
  cc?: string
}

/** Games only (`category1=998`): no soundtracks, DLC or demos in a comparable set. */
export function searchUrl(q: SearchQuery): string {
  const params = new URLSearchParams({
    tags: q.tagIds.join(","),
    category1: "998",
    infinite: "1",
    json: "1",
    start: String(q.start ?? 0),
    count: String(q.count ?? 25),
    cc: q.cc ?? "us",
    l: "english",
  })
  const sort = SORT[q.sort ?? "relevance"]
  if (sort) params.set("sort_by", sort)
  return `${STORE}/search/results/?${params}`
}
