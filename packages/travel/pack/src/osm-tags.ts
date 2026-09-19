import type { PlaceCategory } from "@dt/core"

/**
 * OSM tags, read as the categories this product uses.
 *
 * Kept separate from the loader that calls it, and pure, because it is the one
 * part of the extract pipeline with an opinion in it. Everything else is a fetch
 * and an INSERT; this decides that a `cafe` is a place you drink at and a `bar`
 * is a place you go out to, and those are judgements a test should be able to
 * disagree with without a network.
 *
 * ## What the category is currently for, which is less than it looks
 *
 * `PostgresOsmSearch` does **not** filter on it. The mention carries a category
 * too — from the extraction model — and matching the two would be the obvious
 * disambiguation: a mention about a temple should not match a shop with a
 * similar name. It is deliberately not done yet, because the mention's category
 * is a model's guess, and a hard filter would promote every one of the model's
 * category mistakes into a place that cannot be found at all. That trade is
 * worth making against a measured miscategorisation rate and not before.
 *
 * So the column is populated ahead of the query that will use it, and the index
 * on `(city, category)` is there for the same reason. Both are cheap; the
 * alternative is a migration and a full reload at the point we want the answer.
 */

/**
 * `amenity`, which carries most of what this product is about.
 *
 * The split that needed deciding: `cafe` and `bar`. A Bangkok คาเฟ่ is drink-led
 * and open in the afternoon; a bar is somewhere you go in the evening. So cafes
 * and juice bars are `drink`, and bars, pubs and clubs are `nightlife`. The
 * alternative — everything you drink at under `drink` — would make `nightlife`
 * mean only nightclubs, and a category with one tag in it is not a category.
 */
const AMENITY: Record<string, PlaceCategory> = {
  restaurant: "food",
  fast_food: "food",
  food_court: "food",
  cafe: "drink",
  ice_cream: "drink",
  juice_bar: "drink",
  bar: "nightlife",
  pub: "nightlife",
  biergarten: "nightlife",
  nightclub: "nightlife",
  marketplace: "market",
  place_of_worship: "temple",
}

/**
 * `shop`, where the exceptions matter more than the rule.
 *
 * `shop=*` is `shop`, except for the ones a person would describe as somewhere
 * they ate or drank rather than somewhere they bought a thing. A bakery in
 * Bangkok is a place with a queue outside it, not a retail category.
 */
const SHOP: Record<string, PlaceCategory> = {
  bakery: "food",
  pastry: "food",
  confectionery: "food",
  deli: "food",
  ice_cream: "drink",
  coffee: "drink",
  tea: "drink",
  beverages: "drink",
}

/** `leisure` and `natural`, both of which mean the same thing here. */
const LEISURE: Record<string, PlaceCategory> = {
  park: "nature",
  garden: "nature",
  nature_reserve: "nature",
}

/**
 * What an OSM element's tags make this place.
 *
 * Ordered, not scored. An element tagged both `amenity=cafe` and `shop=coffee`
 * is one place, and the first rule that matches wins rather than the most
 * specific one — because "most specific" would need a ranking nobody has a basis
 * for, and the orderings that matter here are all agreements anyway.
 *
 * `other` rather than null when nothing matches. The column is `NOT NULL` with
 * an `other` default, and more to the point a POI we could not categorise is
 * still a POI worth matching a name against: dropping it would cost Tier 1 real
 * recall to avoid admitting we do not know what something is.
 */
export function categoryOf(tags: Readonly<Record<string, string>>): PlaceCategory {
  const amenity = tags.amenity
  if (amenity && AMENITY[amenity]) return AMENITY[amenity] as PlaceCategory

  const shop = tags.shop
  if (shop) return (SHOP[shop] ?? "shop") as PlaceCategory

  const leisure = tags.leisure
  if (leisure && LEISURE[leisure]) return LEISURE[leisure] as PlaceCategory

  if (tags.natural) return "nature"

  // `historic` and `tourism` are real and have no category of their own. `other`
  // is the honest answer, and it still gets the row into the extract.
  return "other"
}

/** One row of the extract, as the loader builds it before the upsert. */
export interface OsmPlaceRow {
  id: string
  city: string
  name: string
  nameLocal: string | null
  nameEn: string | null
  lat: number
  lng: number
  category: PlaceCategory
  tags: string[]
}

/** An Overpass element, narrowed to what this reads. Everything else is ignored. */
export interface OverpassElement {
  type: string
  id: number
  lat?: number
  lon?: number
  /** Ways and relations carry their centroid here, from `out center`. */
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

/**
 * The tags kept on the row, which is a short list on purpose.
 *
 * `tags` is `text[]` and it exists to carry what a person would use to find the
 * place, not to mirror OSM. Copying every tag would put phone numbers, opening
 * hours, operator names and `addr:*` into a table this repository's tests
 * truncate and whose size has to fit a free Supabase tier — and none of it is
 * read by anything.
 */
const KEPT_TAGS = ["cuisine", "amenity", "shop", "tourism"] as const

/**
 * An Overpass element as an `osm_places` row, or null if it cannot be one.
 *
 * Three ways to be null, and all three are ordinary rather than exceptional: no
 * name (the extract is a *named*-POI extract and a nameless node cannot be
 * matched by name), no position (a relation Overpass returned without a centre),
 * and a position that is not a number.
 */
export function rowOf(element: OverpassElement, city: string): OsmPlaceRow | null {
  const tags = element.tags ?? {}
  const name = tags.name?.trim()
  if (!name) return null

  const lat = element.lat ?? element.center?.lat
  const lng = element.lon ?? element.center?.lon
  if (typeof lat !== "number" || typeof lng !== "number") return null
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  const kept = KEPT_TAGS.map((key) => tags[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    // Overpass writes multi-values as `thai;noodles`, which is one tag in OSM
    // and two things a person would search for.
    .flatMap((value) => value.split(";"))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  return {
    // OSM's own `<type>/<id>`, which is what `externalRef` carries and what
    // makes a reload an upsert rather than a duplicate.
    id: `${element.type}/${element.id}`,
    city,
    name,
    nameLocal: tags["name:th"]?.trim() || null,
    nameEn: tags["name:en"]?.trim() || null,
    lat,
    lng,
    category: categoryOf(tags),
    tags: [...new Set(kept)],
  }
}
