CREATE TYPE "public"."drift_state" AS ENUM('running', 'stopped');--> statement-breakpoint
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
ALTER TABLE "harvest_runs" ADD COLUMN "experiment_id" uuid;--> statement-breakpoint
ALTER TABLE "harvest_runs" ADD COLUMN "experiment_day" integer;--> statement-breakpoint
ALTER TABLE "drift_experiments" ADD CONSTRAINT "drift_experiments_persona_a_id_personas_id_fk" FOREIGN KEY ("persona_a_id") REFERENCES "public"."personas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drift_experiments" ADD CONSTRAINT "drift_experiments_persona_b_id_personas_id_fk" FOREIGN KEY ("persona_b_id") REFERENCES "public"."personas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drift_experiments_state_started_idx" ON "drift_experiments" USING btree ("state","started_at");--> statement-breakpoint
ALTER TABLE "harvest_runs" ADD CONSTRAINT "harvest_runs_experiment_id_drift_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."drift_experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "harvest_runs_experiment_day_idx" ON "harvest_runs" USING btree ("experiment_id","experiment_day");--> statement-breakpoint
ALTER TABLE "harvest_runs" ADD CONSTRAINT "harvest_runs_experiment_pair" CHECK (("harvest_runs"."experiment_id" IS NULL) = ("harvest_runs"."experiment_day" IS NULL));