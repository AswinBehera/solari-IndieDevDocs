import { countryCode, locale, personaTier, personaTraits, resolutionState } from "@samsara/core"
// Subpath imports, never the barrels, for the reason `app.ts` gives about
// `@samsara/kernel/jobs`: this app is compiled against the Workers runtime, and
// `@samsara/harvest`'s barrel reaches `run.ts`, `@samsara/sources` and Playwright,
// while `store.ts` reaches `node:crypto`. `./ports` is types only and `./overlap`
// is pure arithmetic — both exist so that this import is a compile error the day
// somebody puts a value in them.
import { overlapAt } from "@samsara/harvest/overlap"
import type { HarvestRunRecord, RawItemRow } from "@samsara/harvest/ports"
import type { JobStore } from "@samsara/kernel/jobs"
import type { PersonaEdit, PersonaRecord, PersonaStore } from "@samsara/personas/store"
import type { MentionFilter, MentionRecord } from "@samsara/refine/ports"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { requireAuth, type Verifier } from "./auth.js"
import {
  type DriftExperimentStoreWriter,
  type DriftItemReaderSlice,
  type DriftRunReaderSlice,
  driftRoutes,
} from "./drift.js"

/**
 * The Persona Lab's read surface (P1.7).
 *
 * The Lab is an engine-facing tool that happens to live in the travel app: every
 * noun below is a persona, a source, a query or an item, and none of them is a
 * place. That is the same rule the seam check enforces one directory over, applied
 * here by hand because `apps/` is allowed travel vocabulary and therefore would not
 * be caught.
 *
 * **Why these routes are a prefix rather than top-level resources.** `/lab/*` is
 * one thing to gate, drop or re-shape when a real product API arrives, and the
 * shapes it returns are tuned for a split screen rather than for a client anyone
 * has to keep working. A route named `/personas` would imply a promise this
 * cannot keep.
 *
 * **What is not here: a way to start a harvest.** The Lab triggers one by posting
 * a `harvest.run` job to the existing `/jobs`, because a harvest *is* a job — it
 * opens a browser, costs money and needs the queue's idempotency and its dispatch
 * refusal. A second door into the same work would be a second place for the
 * double-click bug ADR-0016 already closed.
 *
 * The 10 ms CPU rule (ADR-0014) applies unchanged. The heaviest thing here is
 * `overlapAt` over two lists of at most `MAX_K` strings, which is bounded by the
 * clamp below and measured by `cpu.test.ts`.
 */

/**
 * Three stores, built together.
 *
 * One factory rather than three, because all three sit on one database and a
 * request that opened a Hyperdrive connection per port would open three for a
 * comparison that needs one. `jobs` is a separate factory in `AppDeps` for the
 * opposite reason: the job queue is the one thing that must keep working when
 * everything else is misconfigured.
 */
export interface LabStores {
  personas: PersonaStore
  runs: HarvestRunStoreReader & DriftRunReaderSlice
  items: RawItemStoreReader & DriftItemReaderSlice
  experiments: DriftExperimentStoreWriter
  mentions: MentionStoreReader
}

/**
 * The read half of `MentionStore`, which is all of it today.
 *
 * Declared here anyway rather than importing the port directly, so that the day
 * the port grows a write method this surface does not silently acquire it. The
 * worker writes mentions; the API looks at them.
 */
export interface MentionStoreReader {
  list(filter: MentionFilter): Promise<MentionRecord[]>
}

export interface LabDeps {
  /** Per-request, like `jobs`: a Workers isolate may serve requests for many seconds. */
  stores: (env: unknown) => LabStores
  verifier: Verifier
  /**
   * The queue, for `/lab/drift` alone.
   *
   * Handed down from `AppDeps` rather than built here, because a drift experiment
   * is `days × 2` ordinary `harvest.run` jobs and must go through the same queue,
   * the same idempotency and the same dispatch refusal that `/jobs` uses. A second
   * path into the same work would be a second place for the double-click bug
   * ADR-0016 already closed.
   */
  jobs: (env: unknown) => JobStore
  newId?: () => string
  clock?: () => Date
}

/**
 * The slices of the two harvest ports this file uses, and nothing else.
 *
 * Narrower than the real interfaces on purpose: a read surface that declared it
 * needed `start` and `finish` would be a read surface that could write, and the
 * next person to add a route here would find the tools to do it already in hand.
 */
export interface HarvestRunStoreReader {
  byId(id: string): Promise<HarvestRunRecord | null>
  list(filter?: {
    sourceId?: string
    personaId?: string
    query?: string
    limit?: number
  }): Promise<HarvestRunRecord[]>
}

