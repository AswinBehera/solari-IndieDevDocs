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
    /**
     * Which designed measurement this run is a cell of, and which day of it.
     *
     * Null for the ordinary case — a run somebody asked for once — and the pair is
     * all-or-nothing, which the refinement below enforces. It is a stored pairing
     * key rather than a reconstruction from `startedAt` for the same reason
     * `rawItem.rank` is a column: two runs are comparable because the same tick
     * asked for both, and nothing else in the row can say that. Pairing by clock
     * instead would put a delayed run on the wrong day, and a schedule that may be
     * delayed is the one guarantee ADR-0014 explicitly withholds.
     */
    experimentId: id.nullable(),
    /** Zero-based day within the experiment's plan. */
    experimentDay: z.number().int().nonnegative().nullable(),
  })
  .extend(timestamps.shape)
  .refine((r) => (r.experimentId === null) === (r.experimentDay === null), {
    message: "experimentId and experimentDay are set together or not at all",
    path: ["experimentDay"],
  })
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
