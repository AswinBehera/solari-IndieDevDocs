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
  PrototypeBootValue,
  PrototypeBuildValue,
  PrototypeConsoleValue,
  PrototypeLiveValue,
  PrototypeScreenValue,
  ReviewEarlyValue,
  ReviewHoursValue,
  ReviewLanguagesValue,
  ReviewNegativeValue,
  ReviewRecentValue,
  ReviewsValue,
  ReviewTrendValue,
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

// ---- reviews -----------------------------------------------------------------------------

/** What a review signal needs from one review. Restated so core stays standalone. */
export interface ReviewSample {
  votedUp: boolean
  minutesAtReview: number | null
  language: string
  created: number
  refunded: boolean
}

/** Steam's refund window: under two hours played. */
export const EARLY_MINUTES = 120

const hours = (minutes: number | null): number | null =>
  minutes === null ? null : Math.round((minutes / 60) * 10) / 10

const minutesOf = (rows: ReviewSample[]): number[] =>
  rows.flatMap((r) => (r.minutesAtReview !== null ? [r.minutesAtReview] : []))

const spanDays = (rows: ReviewSample[]): number => {
  const t = rows.map((r) => r.created).filter((c) => c > 0)
  return t.length < 2 ? 0 : Math.round((Math.max(...t) - Math.min(...t)) / 86_400)
}

export function recentReviews(rows: ReviewSample[]): ReviewRecentValue {
  const up = rows.filter((r) => r.votedUp)
  return {
    sampled: rows.length,
    positive: up.length,
    pct: rows.length === 0 ? 0 : Math.round((up.length / rows.length) * 100),
    spanDays: spanDays(rows),
    medianHoursUp: hours(median(minutesOf(up))),
  }
}

/** Over a sample of negative reviews only. A positive one that slipped in is not counted. */
export function negativeReviews(rows: ReviewSample[]): ReviewNegativeValue {
  const down = rows.filter((r) => !r.votedUp)
  return {
    sampled: down.length,
    medianHours: hours(median(minutesOf(down))),
    early: down.filter((r) => r.minutesAtReview !== null && r.minutesAtReview < EARLY_MINUTES)
      .length,
    refunded: down.filter((r) => r.refunded).length,
    spanDays: spanDays(down),
  }
}

export function reviewLanguages(
  rows: Pick<ReviewSample, "language">[],
  top = 5,
): ReviewLanguagesValue {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.language, (counts.get(r.language) ?? 0) + 1)
  return {
    sampled: rows.length,
    top: [...counts]
      .map(([language, n]) => ({ language, n }))
      .sort((a, b) => b.n - a.n || a.language.localeCompare(b.language))
      .slice(0, top),
  }
}

/** A recent score is compared only over at least this many reviews. */
export const TREND_MIN_SAMPLE = 30
export const TREND_MARGIN = 5

export function reviewTrend(
  games: { appid: number; name: string; recent: ReviewRecentValue; allTimePct: number | null }[],
): ReviewTrendValue {
  const judged = games.flatMap((g) =>
    g.allTimePct !== null && g.recent.sampled >= TREND_MIN_SAMPLE
      ? [{ appid: g.appid, name: g.name, recentPct: g.recent.pct, allTimePct: g.allTimePct }]
      : [],
  )
  return {
    judged: judged.length,
    margin: TREND_MARGIN,
    lower: judged.filter((g) => g.recentPct <= g.allTimePct - TREND_MARGIN),
    higher: judged.filter((g) => g.recentPct >= g.allTimePct + TREND_MARGIN),
  }
}

/** Upper edges in hours; the last bucket is open. The first two split Steam's refund window. */
export const HOUR_BUCKETS: { label: string; below: number }[] = [
  { label: "<1 h", below: 1 },
  { label: "1–2 h", below: 2 },
  { label: "2–5 h", below: 5 },
  { label: "5–10 h", below: 10 },
  { label: "10–20 h", below: 20 },
  { label: "20–50 h", below: 50 },
  { label: "50+ h", below: Number.POSITIVE_INFINITY },
]

export function hourBuckets(
  up: ReviewSample[],
  down: ReviewSample[],
): { label: string; up: number; down: number }[] {
  const at = (r: ReviewSample) =>
    HOUR_BUCKETS.findIndex((b) => (r.minutesAtReview as number) / 60 < b.below)
  const out = HOUR_BUCKETS.map((b) => ({ label: b.label, up: 0, down: 0 }))
  for (const r of up) if (r.minutesAtReview !== null) (out[at(r)] as { up: number }).up++
  for (const r of down) if (r.minutesAtReview !== null) (out[at(r)] as { down: number }).down++
  return out
}

/**
 * The lane's reviews pooled: every sampled review counts once, so a game with a
 * long history weighs no more than its sample of 100.
 */
