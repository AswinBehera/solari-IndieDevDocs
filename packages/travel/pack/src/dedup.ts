import type { DedupKey } from "@samsara/refine"
import type { PlaceEntity } from "./entity.js"
import { normaliseName } from "./tier0.js"

/**
 * The travel pack's dedup keys (P2.4), strongest first.
 *
 * "Strongest" means how much *identity* a key carries, which is the same
 * ordering principle ADR-0017 applies to the resolution tiers and for the same
 * reason: a coordinate is precise, and precision is not identity. Two entries
 * twenty metres apart with the same normalised name are almost certainly one
 * shophouse; two entries at the same coordinate with different names are a food
 * court. Only the first key here is an assertion about *which thing this is*;
 * the second is an assertion about which things are close enough to compare.
 *
 * - **`externalRef`** — the same source's own identifier for the same object.
 *   Exact, and the plan is explicit that it is only comparable **within a
 *   source**: two tiers agreeing that a place is OSM node 12345 is a merge, and
 *   an OSM node id colliding numerically with a geocoder's result id is not.
 *   `place.externalRef` is source-tagged in `@dt/core` precisely so that this
 *   key cannot be written wrong — the source is in the value, not assumed.
 * - **`geo`** — a normalised name within `MERGE_RADIUS_M` of a coordinate. This
 *   is the key that does the real work, because the common duplicate is one shop
 *   resolved twice from two posts that spelled it differently and landed on
 *   coordinates a few doors apart.
 *
 * **The third key section 2.4 names is not here, and that is a finding rather
 * than an omission.** Embedding similarity above a threshold needs an embedding,
 * `places` has no vector column, nothing in this repository computes one, and
 * `pgvector` is not installed. Writing the key anyway would have meant either a
 * migration and an embedding pipeline inside a dedup task, or a key that returns
 * nothing forever while appearing in the report as a key that never matches.
 * Neither is worth having; the contract takes an ordered list, so appending it
 * later changes this file and nothing else.
 */

/**
 * How close two entries with the same name have to be to be one entry.
 *
 * A hundred and fifty metres, from plan section 2.4. It is a city-block number
 * and it is chosen against the failure it has to survive: Tier 0 reads a
 * coordinate a person dropped on a map and Tier 1 reads one from an OSM node, and
 * the same shop through those two routes is routinely off by the width of the
 * building plus wherever the pin was placed on the street. A radius tight enough
 * to be sure — say twenty metres — would leave exactly those pairs uncollapsed,
 * which is the pair this key exists for.
 *
 * It is also loose enough to be wrong, and the name is what stops it: inside 150m
 * of a Bangkok street corner there are a dozen food stalls, and this key only
 * fires when one of them has the same normalised name.
 */
export const MERGE_RADIUS_M = 150

/** `kind` values, exported because the stage's report is keyed on them. */
export const EXTERNAL_REF_KEY = "externalRef"
export const GEO_KEY = "geo"

/** The value of an `externalRef` key. Both halves must match; see above. */
export interface ExternalRefKeyValue {
  source: string
  id: string
}

/**
 * The value of a `geo` key.
 *
 * `names` is plural for the reason `OsmSearch.search` takes a list: a place has a
 * local spelling and a roman one, sources use whichever they use, and asking
 * which to trust is a choice with no basis at the point it would be made. Any
 * spelling matching any spelling is a name match.
 */
export interface GeoKeyValue {
  names: readonly string[]
  lat: number
  lng: number
  radiusM: number
}

/** Normalised, de-duplicated, and empty spellings dropped. */
const spellings = (entity: PlaceEntity): string[] => {
  const raw = [entity.localName, entity.canonicalName]
  const out = new Set<string>()
  for (const name of raw) {
    if (name === null) continue
    const normalised = normaliseName(name)
    if (normalised.length > 0) out.add(normalised)
  }
  return [...out]
}

/**
 * What this entity could be recognised by, strongest first.
 *
 * An empty array is a real answer and the stage counts it as one: an entity with
 * no external reference and no coordinate has nothing to compare but a name, and
 * a name alone is not a key. Merging "Jay Fai" into "Jay Fai" across a whole
 * country on the strength of the string would collapse every branch of every
 * chain in Thailand into one row, and unlike a bad coordinate that is not
 * recoverable — the evidence has already been moved.
 */
