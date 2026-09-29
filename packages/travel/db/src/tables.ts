import { sql } from "drizzle-orm"
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import {
  placeCategoryEnum,
  postcardKindEnum,
  postcardStateEnum,
  tripStatusEnum,
  userPlanEnum,
} from "./enums.js"

/**
 * Travel tables (plan section 3.2). Everything here may know it is about travel.
 *
 * Travel may point at engine tables freely — the restriction runs one way only.
 * `postcards.source_refs` holds Evidence ids, and `places` is reached from the engine
 * solely through the opaque `(domain_id, entity_id)` pair, never by a foreign key.
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}

export const users = pgTable("users", {
  /**
   * The Supabase Auth user id — the JWT's `sub` (ADR-0013). Not generated here: one
   * identity, one lifetime, no join table reconciling two id spaces. Deliberately no
   * foreign key to `auth.users`, so local development needs no auth schema.
   */
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  plan: userPlanEnum("plan").notNull().default("free"),
  locale: text("locale").notNull().default("en"),
  /** Null means "use the kernel's global ceiling". The guard reads these; it does not negotiate. */
  budgetSolariMinutesPerDay: integer("budget_solari_minutes_per_day"),
  budgetGeocodeCallsPerDay: integer("budget_geocode_calls_per_day"),
  ...timestamps,
})

export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Canonical, not as typed. "Bangkok", never "bkk". */
    destinationCity: text("destination_city").notNull(),
    startDate: timestamp("start_date", { withTimezone: true }),
    endDate: timestamp("end_date", { withTimezone: true }),
    status: tripStatusEnum("status").notNull().default("dreaming"),
    /**
     * The read-only link's secret (P4.8). Null means not shared; clearing it is
     * how sharing stops, and a new one is minted the next time — so a link that
     * leaked is revoked by sharing again, not by hoping nobody kept it.
     */
    shareToken: text("share_token"),
    ...timestamps,
  },
  (t) => [
    index("trips_user_status_idx").on(t.userId, t.status),
    uniqueIndex("trips_share_token_idx").on(t.shareToken),
  ],
)

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    /** Tiptap/ProseMirror JSON. */
    content: jsonb("content").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  // One document per trip in v1. The constraint says so, rather than a comment hoping so.
  (t) => [uniqueIndex("documents_trip_unique").on(t.tripId)],
)

export const places = pgTable(
  "places",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canonicalName: text("canonical_name").notNull(),
    /** Native script, as written on the sign. Often the only name that resolves. */
    localName: text("local_name"),
    city: text("city").notNull(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    /** ADR-0017: `{ source, id }`. Source-tagged so dedup cannot merge across tiers. */
    externalRef: jsonb("external_ref"),
    /** 0 artifact, 1 OSM extract, 2 hosted geocoder. Null until resolved. */
    resolvedTier: integer("resolved_tier"),
    category: placeCategoryEnum("category").notNull().default("other"),
    tags: text("tags").array().notNull().default([]),
    /** A `ScoreSet` from @samsara/core: each named score carries its own explanations. */
    scores: jsonb("scores").notNull().default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    evidenceCount: integer("evidence_count").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    // Dedup's strongest key. Partial-unique would be better once we trust it; not yet.
    index("places_external_ref_idx").on(t.externalRef),
    index("places_city_category_idx").on(t.city, t.category),
  ],
)

export const postcards = pgTable(
  "postcards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    kind: postcardKindEnum("kind").notNull(),
    placeId: uuid("place_id").references(() => places.id, { onDelete: "set null" }),
    /** Kind-specific. Narrowed by the renderer, not by the database. */
    payload: jsonb("payload").notNull().default({}),
    /** If these are null the card does not appear on the map. That is the whole rule. */
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    timeStart: timestamp("time_start", { withTimezone: true }),
    timeEnd: timestamp("time_end", { withTimezone: true }),
    /** Evidence ids in the engine's table. Every card can show its receipts. */
    sourceRefs: uuid("source_refs").array().notNull().default([]),
    state: postcardStateEnum("state").notNull().default("fresh"),
    ...timestamps,
  },
  (t) => [index("postcards_trip_state_idx").on(t.tripId, t.state)],
)

