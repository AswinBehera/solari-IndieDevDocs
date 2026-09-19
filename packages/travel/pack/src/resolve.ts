import type { LookupHit, Resolution, ResolveCtx } from "@samsara/refine"
import type { PlaceEntity } from "./entity.js"
import type { PlaceMention } from "./mention.js"
import { type City, inBbox, nameAgreement, type Pin, pinsIn } from "./tier0.js"

/**
 * The travel pack's tiered resolver (ADR-0017).
 *
 * Each tier runs only when the one above returns nothing, and the ordering is by
 * how much *identity* each source carries rather than how precise its
 * coordinates are — which is the ADR's central point and the reason Tier 0 sits
 * above a geocoder that would give a more exact number.
 *
 * - **Tier 0** reads a coordinate the author already pinned, out of the
 *   harvested artifact. Free, exact, and the primary path. See `tier0.ts` for
 *   why it insists on attributing a coordinate to a name.
 * - **Tier 1** matches the mention against an OSM extract in our own Postgres.
 *   Free, no key, no rate limit, and it handles Thai because OSM carries
 *   `name:th`.
 * - **Tier 2** asks a hosted free-tier geocoder, through `ctx.lookup` and
 *   therefore through the `geocode.calls` meter. It is the only tier that can
 *   be refused.
 * - **Tier 3** is nothing knew. The mention is written as a place with no
 *   coordinate and does not appear on the map.
 *
 * **The acceptance criterion is a ratio, and it is a criterion about this file.**
 * If Tier 2 carries more than a fifth, Tiers 0 and 1 are underbuilt and that is
 * the bug — not the meter to raise.
 */

/** Tier 1: our own OSM extract. Not `LookupPort`: it is free and it is local. */
export interface OsmSearch {
  /**
   * Candidates for these spellings, biased to the city.
   *
   * Takes every spelling at once rather than one call per name because it is one
   * SQL statement either way, and a port that took one string would make the
   * resolver choose which spelling to try — a choice with no good answer, since
   * the Thai name matches `name:th` and the roman name matches `name`.
   */
  search(
    names: readonly string[],
    city: City,
  ): Promise<{ lat: number; lng: number; osmId: string; name: string; confidence: number }[]>
}

export interface TravelResolveDeps {
  /**
   * Which city this deployment is resolving for.
   *
   * A parameter rather than a constant because it is the one thing that changes
   * when the second city arrives, and because Tier 0 needs its bbox to refuse a
   * coordinate from another country. `places.city` is `NOT NULL`, so there is no
   * version of this that defers the question.
   */
  city: City
  /** Absent until the extract is loaded. Its absence skips Tier 1, it does not defer. */
  osm?: OsmSearch
}

/**
 * Confidence below which a Tier 2 answer is not believed.
 *
 * A hosted geocoder answers *something* for almost any string — that is what
 * makes it useful for addresses and dangerous for shop names. ADR-0017 is
 * explicit that deciding which POI a messy caption refers to is entity
 * resolution and no geocoder does it for us, so a low-confidence hit is a guess
 * wearing a coordinate, and a wrong pin is worse than no pin: it is
 * indistinguishable from a right one on the map and nothing downstream can
 * catch it.
 */
const TIER2_FLOOR = 0.5

/** The spellings worth trying, best first, with no duplicates and no invented ones. */
export const spellingsOf = (mention: PlaceMention): string[] => {
  const names = [mention.localName, mention.romanName].filter(
    (name): name is string => name !== null && name.trim().length > 0,
  )
  return [...new Set(names.map((name) => name.trim()))]
}

/**
 * The name this place will be listed under.
 *
 * The roman name when the source gave one, because the product is read in
 * English; the local name otherwise. Never a transliteration invented here —
 * `PlaceMention.romanName` explains why, and the short version is that Thai
 * romanisation has no single standard, so a guess produces a second spelling
 * that dedup will treat as a second place.
 */
const canonical = (mention: PlaceMention): string => (mention.romanName ?? mention.localName).trim()

/** Tags carry the travel-specific half of why a place is worth knowing about. */
const tagsOf = (mention: PlaceMention): string[] =>
  mention.dish === null ? [] : [mention.dish.trim()]

const entityOf = (
  mention: PlaceMention,
  city: string,
  geo: { lat: number; lng: number } | null,
  tier: 0 | 1 | 2 | null,
  externalRef: PlaceEntity["externalRef"],
): PlaceEntity => ({
  canonicalName: canonical(mention),
  localName: mention.localName.trim(),
  city,
  geo,
  externalRef,
  resolvedTier: tier,
  category: mention.category,
  tags: tagsOf(mention),
})

/**
 * Tier 0. The best-attributed pin in the artifact, or null.
 *
 * "Best" is by name agreement and then by how specific the link was, not by
 * which appeared first: a listicle's later entry is not a worse match for its
 * own name. Pins outside the city bbox are dropped before anything is compared,
 * because a coordinate in another country attributed by a name coincidence is
 * the failure that looks most like success.
 */
