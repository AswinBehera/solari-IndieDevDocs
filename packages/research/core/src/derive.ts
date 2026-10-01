import type {
  AiDisclosureValue,
  AiShareValue,
  BlockKind,
  BlockRecord,
  ComparablesParams,
  ComparableValue,
  DecisionValue,
  FactRecord,
  LaneValue,
  NeighboursValue,
  PriceValue,
  ReviewsValue,
  RunRecord,
} from "./model.js"

/**
 * Pure functions over facts: what a derived block computes, what a chip prints,
 * whether a block is out of date, and what re-running one would cost.
 */

/** Hex SHA-256 via Web Crypto, which Node 22 and Workers both have as a global. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export const appSubject = (appid: number): string => `app:${appid}`
export const appidOf = (subject: string): number | null => {
  const m = /^app:(\d+)$/.exec(subject)
  return m ? Number(m[1]) : null
}

/** The comparables a snapshot covers: the run's rows, in order, minus struck-out ones, up to the limit. */
export function currentComparables(
  facts: FactRecord[],
  params: Pick<ComparablesParams, "exclude" | "limit">,
): FactRecord[] {
  const out = new Set(params.exclude)
  return facts
    .filter((f) => f.key === "comparable" && !out.has((f.value as ComparableValue).appid))
    .slice(0, params.limit)
}

/**
 * The share of a snapshot's games whose store page carries an AI disclosure.
 *
 * A page that could not be read is not counted as "no disclosure": it is left out
 * of the denominator and reported as `unread`, because silently treating it as
 * clean would bias the share down by exactly the pages we failed on.
 */
export function aiShare(snapshotFacts: FactRecord[]): { value: AiShareValue; from: string[] } {
  const names = new Map<string, string>()
  for (const f of snapshotFacts) if (f.key === "name") names.set(f.subject, String(f.value))
  const disclosures = snapshotFacts.filter((f) => f.key === "ai.disclosure")
  const readSubjects = new Set(disclosures.map((f) => f.subject))
  const unread = new Set(
    snapshotFacts
      .filter((f) => f.key === "unavailable" && !readSubjects.has(f.subject))
      .map((f) => f.subject),
  )
  const disclosed = disclosures.filter((f) => (f.value as AiDisclosureValue).disclosed)
  const total = disclosures.length
  return {
    value: {
      disclosed: disclosed.length,
      total,
      unread: unread.size,
      pct: total === 0 ? 0 : Math.round((disclosed.length / total) * 1000) / 10,
      disclosedApps: disclosed.map((f) => ({
        appid: appidOf(f.subject) ?? 0,
        name: names.get(f.subject) ?? f.subject,
      })),
    },
    from: disclosures.map((f) => f.id),
  }
}

// ---- niche breadth -------------------------------------------------------------------

/** What a lane needs from one search result row. Restated so core stays standalone. */
export interface LaneRow {
  appid: number
  name: string
  priceFinal: number | null
  tagIds: number[]
  reviewPct: number | null
  reviewCount: number | null
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 1
    ? (v[mid] as number)
    : Math.round(((v[mid - 1] as number) + (v[mid] as number)) / 2)
}

/**
 * A lane from one search: its total, and medians over the rows it sampled.
 * Free and unpriced games are left out of the price median rather than counted
 * as $0, which would drag a paid niche's price down by its demos and freebies.
 */
export function laneOf(
  input: Pick<LaneValue, "relation" | "tagIds" | "pivot" | "overlap"> & {
    total: number
    rows: LaneRow[]
  },
): LaneValue {
  const { rows } = input
  const byReviews = [...rows].sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0))
  return {
    relation: input.relation,
    tagIds: input.tagIds,
    pivot: input.pivot,
    total: input.total,
    sampled: rows.length,
    medianPriceCents: median(
      rows.flatMap((r) => (r.priceFinal && r.priceFinal > 0 ? [r.priceFinal] : [])),
    ),
    medianReviews: median(rows.flatMap((r) => (r.reviewCount !== null ? [r.reviewCount] : []))),
    medianPositivePct: median(rows.flatMap((r) => (r.reviewPct !== null ? [r.reviewPct] : []))),
    overlap: input.overlap,
    top: byReviews
      .slice(0, 3)
      .map((r) => ({ appid: r.appid, name: r.name, reviews: r.reviewCount })),
  }
}

