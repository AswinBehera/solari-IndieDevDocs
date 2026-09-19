/**
 * Tier 0: the pin is already in the harvest.
 *
 * ADR-0017 calls this the primary path and the one ADR-0007 did not mention at
 * all. It costs nothing, touches no meter, and is more accurate than any name
 * lookup because the author pinned it themselves. The acceptance criterion for
 * P2.3 — that Tier 2 carries no more than a fifth — is in practice a statement
 * about how much of the corpus this file can read.
 *
 * ## The rule that makes this safe
 *
 * **A coordinate is used only when it can be attributed to this mention by
 * name.** That is the whole discipline here, and it costs real recall, so it is
 * worth being clear about what it buys.
 *
 * A resolver sees one mention and the whole artifact. An artifact is often a
 * listicle — "ten noodle shops in Bangkok" — carrying ten map links. Taking the
 * first coordinate found would give all ten mentions the first shop's
 * coordinates, and the failure would be invisible: every mention resolves, at
 * Tier 0, with high confidence, onto a map that looks populated and is wrong.
 * Nothing downstream could detect it, because a wrong coordinate and a right one
 * are the same shape. An unresolvable mention, by contrast, is visibly
 * unresolved and gets another tier.
 *
 * So a bare coordinate — a geotag in text with no name beside it — is *not*
 * Tier 0 here, even though ADR-0017's "geo-tagged posts carry coordinates" is
 * exactly that case. The information needed to use it safely is how many places
 * this artifact names, and that is knowledge the harvester has and the resolver
 * does not: a post's own location tag belongs in a structured field on the raw
 * item, not in the text where it is indistinguishable from a link someone
 * quoted. Recovering those is a harvest change, and it is the first thing to
 * look at if Tier 0's share comes in low.
 */

/** A coordinate found in an artifact, with whatever named it. */
export interface Pin {
  lat: number
  lng: number
  /** The name the link carried, already URL-decoded. Null when it carried none. */
  name: string | null
  /** Source-tagged, per ADR-0017, so dedup cannot merge across namespaces. */
  ref: { source: "artifact"; id: string } | null
}

/** West, south, east, north. The order GeoJSON and Overpass both use. */
export type Bbox = readonly [number, number, number, number]

export interface City {
  /** Canonical, as `places.city` stores it. "Bangkok", never "bkk". */
  name: string
  bbox: Bbox
}

/**
 * Bangkok, wide enough for Nonthaburi and Samut Prakan.
 *
 * Deliberately generous. The bbox is a sanity guard against attributing a
 * coordinate from an entirely different country — a source comparing Bangkok
 * with Tokyo, a footer linking the writer's home city — and not an attempt to
 * decide what counts as Bangkok. Tight bounds here would silently drop real
 * places on the edge of the metro, which is the same failure as a wrong pin and
 * harder to notice.
 */
export const BANGKOK: City = {
  name: "Bangkok",
  bbox: [100.25, 13.45, 100.95, 14.0],
}

export const inBbox = (lat: number, lng: number, bbox: Bbox): boolean =>
  lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]

/**
 * At least three decimal places, on both halves.
 *
 * A coordinate written to two places is good to about a kilometre, which is not
 * a pin. More to the point, the pattern that finds coordinates in free text also
 * finds prices, dates, version strings and "1, 2" in a list, and requiring three
 * decimals on both numbers is what separates a coordinate from arithmetic
 * someone happened to write down.
 */
