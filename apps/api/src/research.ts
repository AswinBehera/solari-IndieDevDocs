import type { PostgresResearchStore } from "@rd/db"
import {
  BLOCK_KINDS,
  type BlockRecord,
  type ComparablesParams,
  currentComparables,
  type EvidenceMove,
  estimateCost,
  evidenceMoves,
  type FactRecord,
  isStale,
  paramsChanged,
  parseParams,
  type RunRecord,
  sourceOf,
} from "@rd/research"
import type { JobStore } from "@samsara/kernel/jobs"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { requireAuth, type Verifier } from "./auth.js"
import type { Dispatcher } from "./dispatch.js"

/**
 * Research documents: the doc, its blocks, and the facts and receipts behind them.
 *
 * Validate, enqueue, read (the 10 ms rule in `app.ts`). A block never runs here: a
 * run is a `block.run` job, and the page watches it through `/jobs/:id/events`.
 * Everything is scoped to the signed-in owner, and something that is not theirs is
 * a 404 rather than a 403, which would confirm it exists.
 */

type Store = Pick<
  PostgresResearchStore,
  | "listDocs"
  | "createDoc"
  | "getDoc"
  | "saveDoc"
  | "deleteDoc"
  | "createBlock"
  | "ownedBlock"
  | "block"
  | "blocksForDoc"
  | "setParams"
  | "setStatus"
  | "runsByIds"
  | "factsForRuns"
  | "ownedFacts"
  | "ownedReceipt"
  | "pageGroup"
>

export interface ResearchDeps {
  /** Per-request, for the Hyperdrive reason `index.ts` gives. */
  store: (env: unknown) => Store
  jobs: (env: unknown) => JobStore
  verifier: Verifier
  dispatcher: Dispatcher
}

export const MAX_DOCUMENT_BYTES = 512 * 1024

async function boundedJson(req: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<unknown> {
  const raw = await req.arrayBuffer()
  if (raw.byteLength > MAX_DOCUMENT_BYTES)
    throw new HTTPException(413, { message: "body is too large" })
  try {
    return JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return null
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body)
  if (!r.success) {
    throw new HTTPException(400, {
      message: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    })
  }
  return r.data
}

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] }

const createDoc = z.object({
  title: z.string().trim().min(1).max(200).default("Untitled research"),
  content: z.unknown().optional(),
})
const saveDoc = z.object({
  version: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.unknown().optional(),
})
const createBlock = z.object({
  kind: z.enum(BLOCK_KINDS as [string, ...string[]]),
  params: z.unknown(),
})
const runBlock = z.object({ cascade: z.boolean().default(false) })

/** What the page needs to draw a block: its answer, whether that answer is behind, and the price of a new one. */
export interface BlockView extends BlockRecord {
  run: RunRecord | null
  facts: FactRecord[]
  stale: boolean
  /** Items a run would cover, for the cost line. */
  items: number
  estimate: ReturnType<typeof estimateCost>
  /** A decision's cited facts, whichever run they came from. Empty for other kinds. */
  evidence: FactRecord[]
  /** Cited facts whose block has since read a different value. */
  moves: EvidenceMove[]
}

