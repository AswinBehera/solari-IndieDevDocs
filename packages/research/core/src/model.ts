import { z } from "zod"

/**
 * The research document's nouns: Document → Block → Run → Receipt → Fact.
 *
 * - A **block** is a question with parameters ("which games are comparable to
 *   mine?"). It lives in the document as an atom holding only its id.
 * - A **run** is one attempt to answer it: which runtimes it used, what it cost,
 *   and whether it finished.
 * - A **receipt** is what a run saw, stored immutably and hashed: an API response,
 *   a page's HTML, a screenshot, or the inputs and formula of a computation.
 * - A **fact** is one typed value read out of one receipt, with a locator saying
 *   where. Prose cites facts, never receipts, and never itself.
 *
 * A block's current answer is the facts of its last run. Older runs stay, which is
 * what makes "what changed since last week" a diff of facts, not a re-read.
 */

export const RUNTIMES = ["api", "browser", "sandbox", "desktop", "derived"] as const
export type Runtime = (typeof RUNTIMES)[number]

export const RUN_OUTCOMES = ["running", "ok", "partial", "blocked", "failed"] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

export const RECEIPT_KINDS = ["json", "html", "screenshot", "computation"] as const
export type ReceiptKind = (typeof RECEIPT_KINDS)[number]

export const BLOCK_STATUSES = ["idle", "queued", "running", "done", "failed"] as const
export type BlockStatus = (typeof BLOCK_STATUSES)[number]

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Where in a receipt a fact was read. Same shape as `@rd/steam`'s, restated so core stays standalone. */
export interface Locator {
  path?: string
  quote?: string
  selector?: string
  box?: Box
  /** For a derived fact: the facts it was computed from. */
  from?: string[]
}

// ---- block kinds --------------------------------------------------------------

export const comparablesParams = z.object({
  /** Steam tag ids, all required. Two or three is the useful range; one is a genre. */
  tagIds: z.array(z.number().int().positive()).min(1).max(5),
  sort: z.enum(["relevance", "reviews", "released"]).default("relevance"),
  /**
   * How many to keep. A run always reads a full page of 25, so striking one out
   * pulls the next into the list without searching again.
   */
  limit: z.number().int().min(3).max(25).default(12),
  /** App ids the writer struck out. Kept rather than deleted, so the pruning is visible. */
  exclude: z.array(z.number().int().positive()).default([]),
})

export const snapshotParams = z.object({
  /** The comparables block this reads its list from. */
  source: z.string().uuid(),
})

export const slopShareParams = z.object({
  /** The snapshot block whose AI-disclosure facts this counts. */
  source: z.string().uuid(),
})

export const BLOCK_PARAMS = {
  comparables: comparablesParams,
  store_snapshot: snapshotParams,
  slop_share: slopShareParams,
} as const

export type BlockKind = keyof typeof BLOCK_PARAMS
export const BLOCK_KINDS = Object.keys(BLOCK_PARAMS) as BlockKind[]

export type ComparablesParams = z.infer<typeof comparablesParams>
export type SnapshotParams = z.infer<typeof snapshotParams>
export type SlopShareParams = z.infer<typeof slopShareParams>

export interface BlockParamsByKind {
  comparables: ComparablesParams
  store_snapshot: SnapshotParams
  slop_share: SlopShareParams
}

export function parseParams<K extends BlockKind>(
  kind: K,
  params: unknown,
): { ok: true; value: BlockParamsByKind[K] } | { ok: false; error: string } {
  const r = BLOCK_PARAMS[kind].safeParse(params)
  return r.success
    ? { ok: true, value: r.data as BlockParamsByKind[K] }
    : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }
}

/** The block a kind reads from, if any. The document's blocks form a DAG through these. */
export function sourceOf(kind: BlockKind, params: unknown): string | null {
  if (kind === "comparables") return null
  const p = params as { source?: unknown }
  return typeof p?.source === "string" ? p.source : null
}

export const BLOCK_TITLES: Record<BlockKind, string> = {
  comparables: "Comparable games",
  store_snapshot: "Store snapshot",
  slop_share: "AI disclosure share",
}

// ---- records ------------------------------------------------------------------

export interface DocRecord {
  id: string
  title: string
  content: unknown
  version: number
  createdAt: string
  updatedAt: string
}

export interface BlockRecord {
  id: string
  docId: string
  kind: BlockKind
  params: unknown
  status: BlockStatus
  lastRunId: string | null
  createdAt: string
  updatedAt: string
}

export interface RunStats {
  requests: number
  browserSessions: number
  browserMinutes: number
  receipts: number
  facts: number
  /** Items the run was asked to cover, and how many it covered. */
  planned: number
  covered: number
}

export interface RunRecord {
  id: string
  blockId: string
  jobId: string | null
  outcome: RunOutcome
  /** The block's parameters when the run started: the question it answered. */
  params: unknown
  runtimes: Runtime[]
  stats: RunStats
  note: string | null
  startedAt: string
  endedAt: string | null
}

export interface ReceiptRecord {
  id: string
  runId: string
  kind: ReceiptKind
  runtime: Runtime
  /** What was read. For a computation, a `computation:` URI naming the formula. */
  url: string
  sha256: string
  bytes: number
  contentType: string
  /** Storage key, content-addressed: `<sha256>.<ext>`. */
  ref: string
  /** The region the store was read as (`cc`), or the browser's egress country. */
  viewpoint: string | null
  sessionId: string | null
  capturedAt: string
}

export interface FactRecord {
  id: string
  blockId: string
  runId: string
  receiptId: string
  /** What the fact is about: `app:413150`, or `set` for a whole-list figure. */
  subject: string
  key: FactKey
  value: unknown
  locator: Locator
  createdAt: string
}

export const emptyStats = (): RunStats => ({
  requests: 0,
  browserSessions: 0,
  browserMinutes: 0,
  receipts: 0,
  facts: 0,
  planned: 0,
  covered: 0,
})

// ---- fact keys ----------------------------------------------------------------

/**
 * Closed, so a chip always knows how to print its value. A new key is a line here
 * and a case in `formatFact`, and the compiler finds the second.
 */
export const FACT_KEYS = [
  "matches",
  "comparable",
  "name",
  "developers",
  "price",
  "release",
  "reviews",
  "tags",
  "ai.disclosure",
  "ai.share",
  "unavailable",
] as const
export type FactKey = (typeof FACT_KEYS)[number]

export interface ComparableValue {
  appid: number
  name: string
  released: string
  priceCents: number | null
  reviewPct: number | null
  reviewCount: number | null
}

export type PriceValue = { currency: string; final: number; initial: number; discountPercent: number } | null
export interface ReviewsValue {
  total: number
  positive: number
  negative: number
  label: string
}
export type AiDisclosureValue = { disclosed: true; text: string } | { disclosed: false }
export interface AiShareValue {
  disclosed: number
  total: number
  /** Apps whose page could not be read. Not in `total`, and said so. */
  unread: number
  pct: number
  disclosedApps: { appid: number; name: string }[]
}
