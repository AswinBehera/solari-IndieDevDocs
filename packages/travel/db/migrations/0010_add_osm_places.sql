-- `gin_trgm_ops` below is an operator class, not an index type, so the extension
-- has to exist before the indexes are built. Created here rather than assumed:
-- a migration that assumes an extension is one that works on the machine it was
-- written on. `IF NOT EXISTS` because the hosted database may already have it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "osm_places" (
	"id" text PRIMARY KEY NOT NULL,
	"city" text NOT NULL,
	"name" text NOT NULL,
	"name_local" text,
	"name_en" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"category" "place_category" DEFAULT 'other' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "osm_places_name_trgm_idx" ON "osm_places" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "osm_places_name_local_trgm_idx" ON "osm_places" USING gin ("name_local" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "osm_places_city_category_idx" ON "osm_places" USING btree ("city","category");