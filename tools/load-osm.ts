/**
 * Load a city's named POIs into `osm_places`, which is what Tier 1 searches.
 *
 * ADR-0017's second tier is a trigram search over an OSM extract in our own
 * Postgres. `PostgresOsmSearch` has been able to query that table since P2.3;
 * this is the thing that puts rows in it, and until it has run, Tier 1 answers
 * "not found" to every mention and the tier report is a measurement of nothing.
 *
 * ## Overpass, not a Geofabrik PBF
 *
 * A Thailand `.osm.pbf` is ~700MB and needs osmium to become rows. One Overpass
 * bbox query for named POIs in Bangkok is tens of megabytes of JSON and needs
 * `JSON.parse`. The extract is a few hundred thousand rows at most either way,
 * so the PBF's advantage is entirely about being allowed to re-run it — which
 * brings us to the part that matters.
 *
 * ## It spends someone else's infrastructure, so it spends it once
 *
 * Overpass is volunteer-run and free at the point of use, which makes it the
 * easiest thing in this repository to be rude to: no bill arrives, no quota
 * trips, and a loop that retries on timeout is indistinguishable from a small
 * denial of service. Three rules follow, and they are enforced here rather than
 * remembered:
 *
 *   1. **One query per run.** No retries, no pagination, no per-category loop.
 *      A failure prints what happened and exits; the operator decides whether to
 *      try again, and when.
 *   2. **Every response is saved before it is parsed.** A download that succeeded
 *      and then hit a parse bug must never be paid for twice. The raw body lands
 *      in `.osm/` and the path is printed.
 *   3. **`--from <file>` replays a saved response** with no network at all. This
 *      is the form to use while iterating on the mapping in `osm-tags.ts`, and a
 *      `.gz` file works too: `data/osm/bangkok.json.gz` is a committed snapshot, so
 *      a fresh clone loads Bangkok without waiting on a busy public Overpass.
 *   4. **`--count` asks how big the answer is** before asking for the answer.
 *      It is the one case where two queries are politer than one: Overpass
 *      answers a count without serialising a result set, and a nationwide query
 *      that dies on `maxsize` after fourteen minutes has spent all of the
 *      lookup and wasted all of it.
 *
 * `--commit` is required to write rows, on the same principle as
 * `tools/backfill-refine.ts`: the default prints what would happen. But note the
 * asymmetry — without `--from`, a dry run still queries Overpass, because the
 * count of rows it would write is not knowable without the data. The dry run is
 * free for us and not free for them, which is the reason rule 2 exists.
 *
 * Usage:
 *   npx tsx tools/load-osm.ts --city thailand --count             # how big is it?
 *   npx tsx --env-file=.env tools/load-osm.ts                     # query, save, report
 *   npx tsx --env-file=.env tools/load-osm.ts --commit            # and write the rows
 *   npx tsx --env-file=.env tools/load-osm.ts --from .osm/x.json --commit
 *   npx tsx --env-file=.env tools/load-osm.ts --from data/osm/bangkok.json.gz --commit
 *   ./tools/with-hosted-env.sh npx tsx tools/load-osm.ts --from .osm/x.json --commit
 *
 * The last form is the one P2.3 needs: `.env` points `DATABASE_URL` at local
 * Docker and must keep doing so. See `with-hosted-env.sh`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { gunzipSync } from "node:zlib"
import { createDb } from "../packages/travel/db/src/index.js"
import {
  BANGKOK,
  type City,
  type OsmPlaceRow,
  type OverpassElement,
  rowOf,
} from "../packages/travel/pack/src/index.js"
import { upsertOsmPlaces } from "../packages/travel/pack/src/postgres.js"

/**
 * Thailand, which is not a city and is deliberately shaped like one.
 *
 * The golden corpus is a Thai food board, and a food board talks about the whole
 * country: the labelled places include a waterfall in Phetchabun, a farm shop at
 * Khao Yai and a lagoon at Phu Pha Man. Measuring Tier 1 against a Bangkok-only
 * extract therefore measures the overlap of two different geographies, and reads
 * as a failure of the tier rather than of the extract's bounds.
 *
 * **Loading this replaces the Bangkok extract rather than adding to it.** The
 * primary key is OSM's `<type>/<id>`, so every POI that is in both extracts is
 * one row, and the last load decides what `city` says. That makes `city` the
 * wrong shape for what it is now being asked to do — it is a filter on a column
 * that holds whichever extract touched the row last, not a fact about the place.
 * The honest fix is to derive the city from the coordinate at query time and let
 * the bbox be the filter it already almost is; this is the measurement that
 * decides whether that work is worth doing, so it is not done here.
 */
const THAILAND: City = { name: "Thailand", bbox: [97.3, 5.6, 105.7, 20.5] }

/** The extracts there is a bbox for. Adding another is a line here. */
const CITIES: Record<string, City> = { bangkok: BANGKOK, thailand: THAILAND }