const PAIR = /(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/

const valid = (lat: number, lng: number): boolean =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180 &&
  // 0,0 is in the Gulf of Guinea and is what a broken serialiser writes.
  !(lat === 0 && lng === 0)

const decode = (raw: string): string | null => {
  try {
    const name = decodeURIComponent(raw.replace(/\+/g, " ")).trim()
    return name.length === 0 ? null : name
  } catch {
    // A malformed percent-escape. The name is not worth a thrown resolver.
    return null
  }
}

/**
 * Every coordinate this text can be read as carrying, in the order they appear.
 *
 * Four shapes, which is not an arbitrary four: they are what actually appears in
 * harvested Thai food writing. Google Maps links dominate, `geo:` URIs come from
 * share sheets, OSM links come from the more technical forum posts, and a bare
 * pair appears when someone pasted from a maps app.
 *
 * Short links — `maps.app.goo.gl`, `bit.ly` — are not here and cannot be:
 * resolving one is an HTTP request, and this function is pure by design. A
 * resolver that reached for `fetch` would be making a network call that no meter
 * counts and no budget guards, which is the thing `LookupPort` exists to
 * prevent.
 */
export function pinsIn(text: string): Pin[] {
  const pins: Pin[] = []
  const push = (lat: number, lng: number, name: string | null, ref: Pin["ref"]) => {
    if (!valid(lat, lng)) return
    // A named link contains a bare pair, so the last pass below would otherwise
    // record every coordinate twice — once with the name that makes it usable
    // and once without. Named first, and a later nameless duplicate is dropped.
    if (pins.some((pin) => pin.lat === lat && pin.lng === lng)) return
    pins.push({ lat, lng, name, ref })
  }

  /**
   * Google Maps place URLs, parsed from the whole URL rather than by one
   * regular expression trying to hold every part at once — the parts appear in
   * different orders depending on which client wrote the link.
   *
   * `!3d<lat>!4d<lng>` is the place's own coordinate and `@<lat>,<lng>` is the
   * viewport centre, so the first wins where both are present: they differ by
   * whatever the map was panned to, which at a shared link's usual zoom is a
   * block or two.
   *
   * `!1s<id>` is Google's own id for the place, and it is worth keeping even
   * though nothing here calls Google. Two artifacts linking the same shop carry
   * the same id, which hands P2.4 an exact dedup key for free — far stronger
   * than agreeing two names are the same. It is tagged `artifact` rather than
   * given a vendor namespace of its own, because what we are recording is that
   * the harvested post carried it, which is the claim we can actually stand
   * behind.
   */
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?google\.[a-z.]+\/maps\/place\/\S+/g)) {
    const url = m[0]
    const name = /\/maps\/place\/([^/@?#]+)/.exec(url)?.[1]
    const exact = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(url)
    const viewport = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url)
    const coords = exact ?? viewport
    if (!coords) continue
    const id = /!1s([\w:.-]+)/.exec(url)?.[1]
    push(
      Number(coords[1]),
      Number(coords[2]),
      name === undefined ? null : decode(name),
      id === undefined ? null : { source: "artifact", id },
    )
  }

  // `?q=`, `?ll=`, `?query=`, `?center=` — the query-parameter spellings, which
  // carry no name. Kept because they still anchor a name found nearby in text.
  const params = /[?&](?:q|ll|query|center|daddr)=(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/g
  for (const m of text.matchAll(params)) {
    push(Number(m[1]), Number(m[2]), null, null)
  }

  // `geo:` URIs, from a phone's share sheet.
  for (const m of text.matchAll(/geo:(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/g)) {
    push(Number(m[1]), Number(m[2]), null, null)
  }

  /**
   * OpenStreetMap links, which are the one shape here that carries an id worth
   * keeping: an OSM node is a stable identity, so `externalRef` gets a real
   * value and Tier 1 and Tier 0 can later be recognised as having found the
   * same thing.
   */
  const osm =
    /https?:\/\/(?:www\.)?openstreetmap\.org\/[^\s]*?mlat=(-?\d+\.\d+)[^\s]*?mlon=(-?\d+\.\d+)/g
  for (const m of text.matchAll(osm)) {
    push(Number(m[1]), Number(m[2]), null, null)
  }
  // `openstreetmap.org/node/<id>` is deliberately not read. It is a real
  // identity and it carries no position, and an id alone cannot place a
  // mention — looking one up is Tier 1's job, against our own extract, where
  // the id is a lookup key rather than an answer.

  // A bare pair, last, so a named link that contains one is already recorded.
  for (const m of text.matchAll(new RegExp(PAIR, "g"))) {
    push(Number(m[1]), Number(m[2]), null, null)
  }

  return pins
}

/**
 * Names, compared the way two people writing about one shop actually differ.
 *
 * NFKC first, because Thai text arriving from different platforms differs in
 * composition and two byte sequences that render identically must compare equal.
 * Then case, then everything that is not a letter or a digit: spaces, the
 * hyphens and middots that URL slugs use, and the quotation marks a caption puts
 * around a name. What is left is a string that a Thai name and its slugified
 * form both reduce to.
 */
export const normaliseName = (name: string): string =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")

/**
 * Generic openers that say what a place *is* rather than what it is called.
 *
 * A mention says "ร้านก๋วยเตี๋ยวเรือทองหล่อ" and the map link says
 * "ก๋วยเตี๋ยวเรือทองหล่อ", differing only by the word for "shop". Stripping
 * these is what lets those match exactly rather than by containment.
 *
 * Stripped only from the front, and only when something is left: "ร้าน" alone is
 * a mention that named nothing, and reducing it to the empty string would make
 * it match every link in the artifact.
 */
const OPENERS = ["ร้านอาหาร", "ร้านกาแฟ", "ร้าน", "โรงแรม", "คาเฟ่", "restaurant", "cafe", "the"]

const stripOpener = (normalised: string): string => {
  for (const opener of OPENERS) {
    const prefix = normaliseName(opener)
    if (normalised.startsWith(prefix) && normalised.length > prefix.length) {
      return normalised.slice(prefix.length)
    }
  }
  return normalised
}

/**
 * How confident we are that these two strings name the same place, or null for
 * "not the same place".
 *
 * Three tiers of agreement and no fuzzy matching at all. Trigram similarity is
 * Tier 1's tool, over a POI table where a near-miss can be checked against a
 * category and a coordinate; here the only evidence is the two strings, and a
 * near-miss produces exactly the silent wrong pin this file is organised to
 * avoid. So: the same name, the same name once a generic opener is dropped, or
 * one name wholly inside the other and long enough for that to mean something.
 *
 * The containment floor is six characters *and* half the longer string. Six
 * alone would let "ทองหล่อ" — a whole district — match any shop with the
 * district in its name, and half alone would let a two-character match count.
 */
export function nameAgreement(a: string, b: string): number | null {
  const left = normaliseName(a)
  const right = normaliseName(b)
  if (left.length === 0 || right.length === 0) return null
  if (left === right) return 0.95

  const bareLeft = stripOpener(left)
  const bareRight = stripOpener(right)
  if (bareLeft === bareRight) return 0.9

  const [short, long] =
    bareLeft.length <= bareRight.length ? [bareLeft, bareRight] : [bareRight, bareLeft]
  if (short.length >= 6 && short.length * 2 >= long.length && long.includes(short)) return 0.75

  return null
}
