import type { DomainPack, ExtractItem } from "@samsara/refine"
import { type PlaceMention, placeMention } from "./mention.js"
import { PLACE_EXTRACT_PROMPT_VERSION, placeExtractPrompt } from "./prompt.js"

/**
 * The travel pack, as far as P2.2 builds it: identity and extraction.
 *
 * `resolve`, `dedupKeys`, `score`, `entity` and `queries` arrive with the stages
 * that call them (P2.3 to P2.5), which is the same discipline `@samsara/refine`'s
 * contract applies from the other side.
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
