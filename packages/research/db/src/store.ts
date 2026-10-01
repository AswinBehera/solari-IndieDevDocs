import type {
  BlockKind,
  BlockRecord,
  BlockStatus,
  DocRecord,
  FactKey,
  FactRecord,
  Locator,
  ReceiptKind,
  ReceiptRecord,
  RunOutcome,
  RunRecord,
  RunStats,
  Runtime,
} from "@rd/research"
import { and, desc, eq, inArray, or, sql } from "drizzle-orm"
import type { Db } from "./client.js"
import { blocks, docs, facts, receipts, runs } from "./tables.js"

/**
 * Every read and write the API and the worker make against the research tables.
 *
 * Ownership is checked here, through the document, and nowhere else: a block, a
 * run, a receipt and a fact belong to whoever owns the document the block is in.
 * The API passes the verified owner; the worker, which acts for whoever queued
 * the job, uses the unchecked reads.
 */

export interface NewReceipt {
  runId: string
  kind: ReceiptKind
  runtime: Runtime
  url: string
  sha256: string
  bytes: number
  contentType: string
  ref: string
  viewpoint: string | null
  profile?: string | null
  sessionId?: string | null
  pairedWith?: string | null
  capturedAt: Date
}

export interface NewFact {
  blockId: string
  runId: string
  receiptId: string
  subject: string
  key: FactKey
  value: unknown
  locator: Locator
}

export type DocSummary = Pick<DocRecord, "id" | "title" | "updatedAt"> & { blocks: number }

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

type DocRow = typeof docs.$inferSelect
type BlockRow = typeof blocks.$inferSelect
type RunRow = typeof runs.$inferSelect
type ReceiptRow = typeof receipts.$inferSelect
type FactRow = typeof facts.$inferSelect

const toDoc = (r: DocRow): DocRecord => ({
  id: r.id,
  title: r.title,
  content: r.content,
  version: r.version,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
})
const toBlock = (r: BlockRow): BlockRecord => ({
  id: r.id,
  docId: r.docId,
  kind: r.kind as BlockKind,
  params: r.params,
  status: r.status as BlockStatus,
  lastRunId: r.lastRunId,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
})
const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  blockId: r.blockId,
  jobId: r.jobId,
  outcome: r.outcome as RunOutcome,
  params: r.params,
  runtimes: r.runtimes as Runtime[],
  stats: r.stats as RunStats,
  note: r.note,
  startedAt: r.startedAt.toISOString(),
  endedAt: iso(r.endedAt),
})
const toReceipt = (r: ReceiptRow): ReceiptRecord => ({
  id: r.id,
  runId: r.runId,
  kind: r.kind as ReceiptKind,
  runtime: r.runtime as Runtime,
  url: r.url,
  sha256: r.sha256,
  bytes: r.bytes,
  contentType: r.contentType,
  ref: r.ref,
  viewpoint: r.viewpoint,
  profile: r.profile,
  sessionId: r.sessionId,
  capturedAt: r.capturedAt.toISOString(),
})
const toFact = (r: FactRow): FactRecord => ({
  id: r.id,
  blockId: r.blockId,
  runId: r.runId,
  receiptId: r.receiptId,
  subject: r.subject,
  key: r.key as FactKey,
  value: r.value,
  locator: r.locator as Locator,
  createdAt: r.createdAt.toISOString(),
})

export class PostgresResearchStore {
  constructor(private readonly db: Db) {}

  // ---- documents --------------------------------------------------------------