const ENDPOINT = "https://overpass-api.de/api/interpreter"

/**
 * Identify the caller. Overpass's usage policy asks for it, and an operator who
 * can see which client is misbehaving can block that client instead of a subnet.
 */
const USER_AGENT = "doen-thang/0.1 (OSM extract for a travel guide; contact via repository)"

/**
 * Overpass's own server-side budget, in seconds, and it is generous on purpose.
 *
 * A bbox this size with this many tag filters takes minutes on a busy day. Asking
 * for 180 and being killed at 180 means the work was done and thrown away, and
 * the honest response to that is to ask again — which is the retry loop rule 1
 * forbids. So the number is large enough that a timeout means something is wrong
 * rather than that it was lunchtime in Europe.
 */
const OVERPASS_TIMEOUT_S = 900

/** Our own ceiling, above Overpass's, so a hung socket still ends the process. */
const FETCH_TIMEOUT_MS = (OVERPASS_TIMEOUT_S + 120) * 1000

/**
 * The query: named POIs, in the bbox, in the families `osm-tags.ts` has an
 * opinion about.
 *
 * `nwr` rather than `node` — a market or a temple is a way or a relation far more
 * often than it is a point, and Tier 1 would be missing exactly the largest
 * places if this asked for nodes. `out center` gives ways and relations a single
 * coordinate; `rowOf` reads it, and a relation that comes back without one is
 * counted and dropped rather than fetched separately.
 *
 * `["name"]` on every clause is what keeps this tens of megabytes instead of
 * hundreds: an extract that Tier 1 matches names against has no use for the
 * unnamed half of OSM.
 */
function overpassQuery(city: City, mode: "data" | "count"): string {
  const [w, s, e, n] = city.bbox
  const bbox = `${s},${w},${n},${e}`
  const families = ["amenity", "shop", "leisure", "tourism", "historic", "natural"]
  const clauses = families.map((key) => `  nwr["${key}"]["name"](${bbox});`).join("\n")
  const out = mode === "count" ? "out count;" : "out center tags;"
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];\n(\n${clauses}\n);\n${out}`
}

/** A saved response, plain or gzipped (the committed snapshot is the latter). */
function readSaved(path: string): string {
  const raw = readFileSync(resolve(path))
  return (path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")
}

function usage(message: string): never {
  console.error(`load-osm: ${message}`)
  console.error("usage: tools/load-osm.ts [--city <name>] [--from <file>] [--count] [--commit]")
  console.error(`extracts: ${Object.keys(CITIES).join(", ")}`)
  process.exit(1)
}

/** Where a response is saved. Inside the repo, gitignored, next to the captures. */
function savePath(city: City): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dir = resolve(import.meta.dirname, "..", ".osm")
  mkdirSync(dir, { recursive: true })
  return resolve(dir, `${city.name.toLowerCase()}-${stamp}.json`)
}

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)}MB`

/**
 * The one query. Saves the body before parsing it, and returns the file it wrote.
 *
 * Deliberately not a function that can be called twice.
 */
async function ask(city: City, mode: "data" | "count"): Promise<string> {
  const query = overpassQuery(city, mode)
  console.log(`querying ${ENDPOINT} for ${city.name}, once`)
  console.log(`(server-side timeout ${OVERPASS_TIMEOUT_S}s; this can take minutes)\n`)

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    // 429 and 504 are Overpass saying it is busy, and both are commonly retried
    // by scripts that should not. The advice is printed for a person to act on
    // later, which is the difference between a client and a crawler.
    const hint =
      response.status === 429 || response.status === 504
        ? " — Overpass is rate-limiting or busy. Wait and run it again by hand; do not loop."
        : ""
    throw new Error(`Overpass answered ${response.status} ${response.statusText}${hint}`)
  }

  const body = await response.text()
  // A count is four numbers. Saving it would clutter `.osm/` with files that
  // cannot be replayed with `--from`, and nothing was expensive enough to be
  // worth not paying for twice.
  if (mode === "count") return body

  const path = savePath(city)
  writeFileSync(path, body)
  console.log(`saved ${mb(body.length)} to ${path}`)
  console.log("re-run with --from on that file rather than querying again\n")
  return body
}

interface Parsed {
  rows: OsmPlaceRow[]
  elements: number
  /** Elements with a name but nothing `rowOf` could use — no centre, or a bad one. */
  unplaceable: number
}

/**
 * Elements to rows, counting what fell out.
 *
 * `remark` is Overpass's way of reporting a server-side timeout *inside a 200*:
 * the body parses, the elements array is short, and nothing else says the answer
 * is partial. Loading it would half-fill the table and report success, so it is
 * an error here.
 */
