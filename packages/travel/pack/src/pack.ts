import type { DomainPack, EntityRepo, ExtractItem } from "@samsara/refine"
import { type PlaceEntity, placeEntity } from "./entity.js"
import { type PlaceMention, placeMention } from "./mention.js"
import { PLACE_EXTRACT_PROMPT_VERSION, placeExtractPrompt } from "./prompt.js"
import { createResolver, type OsmSearch, placeKey } from "./resolve.js"
import { BANGKOK, type City } from "./tier0.js"

/**
 * The travel pack's extraction half: identity, schema, prompt, batching.
 *
 * Still a plain constant, and still the whole pack as far as every caller that
 * only extracts is concerned — the worker's registry, the bake-off, the golden
 * set. `createTravelPack` below adds the resolver, and needs dependencies that
 * a module-level constant cannot have.
 *
 * `dedupKeys` and `score` arrive with the stages that call them (P2.4, P2.5),
 * which is the same discipline `@samsara/refine`'s contract applies from the
 * other side.
 *
 * `version` is the prompt's version, deliberately the same string. The pack
 * version is what the extract stage skips already-done work on, so a prompt
 * changed without a bump is a prompt whose new wording is never asked for.
 */
export const travelPack: DomainPack<PlaceMention> = {
  id: "travel",
  version: PLACE_EXTRACT_PROMPT_VERSION,
  extract: {
    mentionSchema: placeMention,
    prompt: placeExtractPrompt,
    /**
     * By the language the source claimed.
     *
     * A batch is one request to read twenty things, and asking one model to read
     * Thai, English and Vietnamese in a single breath is how the quote comes back
     * translated. Grouping also means a language's items fail together, which is
     * what makes a per-language recall number readable.
     */
    batchBy: (item: ExtractItem) => item.languageGuess ?? "unknown",
    /**
     * Ten, not §8's twenty.
     *
     * A pantip topic is a thread: the item text is the opening post plus replies,
     * and at Thai's roughly one token per character a 4,000-character item is
     * about 4,000 tokens. Twenty of them is an 80k-token request whose answer has
     * to fit `maxOutputTokens`, and a truncated answer is `config` and is not
     * retried. Ten is the number that keeps the saving §8 is actually after — the
     * prompt is sent once instead of ten times — without betting the batch on it.
     */
    batchSize: 10,
  },
}

export interface TravelPackDeps {
  /** Where resolved places are written. The engine never touches this table. */
  places: EntityRepo<PlaceEntity>
  /** Defaults to Bangkok, the city the first vertical is about. */
  city?: City
  /** Tier 1's OSM extract. Absent skips the tier; it does not defer the mention. */
  osm?: OsmSearch
}

/**
 * The whole pack: extraction, plus ADR-0017's tiered resolution.
 *
 * A factory rather than a constant because a resolver needs a place to write and
 * an extract to search, and neither is knowable at import time. The extraction
 * half is spread from `travelPack` rather than restated — two copies of
 * `batchSize` that could disagree would be a worse problem than the indirection.
 *
 * `maxAttempts` is left at the engine's default of three. It is tempting to set
 * it to one here on the grounds that only Tier 2 can defer, but a deferral is a
 * spent quota or a provider having a bad minute, and both are worth asking
 * about again tomorrow.
 */
export const createTravelPack = (deps: TravelPackDeps): DomainPack<PlaceMention, PlaceEntity> => {
  const city = deps.city ?? BANGKOK
  return {
    ...travelPack,
    resolve: {
      entitySchema: placeEntity,
      repo: deps.places,
      key: placeKey(city),
      resolve: createResolver({ city, ...(deps.osm === undefined ? {} : { osm: deps.osm }) }),
    },
  }
}
