import type { Place, PostcardState } from "@dt/core"

/**
 * The judgements the Trip Document's Postcards make, as plain functions — the
 * same split as `place-card.ts`: markup in the `.tsx`, anything worth arguing with
 * here, where a test can hold it without a DOM.
 */

export interface Badge {
  label: string
  /** Utility classes for the stamp's fill and ink. */
  className: string
}

/**
 * The stamp that says where a quote came from, coloured the way the canvas
 * colours them. Keyed on the source id's first segment, because the harvest's
 * ids are `<platform>.<surface>` — `pantip.forum`, `youtube.search` — and a
 * reader cares about the platform, not which of its pages the crawler read.
 */
export function sourceBadge(sourceId: string): Badge {
  const platform = sourceId.split(".")[0] ?? sourceId
  switch (platform) {
    case "tiktok":
      return { label: "TIKTOK", className: "bg-ink text-white" }
    case "youtube":
      return { label: "YOUTUBE", className: "bg-signal-red text-white" }
    case "pantip":
      return { label: "PANTIP", className: "bg-accent-blue text-white" }
    case "maps":
    case "gmaps":
      return { label: "GMAPS", className: "bg-signal-green text-white" }
    default:
      return { label: platform.toUpperCase(), className: "bg-ink-faint text-white" }
  }
}

/** FRESH, STALE or PINNED, in the canvas's three inks. */
export function stateTag(state: PostcardState): Badge {
  switch (state) {
    case "stale":
      return { label: "STALE", className: "border-signal-red text-signal-red" }
    case "pinned":
      return { label: "PINNED", className: "border-accent-gold text-accent-gold" }
    default:
      return { label: "FRESH", className: "border-rule text-ink-muted" }
  }
}

/** `scores.local` as a whole percentage, or null when nothing scored it. */
export function localPercent(place: Pick<Place, "scores">): number | null {
  const value = place.scores.local?.value
  return typeof value === "number" ? Math.round(value * 100) : null
}

/**
 * Factor names as a reader would say them. The pack names its factors in code
 * (`nativeLanguageShare`), and the card shows the algorithm (§6.3), so it has to
 * show it in words; an unknown factor is split on its capitals rather than
 * hidden, because a factor the UI does not know is still part of the number.
 */
const FACTOR_LABELS: Record<string, string> = {
  nativeLanguageShare: "Written in Thai",
  creatorLocalShare: "Creators who read as local",
  sourceDiversity: "Different sources saying so",
  engagementRatio: "Engagement for its reach",
  nonNativeLanguageShare: "Written for visitors",
  visitorCreatorShare: "Creators who read as visitors",
  listicleQuotes: "Listicle phrasing",
  listicleSources: "Listicle sites",
}

/** `native-language share`, `native_language_share` and `nativeLanguageShare` are one factor. */
const squash = (name: string) => name.replace(/[^a-z0-9]/gi, "").toLowerCase()
const BY_SQUASHED = new Map(Object.entries(FACTOR_LABELS).map(([k, v]) => [squash(k), v]))

