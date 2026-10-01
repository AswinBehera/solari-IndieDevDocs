import { z } from "zod"
import { countryCode, domainId, id, storageRef, timestamps } from "./primitives.js"

/**
 * What a session was opened for. `probe` reads a page or records a build; `agent`
 * is the worker itself, for log lines that belong to no session.
 */
export const sessionPurpose = z.enum(["probe", "agent"])
export type SessionPurpose = z.infer<typeof sessionPurpose>

export const sessionOutcome = z.enum(["running", "ok", "blocked", "timeout", "error", "orphaned"])
export type SessionOutcome = z.infer<typeof sessionOutcome>

/**
 * One row per Solari session, opened or attempted. This is how we know what the
 * system is doing and what it costs; the kernel writes it, nobody else does.
 */
export const session = z
  .object({
    id,
    purpose: sessionPurpose,
    /**
     * Opaque. The engine does not know what a user is — only that some caller owns
     * this session's spend. `null` means the system opened it for itself.
     */
    ownerId: z.string().min(1).nullable(),
    domainId: domainId.nullable(),
    country: countryCode,
    /**
     * The viewpoint the session presented, which is **not** the same thing as
     * `country`. `country` is where the packets came from; these are what the
     * browser claimed to be. They diverge on purpose — a `vi-VN` browser on an
     * `sg` egress is a deliberate, recorded compromise, not a misconfiguration —
     * and an Observation is only interpretable next to the viewpoint that produced
     * it. `null` means the session took the provider's defaults, which are `en-US`
     * and UTC and therefore nobody in particular.
     */
    locale: z.string().min(2).nullable(),
    timezoneId: z.string().min(1).nullable(),
    startedAt: z.date(),
    endedAt: z.date().nullable(),
    minutes: z.number().nonnegative(),
    outcome: sessionOutcome,
    recordingRef: storageRef.nullable(),
  })
  .extend(timestamps.shape)
export type Session = z.infer<typeof session>