/** A tag carried by at least this share of the niche describes it; it does not narrow it. */
export const BASELINE_SHARE = 0.8

/**
 * The tags the niche's games carry besides the ones that define it, counted.
 * The most carried become lanes, except those nearly every game shares, which are
 * reported as the niche's baseline. `name` returns null for a tag the product
 * does not offer (the adult ones), which is then never searched.
 */
export function neighbourTags(
  rows: Pick<LaneRow, "tagIds">[],
  base: number[],
  name: (id: number) => string | null,
  lanes: number,
): NeighboursValue {
  const counts = new Map<number, number>()
  const own = new Set(base)
  for (const r of rows)
    for (const t of new Set(r.tagIds)) if (!own.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1)
  const ranked = [...counts]
    .flatMap(([id, carry]) => {
      const n = name(id)
      return n === null ? [] : [{ id, name: n, carry }]
    })
    .sort((a, b) => b.carry - a.carry || a.id - b.id)
  const cut = Math.ceil(rows.length * BASELINE_SHARE)
  return {
    of: rows.length,
    baseline: ranked.filter((t) => rows.length > 0 && t.carry >= cut),
    lanes: ranked.filter((t) => t.carry < cut).slice(0, lanes),
  }
}

// ---- decisions -------------------------------------------------------------------------

/** The same reading in a later run: same block, same subject, same key. */
export function currentReading(fact: FactRecord, latest: FactRecord[]): FactRecord | null {
  return (
    latest.find(
      (f) => f.blockId === fact.blockId && f.subject === fact.subject && f.key === fact.key,
    ) ?? null
  )
}

export interface EvidenceMove {
  factId: string
  /** The value as its block now reads it, or null when the latest run has no such fact. */
  now: FactRecord | null
}

/**
 * The evidence a decision cited whose block has since read something different.
 * A re-run that reads the same value is not a move: the decision still holds.
 */
export function evidenceMoves(
  evidence: FactRecord[],
  lastRunOf: (blockId: string) => string | null,
  latest: FactRecord[],
): EvidenceMove[] {
  return evidence.flatMap((f) => {
    const last = lastRunOf(f.blockId)
    if (!last || last === f.runId) return []
    const now = currentReading(
      f,
      latest.filter((l) => l.runId === last),
    )
    return now && JSON.stringify(now.value) === JSON.stringify(f.value)
      ? []
      : [{ factId: f.id, now }]
  })
}

export const formatCents = (cents: number, currency = "USD"): string =>
  currency === "USD" ? `$${(cents / 100).toFixed(2)}` : `${(cents / 100).toFixed(2)} ${currency}`

/** What a fact chip prints. Short: a chip sits inside a sentence. */
export function formatFact(f: Pick<FactRecord, "key" | "value">): string {
  switch (f.key) {
    case "matches":
      return `${Number(f.value).toLocaleString("en-US")} games`
    case "comparable":
      return (f.value as ComparableValue).name
    case "name":
      return String(f.value)
    case "developers":
      return (f.value as string[]).join(", ") || "unknown developer"
    case "price": {
      const p = f.value as PriceValue
      if (!p) return "free / unpriced"
      return p.discountPercent > 0
        ? `${formatCents(p.final, p.currency)} (${p.discountPercent}% off ${formatCents(p.initial, p.currency)})`
        : formatCents(p.final, p.currency)
    }
    case "release":
      return String((f.value as { date?: string }).date ?? f.value)
    case "reviews": {
      const r = f.value as ReviewsValue
      const pct = r.total > 0 ? Math.round((r.positive / r.total) * 100) : 0
      return `${r.total.toLocaleString("en-US")} reviews, ${pct}% positive`
    }
    case "tags":
      return (f.value as string[]).slice(0, 3).join(", ")
    case "ai.disclosure":
      return (f.value as AiDisclosureValue).disclosed ? "discloses AI use" : "no AI disclosure"
    case "ai.share": {
      const s = f.value as AiShareValue
      return `${s.pct}% (${s.disclosed} of ${s.total})`
    }
    case "lane": {
      const l = f.value as LaneValue
      const n = `${l.total.toLocaleString("en-US")} games`
      if (l.relation === "this" || !l.pivot) return n
      return l.relation === "narrower"
        ? `${n} with ${l.pivot.name}`
        : `${n} without ${l.pivot.name}`
    }
    case "neighbours":
      return (f.value as NeighboursValue).lanes
        .slice(0, 3)
        .map((t) => t.name)
        .join(", ")
    case "decision": {
      const d = f.value as DecisionValue
      return d.statement.length > 60 ? `"${d.statement.slice(0, 57)}…"` : `"${d.statement}"`
    }
    case "unavailable":
      return "not readable"
  }
}

