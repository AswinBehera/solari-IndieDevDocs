import { definePrompt } from "@samsara/llm"
import { z } from "zod"
import { ENVELOPE_INSTRUCTIONS, ITEMS_VARIABLE } from "../extract.js"
import { MemoryEntityRepo } from "../memory.js"
import type { DomainPack, Resolution } from "../pack.js"

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
 * - **A resolver with no geography in it** (P2.3). Travel's tiers end in a pair
 *   of coordinates and it would be easy for the stage to grow an opinion about
 *   that — a `geo` field on the resolution, a lat/lng in the cache row. A
 *   creator resolves to a channel URL, and a channel URL has no latitude. Tier 0
 *   here is "the item already gave us the URL", Tier 1 is "we can build it from
 *   the handle", and Tier 3 is a handle we cannot place on any platform, which
 *   is the same *shape* as ADR-0017's tiers without being the same thing.
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


/** What a resolved creator is: the pack's own entity, sharing nothing with travel's. */
export const creatorEntity = z.object({
  canonicalHandle: z.string().min(1),
  platform: z.enum(["youtube", "tiktok", "forum"]),
  /** Null when the handle was found but no channel could be built for it. */
  channelUrl: z.url().nullable(),
  postsPerWeek: z.number().nonnegative().nullable(),
})

export type CreatorEntity = z.infer<typeof creatorEntity>

/** Exposed so a test can read back what the stage wrote. */
export const creatorRepo = new MemoryEntityRepo<CreatorEntity>()

/**
 * Tiered the way ADR-0017 tiers travel's, and deliberately about nothing
 * geographic.
 *
 * Tier 0 is free and exact: the item already carried the channel URL, which is
 * this vertical's version of "the coordinates were in the artifact". Tier 1
 * builds a URL from the handle for the one platform whose URLs are predictable,
 * which is the cheap local guess. There is no Tier 2, because a creator pack has
 * nothing to pay a hosted service for — and that absence is itself worth having
 * in the fixture: the stage must not require every pack to have a metered tier.
 */
const resolveCreator = (m: CreatorMention): Resolution<CreatorEntity> => {
  const handle = m.handle.trim().toLowerCase().replace(/^@/, "")

  if (m.channelUrl !== null) {
    return {
      outcome: "resolved",
      entity: {
        canonicalHandle: handle,
        platform: m.platform,
        channelUrl: m.channelUrl,
        postsPerWeek: m.postsPerWeek,
      },
      tier: 0,
      confidence: 0.95,
    }
  }

  if (m.platform === "youtube") {
    return {
      outcome: "resolved",
      entity: {
        canonicalHandle: handle,
        platform: m.platform,
        channelUrl: `https://example.invalid/c/${handle}`,
        postsPerWeek: m.postsPerWeek,
      },
      tier: 1,
      confidence: 0.6,
    }
  }

  // Still an entity, flagged — the same rule P2.3 states for a mention nobody
  // can place. A handle with no channel is worth carrying; absent is
  // indistinguishable from never extracted.
  return {
    outcome: "unresolvable",
    entity: {
      canonicalHandle: handle,
      platform: m.platform,
      channelUrl: null,
      postsPerWeek: m.postsPerWeek,
    },
    tier: 3,
  }
}

creatorPack.resolve = {
  entitySchema: creatorEntity,
  repo: creatorRepo,
  /**
   * The handle, normalised — not the channel URL, even though that is what the
   * pack resolves *to*. A key is what two mentions have in common **before**
   * anyone has looked anything up, and half these mentions arrive with no URL at
   * all. Keying on the answer would mean never getting a cache hit on the
   * mentions that most need one.
   */
  key: (m) => `${m.platform}:${m.handle.trim().toLowerCase().replace(/^@/, "")}`,
  resolve: async (m) => resolveCreator(m),
}