export interface RawItemStoreReader {
  listByRun(harvestRunId: string, limit?: number): Promise<RawItemRow[]>
}

/**
 * The largest top-k a comparison may ask for.
 *
 * 100 rather than "whatever the client sends" because k is the width of two
 * result lists *and* the length of the arithmetic over them, so it is the one
 * number in this file that a caller could use to spend our CPU. The acceptance
 * criterion in the plan is stated at k = 20; this leaves room to look wider
 * without leaving room to ask for a million.
 */
const MAX_K = 100
const DEFAULT_K = 20

const clampK = (raw: string | undefined): number => {
  if (raw === undefined) return DEFAULT_K
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_K
  return Math.max(1, Math.min(Math.floor(n), MAX_K))
}

/**
 * What a client may say when it creates a persona, and nothing more.
 *
 * Everything the record needs that is not here is set by this handler to the
 * value a new identity actually has: no profile, no sticky address, no seed plan,
 * never yet alive, all counters zero. Accepting them from the body would let a
 * client invent a persona that claims to have run forty sessions, and the health
 * assessment downstream reads those counters as evidence.
 *
 * `tier` defaults to `anon` because an identity with no browsing history behind it
 * is an anonymous one, and calling it `seeded` before anything has seeded it is a
 * claim the row cannot support.
 */
const createPersonaBody = z.object({
  name: z.string().min(1).max(120),
  locality: z.string().min(1).max(120),
  country: countryCode,
  locale,
  /** IANA zone. Not validated against the database here: Workers has no tz table. */
  timezoneId: z.string().min(1).max(60),
  tier: personaTier.default("anon"),
  traits: personaTraits.optional(),
})

/**
 * What the character builder may change. The where-and-how fields only while the
 * identity has never run: a persona with sessions behind it that moved country
 * would make its own history uninterpretable. The name and traits may change any
 * time; they describe what to ask next, not what was asked.
 */
const editPersonaBody = createPersonaBody.omit({ tier: true }).partial()

/**
 * Send a persona out: `persona.explore`, which queues its harvests. The city and
 * interests are the traveller's; sources default to the persona's own.
 */
const exploreBody = z.object({
  city: z.string().trim().min(1).max(80),
  interests: z.array(z.string().trim().min(1).max(60)).max(24).optional(),
  sources: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
})

const personaView = (p: PersonaRecord) => ({
  id: p.id,
  name: p.name,
  locality: p.locality,
  country: p.country,
  locale: p.locale,
  timezoneId: p.timezoneId,
  tier: p.tier,
  health: p.health,
  lastAliveAt: p.lastAliveAt?.toISOString() ?? null,
  stats: p.stats,
  traits: p.traits ?? null,
})

const runView = (r: HarvestRunRecord) => ({
  id: r.id,
  personaId: r.personaId,
  sourceId: r.sourceId,
  query: r.query,
  domainId: r.domainId,
  outcome: r.outcome,
  itemCount: r.itemCount,
  startedAt: r.startedAt.toISOString(),
  endedAt: r.endedAt?.toISOString() ?? null,
})

/**
 * `rank` and `url` are the two fields the comparison is made of, so they lead.
 *
 * `text` is truncated. A split screen shows an excerpt, and a Pantip topic's items
 * run to tens of kilobytes each — twenty of them would be a megabyte of response
 * body to render two columns of prose nobody reads in full. The full text is in
 * the database and the untouched bytes are in the archive; this is a view.
 */
const TEXT_PREVIEW = 400

/**
 * A mention as the Lab renders it.
 *
 * `payload` goes out untouched. The engine stored what the pack validated, and
 * this file has no schema for it and wants none — reaching into it to pull out a
 * `localName` would put travel vocabulary in the one layer that is supposed to
 * carry none, and would break the day a second pack stores a different shape. The
 * client knows which pack it asked about and parses accordingly.
 */
const mentionView = (m: MentionRecord) => ({
  id: m.id,
  rawItemId: m.rawItemId,
  domainId: m.domainId,
  packVersion: m.packVersion,
  payload: m.payload,
  entityId: m.entityId,
  resolution: m.resolution,
  confidence: m.confidence,
  createdAt: m.createdAt.toISOString(),
  item: m.item,
})

const itemView = (item: RawItemRow) => ({
  id: item.id,
  rank: item.rank,
  url: item.url,
  title: item.title,
  text: item.text.length > TEXT_PREVIEW ? `${item.text.slice(0, TEXT_PREVIEW)}…` : item.text,
  truncated: item.text.length > TEXT_PREVIEW,
  languageGuess: item.languageGuess,
  mediaRefs: item.mediaRefs,
  engagement: item.engagement,
  capturedAt: item.capturedAt.toISOString(),
})

