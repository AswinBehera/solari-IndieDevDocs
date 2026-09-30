import { definePrompt } from "@samsara/llm"
import { type DomainPack, ENVELOPE_INSTRUCTIONS, type ExtractItem } from "@samsara/refine"
import type { z } from "zod"
import { DEAL_PROMPT_VERSION, DEALS_DOMAIN, type DealMention, dealMention } from "./deals.js"

/** The deals pack: extract only. See `deals.ts` for why it is a pack of its own. */
export const dealExtractPrompt = definePrompt({
  id: "deals/code.extract",
  version: DEAL_PROMPT_VERSION,
  system: `You read Thai forum posts and video titles and descriptions, and list discount codes for hotel booking sites.

A code qualifies only if the item writes out the code itself: a string someone would type into a promo-code box, such as "AGODA8TH" or "BKTHAI10". These do not qualify:
- a referral or affiliate link with no code in it
- a sale or campaign name with nothing to type ("11.11 sale", "Agoda VIP")
- a bank or credit-card promotion that applies automatically
- a code the item says is expired or no longer works

Rules:
- "provider" is "agoda" or "booking" when the item says which site the code is for, else "other".
- "code" is copied exactly as written. Never correct, complete or guess it.
- "offer", "expires" and "conditions" are in the item's own words and language, or null when it does not say. Do not translate them.
- "quote" is one unbroken run of characters copied from the item that contains the code, at most 240 characters.
- The same code twice in one item is one mention.

${ENVELOPE_INSTRUCTIONS}`,
  template: `Items:

{{items}}`,
})

export const dealsPack: DomainPack<DealMention> = {
  id: DEALS_DOMAIN,
  version: DEAL_PROMPT_VERSION,
  extract: {
    mentionSchema: dealMention as unknown as z.ZodType<DealMention>,
    prompt: dealExtractPrompt,
    batchBy: (item: ExtractItem) => item.languageGuess ?? "unknown",
    batchSize: 10,
  },
}
