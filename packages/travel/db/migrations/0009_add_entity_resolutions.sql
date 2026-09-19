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
CREATE UNIQUE INDEX "entity_resolutions_domain_key_idx" ON "entity_resolutions" USING btree ("domain_id","key");--> statement-breakpoint
CREATE INDEX "entity_resolutions_domain_state_tier_idx" ON "entity_resolutions" USING btree ("domain_id","state","tier");