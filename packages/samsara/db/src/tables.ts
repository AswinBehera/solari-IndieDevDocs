import { sql } from "drizzle-orm"
import {
  boolean,
  check,
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
  driftStateEnum,
  harvestOutcomeEnum,
  jobStateEnum,
  meterIdEnum,
  personaHealthEnum,
  personaTierEnum,
  probeCadenceEnum,
  resolutionStateEnum,
  sessionOutcomeEnum,
  sessionPurposeEnum,
} from "./enums.js"

/**
 * Engine tables (plan section 3.1). No vertical vocabulary appears in this file.
 *
 * The rule that shapes everything here: an engine table never holds a foreign key
 * to a vertical's table. Where the engine points at a vertical's entity it stores an
 * opaque `(domain_id, entity_id)` pair with no constraint, and the pack's `EntityRepo`
 * resolves it. `owner_id` is the same idea applied to callers: plain text, no
 * reference, because the engine does not know what a user is.
 */

export const personas = pgTable(
  "personas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Free text: the city or region this identity reads as being in. */
    locality: text("locality").notNull(),
    /** Lowercase ISO 3166-1 alpha-2 — the form the proxy layer takes. */
    country: text("country").notNull(),
    locale: text("locale").notNull(),
    /**
     * IANA zone, stored rather than derived. Deriving it from `country` or from
     * `locale` would re-couple the two things this system exists to pull apart:
     * P1.0 measured a `us` egress asking in Thai returning entirely Thai results,
     * and an identity whose clock is computed from its IP cannot express that.
     */
    timezoneId: text("timezone_id").notNull(),
    tier: personaTierEnum("tier").notNull(),
    solariProfileId: text("solari_profile_id"),
    /** Sticky IP key, so one identity keeps one address across sessions. */
    proxySession: text("proxy_session"),
    health: personaHealthEnum("health").notNull().default("healthy"),
    seedPlanId: uuid("seed_plan_id"),
    lastAliveAt: timestamp("last_alive_at", { withTimezone: true }),
    statSessions: integer("stat_sessions").notNull().default(0),
    statMinutes: doublePrecision("stat_minutes").notNull().default(0),
    statBlocks: integer("stat_blocks").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("personas_country_health_idx").on(t.country, t.health)],
)

export const seedPlans = pgTable("seed_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  locality: text("locality").notNull(),
  /** Versioned: comparing identity drift is meaningless if the recipe moved underneath it. */
  version: integer("version").notNull().default(1),
  steps: jsonb("steps").notNull(),
  ...timestamps,
})

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: sessionPurposeEnum("purpose").notNull(),
    /** Opaque. No foreign key: the engine does not know what a user is. */
    ownerId: text("owner_id"),
    domainId: text("domain_id"),
    personaId: uuid("persona_id").references(() => personas.id, { onDelete: "set null" }),
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
 * A repeated measurement (P1.8): the same question, the same two identities, one
 * run each per interval, for a fixed number of days.
 *
 * The row is the **plan**. What happened is the harvest runs that carry its id, and
 * the two are allowed to disagree — a day whose runs never happened leaves a hole,
 * and under ADR-0014 that is the ordinary case rather than an incident. Nothing
 * here records progress, because a progress column is a fact that goes stale the
 * first time the thing that would update it does not run.
 *
 * No `complete` state, for the same reason: the last day being in the past is
 * arithmetic. `stopped` is not — it is somebody deciding to stop spending browser
 * minutes on this question, and that decision is the only thing a reader cannot
 * derive.
 */
