import type { NewFact, PostgresResearchStore } from "@rd/db"
import {
  type AiDisclosureValue,
  type AiShareValue,
  appSubject,
  type BlockRecord,
  type ComparableValue,
  currentComparables,
  emptyStats,
  type FactKey,
  type Locator,
  parseParams,
  type ReceiptKind,
  type RunOutcome,
  type RunStats,
  type Runtime,
  aiShare,
  sourceOf,
} from "@rd/research"
import {
  appDetailsUrl,
  parseAppDetails,
  parseReviewSummary,
  parseSearch,
  parseStorePage,
  reviewShareFromTooltip,
  reviewSummaryUrl,
  SteamClient,
  searchUrl,
  storePageUrl,
} from "@rd/steam"
import type { JobStore } from "@samsara/kernel"
import type { JobContext, JobHandler } from "../handlers.js"
import type { FilesystemReceiptArchive } from "./archive.js"
import { captureStorePage, type PageLike } from "./capture.js"

/**
 * `block.run`: answer one block's question, keeping a receipt for everything it
 * read and a fact for every value it will let the document cite.
 *
 * A run that cannot finish is still written down. It ends `failed` or `partial`
 * with a note, and the job itself succeeds: retrying a block whose source has
 * never run would only fail the same way, and a partial snapshot of 11 games out
 * of 12 is worth more than no snapshot. Transient trouble on one game is recorded
 * on that game (an `unavailable` fact with its own receipt) and the run carries on.
 *
 * With `cascade`, a finished run queues every block that reads from it. The page
 * asks for that explicitly, after showing what the chain will cost.
 */

type Store = Pick<
  PostgresResearchStore,
  | "block"
  | "blocksForDoc"
  | "startRun"
  | "finishRun"
  | "setStatus"
  | "putReceipt"
  | "putFacts"
  | "factsForRuns"
>

export interface BlockRunDeps {
  store: Store
  archive: Pick<FilesystemReceiptArchive, "put">
  /** A fresh client per run, so its request count is this run's. */
  steam: () => SteamClient
  /** Whether the kernel can open a browser. Without one, store pages are read over HTTP. */
  browser: boolean
  queue?: Pick<JobStore, "enqueue">
  /** Store pages in flight at once. Three is the free plan's browser limit. */
  concurrency?: number
}

export const BLOCK_RUN = "block.run" as const

interface Payload {
  blockId?: unknown
  cascade?: unknown
}

class Recorder {
  readonly stats: RunStats = emptyStats()
  readonly runtimes = new Set<Runtime>()
  private pending: NewFact[] = []

  constructor(
    readonly runId: string,
    readonly block: BlockRecord,
    private readonly deps: BlockRunDeps,
  ) {}

  async receipt(input: {
    kind: ReceiptKind
    runtime: Runtime
    url: string
    body: Uint8Array
    contentType: string
    viewpoint?: string | null
    sessionId?: string | null
    pairedWith?: string | null
    at?: Date
  }) {
    const archived = await this.deps.archive.put(input.kind, input.body)
    this.runtimes.add(input.runtime)
    this.stats.receipts++
    return this.deps.store.putReceipt({
      runId: this.runId,
      kind: input.kind,
      runtime: input.runtime,
      url: input.url,
      contentType: input.contentType,
      viewpoint: input.viewpoint ?? null,
      sessionId: input.sessionId ?? null,
      pairedWith: input.pairedWith ?? null,
      capturedAt: input.at ?? new Date(),
      ...archived,
    })
  }

  /** A computation's receipt: its inputs and output as JSON, hashed like any other. */
  computation(name: string, body: unknown) {
    return this.receipt({
      kind: "computation",
      runtime: "derived",
      url: `computation:${name}`,
      body: new TextEncoder().encode(JSON.stringify(body, null, 2)),
      contentType: "application/json",
    })
  }

  fact(receiptId: string, subject: string, key: FactKey, value: unknown, locator: Locator) {
    this.pending.push({ blockId: this.block.id, runId: this.runId, receiptId, subject, key, value, locator })
  }

  async flush() {
    const batch = this.pending
    this.pending = []
    this.stats.facts += (await this.deps.store.putFacts(batch)).length
  }
}

type Outcome = { outcome: Exclude<RunOutcome, "running">; note: string | null }

