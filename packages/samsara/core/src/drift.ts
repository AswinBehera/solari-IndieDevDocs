import { z } from "zod"
import { domainId, id, sourceId, timestamps } from "./primitives.js"

/**
 * A repeated measurement: the same question, the same two identities, once a day,
 * for a fixed number of days (plan P1.8).
 *
 * The signal matrix in `@samsara/harvest/matrix` answers "which signal moves the
 * result". This answers the question that one cannot: **whether the answer it gave
 * is stable**. A single pair of runs an hour apart cannot tell a viewpoint effect
 * from a surface that reshuffles itself every afternoon, and the whole of Phase 1's
 * gate — "the two columns disagree by more than 60%" — is a claim about an effect
 * rather than about a Tuesday.
 *
 * The row is a **plan**, not a log. It says what was designed; the harvest runs
 * carrying `experimentId` are what happened, and the two are deliberately allowed
 * to disagree. A day that never ran leaves a hole, and a hole that can be seen is
 * the point: under ADR-0014 the schedule is best-effort, so a series that silently
 * renumbered its remaining days to look complete would be the one lie this table
 * exists to prevent.
 */

/**
 * Two states, and no `complete`.
 *
 * Completion is derivable — the last scheduled day is in the past — and a derived
 * fact stored in a column is a fact that goes stale the first time nothing runs to
 * update it. The same reasoning kept persona health out of a column in P1.1. What
 * `stopped` carries, and derivation cannot, is a *decision*: somebody chose to stop
 * spending browser minutes on this question before it had finished asking.
 */
export const driftState = z.enum(["running", "stopped"])
export type DriftState = z.infer<typeof driftState>

/** The interval a plain reading of "daily" means, in minutes. */
export const DAILY_MINUTES = 1440

export const driftExperiment = z
  .object({
    id,
    domainId,
    /** Opaque, like every other `ownerId` here: a week of sessions has somebody to bill. */
    ownerId: z.string().min(1).nullable(),
    sourceId,
    query: z.string().min(1),
    /**
     * Two identities, and the schema refuses to let them be one.
     *
     * `overlapAt(x, x, k)` is a perfectly good 1.0, so an experiment pointed at
     * one persona twice would run for a week, spend fourteen sessions, and plot a
     * flat line at 100% that reads as the strongest possible finding. The
     * refusal belongs here rather than only in the HTTP handler because the
     * handler is not the only thing that can write this row.
     */
    personaAId: id,
    personaBId: id,
    /** How many days the plan covers. Every day is one run per identity. */
    days: z.number().int().min(1),
    /**
     * The k the series is measured at, stored rather than passed at read time.
     *
     * A reader may still ask for another one, and should be able to. What the
     * column fixes is the k the experiment was *designed* at, so that a plot
     * screenshotted in week one and a plot read in week three are the same
     * measurement unless somebody deliberately says otherwise.
     */
    k: z.number().int().min(1),
    /**
     * Minutes between days. 1440 is "daily" and the only value Phase 1 uses.
     *
     * A column rather than a constant because a seven-day experiment cannot be
     * demonstrated, tested end to end, or debugged at its real cadence — and the
     * alternative to a parameter is a test that fakes the clock, which proves the
     * schedule arithmetic and not the queue that carries it.
     */
    intervalMinutes: z.number().int().min(1),
    /** The anchor the whole schedule is computed from. Day n is due `n` intervals after it. */
    startedAt: z.date(),
    state: driftState,
  })
  .extend(timestamps.shape)
  .refine((e) => e.personaAId !== e.personaBId, {
    message: "an experiment needs two different personas; one compared with itself is always 1.0",
    path: ["personaBId"],
  })
export type DriftExperiment = z.infer<typeof driftExperiment>
