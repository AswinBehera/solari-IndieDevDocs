-- A lifetime window: the day windows reset, a prepaid balance does not.
-- No backfill here: Postgres refuses a new enum value inside the transaction that
-- added it. Spend before this migration is not in the total unless summed in by hand
-- from the `global.day` rows once it has committed.
ALTER TYPE "public"."budget_window" ADD VALUE 'global.total';