export function laneReviews(
  recent: ReviewSample[][],
  negative: ReviewSample[][],
): { hours: ReviewHoursValue; early: ReviewEarlyValue; languages: ReviewLanguagesValue } {
  const up = recent.flat().filter((r) => r.votedUp)
  const down = negative.flat().filter((r) => !r.votedUp)
  const early = down.filter((r) => r.minutesAtReview !== null && r.minutesAtReview < EARLY_MINUTES)
  return {
    hours: {
      medianHoursUp: hours(median(minutesOf(up))),
      medianHoursDown: hours(median(minutesOf(down))),
      up: up.length,
      down: down.length,
      buckets: hourBuckets(up, down),
    },
    early: {
      early: early.length,
      of: down.length,
      pct: down.length === 0 ? 0 : Math.round((early.length / down.length) * 100),
      refunded: down.filter((r) => r.refunded).length,
    },
    languages: reviewLanguages(recent.flat()),
  }
}

const LANGUAGES: Record<string, string> = {
  english: "English",
  schinese: "Simplified Chinese",
  tchinese: "Traditional Chinese",
  russian: "Russian",
  brazilian: "Portuguese (Brazil)",
  portuguese: "Portuguese",
  koreana: "Korean",
  japanese: "Japanese",
  german: "German",
  french: "French",
  spanish: "Spanish",
  latam: "Spanish (Latin America)",
  polish: "Polish",
  turkish: "Turkish",
  ukrainian: "Ukrainian",
  italian: "Italian",
  thai: "Thai",
  vietnamese: "Vietnamese",
  czech: "Czech",
  hungarian: "Hungarian",
  dutch: "Dutch",
  swedish: "Swedish",
  finnish: "Finnish",
  danish: "Danish",
  norwegian: "Norwegian",
  indonesian: "Indonesian",
  romanian: "Romanian",
  greek: "Greek",
  bulgarian: "Bulgarian",
  arabic: "Arabic",
}

export const languageName = (code: string): string => LANGUAGES[code] ?? code

/** `English 61%, Simplified Chinese 14%`: the first `n` languages as shares of the sample. */
export function languageShares(v: ReviewLanguagesValue, n = 3): string {
  if (v.sampled === 0) return "no reviews"
  return v.top
    .slice(0, n)
    .map((l) => `${languageName(l.language)} ${Math.round((l.n / v.sampled) * 100)}%`)
    .join(", ")
}

const h = (x: number | null): string => (x === null ? "?" : `${x} h`)

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
    case "review.recent": {
      const r = f.value as ReviewRecentValue
      return `${r.pct}% positive in the latest ${r.sampled}`
    }
    case "review.negative": {
      const r = f.value as ReviewNegativeValue
      return `negative at ${h(r.medianHours)}, ${r.early} of ${r.sampled} under 2 h`
    }
    case "review.languages":
      return languageShares(f.value as ReviewLanguagesValue)
    case "review.trend": {
      const t = f.value as ReviewTrendValue
      return `${t.lower.length} of ${t.judged} reviewed worse lately`
    }
    case "review.hours": {
      const r = f.value as ReviewHoursValue
      return `positive at ${h(r.medianHoursUp)}, negative at ${h(r.medianHoursDown)}`
    }
    case "review.early": {
      const r = f.value as ReviewEarlyValue
      return `${r.pct}% of negative reviews under 2 h`
    }
    case "prototype.build": {
      const b = f.value as PrototypeBuildValue
      return `${b.commit.slice(0, 7)}, ${b.files} files`
    }
    case "prototype.boot": {
      const b = f.value as PrototypeBootValue
      const load =
        b.loadMs === null ? "never loaded" : `loaded in ${(b.loadMs / 1000).toFixed(1)} s`
      return `${load}, ${b.errors} console error${b.errors === 1 ? "" : "s"}`
    }
    case "prototype.console": {
      const c = f.value as PrototypeConsoleValue
      return c.errors[0] ?? "no console errors"
    }
    case "prototype.screen":
      return (f.value as PrototypeScreenValue).moment === "boot"
        ? "screen at boot"
        : "screen after input"
    case "prototype.live":
      return `playable until ${(f.value as PrototypeLiveValue).until.slice(11, 16)} UTC`
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
    // How long it stays playable is not part of the question.
    if (kind === "prototype") return { repo: o.repo ?? "", ref: o.ref ?? "", dir: o.dir ?? "" }
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
    case "review_signals":
      return {
        requests: items * 2,
        browserPages: 0,
        minutes: Math.ceil(items * 2 * 0.05 * 10) / 10,
        label: `${items * 2} Steam review pages, no browser`,
      }
    case "niche_map":
      return {
        requests: items,
        browserPages: 0,
        minutes: Math.ceil(items * 0.1 * 10) / 10,
        label: `${items} store searches, no browser`,
      }
    case "prototype":
      // `items` is the minutes it stays playable. About a minute to clone, serve
      // and open it in a browser, and the kept time is billed whether or not
      // anyone plays.
      return {
        requests: 0,
        browserPages: 1,
        minutes: 1 + items,
        label:
          items > 0
            ? `1 sandbox and 1 browser session, then playable for ${items} min: about ${1 + items} sandbox min`
            : "1 sandbox and 1 browser session, about 1 min; recorded, not kept playable",
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
