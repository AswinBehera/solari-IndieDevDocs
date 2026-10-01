import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { timestamps } from "./columns.js"
import {
  budgetWindowEnum,
  jobStateEnum,
  meterIdEnum,
  sessionOutcomeEnum,
  sessionPurposeEnum,
} from "./enums.js"

/**
 * The kernel's tables: sessions, budget counters, the job queue and its progress
 * events. The research product's own tables are in `@rd/db`.
 *
 * `owner_id` and `domain_id` are plain text with no reference, because the kernel
 * does not know what a user or a document is.
 */

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: sessionPurposeEnum("purpose").notNull(),
    /** Opaque. No foreign key: the engine does not know what a user is. */
    ownerId: text("owner_id"),
    domainId: text("domain_id"),
    country: text("country").notNull(),
    /** What the browser claimed to be, as distinct from where it egressed. */
    locale: text("locale"),
    timezoneId: text("timezone_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    minutes: doublePrecision("minutes").notNull().default(0),
    outcome: sessionOutcomeEnum("outcome").notNull().default("running"),
    recordingRef: text("recording_ref"),
    ...timestamps,
  },
  (t) => [
    // The budget guard reads this shape every time it decides whether to launch.
    index("sessions_owner_started_idx").on(t.ownerId, t.startedAt),
    index("sessions_purpose_started_idx").on(t.purpose, t.startedAt),
  ],
)

/**
 * The budget guard's counters. One row per
 * `(meter, window, window_key)`; the guard reads before it spends and adds after.
 *
 * These live in Postgres rather than in a cache because a scheduled runner exits
 * between drains (ADR-0014), and a counter that resets when the process does would
 * make the ceiling decorative. Ceilings themselves are not stored:
 * they are constants in `@samsara/kernel`, so changing one is a reviewed diff
 * rather than an UPDATE nobody sees.
 */
export const budgetCounters = pgTable(
  "budget_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meter: meterIdEnum("meter").notNull(),
    window: budgetWindowEnum("window").notNull(),
    /** The value the window is sliced by: a date, `<ownerId>:<date>`, `<purpose>:<runId>`, or `all`. */
    windowKey: text("window_key").notNull(),
    amount: doublePrecision("amount").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    // Load-bearing, not an optimisation: the guard upserts against this constraint,
    // so two concurrent runners increment one row instead of racing to create two.
    uniqueIndex("budget_counters_meter_window_key_idx").on(t.meter, t.window, t.windowKey),
  ],
)

/**
 * The queue (ADR-0004, as amended by ADR-0014). Claimed with `FOR UPDATE SKIP
 * LOCKED`; see `PostgresJobStore` in `@samsara/kernel/postgres` for the statement.
 *
 * Two columns here are doing work that is easy to mistake for bookkeeping.
 * `lease_until` is what makes a cancelled runner recoverable without an operator:
 * a scheduled Actions run can be killed between any two statements, and a `running`
 * row with an expired lease is the *normal* residue of that, not an incident.
 * `idempotency_key` is what stops a double-click from spending two sets of browser
 * minutes on one piece of work — the unique index below is load-bearing, because
 * the API relies on the insert conflicting rather than on checking first.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    /** Opaque label the caller sets ("steam", "prototype"); no foreign key, by the rule above. */
    domainId: text("domain_id"),
    ownerId: text("owner_id"),
    payload: jsonb("payload").notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    state: jobStateEnum("state").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    lastError: text("last_error"),
    /** The Error's name and message behind `last_error`. Never served by the API or
     *  logged (the repo's Actions logs are public); read only with database access. */
    lastCause: text("last_cause"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // The claim query's index. Ordered to match its ORDER BY exactly, because the
    // claim runs inside a transaction holding row locks and a sequential scan there
    // is a lock held over the whole table.
    index("jobs_claim_idx").on(t.state, t.priority, t.runAfter),
    // Partial would be tighter, but drizzle-kit's `where` on unique indexes is the
    // sharp edge here; a full unique index over a nullable column already gives
    // Postgres' "nulls are distinct" behaviour, which is exactly what is wanted:
    // keyed jobs collide, unkeyed ones never do.
    uniqueIndex("jobs_idempotency_key_idx").on(t.idempotencyKey),
  ],
)

/**
 * Append-only progress (ADR-0016). The runner writes a row per state change; the
 * API's SSE stream reads rows after a cursor.
 *
 * `seq` rather than a timestamp because the cursor must be exact: two events in the
 * same millisecond are ordinary, and an SSE client that resumes from a time either
 * replays an event or loses one. `note` is capped at 200 characters for the same
 * reason the kernel's logger has no free-form field — this table is streamed to a
 * browser out of a public repository.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    state: jobStateEnum("state").notNull(),
    note: text("note"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The stream's only query, and the reason it costs one round trip per tick.
    uniqueIndex("job_events_job_seq_idx").on(t.jobId, t.seq),
  ],
)