async function blockViews(
  store: Store,
  ownerId: string,
  blocks: BlockRecord[],
): Promise<BlockView[]> {
  const runIds = blocks.flatMap((b) => (b.lastRunId ? [b.lastRunId] : []))
  const cited = blocks.flatMap((b) => {
    if (b.kind !== "decision") return []
    const p = parseParams("decision", b.params)
    return p.ok ? p.value.evidence : []
  })
  const [runs, facts, citedFacts] = await Promise.all([
    store.runsByIds(runIds),
    store.factsForRuns(runIds),
    store.ownedFacts(ownerId, cited),
  ])
  const runById = new Map(runs.map((r) => [r.id, r]))
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const factsByRun = new Map<string, FactRecord[]>()
  for (const f of facts) factsByRun.set(f.runId, [...(factsByRun.get(f.runId) ?? []), f])

  /** The games a snapshot or a reviews block would read now, from its source's last run and current pruning. */
  const wantedBy = (b: BlockRecord): string[] | null => {
    if (b.kind !== "store_snapshot" && b.kind !== "review_signals") return null
    const src = byId.get(sourceOf(b.kind, b.params) ?? "")
    if (!src?.lastRunId) return []
    const p = parseParams("comparables", src.params)
    if (!p.ok) return []
    return currentComparables(
      factsByRun.get(src.lastRunId) ?? [],
      p.value as ComparablesParams,
    ).map((f) => f.subject)
  }

  const citedById = new Map(citedFacts.filter((f) => byId.has(f.blockId)).map((f) => [f.id, f]))
  const evidenceOf = (b: BlockRecord): FactRecord[] => {
    if (b.kind !== "decision") return []
    const p = parseParams("decision", b.params)
    return p.ok ? p.value.evidence.flatMap((id) => citedById.get(id) ?? []) : []
  }

  /** What a run would cover, for the cost line: games for a snapshot, searches for a niche map. */
  const itemsOf = (b: BlockRecord, wanted: string[] | null): number => {
    if (b.kind === "comparables") return 1
    if (b.kind === "niche_map") {
      const p = parseParams("niche_map", b.params)
      const src = byId.get(sourceOf(b.kind, b.params) ?? "")
      const tags = src ? parseParams("comparables", src.params) : null
      const base = tags?.ok ? tags.value.tagIds.length : 0
      return 1 + (p.ok ? p.value.neighbours : 6) + (base >= 2 ? base : 0)
    }
    if (b.kind === "decision") return evidenceOf(b).length
    return wanted?.length ?? 0
  }

  return blocks.map((b) => {
    const run = b.lastRunId ? (runById.get(b.lastRunId) ?? null) : null
    const facts = b.lastRunId ? (factsByRun.get(b.lastRunId) ?? []) : []
    const src = byId.get(sourceOf(b.kind, b.params) ?? "")
    const srcRun = src?.lastRunId ? (runById.get(src.lastRunId) ?? null) : null
    const wanted = wantedBy(b)
    // A snapshot is also behind when the list was pruned after it ran: same
    // source run, different games.
    const read = new Set(facts.flatMap((f) => (f.subject === "set" ? [] : [f.subject])))
    const pruned =
      wanted !== null &&
      run !== null &&
      (wanted.length !== read.size || wanted.some((s) => !read.has(s)))
    const evidence = evidenceOf(b)
    const lastRunOf = (id: string) => byId.get(id)?.lastRunId ?? null
    const latest = evidence.flatMap((f) => factsByRun.get(lastRunOf(f.blockId) ?? "") ?? [])
    const moves = evidenceMoves(evidence, lastRunOf, latest)
    const items = itemsOf(b, wanted)
    return {
      ...b,
      run,
      facts,
      stale:
        isStale(b, run, srcRun) ||
        pruned ||
        (run !== null && (moves.length > 0 || paramsChanged(b.kind, run.params, b.params))),
      items,
      estimate: estimateCost(b.kind, items),
      evidence,
      moves,
    }
  })
}