function parse(body: string, city: City): Parsed {
  const payload = JSON.parse(body) as { elements?: OverpassElement[]; remark?: string }
  if (payload.remark) throw new Error(`Overpass returned a partial answer: ${payload.remark}`)
  const elements = payload.elements ?? []

  const byId = new Map<string, OsmPlaceRow>()
  let unplaceable = 0
  for (const element of elements) {
    const row = rowOf(element, city.name)
    if (!row) {
      // A nameless element is not a loss — the query asked for named ones, and
      // these are the few whose only name is `name:th`. An element with a name
      // and no position is the one worth counting.
      if (element.tags?.name) unplaceable += 1
      continue
    }
    // The families overlap: a temple tagged `amenity` and `historic` comes back
    // from two clauses as the same element. Last write wins and they are
    // identical, but a duplicate id inside one INSERT is an error Postgres
    // raises rather than resolves.
    byId.set(row.id, row)
  }
  return { rows: [...byId.values()], elements: elements.length, unplaceable }
}

function report(parsed: Parsed): void {
  const { rows, elements, unplaceable } = parsed
  console.log(`${elements} element(s) → ${rows.length} row(s)`)
  if (unplaceable > 0) console.log(`${unplaceable} named element(s) had no usable position`)

  const byCategory = new Map<string, number>()
  for (const row of rows) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1)
  const ordered = [...byCategory].sort((a, b) => b[1] - a[1])
  console.log(`categories: ${ordered.map(([c, n]) => `${c} ${n}`).join(", ")}`)

  // The two counts that say whether ADR-0017's premise holds. Tier 1 exists
  // because `name:th` is the spelling a Thai source writes and Tier 0 cannot
  // match; if that column were mostly empty the tier would be a romanisation
  // search with extra steps, and this is where that would first be visible.
  const local = rows.filter((r) => r.nameLocal !== null).length
  const en = rows.filter((r) => r.nameEn !== null).length
  const pct = (n: number) => (rows.length === 0 ? "0" : ((n / rows.length) * 100).toFixed(1))
  console.log(`name:th on ${local} (${pct(local)}%), name:en on ${en} (${pct(en)}%)`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const commit = args.includes("--commit")
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name)
    if (at === -1) return undefined
    const value = args[at + 1]
    if (!value || value.startsWith("--")) usage(`${name} needs a value`)
    return value
  }

  const cityKey = (flag("--city") ?? "bangkok").toLowerCase()
  const city = CITIES[cityKey]
  if (!city) usage(`no bbox for "${cityKey}"`)

  const from = flag("--from")
  const url = process.env.DATABASE_URL
  // Checked before the query, not after. Discovering that `DATABASE_URL` is unset
  // *after* spending fifteen minutes of somebody's Overpass instance is the exact
  // rudeness this file is arranged to avoid.
  if (commit && !url) usage("DATABASE_URL is not set, and --commit needs somewhere to write")

  /**
   * `out count` before `out center tags`, for a bbox nobody has run before.
   *
   * It is a second query, which the rest of this file is arranged to avoid, and
   * it is cheap in the way that matters: Overpass answers a count from the same
   * search without serialising a result set, so it costs the lookup and none of
   * the transfer. Aiming a fifteen-minute nationwide query at a volunteer
   * instance without knowing whether the answer is fifty thousand rows or five
   * million — and having it die on `maxsize` after fourteen of them — is the
   * more expensive kind of politeness to skip.
   */
  if (args.includes("--count")) {
    const counts = JSON.parse(await ask(city, "count")) as {
      elements?: { tags?: Record<string, string> }[]
    }
    const tags = counts.elements?.[0]?.tags ?? {}
    console.log(`${city.name}: ${tags.total ?? "?"} element(s) match`)
    console.log(
      `(nodes ${tags.nodes ?? "?"}, ways ${tags.ways ?? "?"}, relations ${tags.relations ?? "?"})`,
    )
    return
  }

  const body = from ? readSaved(from) : await ask(city, "data")
  if (from) console.log(`read ${mb(body.length)} from ${from}\n`)

  const parsed = parse(body, city)
  report(parsed)

  if (!commit) {
    console.log("\n--commit not given, so nothing was written.")
    if (!from) console.log("the saved file above can be loaded with --from, without querying again")
    return
  }

  const database = createDb(url as string)
  try {
    const written = await upsertOsmPlaces(database.db, parsed.rows)

    // ADR-0017 asks for a measurement, and this is half of it: whether the
    // extract fits the free Supabase tier at all. The other half — what fraction
    // of mentions Tier 1 actually answers, and therefore whether Tier 2 is worth
    // an account — comes from `report.tiers` after the backfill.
    const [size] = await database.sql<{ total: string; rows: string }[]>`
      select pg_size_pretty(pg_total_relation_size('osm_places')) as total,
             count(*)::text as rows
      from osm_places
    `
    console.log(`\nwrote ${written} row(s) for ${city.name}`)
    if (size) console.log(`osm_places: ${size.rows} row(s), ${size.total} including indexes`)
  } finally {
    await database.sql.end({ timeout: 5 })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