/**
 * Out of date: the block it reads from has finished a run since this block's
 * last run started. Never re-run automatically — the page asks, with the cost.
 */
export function isStale(
  block: Pick<BlockRecord, "lastRunId">,
  lastRun: Pick<RunRecord, "startedAt"> | null,
  sourceRun: Pick<RunRecord, "endedAt" | "outcome"> | null,
): boolean {
  if (!block.lastRunId || !lastRun || !sourceRun?.endedAt) return false
  if (sourceRun.outcome === "failed") return false
  return Date.parse(sourceRun.endedAt) > Date.parse(lastRun.startedAt)
}

/**
 * The block now asks something its last run did not answer. Only parameters that
 * change what a run reads count: a comparables block's `exclude` and `limit` are
 * applied when its facts are read, so pruning never makes the search itself stale.
 */
export function paramsChanged(kind: BlockKind, runParams: unknown, current: unknown): boolean {
  const pick = (p: unknown): unknown => {
    const o = (p ?? {}) as Record<string, unknown>
    if (kind === "comparables") {
      const tags = Array.isArray(o.tagIds) ? [...(o.tagIds as number[])].sort((a, b) => a - b) : []
      return { tagIds: tags, sort: o.sort ?? "relevance" }
    }
    if (kind === "niche_map") return { source: o.source ?? null, neighbours: o.neighbours ?? 6 }
    if (kind === "decision") {
      const ev = Array.isArray(o.evidence) ? [...(o.evidence as string[])].sort() : []
      return { statement: String(o.statement ?? "").trim(), evidence: ev }
    }
    return { source: o.source ?? null }
  }
  return JSON.stringify(pick(runParams)) !== JSON.stringify(pick(current))
}

export interface CostEstimate {
  requests: number
  browserPages: number
  /** Rough, from measured page loads (~20 s each, three at a time). */
  minutes: number
  label: string
}

/** What a run would spend, said before it spends it. */
export function estimateCost(kind: BlockKind, items: number): CostEstimate {
  switch (kind) {
    case "comparables":
      return { requests: 1, browserPages: 0, minutes: 0.05, label: "1 store search, no browser" }
    case "store_snapshot": {
      const minutes = Math.ceil(((items * 20) / 3 / 60) * 10) / 10 + 0.5
      return {
        requests: items * 2,
        browserPages: items,
        minutes,
        label: `${items * 2} Steam API calls + ${items} store pages in a cloud browser, about ${minutes} min`,
      }
    }
    case "slop_share":
      return {
        requests: 0,
        browserPages: 0,
        minutes: 0,
        label: "Computed from the snapshot. Free.",
      }
    case "niche_map":
      return {
        requests: items,
        browserPages: 0,
        minutes: Math.ceil(items * 0.1 * 10) / 10,
        label: `${items} store searches, no browser`,
      }
    case "decision":
      return {
        requests: 0,
        browserPages: 0,
        minutes: 0,
        label: "Records the evidence as it stands. Free.",
      }
  }
}
