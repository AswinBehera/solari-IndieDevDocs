import { z } from "zod"
import { engagement } from "./harvest.js"
import { domainId, id, sourceId, storageRef, timestamps } from "./primitives.js"

export const resolutionState = z.enum(["pending", "resolved", "unresolvable"])
export type ResolutionState = z.infer<typeof resolutionState>

/**
 * Something a pack's extractor found in a RawItem, before anyone worked out what it
 * refers to. `payload` is opaque here and validated against the pack's own
 * `mentionSchema` at the boundary — the engine stores it, the pack shapes it.
 */
export const mention = z
  .object({
    id,
    rawItemId: id,
    domainId,
    /** Bumped whenever the pack's prompts or weights change. Stored so old rows stay readable. */
    packVersion: z.string().min(1),
    payload: z.unknown(),
    /** Opaque pointer into the pack's own table. Null until resolved. See `entityRef`. */
    entityId: id.nullable(),
    resolution: resolutionState,
    confidence: z.number().min(0).max(1),
  })
  .extend(timestamps.shape)
export type Mention = z.infer<typeof mention>

/**
 * Why we believe something about an entity: which identity saw it, where, when, in
 * what language, and the receipt. Every score points back at these, and a score with
 * no Evidence behind it is a bug.
 */
export const evidence = z
  .object({
    id,
    domainId,
    /** Opaque by design — no foreign key to a vertical's table. See section 3 of the plan. */
    entityId: id,
    rawItemId: id,
    sourceId,
    sourceUrl: z.url(),
    personaId: id,
    language: z.string().min(2).nullable(),
    capturedAt: z.date(),
    /** Pack-shaped. The engine carries it without reading it. */
    extract: z.unknown(),
    rawRef: storageRef,
    engagement: engagement.nullable(),
  })
  .extend(timestamps.shape)
export type Evidence = z.infer<typeof evidence>

/**
 * The resolve stage's cache (P2.3), one row per `(domainId, key)`.
 *
 * The plan asks the stage to "cache by `(domainId, normalised key)`", and the
 * reason is arithmetic rather than tidiness: a week of harvests names the same
 * handful of entities over and over, and resolving each mention separately would
 * spend one hosted lookup per mention instead of one per distinct name. The
 * ceiling that makes this matter is `geocode.calls`, and a resolver that needs
 * more than a few hundred of those a day is failing at the cheap tiers.
 *
 * **`attempts` is on the key and not on the Mention**, which is the whole design.
 * Twelve mentions of one name that cannot be looked up should cost N attempts in
 * total, not twelve times N. Moving this column to `mentions` would multiply the
 * one budget the stage is supposed to protect by however popular the unlucky name
 * happens to be.
 *
 * **No pack version in the key**, deliberately, and unlike the extract stage's
 * skip. What is cached here is a fact about the world — where a name is — and it
 * does not become untrue when a prompt is reworded. Re-deriving it would re-spend
 * the one metered tier for nothing. A resolver that genuinely improves invalidates
 * by `tier` instead: `DELETE ... WHERE tier = 2` is a query this shape can answer
 * and a version bump is not.
 */
export const entityResolution = z
  .object({
    id,
    domainId,
    /**
     * The pack's normalised key. The engine never constructs one: normalising a
     * name is exactly the knowledge a pack has and the engine does not.
     */
    key: z.string().min(1),
    state: resolutionState,
    /** Opaque pointer into the pack's own table, like `mention.entityId`. */
    entityId: id.nullable(),
    /**
     * Which tier answered, lowest-numbered first, as ADR-0017 orders them. Null
     * while nothing has answered yet. The stage reports the distribution because
     * that distribution *is* P2.3's acceptance criterion.
     */
    tier: z.number().int().nonnegative().nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    /** Counts only the attempts that could not look, never the ones that looked and found nothing. */
    attempts: z.number().int().nonnegative(),
  })
  .extend(timestamps.shape)
export type EntityResolution = z.infer<typeof entityResolution>
