import type { Geo, Place, PlaceCategory } from "@dt/core"
import type { Explanation } from "@samsara/core"

/**
 * What a Place Postcard shows, decided in plain functions.
 *
 * The card's judgements — which spelling leads, what a tier means in words,
 * whether a coordinate is where it claims to be — are the parts worth arguing
 * with, so they are here rather than inside JSX. `PlaceCard.tsx` reads this and
 * adds no decisions of its own.
 *
 * The same reasoning as `@dt/travel-pack`'s `osm-tags.ts`: a mapping that
 * encodes opinions should be testable without standing up the thing that
 * normally calls it. Here that also means the card is covered without a DOM, a
 * renderer, or a testing library the dependency list does not have.
 */

/** West, south, east, north — the order `@dt/travel-pack`'s `Bbox` uses. */
export type Bbox = readonly [number, number, number, number]

/**
 * One piece of evidence, as the card needs it.
 *
 * Not `@samsara/core`'s `Evidence`: that row carries the pack-shaped `extract` as
 * `unknown`, a storage ref and a persona id, and the card wants the quote out of
 * it and nothing else. Narrowing here rather than in the component means the API
 * can send exactly this and the card does not learn the shape of a database row.
 */
export interface CardEvidence {
  quote: string
  sourceId: string
  sourceUrl: string
  /** BCP-47 or a bare language code, as the harvest recorded it. Null when unknown. */
  language: string | null
}

export interface NamePair {
  /** The line set in the display face. */
  primary: string
  /** The line under it, or null when repeating the primary would be all it said. */
  secondary: string | null
  /** True when `primary` is in Thai script, which the card sets at a larger size. */
  primaryIsLocal: boolean
}

/**
 * The native spelling leads when there is one.
 *
 * This is a product decision and not a formatting one. The guide is about places
 * as they are signed, and the romanisation is the accommodation — putting "Jay
 * Fai" above "เจ๊ไฝ" would make the Thai a subtitle of the English in a Thai
 * travel guide. It also matches what the resolver found: Tier 1 matches the
 * native name far more often than the romanisation, so the native name is the
 * one the rest of the system agrees on.
 *
 * When the two are the same string — common for places whose sign is in Latin
 * script — the second line is dropped rather than printed twice.
 */
export function names(place: Place): NamePair {
  const local = place.localName?.trim()
  const canonical = place.canonicalName.trim()
  if (!local) return { primary: canonical, secondary: null, primaryIsLocal: false }
  if (local === canonical) return { primary: local, secondary: null, primaryIsLocal: true }
  return { primary: local, secondary: canonical, primaryIsLocal: true }
}

export const categoryLabel: Record<PlaceCategory, string> = {
  food: "Food",
  drink: "Drink",
  market: "Market",
  temple: "Temple",
  nature: "Nature",
  nightlife: "Nightlife",
  shop: "Shop",
  other: "Other",
}

export interface Meter {
  /** `scores` key, as the pack named it. */
  key: string
  label: string
  /** 0 to 1, clamped. A score outside the range is a scorer bug, not a wider bar. */
  fraction: number
  /** Two significant figures, for the number printed beside the bar. */
  reading: string
  /** Product principle 3: the card can show why, so it is carried here. */
  because: readonly Explanation[]
}

/**
 * The local/tourist pair, in that order, always both present.
 *
 * Both are rendered even when one is missing from `scores`, as a zero with no
 * explanations. A card that silently omitted the tourist bar would read as "no
 * tourist signal" when it in fact means "the scorer did not run", and those are
 * different enough that the second must not be able to impersonate the first.
 */
export function meters(place: Place): readonly [Meter, Meter] {
  return [meter(place, "local", "Local"), meter(place, "tourist", "Tourist")]
}

function meter(place: Place, key: string, label: string): Meter {
  const score = place.scores[key]
  const raw = score?.value ?? 0
  const fraction = Math.min(1, Math.max(0, raw))
  return { key, label, fraction, reading: fraction.toFixed(2), because: score?.because ?? [] }
}

/**
 * How the coordinate was arrived at, in words a reader can weigh.
 *
 * ADR-0017 made the winning tier recoverable precisely so it could be shown, and
 * P2.3's measurement is the argument for showing it: Tier 1 resolves a name by
 * trigram similarity and is capable of confident 300km errors, while Tier 0 read
 * a pin the author dropped themselves. Those deserve different amounts of trust
 * and the card should not flatten them into a dot on a map.
 */
export function provenance(place: Place): string {
  if (!place.geo) return "No coordinate"
  const source = place.externalRef?.source
  switch (place.resolvedTier) {
    case 0:
      return "Pinned in the post"
    case 1:
      return "Matched in OpenStreetMap"
    case 2:
      return "Looked up by geocoder"
    default:
      return source ? `From ${source}` : "Location source not recorded"
  }
}

export interface Locator {
  /** 0 at the west edge, 1 at the east edge. */
  x: number
  /** 0 at the *north* edge, 1 at the south — SVG's axis, not latitude's. */
  y: number
  /**
   * The coordinate resolved outside the frame it is being drawn in.
   *
   * P2.3 found this is the failure that matters: widening the OSM extract from
   * the Bangkok bbox to the country turned off the check that had been rejecting
   * these, and a resolution 290km from the city it is filed under stopped being
   * refused. Clamping the dot to the edge would draw that as an ordinary place
   * near the boundary, so it is reported instead and the card says so.
   */
  outside: boolean
}

export function locate(geo: Geo, bbox: Bbox): Locator {
  const [west, south, east, north] = bbox
  const x = (geo.lng - west) / (east - west)
  const y = (north - geo.lat) / (north - south)
  const outside = x < 0 || x > 1 || y < 0 || y > 1
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), outside }
}

/**
 * Strongest local signal first, and ties broken by something stable.
 *
 * P2.7 asks for the grid sorted by `scores.local`. Sorting by that alone leaves
 * the order of equal scores up to the input order, which for a grid fed by a
 * query means the layout reshuffles between refetches of identical data. The
 * evidence count then the id settle it: more evidence is the better card to show
 * first, and the id is arbitrary but never changes.
 */
export function byLocalScore(a: Place, b: Place): number {
  const scoreDelta = (b.scores.local?.value ?? 0) - (a.scores.local?.value ?? 0)
  if (scoreDelta !== 0) return scoreDelta
  const evidenceDelta = b.evidenceCount - a.evidenceCount
  if (evidenceDelta !== 0) return evidenceDelta
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