export function researchRoutes(deps: ResearchDeps) {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: { ownerId: string } }>()
  app.use("*", requireAuth(deps.verifier))

  // ---- documents ---------------------------------------------------------------

  app.get("/docs", async (c) =>
    c.json({ docs: await deps.store(c.env).listDocs(c.get("ownerId")) }),
  )

  app.post("/docs", async (c) => {
    const body = parse(createDoc, await boundedJson(c.req.raw))
    const doc = await deps
      .store(c.env)
      .createDoc(c.get("ownerId"), body.title, body.content ?? EMPTY_DOC)
    return c.json({ doc }, 201)
  })

  app.get("/docs/:id", async (c) => {
    const store = deps.store(c.env)
    const doc = await store.getDoc(c.get("ownerId"), c.req.param("id"))
    if (!doc) throw new HTTPException(404, { message: "no such document" })
    return c.json({
      doc,
      blocks: await blockViews(store, c.get("ownerId"), await store.blocksForDoc(doc.id)),
    })
  })

  app.put("/docs/:id", async (c) => {
    const body = parse(saveDoc, await boundedJson(c.req.raw))
    const result = await deps
      .store(c.env)
      .saveDoc(
        c.get("ownerId"),
        c.req.param("id"),
        { content: body.content, ...(body.title !== undefined ? { title: body.title } : {}) },
        body.version,
      )
    if (!result) throw new HTTPException(404, { message: "no such document" })
    return result.saved
      ? c.json({ version: result.version })
      : c.json({ error: "changed elsewhere", version: result.version }, 409)
  })

  app.delete("/docs/:id", async (c) => {
    const ok = await deps.store(c.env).deleteDoc(c.get("ownerId"), c.req.param("id"))
    if (!ok) throw new HTTPException(404, { message: "no such document" })
    return c.body(null, 204)
  })

  // ---- blocks --------------------------------------------------------------------

  app.post("/docs/:id/blocks", async (c) => {
    const body = parse(createBlock, await boundedJson(c.req.raw))
    const kind = body.kind as BlockRecord["kind"]
    const params = parseParams(kind, body.params ?? {})
    if (!params.ok) throw new HTTPException(400, { message: params.error })
    const store = deps.store(c.env)
    const docId = c.req.param("id")
    const src = sourceOf(kind, params.value)
    if (src) {
      const s = await store.ownedBlock(c.get("ownerId"), src)
      if (!s || s.docId !== docId)
        throw new HTTPException(400, { message: "source block is not in this document" })
    }
    const block = await store.createBlock(c.get("ownerId"), docId, kind, params.value)
    if (!block) throw new HTTPException(404, { message: "no such document" })
    const view = (await blockViews(store, c.get("ownerId"), await store.blocksForDoc(docId))).find(
      (b) => b.id === block.id,
    )
    return c.json({ block: view }, 201)
  })

  app.get("/blocks/:id", async (c) => {
    const store = deps.store(c.env)
    const block = await store.ownedBlock(c.get("ownerId"), c.req.param("id"))
    if (!block) throw new HTTPException(404, { message: "no such block" })
    const siblings = await store.blocksForDoc(block.docId)
    const view = (await blockViews(store, c.get("ownerId"), siblings)).find(
      (b) => b.id === block.id,
    )
    return c.json({ block: view })
  })

  /** New parameters. The last run's facts stay, and the page marks them as answering the old question. */
  app.patch("/blocks/:id", async (c) => {
    const store = deps.store(c.env)
    const block = await store.ownedBlock(c.get("ownerId"), c.req.param("id"))
    if (!block) throw new HTTPException(404, { message: "no such block" })
    const body = (await boundedJson(c.req.raw)) as { params?: unknown } | null
    const params = parseParams(block.kind, {
      ...(block.params as object),
      ...((body?.params as object) ?? {}),
    })
    if (!params.ok) throw new HTTPException(400, { message: params.error })
    await store.setParams(block.id, params.value)
    const view = (
      await blockViews(store, c.get("ownerId"), await store.blocksForDoc(block.docId))
    ).find((b) => b.id === block.id)
    return c.json({ block: view })
  })

  /**
   * Queue a run. Deduped per block while one is queued or running, so a double
   * click spends one run. The key rotates with the block's last run, which is what
   * lets the next click through once this one has finished.
   */
  app.post("/blocks/:id/run", async (c) => {
    const store = deps.store(c.env)
    const block = await store.ownedBlock(c.get("ownerId"), c.req.param("id"))
    if (!block) throw new HTTPException(404, { message: "no such block" })
    const body = parse(runBlock, (await boundedJson(c.req.raw)) ?? {})
    const result = await deps.jobs(c.env).enqueue({
      type: "block.run",
      ownerId: c.get("ownerId"),
      payload: { blockId: block.id, cascade: body.cascade },
      idempotencyKey: `block.run:${block.id}:after:${block.lastRunId ?? "none"}`,
    })
    if (!result.deduped) await store.setStatus(block.id, "queued")
    const dispatched = result.deduped ? false : await deps.dispatcher.dispatch(result.id)
    return c.json(
      { jobId: result.id, deduped: result.deduped, dispatched },
      result.deduped ? 200 : 202,
    )
  })

  // ---- facts and receipts ------------------------------------------------------------

  /** What fact chips resolve through. A chip whose fact is gone shows as broken, not as blank. */
  app.get("/facts", async (c) => {
    const ids = (c.req.query("ids") ?? "")
      .split(",")
      .filter((s) => /^[0-9a-f-]{36}$/.test(s))
      .slice(0, 200)
    return c.json({ facts: await deps.store(c.env).ownedFacts(c.get("ownerId"), ids) })
  })

  app.get("/receipts/:id", async (c) => {
    const store = deps.store(c.env)
    const receipt = await store.ownedReceipt(c.get("ownerId"), c.req.param("id"))
    if (!receipt) throw new HTTPException(404, { message: "no such receipt" })
    // A screenshot and a replay name their HTML. The group is what that page load
    // produced, so the drawer can show each beside the others.
    const group =
      receipt.kind === "html" || receipt.pairedWith
        ? await store.pageGroup(receipt.pairedWith ?? receipt.id)
        : [receipt]
    return c.json({ receipt, group: group.length > 0 ? group : [receipt] })
  })

  return app
}
