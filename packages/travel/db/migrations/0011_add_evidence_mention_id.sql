-- P2.5. `NOT NULL` with no default and no backfill, which is only safe because
-- `evidence` is empty in every environment: nothing has ever written it, and
-- P2.5 is the task that starts. If that stops being true, this needs a backfill
-- from `mentions` before the constraint.
ALTER TABLE "evidence" ADD COLUMN "mention_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_mention_id_mentions_id_fk" FOREIGN KEY ("mention_id") REFERENCES "public"."mentions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_domain_mention_idx" ON "evidence" USING btree ("domain_id","mention_id");
