/**
 * The shapes `/lab/*` returns, restated for the browser.
 *
 * Restated rather than imported. `apps/api` could export these and this app could
 * `import type` them, and it deliberately does not: the browser would then be
 * compiling the Worker's source — `hono`, `zod`, `@samsara/harvest/ports` and the
 * rest — to learn the shape of a JSON body it already receives as JSON. What
 * crosses this boundary is a wire format, not a module, and the honest way to say
 * that is to write the wire format down.
 *
 * The cost is that the two can drift. It is the cheaper cost: a drift shows up as
 * a field rendering `undefined` in an internal tool, where the alternative shows
 * up as a bundler resolving `node:crypto` for a page.
 */

export type PersonaTier = "anon" | "seeded"
export type PersonaHealth = "healthy" | "degraded" | "banned" | "retired"

export interface Persona {
  id: string
  name: string
  locality: string
  country: string
  locale: string
  timezoneId: string
  tier: PersonaTier
  health: PersonaHealth
  lastAliveAt: string | null
  stats: { sessions: number; minutes: number; blocks: number }
  /** What makes it a character. Null for a bare persona made in the Lab. */
  traits: PersonaTraits | null
}

export interface PersonaTraits {
  archetype?: string
  bio?: string
  interests?: string[]
  sources?: string[]
  look?: { colour?: string; prop?: string }
}

export type HarvestOutcome = "running" | "ok" | "empty" | "partial" | "blocked" | "error"

export interface Harvest {
  id: string
  personaId: string
  sourceId: string
  query: string
  domainId: string
  outcome: HarvestOutcome | null
  itemCount: number
  startedAt: string
  endedAt: string | null
}

export interface Item {
  id: string
  rank: number
  url: string
  title: string | null
  text: string
  truncated: boolean
  languageGuess: string | null
  mediaRefs: readonly string[]
  engagement: { views: number | null; likes: number | null; comments: number | null } | null
  capturedAt: string
}

/** `@samsara/harvest`'s `OverlapAtK`. See that file for why `comparable` is not `k`. */
export interface OverlapAtK {
  k: number
  shared: number
  comparable: number
  overlap: number
}

export interface Side {
  personaId: string
  harvest: Harvest | null
  items: Item[]
}

export interface Comparison {
  query: string
  sourceId: string | null
  overlap: OverlapAtK
  a: Side
  b: Side
}

/**
 * The sources a deployment can be told to spend money on, for the input's
 * suggestions only.
 *
 * A `<datalist>` and not a `<select>`, because this list is a copy of
 * `apps/worker/src/sources.ts` and a copy goes stale. A select would make a source
 * registered there and missing here unreachable from the Lab; a datalist leaves it
 * typeable, and the worker is the thing that actually refuses an unregistered id.
 */
export const SOURCE_IDS = [
  "youtube.search",
  "youtube.trending",
  "tiktok.search",
  "tiktok.explore",
  "maps.search",
  "maps.reviews",
  "pantip.forum",
  "pantip.tag",
  "pantip.topic",
] as const

/**
 * The drift experiment (P1.8): the same question, asked every day, by two
 * identities.
 *
 * `@samsara/harvest/drift`'s `DriftSeries`, restated for the same reason the rest
 * of this file restates things — the wire is a format, not a module. The one field
 * worth reading twice is `state`, because it is what keeps the chart honest:
 * `overlap` is `null` on every day that is not `compared`, and a day that was never
 * measured must not be drawn as agreement of zero.
 */
export type DriftExperimentState = "running" | "stopped"

export interface DriftExperiment {
  id: string
  domainId: string
  sourceId: string
  query: string
  personaAId: string
  personaBId: string
  days: number
  k: number
  intervalMinutes: number
  startedAt: string
  state: DriftExperimentState
}

/**
 * Why a day has no number, in four words.
 *
 * - `compared` — both identities ran, and the overlap is real.
 * - `empty` — both ran and at least one came back with nothing, so there was
 *   nothing to compare. Not the same as agreeing on nothing.
 * - `missing` — the day came due and did not produce two runs. A gap.
 * - `pending` — the day has not come due yet. Not a gap; a future.
 */
export type DriftPointState = "pending" | "missing" | "empty" | "compared"

export interface DriftSide {
  runId: string
  personaId: string
  outcome: HarvestOutcome
  itemCount: number
  startedAt: string
}

export interface DriftPoint {
  day: number
  dueAt: string
  measuredAt: string | null
  state: DriftPointState
  overlap: OverlapAtK | null
  meanRankShift: number | null
  a: DriftSide | null
  b: DriftSide | null
}

export interface DriftSeries {
  experiment: DriftExperiment
  k: number
  summary: {
    comparedDays: number
    missingDays: number
    meanOverlap: number | null
    spread: number | null
    complete: boolean
  }
  points: DriftPoint[]
}

/**
 * A Mention as `/lab/mentions` returns it (P2.2).
 *
 * **`payload` is `unknown` all the way to the browser, and that is the seam
 * working.** The engine stored whatever the pack's `mentionSchema` validated and
 * hands it back unread; `apps/api` passes it through without looking. This app is
 * allowed to know it is a place — it is the travel app — so the narrowing happens
 * here, in `asPlaceMention` below, and nowhere upstream of here.
 *
 * Restated rather than imported from `@dt/travel-pack` for the reason at the top
 * of this file, and more sharply than usual: that package depends on
 * `@samsara/refine`, which depends on `drizzle-orm`. Importing a type from it to
 * render a name would put a database driver in the bundler's graph.
 */
export type ResolutionState = "pending" | "resolved" | "unresolvable"

export const RESOLUTION_STATES: readonly ResolutionState[] = [
  "pending",
  "resolved",
  "unresolvable",
] as const

export interface Mention {
  id: string
  rawItemId: string
  domainId: string
  packVersion: string
  payload: unknown
  entityId: string | null
  resolution: ResolutionState
  confidence: number
  createdAt: string
  item: {
    sourceId: string
    url: string
    title: string | null
    languageGuess: string | null
  }
}

/** `@dt/travel-pack`'s `placeMention`, restated. See `asPlaceMention`. */
export interface PlaceMention {
  localName: string
  romanName: string | null
  dish: string | null
  category: string
  priceHint: string | null
  quote: string
  sentiment: "positive" | "mixed" | "negative"
  creatorReads: "local" | "visitor" | "unknown"
}

/**
 * Narrow a mention payload to a place, or don't.
 *
 * Returns `null` rather than throwing, and the caller renders the raw JSON when
 * it does. That is not defensive habit — it is the only honest way to read this
 * column. `mentions.payload` is `jsonb` written by whichever pack version was
 * running at the time, so a row extracted before a schema change genuinely does
 * not have today's shape, and a cast would render it as a card with `undefined`
 * where the name goes. A row this function refuses is a row worth seeing.
 *
 * Only the fields this screen shows are checked. A stricter check here would be
 * a second copy of `placeMention` that can disagree with the first; the pack
 * already validated the payload before it was stored, and re-validating it in a
 * browser would not make that more true.
 */
export function asPlaceMention(payload: unknown): PlaceMention | null {
  if (typeof payload !== "object" || payload === null) return null
  const p = payload as Record<string, unknown>
  if (typeof p.localName !== "string" || typeof p.quote !== "string") return null
  return p as unknown as PlaceMention
}
