DROP INDEX "raw_items_run_idx";--> statement-breakpoint
ALTER TABLE "raw_items" ADD COLUMN "rank" integer NOT NULL;--> statement-breakpoint
CREATE INDEX "harvest_runs_persona_started_idx" ON "harvest_runs" USING btree ("persona_id","started_at");--> statement-breakpoint
CREATE INDEX "raw_items_run_rank_idx" ON "raw_items" USING btree ("harvest_run_id","rank");