export function createBlockRunHandler(deps: BlockRunDeps): JobHandler {
  return async (ctx) => {
    const payload = (ctx.job.payload ?? {}) as Payload
    if (typeof payload.blockId !== "string") throw new Error("block.run: payload.blockId is required")
    const block = await deps.store.block(payload.blockId)
    if (!block) {
      // Deleted between the click and the claim. Nothing to answer.
      await ctx.heartbeat("block no longer exists")
      return
    }

    const run = await deps.store.startRun(block.id, ctx.job.id, block.params, emptyStats())
    await deps.store.setStatus(block.id, "running")
    const rec = new Recorder(run.id, block, deps)
    const steam = deps.steam()

    let result: Outcome
    try {
      result = await answer(block, rec, steam, deps, ctx)
    } catch (e) {
      result = { outcome: "failed", note: e instanceof Error ? e.message : String(e) }
    }
    await rec.flush().catch(() => {})
    rec.stats.requests += steam.requests
    await deps.store.finishRun(run.id, result.outcome, [...rec.runtimes], rec.stats, result.note)
    await deps.store.setStatus(block.id, result.outcome === "failed" ? "failed" : "done", run.id)
    await ctx.heartbeat(
      `${result.outcome}: ${rec.stats.facts} facts from ${rec.stats.receipts} receipts${result.note ? ` — ${result.note}` : ""}`,
    )

    if (payload.cascade === true && result.outcome !== "failed" && deps.queue) {
      const downstream = (await deps.store.blocksForDoc(block.docId)).filter(
        (b) => sourceOf(b.kind, b.params) === block.id,
      )
      for (const b of downstream) {
        await deps.store.setStatus(b.id, "queued")
        await deps.queue.enqueue({
          type: BLOCK_RUN,
          ownerId: ctx.job.ownerId,
          payload: { blockId: b.id, cascade: true },
          idempotencyKey: `${BLOCK_RUN}:${b.id}:after:${run.id}`,
        })
      }
    }
  }
}

async function answer(
  block: BlockRecord,
  rec: Recorder,
  steam: SteamClient,
  deps: BlockRunDeps,
  ctx: JobContext,
): Promise<Outcome> {
  switch (block.kind) {
    case "comparables":
      return comparables(block, rec, steam)
    case "store_snapshot":
      return snapshot(block, rec, steam, deps, ctx)
    case "slop_share":
      return slopShare(block, rec, deps)
  }
}

// ---- comparables ----------------------------------------------------------------

async function comparables(block: BlockRecord, rec: Recorder, steam: SteamClient): Promise<Outcome> {
  const p = parseParams("comparables", block.params)
  if (!p.ok) return { outcome: "failed", note: p.error }
  const url = searchUrl({ tagIds: p.value.tagIds, sort: p.value.sort, count: 25 })
  const { fetched, json } = await steam.json(url)
  const receipt = await rec.receipt({
    kind: "json",
    runtime: "api",
    url,
    body: fetched.body,
    contentType: fetched.contentType,
    viewpoint: "us",
    at: fetched.fetchedAt,
  })
  const page = parseSearch(json)
  if (!page) return { outcome: "failed", note: "Steam's search did not answer with a result list" }

  rec.fact(receipt.id, "set", "matches", page.total, { path: "$.total_count" })
  for (const row of page.rows) {
    const share = row.reviewTooltip ? reviewShareFromTooltip(row.reviewTooltip) : null
    const value: ComparableValue = {
      appid: row.appid,
      name: row.name,
      released: row.released,
      priceCents: row.priceFinal,
      reviewPct: share?.pct ?? null,
      reviewCount: share?.count ?? null,
    }
    rec.fact(receipt.id, appSubject(row.appid), "comparable", value, { ...row.at, path: "$.results_html" })
  }
  rec.stats.planned = 25
  rec.stats.covered = page.rows.length
  return {
    outcome: page.rows.length > 0 ? "ok" : "failed",
    note: page.rows.length > 0 ? null : "No games carry all of these tags",
  }
}

// ---- store snapshot ---------------------------------------------------------------