  async listDocs(ownerId: string): Promise<DocSummary[]> {
    const rows = await this.db
      .select({
        id: docs.id,
        title: docs.title,
        updatedAt: docs.updatedAt,
        // Qualified by hand: drizzle prints bare column names inside `sql`, and a
        // bare "id" here binds to the subquery's own table.
        blocks: sql<number>`(select count(*)::int from blocks b where b.doc_id = "docs"."id")`,
      })
      .from(docs)
      .where(eq(docs.ownerId, ownerId))
      .orderBy(desc(docs.updatedAt))
      .limit(100)
    return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }))
  }

  async createDoc(ownerId: string, title: string, content: unknown): Promise<DocRecord> {
    const [row] = await this.db.insert(docs).values({ ownerId, title, content }).returning()
    return toDoc(row as DocRow)
  }

  async getDoc(ownerId: string, id: string): Promise<DocRecord | null> {
    const [row] = await this.db
      .select()
      .from(docs)
      .where(and(eq(docs.id, id), eq(docs.ownerId, ownerId)))
    return row ? toDoc(row) : null
  }

  /** Saved only against the version it was made from; otherwise the current version. */
  async saveDoc(
    ownerId: string,
    id: string,
    patch: { content?: unknown; title?: string },
    version: number,
  ): Promise<{ saved: true; version: number } | { saved: false; version: number } | null> {
    const [row] = await this.db
      .update(docs)
      .set({
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        version: sql`${docs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(docs.id, id), eq(docs.ownerId, ownerId), eq(docs.version, version)))
      .returning({ version: docs.version })
    if (row) return { saved: true, version: row.version }
    const current = await this.getDoc(ownerId, id)
    return current ? { saved: false, version: current.version } : null
  }

  async deleteDoc(ownerId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(docs)
      .where(and(eq(docs.id, id), eq(docs.ownerId, ownerId)))
      .returning({ id: docs.id })
    return rows.length > 0
  }

  // ---- blocks -----------------------------------------------------------------

  async createBlock(
    ownerId: string,
    docId: string,
    kind: BlockKind,
    params: unknown,
  ): Promise<BlockRecord | null> {
    if (!(await this.getDoc(ownerId, docId))) return null
    const [row] = await this.db.insert(blocks).values({ docId, kind, params }).returning()
    return toBlock(row as BlockRow)
  }

  /** The block, if the owner owns its document. */
  async ownedBlock(ownerId: string, id: string): Promise<BlockRecord | null> {
    const [row] = await this.db
      .select({ block: blocks })
      .from(blocks)
      .innerJoin(docs, eq(docs.id, blocks.docId))
      .where(and(eq(blocks.id, id), eq(docs.ownerId, ownerId)))
    return row ? toBlock(row.block) : null
  }

  /** Unchecked: the worker's read, for a job the API already authorised. */
  async block(id: string): Promise<BlockRecord | null> {
    const [row] = await this.db.select().from(blocks).where(eq(blocks.id, id))
    return row ? toBlock(row) : null
  }

  async blocksForDoc(docId: string): Promise<BlockRecord[]> {
    const rows = await this.db.select().from(blocks).where(eq(blocks.docId, docId))
    return rows.map(toBlock)
  }

  async setParams(id: string, params: unknown): Promise<void> {
    await this.db.update(blocks).set({ params, updatedAt: new Date() }).where(eq(blocks.id, id))
  }

  async setStatus(id: string, status: BlockStatus, lastRunId?: string): Promise<void> {
    await this.db
      .update(blocks)
      .set({ status, updatedAt: new Date(), ...(lastRunId ? { lastRunId } : {}) })
      .where(eq(blocks.id, id))
  }

  // ---- runs -------------------------------------------------------------------

  async startRun(
    blockId: string,
    jobId: string | null,
    params: unknown,
    stats: RunStats,
  ): Promise<RunRecord> {
    const [row] = await this.db.insert(runs).values({ blockId, jobId, params, stats }).returning()
    return toRun(row as RunRow)
  }

  async finishRun(
    id: string,
    outcome: Exclude<RunOutcome, "running">,
    runtimes: Runtime[],
    stats: RunStats,
    note: string | null,
  ): Promise<void> {
    await this.db
      .update(runs)
      .set({ outcome, runtimes, stats, note, endedAt: new Date() })
      .where(eq(runs.id, id))
  }

  async runsByIds(ids: string[]): Promise<RunRecord[]> {
    if (ids.length === 0) return []
    return (await this.db.select().from(runs).where(inArray(runs.id, ids))).map(toRun)
  }

  async runsForBlock(blockId: string, limit = 10): Promise<RunRecord[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.blockId, blockId))
      .orderBy(desc(runs.startedAt))
      .limit(limit)
    return rows.map(toRun)
  }

  // ---- receipts and facts -----------------------------------------------------

  async putReceipt(r: NewReceipt): Promise<ReceiptRecord> {
    const [row] = await this.db
      .insert(receipts)
      .values({
        ...r,
        profile: r.profile ?? null,
        sessionId: r.sessionId ?? null,
        pairedWith: r.pairedWith ?? null,
      })
      .onConflictDoUpdate({
        // The same bytes from the same URL in the same run: one receipt, not two.
        target: [receipts.runId, receipts.sha256, receipts.url],
        set: { capturedAt: r.capturedAt },
      })
      .returning()
    return toReceipt(row as ReceiptRow)
  }

  async putFacts(input: NewFact[]): Promise<FactRecord[]> {
    if (input.length === 0) return []
    const rows = await this.db.insert(facts).values(input).returning()
    return rows.map(toFact)
  }

  async factsForRuns(runIds: string[]): Promise<FactRecord[]> {
    if (runIds.length === 0) return []
    const rows = await this.db
      .select()
      .from(facts)
      .where(inArray(facts.runId, runIds))
      .orderBy(facts.subject, facts.createdAt)
    return rows.map(toFact)
  }

  /** Facts by id, limited to the owner's documents. What a chip resolves through. */
  async ownedFacts(ownerId: string, ids: string[]): Promise<FactRecord[]> {
    if (ids.length === 0) return []
    const rows = await this.db
      .select({ fact: facts })
      .from(facts)
      .innerJoin(blocks, eq(blocks.id, facts.blockId))
      .innerJoin(docs, eq(docs.id, blocks.docId))
      .where(and(inArray(facts.id, ids), eq(docs.ownerId, ownerId)))
    return rows.map((r) => toFact(r.fact))
  }

  async ownedReceipt(
    ownerId: string,
    id: string,
  ): Promise<(ReceiptRecord & { pairedWith: string | null; blockId: string }) | null> {
    const [row] = await this.db
      .select({ receipt: receipts, blockId: runs.blockId })
      .from(receipts)
      .innerJoin(runs, eq(runs.id, receipts.runId))
      .innerJoin(blocks, eq(blocks.id, runs.blockId))
      .innerJoin(docs, eq(docs.id, blocks.docId))
      .where(and(eq(receipts.id, id), eq(docs.ownerId, ownerId)))
    return row
      ? { ...toReceipt(row.receipt), pairedWith: row.receipt.pairedWith, blockId: row.blockId }
      : null
  }

  /**
   * Everything one page load produced: the HTML, and the screenshot and replay that
   * name it as their pair. Pass the HTML's id. Ordered HTML, screenshot, log, replay,
   * and by capture time within a kind so a boot screenshot comes before the next one.
   */
  async pageGroup(htmlId: string): Promise<ReceiptRecord[]> {
    const rows = await this.db
      .select()
      .from(receipts)
      .where(or(eq(receipts.id, htmlId), eq(receipts.pairedWith, htmlId)))
    const order = ["html", "screenshot", "json", "replay"]
    return rows
      .map(toReceipt)
      .sort(
        (a, b) =>
          order.indexOf(a.kind) - order.indexOf(b.kind) || a.capturedAt.localeCompare(b.capturedAt),
      )
  }
}
