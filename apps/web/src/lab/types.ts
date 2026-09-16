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
}

export type HarvestOutcome = "ok" | "partial" | "blocked" | "error"

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
