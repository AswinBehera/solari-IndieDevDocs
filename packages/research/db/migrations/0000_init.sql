CREATE TYPE "public"."budget_window" AS ENUM('global.day', 'owner.day', 'purpose.run', 'global.total');--> statement-breakpoint
CREATE TYPE "public"."drift_state" AS ENUM('running', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."harvest_outcome" AS ENUM('running', 'ok', 'blocked', 'empty', 'error');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."meter_id" AS ENUM('solari.minutes', 'llm.input.tokens', 'llm.output.tokens', 'geocode.calls');--> statement-breakpoint
CREATE TYPE "public"."persona_health" AS ENUM('healthy', 'degraded', 'banned', 'retired');--> statement-breakpoint
CREATE TYPE "public"."persona_tier" AS ENUM('anon', 'seeded');--> statement-breakpoint
CREATE TYPE "public"."probe_cadence" AS ENUM('hourly', 'daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."resolution_state" AS ENUM('pending', 'resolved', 'unresolvable');--> statement-breakpoint
CREATE TYPE "public"."session_outcome" AS ENUM('running', 'ok', 'blocked', 'timeout', 'error', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."session_purpose" AS ENUM('persona.seed', 'persona.keepalive', 'harvest', 'probe', 'agent');--> statement-breakpoint
CREATE TABLE "budget_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meter" "meter_id" NOT NULL,
	"window" "budget_window" NOT NULL,
	"window_key" text NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drift_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" text NOT NULL,
	"owner_id" text,
	"source_id" text NOT NULL,
	"query" text NOT NULL,
	"persona_a_id" uuid NOT NULL,
	"persona_b_id" uuid NOT NULL,
	"days" integer NOT NULL,
	"k" integer DEFAULT 20 NOT NULL,
	"interval_minutes" integer DEFAULT 1440 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" "drift_state" DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drift_experiments_two_personas" CHECK ("drift_experiments"."persona_a_id" <> "drift_experiments"."persona_b_id")
);
--> statement-breakpoint
CREATE TABLE "entity_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" text NOT NULL,
	"key" text NOT NULL,
	"state" "resolution_state" DEFAULT 'pending' NOT NULL,
	"entity_id" uuid,
	"tier" integer,
	"confidence" double precision,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"mention_id" uuid NOT NULL,
	"raw_item_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text NOT NULL,
	"persona_id" uuid NOT NULL,
	"language" text,
	"captured_at" timestamp with time zone NOT NULL,
	"extract" jsonb NOT NULL,
	"raw_ref" text NOT NULL,
	"engagement_views" integer,
	"engagement_likes" integer,
	"engagement_comments" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harvest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" text NOT NULL,
	"persona_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"query" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" "harvest_outcome" DEFAULT 'running' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"session_id" uuid NOT NULL,
	"experiment_id" uuid,
	"experiment_day" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harvest_runs_experiment_pair" CHECK (("harvest_runs"."experiment_id" IS NULL) = ("harvest_runs"."experiment_day" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"state" "job_state" NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"domain_id" text,
	"owner_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"claimed_by" text,
	"last_error" text,
	"last_cause" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_item_id" uuid NOT NULL,
	"domain_id" text NOT NULL,
	"pack_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"entity_id" uuid,
	"resolution" "resolution_state" DEFAULT 'pending' NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"country" text NOT NULL,
	"persona_id" uuid,
	"captured_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"screenshot_ref" text NOT NULL,
	"session_id" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"locality" text NOT NULL,
	"country" text NOT NULL,
	"locale" text NOT NULL,
	"timezone_id" text NOT NULL,
	"tier" "persona_tier" NOT NULL,
	"solari_profile_id" text,
	"proxy_session" text,
	"health" "persona_health" DEFAULT 'healthy' NOT NULL,
	"seed_plan_id" uuid,
	"last_alive_at" timestamp with time zone,
	"stat_sessions" integer DEFAULT 0 NOT NULL,
	"stat_minutes" double precision DEFAULT 0 NOT NULL,
	"stat_blocks" integer DEFAULT 0 NOT NULL,
	"traits" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "probe_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text,
	"source_id" text NOT NULL,
	"url" text NOT NULL,
	"parsed" jsonb NOT NULL,
	"watch" boolean DEFAULT false NOT NULL,
	"cadence" "probe_cadence",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"harvest_run_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"rank" integer NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"text" text NOT NULL,
	"language_guess" text,
	"media_refs" text[] DEFAULT '{}' NOT NULL,
	"engagement_views" integer,
	"engagement_likes" integer,
	"engagement_comments" integer,
	"captured_at" timestamp with time zone NOT NULL,
	"raw_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seed_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"locality" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "session_purpose" NOT NULL,
	"owner_id" text,
	"domain_id" text,
	"persona_id" uuid,
	"country" text NOT NULL,
	"locale" text,
	"timezone_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"minutes" double precision DEFAULT 0 NOT NULL,
	"outcome" "session_outcome" DEFAULT 'running' NOT NULL,
	"recording_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"locator" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"runtime" text NOT NULL,
	"url" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"ref" text NOT NULL,
	"viewpoint" text,
	"session_id" uuid,
	"paired_with" uuid,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_id" uuid NOT NULL,
	"job_id" uuid,
	"outcome" text DEFAULT 'running' NOT NULL,
	"runtimes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"note" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "drift_experiments" ADD CONSTRAINT "drift_experiments_persona_a_id_personas_id_fk" FOREIGN KEY ("persona_a_id") REFERENCES "public"."personas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drift_experiments" ADD CONSTRAINT "drift_experiments_persona_b_id_personas_id_fk" FOREIGN KEY ("persona_b_id") REFERENCES "public"."personas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_mention_id_mentions_id_fk" FOREIGN KEY ("mention_id") REFERENCES "public"."mentions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harvest_runs" ADD CONSTRAINT "harvest_runs_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harvest_runs" ADD CONSTRAINT "harvest_runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harvest_runs" ADD CONSTRAINT "harvest_runs_experiment_id_drift_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."drift_experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_target_id_probe_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."probe_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_harvest_run_id_harvest_runs_id_fk" FOREIGN KEY ("harvest_run_id") REFERENCES "public"."harvest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_counters_meter_window_key_idx" ON "budget_counters" USING btree ("meter","window","window_key");--> statement-breakpoint
CREATE INDEX "drift_experiments_state_started_idx" ON "drift_experiments" USING btree ("state","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_resolutions_domain_key_idx" ON "entity_resolutions" USING btree ("domain_id","key");--> statement-breakpoint
CREATE INDEX "entity_resolutions_domain_state_tier_idx" ON "entity_resolutions" USING btree ("domain_id","state","tier");--> statement-breakpoint
CREATE INDEX "evidence_domain_entity_idx" ON "evidence" USING btree ("domain_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_domain_mention_idx" ON "evidence" USING btree ("domain_id","mention_id");--> statement-breakpoint
CREATE INDEX "harvest_runs_domain_source_idx" ON "harvest_runs" USING btree ("domain_id","source_id","started_at");--> statement-breakpoint
CREATE INDEX "harvest_runs_experiment_day_idx" ON "harvest_runs" USING btree ("experiment_id","experiment_day");--> statement-breakpoint
CREATE INDEX "harvest_runs_persona_started_idx" ON "harvest_runs" USING btree ("persona_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_events_job_seq_idx" ON "job_events" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("state","priority","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_idx" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "mentions_domain_resolution_idx" ON "mentions" USING btree ("domain_id","resolution");--> statement-breakpoint
CREATE INDEX "observations_target_captured_idx" ON "observations" USING btree ("target_id","captured_at");--> statement-breakpoint
CREATE INDEX "personas_country_health_idx" ON "personas" USING btree ("country","health");--> statement-breakpoint
CREATE INDEX "probe_targets_watch_cadence_idx" ON "probe_targets" USING btree ("watch","cadence");--> statement-breakpoint
CREATE INDEX "raw_items_run_rank_idx" ON "raw_items" USING btree ("harvest_run_id","rank");--> statement-breakpoint
CREATE INDEX "raw_items_source_captured_idx" ON "raw_items" USING btree ("source_id","captured_at");--> statement-breakpoint
CREATE INDEX "sessions_owner_started_idx" ON "sessions" USING btree ("owner_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_purpose_started_idx" ON "sessions" USING btree ("purpose","started_at");--> statement-breakpoint
CREATE INDEX "blocks_doc_idx" ON "blocks" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "docs_owner_idx" ON "docs" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "facts_run_idx" ON "facts" USING btree ("run_id","subject");--> statement-breakpoint
CREATE INDEX "facts_block_idx" ON "facts" USING btree ("block_id");--> statement-breakpoint
CREATE INDEX "receipts_run_idx" ON "receipts" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_run_sha_url_uq" ON "receipts" USING btree ("run_id","sha256","url");--> statement-breakpoint
CREATE INDEX "runs_block_idx" ON "runs" USING btree ("block_id","started_at");