export const driftExperiments = pgTable(
  "drift_experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: text("domain_id").notNull(),
    ownerId: text("owner_id"),
    sourceId: text("source_id").notNull(),
    query: text("query").notNull(),
    /**
     * Two identities, `restrict` on both.
     *
     * A persona deleted mid-experiment would leave a series whose other column has
     * nothing to be compared against and no way to say whose fault that is — the
     * same reasoning that makes `harvest_runs.persona_id` restrict.
     */
    personaAId: uuid("persona_a_id")
      .notNull()
      .references(() => personas.id, { onDelete: "restrict" }),
    personaBId: uuid("persona_b_id")
      .notNull()
      .references(() => personas.id, { onDelete: "restrict" }),
    days: integer("days").notNull(),
    /** The top-k the experiment was designed at. A reader may ask for another. */
    k: integer("k").notNull().default(20),
    /**
     * Minutes between days; 1440 is "daily" and the only value Phase 1 uses.
     *
     * A column rather than a constant because a seven-day experiment cannot be
     * demonstrated or exercised end to end at its real cadence, and the
     * alternative to a parameter is a test that fakes a clock — which proves the
     * schedule arithmetic and not the queue that has to carry it.
     */
    intervalMinutes: integer("interval_minutes").notNull().default(1440),
    /** The anchor every day is computed from. Day n is due n intervals after it. */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    state: driftStateEnum("state").notNull().default("running"),
    ...timestamps,
  },
  (t) => [
    index("drift_experiments_state_started_idx").on(t.state, t.startedAt),
    // In the database rather than only in the Zod schema, because the row can be
    // written by anything holding the connection string. `overlapAt(x, x, k)` is a
    // perfectly good 1.0, so an experiment pointed at one identity twice spends a
    // week of sessions drawing a flat line at 100% that reads as the strongest
    // result the tool can produce.
    check("drift_experiments_two_personas", sql`${t.personaAId} <> ${t.personaBId}`),
  ],
)

export const harvestRuns = pgTable(
  "harvest_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: text("domain_id").notNull(),
    personaId: uuid("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "restrict" }),
    sourceId: text("source_id").notNull(),
    query: text("query").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: harvestOutcomeEnum("outcome").notNull().default("running"),
    itemCount: integer("item_count").notNull().default(0),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    /**
     * Which designed measurement asked for this run, and which day of it.
     *
     * Null for an ordinary run. Set together or not at all — the check constraint
     * in the migration says so, because half a pairing key is worse than none: a
     * run that knows its experiment and not its day cannot be put opposite
     * anything.
     *
     * It is a stored key rather than a reconstruction from `started_at`, and that
     * is the same argument `raw_items.rank` settles one table over. Two runs are
     * comparable because one tick asked for both; pairing them by clock instead
     * puts a delayed run on the wrong day, and a schedule that may be delayed is
     * precisely the guarantee ADR-0014 withholds. `set null` rather than cascade
     * on delete, because deleting the plan must not delete the evidence — the runs
     * happened and the minutes were billed whatever becomes of the row that asked.
     */
    experimentId: uuid("experiment_id").references(() => driftExperiments.id, {
      onDelete: "set null",
    }),
    experimentDay: integer("experiment_day"),
    ...timestamps,
  },
  (t) => [
    index("harvest_runs_domain_source_idx").on(t.domainId, t.sourceId, t.startedAt),
    // The series read, and the only index it needs: one experiment's runs, in day
    // order, both sides interleaved. Without it, drawing a seven-point plot is a
    // scan of every run anybody has ever done.
    index("harvest_runs_experiment_day_idx").on(t.experimentId, t.experimentDay),
    // Half a pairing key is worse than none: a run that knows its experiment and
    // not its day cannot be put opposite anything, and would read as a day-0 run
    // if anything ever coalesced the null.
    check(
      "harvest_runs_experiment_pair",
      sql`(${t.experimentId} IS NULL) = (${t.experimentDay} IS NULL)`,
    ),
    // The Lab's question, and the drift experiment's: what did *this* identity get
    // back, most recent first. Without it, "the newest run for persona A" is a scan
    // of every run anybody has ever done.
    index("harvest_runs_persona_started_idx").on(t.personaId, t.startedAt),
  ],
)