async function sourceFacts(deps: BlockRunDeps, sourceId: string, kind: BlockRecord["kind"]) {
  const src = await deps.store.block(sourceId)
  if (!src || src.kind !== kind) return { error: `Its source block is missing or is not a ${kind} block` } as const
  if (!src.lastRunId) return { error: "Its source block has not run yet" } as const
  return { src, facts: await deps.store.factsForRuns([src.lastRunId]) } as const
}

async function snapshot(
  block: BlockRecord,
  rec: Recorder,
  steam: SteamClient,
  deps: BlockRunDeps,
  ctx: JobContext,
): Promise<Outcome> {
  const p = parseParams("store_snapshot", block.params)
  if (!p.ok) return { outcome: "failed", note: p.error }
  const source = await sourceFacts(deps, p.value.source, "comparables")
  if ("error" in source) return { outcome: "failed", note: source.error }
  const srcParams = parseParams("comparables", source.src.params)
  if (!srcParams.ok) return { outcome: "failed", note: srcParams.error }
  const games = currentComparables(source.facts, srcParams.value).map((f) => f.value as ComparableValue)
  rec.stats.planned = games.length
  if (games.length === 0) return { outcome: "failed", note: "The comparables list is empty" }

  const notes = new Set<string>()
  let done = 0
  const one = async (g: ComparableValue) => {
    const subject = appSubject(g.appid)
    try {
      await readApi(g, subject, rec, steam)
      const page = await readStorePage(g, subject, rec, steam, deps, ctx, notes)
      if (page) rec.stats.covered++
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const r = await rec.computation(`unavailable:${g.appid}`, { appid: g.appid, url: storePageUrl(g.appid), error: message })
      rec.fact(r.id, subject, "unavailable", { reason: message }, { path: "$.error" })
      notes.add(message.slice(0, 120))
    }
    await rec.flush()
    await ctx.heartbeat(`${++done}/${games.length} ${g.name}`)
  }

  const queue = [...games]
  const workers = Array.from({ length: Math.min(deps.concurrency ?? 3, queue.length) }, async () => {
    while (queue.length > 0) {
      if (ctx.signal.aborted) return
      const g = queue.shift()
      if (g) await one(g)
    }
  })
  await Promise.all(workers)

  const { covered, planned } = rec.stats
  return {
    outcome: covered === planned ? "ok" : covered > 0 ? "partial" : "failed",
    note: notes.size > 0 ? [...notes].join("; ") : null,
  }
}

async function readApi(g: ComparableValue, subject: string, rec: Recorder, steam: SteamClient) {
  const detailsUrl = appDetailsUrl(g.appid)
  const d = await steam.json(detailsUrl)
  const dr = await rec.receipt({
    kind: "json",
    runtime: "api",
    url: detailsUrl,
    body: d.fetched.body,
    contentType: d.fetched.contentType,
    viewpoint: "us",
    at: d.fetched.fetchedAt,
  })
  const details = parseAppDetails(d.json, g.appid)
  if (details) {
    rec.fact(dr.id, subject, "name", details.name.value, details.name.at)
    rec.fact(dr.id, subject, "developers", details.developers.value, details.developers.at)
    rec.fact(dr.id, subject, "price", details.price?.value ?? null, details.price?.at ?? { path: `$.${g.appid}.data.is_free` })
    rec.fact(dr.id, subject, "release", details.releaseDate.value, details.releaseDate.at)
  } else {
    rec.fact(dr.id, subject, "name", g.name, { path: `$.${g.appid}.success` })
  }

  const reviewsUrl = reviewSummaryUrl(g.appid)
  const r = await steam.json(reviewsUrl)
  const rr = await rec.receipt({
    kind: "json",
    runtime: "api",
    url: reviewsUrl,
    body: r.fetched.body,
    contentType: r.fetched.contentType,
    at: r.fetched.fetchedAt,
  })
  const reviews = parseReviewSummary(r.json)
  if (reviews) {
    rec.fact(
      rr.id,
      subject,
      "reviews",
      { total: reviews.total.value, positive: reviews.positive, negative: reviews.negative, label: reviews.label.value },
      reviews.total.at,
    )
  }
}

/**
 * The store page, from a cloud browser when there is one (HTML plus a screenshot
 * with the cited sections boxed), and over plain HTTP when there is not or the
 * browser fails. The receipt says which, so a reader can tell.
 */