/**
 * The OpenStreetMap named-POI extract, ADR-0017's Tier 1 (P2.3).
 *
 * The honest version of the idea ADR-0007 reached for when it named the public
 * Nominatim server: the same ODbL data, queried from our own copy. Their usage
 * policy caps scripts running at regular intervals at four requests a minute and
 * names systematic querying as grounds for a ban — a nightly harvest resolving a
 * hundred mentions is precisely the pattern it discourages, and we are not
 * entitled to that server.
 *
 * This is a cache of a public dataset and not a table anyone edits. `id` is
 * OSM's own — `node/123456`, `way/789` — rather than a generated uuid, which is
 * what makes a refresh an upsert rather than a truncate-and-reload, and what
 * lets a resolved place's `external_ref` be checked against the extract later.
 *
 * It stays small by holding only what resolution needs: named POIs inside one
 * city's bbox, a coordinate, and a category. Not geometry, not addresses, not
 * opening hours. ADR-0017 makes the size a measurement to take rather than a
 * number to assume, because it has to fit inside the free Supabase tier.
 */
export const osmPlaces = pgTable(
  "osm_places",
  {
    /** OSM's own identity, `<type>/<id>`. Stable across refreshes. */
    id: text("id").primaryKey(),
    /** Which extract this row came from. Matches `places.city`. */
    city: text("city").notNull(),
    /** The `name` tag, as OSM holds it — often, in Thailand, already Thai script. */
    name: text("name").notNull(),
    /**
     * The `name:th` tag, when it differs from `name`.
     *
     * The reason this tier works for the first vertical at all. A Thai source
     * writes a shop's name in Thai and nothing else will match it — ADR-0007's
     * premise was that only Google indexes those, and `name:th` is the
     * counter-example that makes Tier 1 worth building.
     */
    nameLocal: text("name_local"),
    /** The `name:en` tag. Present far less often than `name:th`. */
    nameEn: text("name_en"),
    /**
     * The name people say, when OSM files the place under a formal one:
     * `loc_name:en`, else `short_name:en`. Bangkok's famous places are mapped
     * by their royal names — Wat Pho's `name` is วัดพระเชตุพนวิมลมังคลาราม and
     * "Wat Pho" is only its `loc_name:en` — so a card that drew `name:en` would
     * title Wat Pho "Wat Phra Chettuphon Wimon Mangkhalaram Ratchaworamahawihan".
     */
    commonName: text("common_name"),
    /** The same in Thai: `loc_name`, else `short_name`, when either is Thai script. */
    commonLocal: text("common_local"),
    /**
     * Every other name a person might type: the common names above, `alt_name`,
     * `official_name`, `old_name` and their `:en`/`:th` forms. Searched by `/place`'s
     * fallback; without them "Wat Pho" finds a smaller temple across the river
     * that happens to be called that, and not the one everyone means.
     */
    altNames: text("alt_names").array().notNull().default([]),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    /** Mapped from OSM tags by the loader, so the resolver never reads a raw tag. */
    category: placeCategoryEnum("category").notNull().default("other"),
    /** The OSM tag values the category was derived from, kept so a remap is possible. */
    tags: text("tags").array().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    /**
     * Trigram indexes, one per name column, which is what makes this tier a
     * lookup rather than a scan. `gin_trgm_ops` is an operator class rather
     * than an index type, so `pg_trgm` must exist before these are built — the
     * migration creates the extension in the same file, deliberately, because a
     * migration that assumes an extension is a migration that works on the
     * machine it was written on.
     */
    index("osm_places_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
    index("osm_places_name_local_trgm_idx").using("gin", sql`${t.nameLocal} gin_trgm_ops`),
    index("osm_places_city_category_idx").on(t.city, t.category),
  ],
)