export function labRoutes(deps: LabDeps) {
  const lab = new Hono<{ Bindings: Record<string, unknown> }>()
  const newId = deps.newId ?? (() => crypto.randomUUID())

  lab.use("*", requireAuth(deps.verifier))

  lab.get("/personas", async (c) => {
    const country = c.req.query("country")
    const rows = await deps.stores(c.env).personas.list({
      ...(country ? { country } : {}),
      // Deliberately unfiltered by health. A Lab that hides banned identities hides
      // the outcome the Lab exists to make visible.
    })
    return c.json({ personas: rows.map(personaView) })
  })

  lab.post("/personas", async (c) => {
    const parsed = createPersonaBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      // The issue path and message, not the whole zod tree: the tree carries the
      // input back to the client, and a 400 that echoes the body is a 400 that can
      // be used to reflect content through the API.
      const issue = parsed.error.issues[0]
      throw new HTTPException(400, {
        message: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body",
      })
    }

    const row: PersonaRecord = {
      id: newId(),
      ...parsed.data,
      solariProfileId: null,
      proxySession: null,
      health: "healthy",
      seedPlanId: null,
      lastAliveAt: null,
      stats: { sessions: 0, minutes: 0, blocks: 0 },
      traits: parsed.data.traits ?? null,
    }
    await deps.stores(c.env).personas.insert(row)
    return c.json({ persona: personaView(row) }, 201)
  })

  lab.patch("/personas/:id", async (c) => {
    const parsed = editPersonaBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new HTTPException(400, {
        message: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body",
      })
    }
    const store = deps.stores(c.env).personas
    const current = await store.byId(c.req.param("id"))
    if (!current) throw new HTTPException(404, { message: "no such persona" })
    // Only the fields the body named: zod's partial leaves the rest as undefined.
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    ) as PersonaEdit
    const movesIt = Object.keys(patch).some((k) => k !== "traits" && k !== "name")
    if (current.stats.sessions > 0 && movesIt) {
      throw new HTTPException(409, {
        message: "this persona has already browsed; make a new one to change where it is",
      })
    }
    const edited = await store.edit(current.id, patch)
    if (!edited) throw new HTTPException(404, { message: "no such persona" })
    return c.json({ persona: personaView(edited) })
  })

  lab.post("/personas/:id/explore", async (c) => {
    const parsed = exploreBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new HTTPException(400, {
        message: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body",
      })
    }
    const persona = await deps.stores(c.env).personas.byId(c.req.param("id"))
    if (!persona) throw new HTTPException(404, { message: "no such persona" })
    const hour = Math.floor((deps.clock?.() ?? new Date()).getTime() / 3_600_000)
    const queued = await deps.jobs(c.env).enqueue({
      type: "persona.explore",
      domainId: "travel",
      ownerId: c.get("ownerId"),
      payload: { personaId: persona.id, ...parsed.data },
      // One outing an hour per persona and question: a double click is one.
      idempotencyKey: `persona.explore:${persona.id}:${hour}:${JSON.stringify(parsed.data)}`,
    })
    return c.json({ jobId: queued.id, deduped: queued.deduped }, queued.deduped ? 200 : 202)
  })

  lab.get("/harvests", async (c) => {
    const personaId = c.req.query("personaId")
    const sourceId = c.req.query("sourceId")
    const query = c.req.query("query")
    const limit = Number(c.req.query("limit"))
    const runs = await deps.stores(c.env).runs.list({
      ...(personaId ? { personaId } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(query ? { query } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    })
    return c.json({ harvests: runs.map(runView) })
  })

  lab.get("/harvests/:id/items", async (c) => {
    const id = c.req.param("id")
    const stores = deps.stores(c.env)
    const run = await stores.runs.byId(id)
    if (!run) throw new HTTPException(404, { message: "no such harvest run" })
    const items = await stores.items.listByRun(id, clampK(c.req.query("limit")))
    return c.json({ harvest: runView(run), items: items.map(itemView) })
  })

  /**
   * What the extractor claimed, and the post it claimed it from.
   *
   * This is the screen the Phase 2 gate is written against — "quality review of
   * the top 30, and if more than a third are wrong, fix extract before Phase 3" —
   * so the thing it must make easy is *disagreeing* with a row. Hence the item's
   * URL and source on every mention rather than behind a click: a reviewer who has
   * to navigate to check a name will check the first five and trust the rest.
   *
   * Filters are all optional and all narrowing. No date range: the list is newest
   * first and bounded, and a reviewer who needs an older window wants a different
   * screen rather than a longer one.
   */
  lab.get("/mentions", async (c) => {
    const domainId = c.req.query("domainId")
    const packVersion = c.req.query("packVersion")
    const rawItemId = c.req.query("rawItemId")
    // Validated against the enum `@samsara/core` already owns rather than a list
    // written here, so a fourth resolution state cannot be accepted by the
    // database and rejected by the screen that reads it.
    const raw = c.req.query("resolution")
    const parsed = raw === undefined ? undefined : resolutionState.safeParse(raw)
    if (parsed && !parsed.success) {
      throw new HTTPException(400, {
        message: `resolution must be one of ${resolutionState.options.join(", ")}`,
      })
    }
    const resolution = parsed?.data
    const limit = Number(c.req.query("limit"))
    const rows = await deps.stores(c.env).mentions.list({
      ...(domainId ? { domainId } : {}),
      ...(packVersion ? { packVersion } : {}),
      ...(rawItemId ? { rawItemId } : {}),
      ...(resolution ? { resolution } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    })
    return c.json({ mentions: rows.map(mentionView) })
  })

  /**
   * The split screen: the same question, asked by two identities.
   *
   * Four queries — the newest matching run for each side, then that run's items —
   * and the arithmetic is `overlapAt` from `@samsara/harvest`, not a comparison
   * written here. The plan's words are "rough UI is fine; correctness of the
   * comparison is not", and the way to keep that true is for exactly one
   * implementation of the comparison to exist. It is computed server-side for the
   * same reason: two clients agreeing on a number is not the same as there being
   * one number.
   *
   * **The newest run, whatever happened to it.** If the newest run for a persona
   * was blocked or came back empty, that is what the response carries, including
   * an empty item list. Quietly falling back to an older successful run would make
   * the two sides of the screen describe different days, which is a comparison
   * that cannot be wrong because it is not about anything.
   *
   * URLs are the identifiers compared, because that is what the acceptance
   * criterion is written in and because they are the one field two different
   * surfaces can agree on. `overlapAt` drops duplicates, so a source that returns
   * one URL twice cannot inflate a shortfall into agreement.
   */
  lab.get("/compare", async (c) => {
    const a = c.req.query("a")
    const b = c.req.query("b")
    const query = c.req.query("query")
    const sourceId = c.req.query("sourceId")
    if (!a || !b) throw new HTTPException(400, { message: "a and b are required persona ids" })
    if (a === b) {
      // Not an arithmetic problem — `overlapAt(x, x, k)` is a perfectly good 1.0.
      // It is that a screen showing 100% because both columns are the same identity
      // is the most convincing wrong answer this tool could produce.
      throw new HTTPException(400, { message: "a and b must be different personas" })
    }
    if (!query) throw new HTTPException(400, { message: "query is required" })
    const k = clampK(c.req.query("k"))

    const { runs: runStore, items: itemStore } = deps.stores(c.env)
    const filter = { query, limit: 1, ...(sourceId ? { sourceId } : {}) }

    const side = async (personaId: string) => {
      const [run] = await runStore.list({ ...filter, personaId })
      if (!run) return { personaId, harvest: null, items: [] as RawItemRow[] }
      return { personaId, harvest: run, items: await itemStore.listByRun(run.id, k) }
    }

    const [left, right] = await Promise.all([side(a), side(b)])
    const overlap = overlapAt(
      left.items.map((item) => item.url),
      right.items.map((item) => item.url),
      k,
    )

    return c.json({
      query,
      sourceId: sourceId ?? null,
      overlap,
      a: {
        personaId: left.personaId,
        harvest: left.harvest ? runView(left.harvest) : null,
        items: left.items.map(itemView),
      },
      b: {
        personaId: right.personaId,
        harvest: right.harvest ? runView(right.harvest) : null,
        items: right.items.map(itemView),
      },
    })
  })

  // The drift experiment (P1.8): the same comparison above, repeated daily. It
  // gets its own file because it is the only part of the Lab that *writes* — an
  // experiment row and a fortnight of queued jobs — and that difference should be
  // visible in the import list rather than buried in a handler halfway down.
  lab.route(
    "/drift",
    driftRoutes({
      stores: (env) => deps.stores(env),
      jobs: deps.jobs,
      ...(deps.newId ? { newId: deps.newId } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
    }),
  )

  return lab
}
