import { z } from "zod"
import { countryCode, id, locale, timestamps } from "./primitives.js"

/** How much history an identity carries. `anon` is disposable; `seeded` has been lived in. */
export const personaTier = z.enum(["anon", "seeded"])
export type PersonaTier = z.infer<typeof personaTier>

/**
 * `degraded` means still usable but showing signs — captchas, throttling, thinner
 * results. `banned` is terminal for the profile; `retired` is our own decision.
 */
export const personaHealth = z.enum(["healthy", "degraded", "banned", "retired"])
export type PersonaHealth = z.infer<typeof personaHealth>

export const personaStats = z.object({
  sessions: z.number().int().nonnegative(),
  minutes: z.number().nonnegative(),
  blocks: z.number().int().nonnegative(),
})
export type PersonaStats = z.infer<typeof personaStats>

/**
 * What a person looking through this identity is like, beyond where and in what
 * language: a short description, what they care about, where they tend to look,
 * and how the identity is drawn on screen.
 *
 * **The engine stores this and reads none of it.** A vertical turns `interests`
 * into the questions it asks and `sources` into the surfaces it asks them on; the
 * engine only needs the identity's locale, clock and egress. Every field is
 * optional and bounded, because this is a description a person edits, not a
 * contract another stage depends on.
 */
export const personaTraits = z.object({
  /** A vertical's preset this identity was made from, if any. */
  archetype: z.string().trim().min(1).max(40).optional(),
  bio: z.string().trim().max(280).optional(),
  interests: z.array(z.string().trim().min(1).max(60)).max(24).optional(),
  /** Source ids, preferred first. Suggestions to a planner, not a permission. */
  sources: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
  look: z
    .object({
      colour: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      prop: z.string().trim().min(1).max(30).optional(),
    })
    .optional(),
})
export type PersonaTraits = z.infer<typeof personaTraits>

/**
 * An identity the system can look through. Country is where it egresses; locality is
 * where it reads as being from, which is not always the same thing and is the more
 * interesting of the two.
 */
export const persona = z
  .object({
    id,
    name: z.string().min(1),
    /** Free text: the city or region this identity reads as being in. */
    locality: z.string().min(1),
    country: countryCode,
    locale,
    tier: personaTier,
    /** Solari profile holding this identity's cookies and storage, once it has any. */
    solariProfileId: z.string().min(1).nullable(),
    /** Sticky IP key, so one identity keeps one address across sessions. */
    proxySession: z.string().min(1).nullable(),
    health: personaHealth,
    seedPlanId: id.nullable(),
    lastAliveAt: z.date().nullable(),
    stats: personaStats,
    traits: personaTraits.nullish(),
  })
  .extend(timestamps.shape)
export type Persona = z.infer<typeof persona>
