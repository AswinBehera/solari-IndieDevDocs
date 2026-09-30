import { z } from "zod"

/**
 * Discount codes for hotel sites, as Thai bargain hunters pass them around.
 *
 * **A second pack on the same engine, not a feature bolted onto the first.** A
 * code hunt is a harvest like any other, run by a character in Thai on Pantip and
 * YouTube, with `domainId: "deals"`. The harvest chains into `refine.extract`
 * exactly as a place harvest does; the registry hands it this pack, and the
 * mentions land in the same table under their own domain. There is no `resolve`
 * spec, so the chain stops after extraction: a code has nothing to resolve to.
 *
 * This file is the schema and the folding, zod only, so the API and the browser
 * can import it; the prompt and the pack object are in `deals-pack.ts`.
 *
 * **Never verified.** Nobody applies a code at checkout; the card says where it
 * was seen and when, and says it is unverified, because it is.
 */

export const DEALS_DOMAIN = "deals"
export const DEAL_PROMPT_VERSION = "1"

export const DEAL_PROVIDERS = ["agoda", "booking"] as const
export type DealProvider = (typeof DEAL_PROVIDERS)[number]

export const PROVIDER_LABEL: Record<DealProvider, string> = {
  agoda: "Agoda",
  booking: "Booking.com",
}

/**
 * What the Deal hunter searches, per provider. Thai first, because the codes are
 * posted by Thai users for Thai users; the site names stay Latin, since that is
 * how they are typed.
 */
export const DEAL_SEARCHES: readonly { provider: DealProvider; sourceId: string; query: string }[] =
  [
    { provider: "agoda", sourceId: "youtube.search", query: "โค้ดส่วนลด agoda" },
    { provider: "agoda", sourceId: "pantip.tag", query: "Agoda" },
    { provider: "booking", sourceId: "youtube.search", query: "โค้ดส่วนลด booking.com" },
    { provider: "booking", sourceId: "pantip.tag", query: "Booking.com" },
  ]

const CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/

/**
 * One code as a post gave it.
 *
 * The refinement is the part that matters: the code must appear, letter for
 * letter, inside the quote, and the quote is copied from the item. A model that
 * invents a plausible code fails validation and the extract stage drops that one
 * mention, which is the only honest thing to do with a code nobody wrote.
 */
export const dealMention = z
  .object({
    provider: z.enum([...DEAL_PROVIDERS, "other"]),
    code: z
      .string()
      .transform((s) => s.trim().toUpperCase())
      .pipe(z.string().regex(CODE)),
    /** The offer as written: "ลด 8%", "฿500 off". Null if the post does not say. */
    offer: z.string().min(1).max(80).nullable(),
    /** The expiry as written, in the post's own words. Null if not given. */
    expires: z.string().min(1).max(60).nullable(),
    /** Minimum spend, new users only, app only; as written. */
    conditions: z.string().min(1).max(140).nullable(),
    quote: z.string().min(1).max(240),
  })
  .refine((m) => m.quote.toUpperCase().includes(m.code), {
    message: "the code must appear verbatim in the quote",
    path: ["code"],
  })

export type DealMention = z.infer<typeof dealMention>

/** One code on the card: every sighting of it folded into one row. */
export interface DealCode {
  provider: DealMention["provider"]
  code: string
  offer: string | null
  expires: string | null
  conditions: string | null
  quote: string
  /** Where it was seen most recently. */
  seenOn: { sourceId: string; url: string; at: string }
  sightings: number
}

export interface DealSighting {
  payload: unknown
  createdAt: string
  item: { sourceId: string; url: string }
}

/**
 * Fold mentions into one row per (provider, code), newest sighting first.
 *
 * Re-validated here rather than trusted, for the reason `asPlaceMention` gives:
 * the payload column holds whatever the pack version of the day wrote.
 */
export function groupDeals(
  rows: readonly DealSighting[],
  providers?: readonly string[],
): DealCode[] {
  const byKey = new Map<string, DealCode>()
  const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const row of sorted) {
    const parsed = dealMention.safeParse(row.payload)
    if (!parsed.success) continue
    const m = parsed.data
    if (providers && !providers.includes(m.provider)) continue
    const key = `${m.provider}:${m.code}`
    const seen = byKey.get(key)
    if (seen) {
      seen.sightings += 1
      seen.offer ??= m.offer
      seen.expires ??= m.expires
      seen.conditions ??= m.conditions
      continue
    }
    byKey.set(key, {
      provider: m.provider,
      code: m.code,
      offer: m.offer,
      expires: m.expires,
      conditions: m.conditions,
      quote: m.quote,
      seenOn: { sourceId: row.item.sourceId, url: row.item.url, at: row.createdAt },
      sightings: 1,
    })
  }
  return [...byKey.values()].sort(
    (a, b) => b.sightings - a.sightings || b.seenOn.at.localeCompare(a.seenOn.at),
  )
}
