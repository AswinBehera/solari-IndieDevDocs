-- P4.8. Nullable, no backfill: a trip is unshared until its owner shares it. The
-- unique index allows any number of NULLs, which is what "not shared" is.
ALTER TABLE "trips" ADD COLUMN "share_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "trips_share_token_idx" ON "trips" USING btree ("share_token");