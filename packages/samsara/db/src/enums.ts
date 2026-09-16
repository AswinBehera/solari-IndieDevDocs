import {
  type BudgetWindow,
  budgetWindow,
  type DriftState,
  driftState,
  type HarvestOutcome,
  harvestOutcome,
  type JobState,
  jobState,
  type MeterId,
  meterId,
  type PersonaHealth,
  type PersonaTier,
  personaHealth,
  personaTier,
  type ResolutionState,
  resolutionState,
  type SessionOutcome,
  type SessionPurpose,
  sessionOutcome,
  sessionPurpose,
} from "@samsara/core"
import { pgEnum } from "drizzle-orm/pg-core"

/**
 * Postgres enums are derived from the Zod enums in `@samsara/core` rather than
 * retyped here. A schema and its database type cannot drift if only one of them
 * is written down.
 *
 * The cast is parameterised by the literal union rather than widened to `string`.
 * Widening compiles just as well and costs the caller everything: `sessions.purpose`
 * reads back as `string`, and every consumer has to re-narrow a value the database
 * already guarantees. `values()` wants a mutable non-empty tuple, which is the only
 * reason a cast is needed at all.
 */
type Values<T extends string> = [T, ...T[]]

export const personaTierEnum = pgEnum(
  "persona_tier",
  personaTier.options as unknown as Values<PersonaTier>,
)
export const personaHealthEnum = pgEnum(
  "persona_health",
  personaHealth.options as unknown as Values<PersonaHealth>,
)
export const sessionPurposeEnum = pgEnum(
  "session_purpose",
  sessionPurpose.options as unknown as Values<SessionPurpose>,
)
export const sessionOutcomeEnum = pgEnum(
  "session_outcome",
  sessionOutcome.options as unknown as Values<SessionOutcome>,
)
export const harvestOutcomeEnum = pgEnum(
  "harvest_outcome",
  harvestOutcome.options as unknown as Values<HarvestOutcome>,
)
export const jobStateEnum = pgEnum("job_state", jobState.options as unknown as Values<JobState>)
export const resolutionStateEnum = pgEnum(
  "resolution_state",
  resolutionState.options as unknown as Values<ResolutionState>,
)
/** Nullable in the row; the enum itself holds only the real cadences. */
export const probeCadenceEnum = pgEnum("probe_cadence", ["hourly", "daily", "weekly"])

export const driftStateEnum = pgEnum(
  "drift_state",
  driftState.options as unknown as Values<DriftState>,
)

export const meterIdEnum = pgEnum("meter_id", meterId.options as unknown as Values<MeterId>)
export const budgetWindowEnum = pgEnum(
  "budget_window",
  budgetWindow.options as unknown as Values<BudgetWindow>,
)