export function tier0(
  mention: PlaceMention,
  text: string,
  city: City,
): { pin: Pin; confidence: number } | null {
  const spellings = spellingsOf(mention)
  let best: { pin: Pin; confidence: number } | null = null

  for (const pin of pinsIn(text)) {
    if (!inBbox(pin.lat, pin.lng, city.bbox)) continue
    if (pin.name === null) continue
    for (const spelling of spellings) {
      const agreement = nameAgreement(spelling, pin.name)
      if (agreement === null) continue
      if (best === null || agreement > best.confidence) best = { pin, confidence: agreement }
    }
  }
  return best
}

/** Tier 1 and Tier 2 both return ranked hits; this is how one is chosen. */
const bestHit = <T extends { confidence: number; lat: number; lng: number }>(
  hits: readonly T[],
  city: City,
  floor: number,
): T | null => {
  let best: T | null = null
  for (const hit of hits) {
    if (!inBbox(hit.lat, hit.lng, city.bbox)) continue
    if (hit.confidence < floor) continue
    if (best === null || hit.confidence > best.confidence) best = hit
  }
  return best
}

export function createResolver(deps: TravelResolveDeps) {
  return async function resolvePlace(
    mention: PlaceMention,
    ctx: ResolveCtx,
  ): Promise<Resolution<PlaceEntity>> {
    const { city, osm } = deps

    // Cancellation is checked before each tier rather than once at the top: the
    // tiers are where the time goes, and a runner told to stop should not start
    // a network call it already knows will be thrown away.
    if (ctx.signal?.aborted) return { outcome: "deferred", reason: "cancelled" }

    const pinned = tier0(mention, ctx.item.text, city)
    if (pinned) {
      return {
        outcome: "resolved",
        entity: entityOf(
          mention,
          city.name,
          { lat: pinned.pin.lat, lng: pinned.pin.lng },
          0,
          pinned.pin.ref,
        ),
        tier: 0,
        confidence: pinned.confidence,
      }
    }

    const spellings = spellingsOf(mention)

    if (osm && spellings.length > 0) {
      if (ctx.signal?.aborted) return { outcome: "deferred", reason: "cancelled" }
      // A trigram search is a guess about names, so the floor is higher than
      // Tier 2's: the extract holds only POIs in this city, which makes a
      // near-miss *more* likely to be a real, different shop rather than noise.
      const hit = bestHit(await osm.search(spellings, city), city, 0.6)
      if (hit) {
        return {
          outcome: "resolved",
          entity: entityOf(mention, city.name, { lat: hit.lat, lng: hit.lng }, 1, {
            source: "osm",
            id: hit.osmId,
          }),
          tier: 1,
          confidence: hit.confidence,
        }
      }
    }

    if (ctx.lookup && spellings.length > 0) {
      if (ctx.signal?.aborted) return { outcome: "deferred", reason: "cancelled" }
      /**
       * One call, not one per spelling. The meter counts calls and the ceiling
       * is 800 a day, so trying both spellings of every mention would halve the
       * corpus this tier can reach for no gain worth having — a geocoder that
       * cannot find the Thai name rarely finds the romanisation of it either.
       * The local name goes first for the reason `PlaceMention.localName` gives.
       */
      const query = `${spellings[0]}, ${city.name}`
      const result = await ctx.lookup.lookup(query)
      if (!result.ok) {
        // Forwarded, not translated. `unresolvable` here would record "there is
        // no such place" on a day the quota happened to run out, and that is
        // terminal — nothing would ever ask again.
        return { outcome: "deferred", reason: result.reason }
      }
      const hit = bestHit<LookupHit>(result.hits, city, TIER2_FLOOR)
      if (hit) {
        return {
          outcome: "resolved",
          entity: entityOf(mention, city.name, { lat: hit.lat, lng: hit.lng }, 2, {
            source: "geocoder",
            id: hit.ref,
          }),
          tier: 2,
          confidence: hit.confidence,
        }
      }
    }

    /**
     * Tier 3, and note what it is not: it is not conditional on every tier
     * having *run*. A deployment with no OSM extract and no geocoder key still
     * reaches here and still writes the place, because the alternative —
     * deferring — would spend three runs re-asking a question no configured tier
     * can answer, and then write it off anyway with the tier recorded as null.
     * Saying "tier 3" honestly on the first run is better information.
     */
    return {
      outcome: "unresolvable",
      entity: entityOf(mention, city.name, null, null, null),
      tier: 3,
    }
  }
}

/**
 * The cache key: the local name, normalised, plus the city.
 *
 * Not the roman name, and not both. The key is what two mentions have in common
 * *before* anyone has looked anything up, and `localName` is the one field the
 * schema requires — keying on the roman name would give every mention that
 * lacks one a key of its own and defeat the cache exactly where sources are
 * thinnest. The city is in the key because the same shop name exists in every
 * city in Thailand and this cache is keyed by nothing else that would separate
 * them.
 *
 * Normalisation is `tier0`'s, which is not a coincidence: two spellings that
 * would be attributed to the same pin must share a cache key, or the second one
 * pays for a lookup whose answer is already known.
 */
export const placeKey = (city: City) => {
  const prefix = city.name.toLowerCase()
  return (mention: PlaceMention): string => {
    const normalised = mention.localName
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "")
    return `${prefix}:${normalised}`
  }
}
