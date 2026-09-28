import { definePrompt } from "@samsara/llm"
import { z } from "zod"
import { ENVELOPE_INSTRUCTIONS, ITEMS_VARIABLE } from "../extract.js"
import { MemoryEntityRepo } from "../memory.js"
import type { DedupKey, DomainPack, Resolution } from "../pack.js"
import type { EvidenceRecord } from "../ports.js"

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
 * - **Dedup keys that are both exact** (P2.4). Travel's second key is a radius
 *   around a coordinate, and a stage that walked keys strongest-first could
 *   easily have grown an opinion that the weak key is the fuzzy one. Creator's
 *   two keys are both exact string comparisons; what makes one stronger than the
 *   other is how much identity it carries, which is the only thing the ordering
 *   is supposed to mean.
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

/**
 * Exposed so a test can read back what the stage wrote.
 *
 * Configured for dedup as well, because `MemoryEntityRepo` cannot answer a key
 * it has not been taught — `DedupKey.value` is `unknown` and that is the seam
 * working, not a gap. Teaching it here rather than in the test is what makes the
 * fixture a pack rather than a fragment: a pack owns what its keys mean on both
 * ends, and the engine gets to remain unable to read either.
 */
export const creatorRepo = new MemoryEntityRepo<CreatorEntity>({
  matches: (key: DedupKey, entity: CreatorEntity): boolean => {
    if (key.kind === CHANNEL_KEY) {
      return entity.channelUrl !== null && entity.channelUrl === key.value
    }
    if (key.kind === HANDLE_KEY) {
      return `${entity.platform}:${entity.canonicalHandle}` === key.value
    }
    throw new Error(`unknown dedup key kind "${key.kind}"`)
  },
  /**
   * The survivor takes whatever it was missing. Both fields are nullable for the
   * same reason — the resolver could not find them — so a duplicate that did
   * find one is the only thing that will ever supply it.
   */
  fold: (into: CreatorEntity, from: CreatorEntity): CreatorEntity => ({
    ...into,
    channelUrl: into.channelUrl ?? from.channelUrl,
    postsPerWeek: into.postsPerWeek ?? from.postsPerWeek,
  }),
})

/** The platform's own identifier for the channel. Exact, and the strongest thing here. */
const CHANNEL_KEY = "channelUrl"
/** The handle on a platform. Exact too, and weaker — a handle can be re-used after a rename. */
const HANDLE_KEY = "handle"

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

/**
 * Two keys, strongest first, and neither of them is about a place.
 *
 * The channel URL first, because it is the platform's own identifier and two
 * entities carrying the same one are the same channel by definition. The
 * `platform:handle` pair second, because a handle is only as stable as the person
 * holding it — accounts get renamed and handles get re-used, so agreement here is
 * strong evidence rather than proof.
 *
 * No key at all for a handle with no platform, which is deliberate rather than an
 * oversight: `@bep_nha_minh` on YouTube and `@bep_nha_minh` on TikTok are
 * routinely different people, and this pack's resolve key says so too.
 */
creatorPack.dedupKeys = (entity: CreatorEntity): DedupKey[] => {
  const keys: DedupKey[] = []
  if (entity.channelUrl !== null) keys.push({ kind: CHANNEL_KEY, value: entity.channelUrl })
  keys.push({ kind: HANDLE_KEY, value: `${entity.platform}:${entity.canonicalHandle}` })
  return keys
}

/**
 * Two factors, and both of them unlike travel's (P2.5).
 *
 * The travel pack's eight factors all read the evidence and ignore the entity.
 * That is a perfectly reasonable thing for them to do and it would make "a
 * factor is a function of the evidence" an assumption the engine could grow
 * without anyone noticing — the signature says `measure(entity, evidence)` and
 * the first argument would never have been used.
 *
 * - **`postingCadence` reads only the entity.** It has no particular evidence
 *   row to point at, so it returns no receipts at all, which the engine has to
 *   accept: `Explanation.evidenceIds` permits an empty list and a stage that
 *   invented one would be attaching a reason to a row that did not supply it.
 * - **It abstains on a null,** and `postsPerWeek` is null for every creator
 *   whose source never said. Over a page where it is null throughout, this score
 *   falls back to `channelReach` alone — the abstention path, exercised by a
 *   pack rather than by a stub.
 * - **There is one score, not two.** Travel has `local` and `tourist`, and a
 *   report shaped around a pair would look fine against it.
 */
creatorPack.score = {
  scores: {
    influence: [
      {
        name: "postingCadence",
        weight: 2,
        measure: (entity: CreatorEntity) => {
          if (entity.postsPerWeek === null) return null
          // Daily saturates. A creator posting twice a day is not twice the
          // signal, and the weighted mean needs a number in [0,1] regardless.
          return { value: Math.min(1, entity.postsPerWeek / 7), evidenceIds: [] }
        },
      },
      {
        name: "videoShare",
        weight: 1,
        measure: (_entity: CreatorEntity, evidence: readonly EvidenceRecord[]) => {
          if (evidence.length === 0) return null
          const video = evidence.filter((row) => {
            const parsed = creatorMention.safeParse(row.extract)
            return parsed.success && parsed.data.platform !== "forum"
          })
          return { value: video.length / evidence.length, evidenceIds: video.map((r) => r.id) }
        },
      },
    ],
  },
}
