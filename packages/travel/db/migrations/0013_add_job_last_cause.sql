-- The cause behind `last_error`, which the API serves and so holds only the class.
-- Nullable, no backfill: old failures keep only their class.
ALTER TABLE "jobs" ADD COLUMN "last_cause" text;