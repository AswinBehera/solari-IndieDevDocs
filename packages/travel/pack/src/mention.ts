import { placeCategory } from "@dt/core"
import { z } from "zod"

/**
 * What the travel pack asks a model to find in one harvested item.
 *
 * This is the schema section 2.5 calls `mentionSchema`, and every field in it is
 * either something the resolve stage needs (P2.3) or something the score stage
 * needs (P2.5). Nothing is here because it would be interesting.
 *
 * **Output tokens dominate the LLM bill** (§8), and this schema is where that
 * bill is set. Twenty items in a call, a handful of mentions each, and every
 * field is paid for on every one of them — so the quote is capped, and the two
 * free-text fields that remain are names, which are short by nature. There is no
 * `description`, no `summary` and no `reasoning` field, and their absence is the
 * budget decision.
 */

/**
 * How the place was priced in the source, as the source said it.
 *
 * Free text rather than a number, and nullable, because the harvested sentence
 * is "39 บาท", "ไม่ถึงร้อย" (not even a hundred), "หลักพัน" (thousands) or
 * nothing at all. Parsing that into a currency amount at extraction time throws
 * away the hedge, and the hedge is the information: a range someone gave loosely
 * is a different claim from a price someone read off a menu. Whatever normalises
 * this belongs downstream, where it can be wrong visibly.
 */
const priceHint = z.string().min(1).max(40).nullable()

export const placeMention = z.object({
  /**
   * The name in the script the source wrote it in. For Thai sources this is the
   * only name that will match an OSM `name:th` tag, which is P2.3's Tier 1 —
   * so a romanisation supplied instead of this is a resolution lost.
   */
  localName: z.string().min(1).max(120),
  /**
   * The same name in Latin script, if the source gave one or if it is a
   * transliteration anyone would agree on. Null rather than invented: Thai
   * romanisation has no single standard, and a guess here produces a second
   * spelling that dedup will treat as a second place.
   */
  romanName: z.string().min(1).max(120).nullable(),
  /**
   * The dish, drink or thing this place is named *for* in this item, if the item
   * names one. The travel-specific half of why a place is worth knowing about —
   * "the noodle shop" is a category, "ก๋วยเตี๋ยวเรือ" is a reason to go.
   */
  dish: z.string().min(1).max(80).nullable(),
  category: placeCategory,
  priceHint,
  /**
   * One unbroken span of at most 200 characters, copied from the item verbatim.
   *
   * Verbatim is the whole point: this is what P2.5 renders as the evidence
   * behind a score, and a model's paraphrase of a review is not evidence of
   * anything. The cap is doing budget work as well as editorial work.
   *
   * It is in characters rather than words because the first draft said fifteen
   * words and Thai does not put spaces between them — a bound that could not be
   * counted in the one language this pack exists for. A smoke run against five
   * real Thai items obeyed that word count while returning a quote stitched from
   * two halves of a sentence. `max(200)` here and "at most 200 characters" in
   * the prompt are deliberately the same number, so the schema refuses exactly
   * what the instructions forbid instead of something adjacent to it.
   */
  quote: z.string().min(1).max(200),
  sentiment: z.enum(["positive", "mixed", "negative"]),
  /**
   * Whether the person who wrote this item reads as living where they are
   * writing about, rather than visiting it.
   *
   * The single most load-bearing field in the schema, because `scores.local` is
   * built from the mix of evidence behind a place and this is the term that
   * makes the mix mean anything. It is a judgement, so it is three-valued: a
   * model forced to choose between local and tourist on an item that says
   * neither will choose, and a fabricated majority is worse than an honest
   * `unknown`.
   */
  creatorReads: z.enum(["local", "visitor", "unknown"]),
})

export type PlaceMention = z.infer<typeof placeMention>
