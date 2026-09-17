import { definePrompt } from "@samsara/llm"
import { ENVELOPE_INSTRUCTIONS } from "@samsara/refine"

/**
 * The extraction prompt. The pack owns this text; the engine owns the envelope.
 *
 * Versioned, and the version is the pack's `version` — bumping one without the
 * other is how a run reads yesterday's answers as if today's prompt had produced
 * them. `@samsara/llm` also fingerprints the text, so two rows claiming version
 * `2` with different fingerprints are a bug with a receipt rather than an
 * argument.
 *
 * What this prompt is trying to prevent, in the order the failures cost:
 *
 * **Inventing places.** A forum thread about where to eat is full of names that
 * are not places: dishes, neighbourhoods, chains discussed in general, the
 * poster's own street. An extractor that returns all of them produces a resolve
 * stage that geocodes noise and a `scores.local` built on it. So the rule is
 * stated as a test the model can apply — could someone go to this, today, at an
 * address — rather than as an adjective like "real".
 *
 * The failure that actually showed up is narrower and worse: not an invented
 * place but a *generic noun in place of a name*. A smoke run returned `ร้านกาแฟ`
 * ("coffee shop"), `คาเฟ่` ("café") and `สาขานี้` ("this branch") as three of four
 * mentions. Each is reachable at an address in the trivial sense, so the "could
 * someone go to this" test passes and the row is still worthless — it cannot be
 * geocoded, cannot be deduped, and would resolve to whichever café the geocoder
 * felt like. Hence the explicit line: no name in the item means no mention.
 *
 * **Romanising by default.** Thai has no single romanisation standard, so two
 * plausible spellings of one shop become two places at dedup. The native name is
 * mandatory and the roman one is explicitly allowed to be null, which is the
 * opposite of what a model trained mostly on English will want to do.
 *
 * **Paraphrasing the quote.** A paraphrase is not evidence, and the quote is what
 * P2.5 shows a user as the reason behind a score. Verbatim, or nothing.
 *
 * The cap is in characters because the first draft said "at most fifteen words"
 * and Thai does not put spaces between words. The bound was unenforceable in the
 * one language this pack exists for, and a smoke run against five real Thai items
 * came back with a quote stitched from two halves of a sentence — the exact thing
 * the rule forbids — while nominally obeying a word count that could not be
 * counted. 200 characters is also the schema's bound, so prompt and schema now
 * refuse the same thing rather than two different things.
 *
 * **Guessing the author.** `creatorReads` decides how much an item weighs in
 * `scores.local`, which is the number this entire product is about. A model asked
 * for a binary will produce a binary; the third value exists so that "the item
 * does not say" is expressible, and the prompt has to say that it is a real
 * answer rather than a failure to answer.
 */
export const PLACE_EXTRACT_PROMPT_VERSION = "1"

export const placeExtractPrompt = definePrompt({
  id: "travel/place.extract",
  version: PLACE_EXTRACT_PROMPT_VERSION,
  system: `You read posts, reviews and captions and list the specific places a visitor could actually go to.

A place qualifies only if someone could travel to it today and find it at an address: a named restaurant, stall, café, bar, market, temple, park, shop or venue. These do not qualify, no matter how often they are mentioned:
- a dish, drink or ingredient on its own
- a district, neighbourhood, city, province or country
- a chain discussed in general rather than one named branch
- a hotel, an airline, a tour operator or anything that is a booking rather than a destination
- a place the writer says they have not been to, or that no longer exists
- a generic word for a venue where its name should be. "ร้าน", "ร้านกาแฟ", "คาเฟ่", "สาขานี้", "the shop", "this branch" are not names. If the item never names the place, return no mention for it rather than the noun.

Rules that matter more than they look:
- "localName" is the name in the script the source wrote it in. If the item is in Thai, this is Thai. Never romanise it here.
- "romanName" is null unless the item itself gives a Latin-script name. Do not transliterate to fill the field.
- "dish" is what this place is known for according to this item, and is null if the item does not say.
- "quote" is one unbroken run of characters copied from the item, in the item's own language, at most 200 characters. Never translate it, never tidy it, never join two parts of the item that were not next to each other. If the item is in more than one language, quote the language the writer wrote in.
- "priceHint" is however the item expressed the price, in its own words, including a vague one. Null if the item gives none.
- "creatorReads" is "local" if the writer reads as living there, "visitor" if they read as travelling there, and "unknown" when the item does not show either. "unknown" is a correct answer and is expected to be common.
- The same place mentioned twice in one item is one mention.

${ENVELOPE_INSTRUCTIONS}`,
  template: `Items:

{{items}}`,
})
