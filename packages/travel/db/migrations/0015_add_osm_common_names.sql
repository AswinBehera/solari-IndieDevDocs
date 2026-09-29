ALTER TABLE "osm_places" ADD COLUMN "common_name" text;--> statement-breakpoint
ALTER TABLE "osm_places" ADD COLUMN "common_local" text;--> statement-breakpoint
ALTER TABLE "osm_places" ADD COLUMN "alt_names" text[] DEFAULT '{}' NOT NULL;