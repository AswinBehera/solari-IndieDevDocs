import { z } from "zod"
import { domainId, id, sourceId, storageRef, timestamps } from "./primitives.js"

export const harvestOutcome = z.enum(["running", "ok", "blocked", "empty", "error"])
export type HarvestOutcome = z.infer<typeof harvestOutcome>

/** One identity asking one source one question, once. */
export const harvestRun = z
  .object({
    id,
    domainId,
    personaId: id,
    sourceId,
    query: z.string().min(1),
    startedAt: z.date(),
    endedAt: z.date().nullable(),
    outcome: harvestOutcome,
    itemCount: z.number().int().nonnegative(),
    sessionId: id,
  })
  .extend(timestamps.shape)
export type HarvestRun = z.infer<typeof harvestRun>

/** Nullable throughout: plenty of sources show none of this, and zero is not the same as unknown. */
export const engagement = z.object({
  views: z.number().int().nonnegative().nullable(),
  likes: z.number().int().nonnegative().nullable(),
  comments: z.number().int().nonnegative().nullable(),
})
export type Engagement = z.infer<typeof engagement>

/**
 * The unit an adapter produces and `extract` consumes — the seam between fetching
 * and understanding. Stored verbatim, so re-running extraction never reopens a
 * browser. That property is what makes the extraction model cheap to change.
 */
export const rawItem = z
  .object({
    id,
    harvestRunId: id,
    sourceId,
    /**
     * Where the source put this item within its own run, zero-based.
     *
     * Not a quality score. It is the position a ranked surface chose, which is
     * the only thing such a surface actually asserts — and it is stored because
     * "the top twenty" is the unit every comparison between two viewpoints is
     * stated in, and nothing else in the row can reconstruct it.
     */
    rank: z.number().int().nonnegative(),
    url: z.url(),
    title: z.string().nullable(),
    text: z.string(),
    /** What the source or a cheap detector claimed. Not authoritative. */
    languageGuess: z.string().min(2).nullable(),
    mediaRefs: z.array(storageRef),
    engagement: engagement.nullable(),
    capturedAt: z.date(),
    /** The untouched response body in object storage, for when a parser turns out wrong. */
    rawRef: storageRef,
  })
  .extend(timestamps.shape)
export type RawItem = z.infer<typeof rawItem>