export function factorLabel(name: string): string {
  const known = FACTOR_LABELS[name] ?? BY_SQUASHED.get(squash(name))
  if (known) return known
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export interface WhyRow {
  label: string
  /** The factor's contribution to the score, in points of the percentage. */
  points: string
}

/** "Why this score": the local score's own explanation, strongest factor first. */
export function whyRows(place: Pick<Place, "scores">): WhyRow[] {
  const because = place.scores.local?.because ?? []
  return [...because]
    .sort((a, b) => b.contribution - a.contribution)
    .map((e) => ({ label: factorLabel(e.factor), points: `+${Math.round(e.contribution * 100)}` }))
}

export type LinkKind = "tiktok" | "youtube" | "booking" | "agoda" | "maps" | "other"

/** What a pasted link is, which decides what the card can offer to do with it. */
export function linkKind(raw: string): LinkKind {
  let host: string
  try {
    host = new URL(raw).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return "other"
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok"
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com"))
    return "youtube"
  if (host === "booking.com" || host.endsWith(".booking.com")) return "booking"
  if (host === "agoda.com" || host.endsWith(".agoda.com")) return "agoda"
  if (host === "maps.app.goo.gl" || (host.startsWith("google.") && raw.includes("/maps"))) {
    return "maps"
  }
  return "other"
}

/**
 * The line under a link, saying honestly what the OS can do with it today.
 *
 * The canvas offers to "make a Place Postcard" from a TikTok and to watch a hotel
 * across eight countries. Reading a single link (P4.7) and Hundred Eyes (Phase 3)
 * are not built, so the card names what the link is and does not offer a button
 * that would do nothing.
 */
export function linkLine(kind: LinkKind): string {
  switch (kind) {
    case "tiktok":
      return "TikTok video, kept as a link. Turning videos into places is coming soon."
    case "youtube":
      return "YouTube video, kept as a link. Turning videos into places is coming soon."
    case "booking":
    case "agoda":
      return "A hotel page. Put it on a /price card to compare booking sites."
    case "maps":
      return "A map link."
    default:
      return "A link."
  }
}

export interface ChecklistItem {
  text: string
  done: boolean
}

/** "2 OF 4", or "EMPTY" for a list with nothing on it yet. */
export function checklistCount(items: readonly ChecklistItem[]): string {
  if (items.length === 0) return "EMPTY"
  return `${items.filter((i) => i.done).length} OF ${items.length}`
}

/** What a photo's metadata gave us: "GEO ✓ · NO TIME". */
export function photoLine(geo: unknown, takenAt: string | null): string {
  return `${geo ? "GEO ✓" : "NO GEO"} · ${takenAt ? "TIME ✓" : "NO TIME"}`
}

/** One country's line in the price table, from what `/probes/:id` returns. */
export interface PriceRow {
  country: string
  /** What was shown, exactly as the site displayed it, or the reason there is no figure. */
  label: string
  usd: number | null
  status: "price" | "no_price" | "blocked"
  cheapest: boolean
  /** Published path of the screenshot, when the API sent one. */
  screenshotRef: string | null
}

export interface ObservationWire {
  country: string
  payload: unknown
  screenshotRef?: string | null
}

/**
 * Rows for the table: priced countries cheapest first, then the ones with no figure.
 *
 * Only a normalised `usd` competes for "cheapest". A row with a price the FX source
 * could not convert is shown but never highlighted, because a highlight is a claim
 * and an unconverted figure cannot back it.
 */
export function priceRows(observations: readonly ObservationWire[]): PriceRow[] {
  const rows: PriceRow[] = observations.map((o) => {
    const p = (o.payload ?? {}) as {
      status?: PriceRow["status"]
      displayed?: string | null
      usd?: number | null
      wall?: string | null
    }
    const status = p.status ?? "no_price"
    const label =
      status === "price"
        ? (p.displayed ?? "").replace(/\s+/g, " ").trim()
        : status === "blocked"
          ? `blocked${p.wall ? ` (${p.wall})` : ""}`
          : "no price shown"
    return {
      country: o.country,
      label,
      usd: status === "price" && typeof p.usd === "number" ? p.usd : null,
      status,
      cheapest: false,
      screenshotRef: o.screenshotRef ?? null,
    }
  })
  rows.sort(
    (a, b) => (a.usd ?? Infinity) - (b.usd ?? Infinity) || a.country.localeCompare(b.country),
  )
  const first = rows.find((r) => r.usd !== null)
  if (first) first.cheapest = true
  return rows
}

/** "Highest is 7% above the lowest", or null when fewer than two countries have a figure. */
export function priceSpread(rows: readonly PriceRow[]): string | null {
  const usd = rows.map((r) => r.usd).filter((n): n is number => n !== null)
  if (usd.length < 2) return null
  const lo = Math.min(...usd)
  const hi = Math.max(...usd)
  const pct = Math.round(((hi - lo) / lo) * 100)
  return pct === 0 ? "Same price everywhere we could read." : `Highest is ${pct}% above the lowest.`
}

/** A hotel site the price card knows by name, from its URL. */
export function providerOf(url: string): { id: string; label: string } | null {
  const kind = linkKind(url)
  if (kind === "booking") return { id: "booking", label: "Booking.com" }
  if (kind === "agoda") return { id: "agoda", label: "Agoda" }
  return null
}

/** One site's line on the price card: one link, read from one viewpoint. */
export interface OfferRow {
  url: string
  provider: { id: string; label: string } | null
  /** Where the offer stands: not checked, being read, read, or read and refused. */
  status: "unchecked" | "reading" | "price" | "no_price" | "blocked"
  label: string
  usd: number | null
  /** Nights the page was asked for, so two sites are compared on the same stay. */
  nights: number | null
  checkIn: string | null
  screenshotRef: string | null
  cheapest: boolean
}

export interface OfferWire {
  url: string
  /** The stored probe target's `parsed`, when one has been read. */
  parsed?: unknown
  /** The observation from the card's viewpoint, if it has landed. */
  observation?: ObservationWire | null
  started?: boolean
}

/** Two sites within 2% of each other are level: see `offerRows`. */
export const NEAR_LEVEL = 0.02

/**
 * Rows for the provider comparison, cheapest first.
 *
 * "Cheapest" is only claimed between offers for the same stay (check-in and
 * nights) read from the same viewpoint in dollars; a two-night page against a
 * one-night page is not a saving, it is a different question.
 */
export function offerRows(offers: readonly OfferWire[]): OfferRow[] {
  const rows: OfferRow[] = offers.map((o) => {
    const parsed = (o.parsed ?? {}) as { checkIn?: string; checkOut?: string }
    const nights =
      parsed.checkIn && parsed.checkOut
        ? Math.round((Date.parse(parsed.checkOut) - Date.parse(parsed.checkIn)) / 86_400_000)
        : null
    const base = {
      url: o.url,
      provider: providerOf(o.url),
      nights,
      checkIn: parsed.checkIn ?? null,
      cheapest: false,
    }
    if (!o.observation) {
      return {
        ...base,
        status: o.started ? "reading" : "unchecked",
        label: o.started ? "reading…" : "not checked",
        usd: null,
        screenshotRef: null,
      }
    }
    const [row] = priceRows([o.observation])
    return {
      ...base,
      status: row?.status ?? "no_price",
      label: row?.label ?? "no price shown",
      usd: row?.usd ?? null,
      screenshotRef: row?.screenshotRef ?? null,
    }
  })
  rows.sort((a, b) => (a.usd ?? Infinity) - (b.usd ?? Infinity))
  const priced = rows.filter((r) => r.usd !== null)
  const sameStay =
    priced.length >= 2 &&
    priced.every((r) => r.nights === priced[0]?.nights && r.checkIn === priced[0]?.checkIn)
  // A gap inside NEAR_LEVEL is smaller than the tax and "from"-price differences
  // between sites, so naming a winner would be a claim the figures cannot back.
  const lo = priced[0]?.usd ?? 0
  const hi = priced[priced.length - 1]?.usd ?? 0
  if (sameStay && priced[0] && (hi - lo) / lo >= NEAR_LEVEL) priced[0].cheapest = true
  return rows
}

/** "Agoda is $80 less than Booking.com for the same night." or why no saving is claimed. */
export function offerVerdict(rows: readonly OfferRow[]): string | null {
  const priced = rows.filter((r) => r.usd !== null)
  if (priced.length < 2) return null
  const lo = priced[0] as OfferRow
  const hi = priced[priced.length - 1] as OfferRow
  const sameStay = priced.every((r) => r.nights === lo.nights && r.checkIn === lo.checkIn)
  if (!sameStay) return "These links are for different stays, so the prices are not compared."
  const gap = Math.round((hi.usd as number) - (lo.usd as number))
  const nights = lo.nights === 1 ? "the same night" : `the same ${lo.nights} nights`
  if (gap === 0) return "Same price on every site we read."
  if (!lo.cheapest)
    return `Level: within $${gap} for ${nights}, less than tax differences between sites. A code would decide it.`
  return `${lo.provider?.label ?? "One site"} is $${gap} less than ${hi.provider?.label ?? "the dearest"} for ${nights}.`
}