export const placeDedupKeys = (entity: PlaceEntity): DedupKey[] => {
  const keys: DedupKey[] = []

  if (entity.externalRef !== null) {
    keys.push({
      kind: EXTERNAL_REF_KEY,
      value: {
        source: entity.externalRef.source,
        id: entity.externalRef.id,
      } satisfies ExternalRefKeyValue,
    })
  }

  const names = spellings(entity)
  if (entity.geo !== null && names.length > 0) {
    keys.push({
      kind: GEO_KEY,
      value: {
        names,
        lat: entity.geo.lat,
        lng: entity.geo.lng,
        radiusM: MERGE_RADIUS_M,
      } satisfies GeoKeyValue,
    })
  }

  return keys
}

/**
 * Narrow an opaque key value, or refuse.
 *
 * The repo is the other end of `dedupKeys` and the value arrives typed
 * `unknown`, which is the seam working as intended — but "the other end of a
 * function in the same package" is not a reason to cast. A pack that grew a
 * third key and forgot to teach the repo about it would, with a cast, get a
 * query built out of `undefined` and a merge decided by it. These throw instead,
 * naming the kind, because an unrecognised key is a bug in this package and not
 * a row that failed to match.
 */
export const asExternalRefKey = (value: unknown): ExternalRefKeyValue => {
  const v = value as Partial<ExternalRefKeyValue> | null
  if (!v || typeof v.source !== "string" || typeof v.id !== "string") {
    throw new Error(`dedup key "${EXTERNAL_REF_KEY}" has a value this pack did not build`)
  }
  return { source: v.source, id: v.id }
}

export const asGeoKey = (value: unknown): GeoKeyValue => {
  const v = value as Partial<GeoKeyValue> | null
  if (
    !v ||
    !Array.isArray(v.names) ||
    v.names.some((name) => typeof name !== "string") ||
    typeof v.lat !== "number" ||
    typeof v.lng !== "number" ||
    typeof v.radiusM !== "number"
  ) {
    throw new Error(`dedup key "${GEO_KEY}" has a value this pack did not build`)
  }
  return { names: v.names, lat: v.lat, lng: v.lng, radiusM: v.radiusM }
}

/** Mean Earth radius, the number every short-distance formula starts from. */
const EARTH_RADIUS_M = 6_371_000

/**
 * Great-circle metres between two coordinates.
 *
 * Haversine rather than an equirectangular approximation, which at these
 * distances would be indistinguishable and at this cost is not worth the
 * asterisk. There is one implementation of this in the repository and this is
 * it: the Postgres repo filters by a bounding box in SQL and then applies *this*
 * function to the survivors, so the radius that decides a merge is computed in
 * one place whatever asked the question.
 */
export const metresBetween = (
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number => {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Half-widths of the smallest lat/lng box containing a circle of `radiusM`.
 *
 * Used to turn a radius into a `BETWEEN` a database can answer from an index.
 * The box is a strict superset of the circle, so it produces false positives and
 * never false negatives — which is the only property that matters, because
 * `metresBetween` runs over whatever it returns and throws the corners away.
 *
 * The longitude term divides by `cos(lat)` because a degree of longitude narrows
 * towards the poles. At 13°N that is a 2.7% widening and at 60°N it would be a
 * doubling; writing it as a constant would work in Bangkok and quietly under-read
 * in any city further north, which is the sort of thing that looks fine until the
 * second city.
 */
export const boxAround = (lat: number, radiusM: number): { dLat: number; dLng: number } => {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI)
  // Guarded, because `cos` reaches zero at the poles and the ratio would not be
  // a number. Nothing in this product is at a pole; a NaN in a `BETWEEN` matches
  // nothing at all and would look exactly like "no duplicates found".
  const shrink = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6)
  return { dLat, dLng: dLat / shrink }
}

/**
 * Does this entity answer to this key?
 *
 * The reference semantics, in one place, in TypeScript. The Postgres repo does
 * not call it for the `geo` key — it cannot, because the candidate set has to be
 * narrowed by the database before anything is compared — but it computes the same
 * two conditions from the same two exported helpers, and the tests hold both to
 * this.
 */
export const matchesDedupKey = (key: DedupKey, entity: PlaceEntity): boolean => {
  switch (key.kind) {
    case EXTERNAL_REF_KEY: {
      const wanted = asExternalRefKey(key.value)
      const ref = entity.externalRef
      // Both halves, never just the id. An OSM node id and a geocoder result id
      // that collide numerically are two different objects, and the plan names
      // this case specifically.
      return ref !== null && ref.source === wanted.source && ref.id === wanted.id
    }
    case GEO_KEY: {
      const wanted = asGeoKey(key.value)
      if (entity.geo === null) return false
      if (metresBetween(wanted, entity.geo) > wanted.radiusM) return false
      const here = new Set(spellings(entity))
      return wanted.names.some((name) => here.has(name))
    }
    default:
      throw new Error(`unknown dedup key kind "${key.kind}"`)
  }
}