export const rawItems = pgTable(
  "raw_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    harvestRunId: uuid("harvest_run_id")
      .notNull()
      .references(() => harvestRuns.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    /**
     * Where the source put this item, zero-based, within its own run.
     *
     * Not a quality score and not comparable across runs: it is the position the
     * surface chose, which is the only thing a ranked surface actually tells us.
     * It is a column rather than a derived order because nothing else in the row
     * can stand in for it — `capturedAt` is one timestamp for the whole batch and
     * `id` is random — and "the top twenty" is the unit every comparison in
     * Phase 1 is stated in. An arbitrary twenty compared against another
     * arbitrary twenty produces a number that looks like a measurement.
     */
    rank: integer("rank").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    text: text("text").notNull(),
    /** What the source or a cheap detector claimed. Not authoritative. */
    languageGuess: text("language_guess"),
    mediaRefs: text("media_refs").array().notNull().default([]),
    engagementViews: integer("engagement_views"),
    engagementLikes: integer("engagement_likes"),
    engagementComments: integer("engagement_comments"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** Untouched response body in object storage, for when a parser turns out wrong. */
    rawRef: text("raw_ref").notNull(),
    ...timestamps,
  },
  (t) => [
    // `(run, rank)` rather than `(run)`: every read of a run's items is a read in
    // rank order, and the index that answers it is the one that carries the order.
    index("raw_items_run_rank_idx").on(t.harvestRunId, t.rank),
    // Re-running extraction scans by source and time. It must never scan by URL.
    index("raw_items_source_captured_idx").on(t.sourceId, t.capturedAt),
  ],
)

export const mentions = pgTable(
  "mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rawItemId: uuid("raw_item_id")
      .notNull()
      .references(() => rawItems.id, { onDelete: "cascade" }),
    domainId: text("domain_id").notNull(),
    /** Bumped when a pack's prompts or weights change, so old rows stay readable. */
    packVersion: text("pack_version").notNull(),
    /** Validated against the pack's own mentionSchema at the boundary, not here. */
    payload: jsonb("payload").notNull(),
    /** Opaque pointer into the pack's table. Null until resolved. No foreign key, by design. */
    entityId: uuid("entity_id"),
    resolution: resolutionStateEnum("resolution").notNull().default("pending"),
    confidence: doublePrecision("confidence").notNull(),
    ...timestamps,
  },
  (t) => [index("mentions_domain_resolution_idx").on(t.domainId, t.resolution)],
)

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: text("domain_id").notNull(),
    /** Opaque by design — no foreign key to a vertical's table. */
    entityId: uuid("entity_id").notNull(),
    rawItemId: uuid("raw_item_id")
      .notNull()
      .references(() => rawItems.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    personaId: uuid("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "restrict" }),
    language: text("language"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** Pack-shaped. The engine carries it without reading it. */
    extract: jsonb("extract").notNull(),
    rawRef: text("raw_ref").notNull(),
    engagementViews: integer("engagement_views"),
    engagementLikes: integer("engagement_likes"),
    engagementComments: integer("engagement_comments"),
    ...timestamps,
  },
  (t) => [
    // Every score explanation resolves through this index. It is the hot one.
    index("evidence_domain_entity_idx").on(t.domainId, t.entityId),
  ],
)

export const probeTargets = pgTable(
  "probe_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id"),
    sourceId: text("source_id").notNull(),
    url: text("url").notNull(),
    /** Shape declared by the source adapter. The engine does not read it. */
    parsed: jsonb("parsed").notNull(),
    watch: boolean("watch").notNull().default(false),
    cadence: probeCadenceEnum("cadence"),
    ...timestamps,
  },
  (t) => [index("probe_targets_watch_cadence_idx").on(t.watch, t.cadence)],
)

export const observations = pgTable(
  "observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetId: uuid("target_id")
      .notNull()
      .references(() => probeTargets.id, { onDelete: "cascade" }),
    country: text("country").notNull(),
    personaId: uuid("persona_id").references(() => personas.id, { onDelete: "set null" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /**
     * Generic on purpose: a fare is one shape, a ranked result list another, a
     * rendered ad slot a third. Adding a fourth must not require a migration.
     */
    payload: jsonb("payload").notNull(),
    screenshotRef: text("screenshot_ref").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("observations_target_captured_idx").on(t.targetId, t.capturedAt)],
)

/**
 * The budget guard's counters (plan section 2.4). One row per
 * `(meter, window, window_key)`; the guard reads before it spends and adds after.
 *
 * These live in Postgres rather than in a cache because a scheduled runner exits
 * between drains (ADR-0014), and a counter that resets when the process does would
 * make the ceiling in section 8 decorative. Ceilings themselves are not stored:
 * they are constants in `@samsara/kernel`, so changing one is a reviewed diff
 * rather than an UPDATE nobody sees.
 */
export const budgetCounters = pgTable(
  "budget_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meter: meterIdEnum("meter").notNull(),
    window: budgetWindowEnum("window").notNull(),
    /** The value the window is sliced by: a date, `<ownerId>:<date>`, or `<purpose>:<runId>`. */
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
    /** Opaque pair with the pack's own tables; no foreign key, by the rule above. */
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
