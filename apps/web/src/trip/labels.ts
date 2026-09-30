import type { Postcard } from "@dt/core"
import { checklistCount } from "@dt/ui"
import { placeFromPayload } from "./places"

/**
 * What a card is called on the map and the timeline, where there is room for a
 * few words and not for the card. A place is its roman name when it has one —
 * the rail is small, and the map is read by someone orienting, not someone
 * ordering — and everything else is named for what it holds.
 */
export function cardTitle(card: Pick<Postcard, "kind" | "payload">): string {
  const payload = (card.payload ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string).trim() : "")
  switch (card.kind) {
    case "place": {
      const snap = placeFromPayload(card.payload)
      if (!snap) return "Place"
      return snap.place.canonicalName || snap.place.localName || "Place"
    }
    case "note": {
      const text = str("text")
      if (!text) return "Note"
      const first = text.split("\n")[0] ?? text
      return first.length > 40 ? `${first.slice(0, 39)}…` : first
    }
    case "checklist": {
      const items = Array.isArray(payload.items) ? payload.items : []
      return `Checklist · ${checklistCount(items as { text: string; done: boolean }[])}`
    }
    case "photo":
      return str("caption") || "Photo"
    case "price": {
      const offers = Array.isArray(payload.offers) ? payload.offers.length : str("url") ? 1 : 0
      return offers ? `Prices · ${offers} site${offers === 1 ? "" : "s"}` : "Prices"
    }
    case "link": {
      const url = str("url")
      const label = "Link"
      try {
        return url ? `${label} · ${new URL(url).hostname.replace(/^www\./, "")}` : label
      } catch {
        return label
      }
    }
  }
}

/** "09:40" for a card with a time of day; empty for a date-only card. */
export function clockOf(card: Pick<Postcard, "time">): string {
  const start = card.time?.start
  if (!start) return ""
  const h = start.getUTCHours()
  const m = start.getUTCMinutes()
  if (h === 0 && m === 0) return ""
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}