async function readStorePage(
  g: ComparableValue,
  subject: string,
  rec: Recorder,
  steam: SteamClient,
  deps: BlockRunDeps,
  ctx: JobContext,
  notes: Set<string>,
): Promise<boolean> {
  const url = storePageUrl(g.appid)

  if (deps.browser) {
    let sessionId: string | null = null
    const captured = await ctx.kernel.withBrowser(
      "probe",
      {
        country: "direct",
        direct: true,
        attempts: 1,
        deadlineMs: 90_000,
        ownerId: ctx.job.ownerId,
        domainId: "steam",
        runId: rec.runId,
        onSession: (s) => {
          sessionId = s.sessionId
          rec.stats.browserSessions++
          rec.stats.browserMinutes += s.minutes
        },
      },
      (page) => captureStorePage(page as PageLike, url),
    )
    if (captured.ok) {
      const at = new Date()
      const html = await rec.receipt({
        kind: "html",
        runtime: "browser",
        url,
        body: new TextEncoder().encode(captured.value.html),
        contentType: "text/html",
        viewpoint: "us",
        sessionId,
        at,
      })
      const shot = await rec.receipt({
        kind: "screenshot",
        runtime: "browser",
        url,
        body: captured.value.screenshot,
        contentType: "image/jpeg",
        viewpoint: "us",
        sessionId,
        pairedWith: html.id,
        at,
      })
      return pageFacts(captured.value.html, subject, shot.id, rec, captured.value.boxes)
    }
    notes.add(`browser: ${captured.error.kind}, read over HTTP instead`)
  }

  const fetched = await steam.get(url)
  const html = await rec.receipt({
    kind: "html",
    runtime: "api",
    url,
    body: fetched.body,
    contentType: fetched.contentType,
    viewpoint: "us",
    at: fetched.fetchedAt,
  })
  return pageFacts(new TextDecoder().decode(fetched.body), subject, html.id, rec, null)
}

function pageFacts(
  html: string,
  subject: string,
  receiptId: string,
  rec: Recorder,
  boxes: { ai: Locator["box"] | null; tags: Locator["box"] | null } | null,
): boolean {
  const page = parseStorePage(html)
  if (page.gated) {
    rec.fact(receiptId, subject, "unavailable", { reason: "age gate" }, { selector: "#app_agegate" })
    return false
  }
  const value: AiDisclosureValue = page.ai.disclosed ? { disclosed: true, text: page.ai.text } : { disclosed: false }
  rec.fact(receiptId, subject, "ai.disclosure", value, {
    ...page.ai.at,
    ...(page.ai.disclosed && boxes?.ai ? { box: boxes.ai } : {}),
  })
  if (page.tags.value.length > 0) {
    rec.fact(receiptId, subject, "tags", page.tags.value, { ...page.tags.at, ...(boxes?.tags ? { box: boxes.tags } : {}) })
  }
  return true
}

// ---- slop share --------------------------------------------------------------------

async function slopShare(block: BlockRecord, rec: Recorder, deps: BlockRunDeps): Promise<Outcome> {
  const p = parseParams("slop_share", block.params)
  if (!p.ok) return { outcome: "failed", note: p.error }
  const source = await sourceFacts(deps, p.value.source, "store_snapshot")
  if ("error" in source) return { outcome: "failed", note: source.error }

  const { value, from } = aiShare(source.facts)
  const inputs = source.facts
    .filter((f) => f.key === "ai.disclosure")
    .map((f) => ({ factId: f.id, subject: f.subject, disclosed: (f.value as AiDisclosureValue).disclosed }))
  const receipt = await rec.computation("ai-share", {
    formula: "disclosed / pages read",
    rule:
      "A game counts as disclosed when its Steam store page has an 'AI Generated Content Disclosure' section. " +
      "Pages that could not be read are left out of the denominator and listed as unread.",
    sourceRun: source.src.lastRunId,
    inputs,
    output: value satisfies AiShareValue,
  })
  rec.fact(receipt.id, "set", "ai.share", value, { path: "$.output", from })
  rec.stats.planned = inputs.length + value.unread
  rec.stats.covered = inputs.length
  return {
    outcome: value.total > 0 ? "ok" : "failed",
    note: value.total > 0 ? null : "The snapshot read no store pages",
  }
}
