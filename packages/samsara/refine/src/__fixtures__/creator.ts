import { definePrompt } from "@samsara/llm"
import { z } from "zod"
import { ENVELOPE_INSTRUCTIONS, ITEMS_VARIABLE } from "../extract.js"
import type { DomainPack } from "../pack.js"

/**
 * The second pack (P2.8), and the only reason it exists is to be unlike the first.
 *
 * ADR-0009's claim is that a second vertical is a domain pack rather than a fork.
 * One pack cannot test that claim — everything the engine assumes about travel is
 * invisible while travel is the only thing it has ever been handed. So this is a
 * *creator* pack: it names people rather than locations, and it disagrees with the
 * travel pack on every axis the engine is in a position to have quietly assumed.
 *
 * - A different mention shape, with a numeric field and an enum. Travel's is all
 *   strings and nullable strings, so "the schema is strings" is an assumption that
 *   would have survived unnoticed.
 * - **`batchBy` on `sourceId`, not language.** This is the sharp one. §8 motivates
 *   batching with "one call should not ask a model to read Thai, English and
 *   Vietnamese in one breath", and a reader could easily conclude the engine groups
 *   by language. It does not; it groups by whatever the pack returns, and a pack
 *   that groups by source proves it.
 * - A batch size of 5 rather than the default 20, so the default is a default and
 *   not a constant.
 *
 * Never exported from the barrel and never shipped. `package.json` exposes `.`,
 * `./postgres` and `./ports`, none of which reach this file.
 */

export const creatorMention = z.object({
  handle: z.string().min(1),
  platform: z.enum(["youtube", "tiktok", "forum"]),
  channelUrl: z.string().url().nullable(),
  /** Posting cadence, which is what P2.5 would score on. Null when unstated. */
  postsPerWeek: z.number().nonnegative().nullable(),
  quote: z.string().min(1).max(200),
})

export type CreatorMention = z.infer<typeof creatorMention>

export const creatorPack: DomainPack<CreatorMention> = {
  id: "creator",
  version: "1",
  extract: {
    mentionSchema: creatorMention,
    prompt: definePrompt({
      id: "creator/extract.mentions",
      version: "1",
      system: ENVELOPE_INSTRUCTIONS,
      template: `Name every person or channel the item treats as a source worth following.

{{${ITEMS_VARIABLE}}}`,
    }),
    batchBy: (item) => item.sourceId,
    batchSize: 5,
  },
}
