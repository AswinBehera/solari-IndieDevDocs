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

export function factorLabel(name: string): string {
  const known = FACTOR_LABELS[name]
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
      return "TikTok video. Reading it into a Place is not wired up yet; it stays as a link."
    case "youtube":
      return "YouTube video. Reading it into a Place is not wired up yet; it stays as a link."
    case "booking":
    case "agoda":
      return "A hotel page. Watching its price across countries arrives with Hundred Eyes."
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
