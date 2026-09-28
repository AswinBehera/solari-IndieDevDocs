import type { EvidenceStore, FactorReport, ScoreEntity } from "@samsara/refine"
import { score } from "@samsara/refine"
import type { JobHandler } from "./handlers.js"

/**
 * `refine.score` job type: stored entities turned into explained numbers.
 *
 * **One handler for every domain**, like every other verb in this directory. The
 * pack arrives through `ctx.packs`, its factors live behind it, and nothing
 * travel-specific appears in this file — the word "local" is a key in a map here
 * and this handler never types it.
 *
 * **Scoped to a domain, like `refine.resolve` and unlike `refine.extract`.** The
 * unit of work is the entity table, which no single harvest run owns: one place
 * accumulates evidence from many runs over many weeks, and its score is a
 * statement about all of it at once. A job scoped to a run would rescore
 * whichever entities that run happened to touch and leave the rest holding
 * numbers computed from a smaller corpus, which is the one thing a score
 * carrying explanations must not do.
 *
 * **Re-running is safe and is the point.** Scoring reads evidence and writes a
 * column; it spends no quota, opens no browser and asks no provider. A score is
 * a function of the corpus at the moment it was taken, the corpus grows every
 * night, and so the right cadence is "after every resolve" rather than "once".
 * A job cut in half leaves the entities it reached holding fresh scores and the
 * rest holding their previous ones, which are both readings that happened — no
 * partial state, nothing to reconcile.
 */

/**
 * How many entities are scored per page, and it is the evidence read that sets it.
 *
 * The stage reads a page's evidence in one query, capped at `EVIDENCE_PER_ENTITY`
 * rows per entity — two hundred. Fifty entities is therefore a query that can
 * return ten thousand rows, which is a large but sane result set, and a hundred
 * would be twice that against the table in this pipeline that grows without
 * bound. This number is not about how much work a job does; `MAX_PAGES` is.
 */
const SCORE_PAGE_SIZE = 50

/**
 * How many pages one job will score, which is a stop and not a budget.
 *
 * Ten thousand entities. The bound reads differently here than in the other
 * handlers and the difference is worth stating: a resolved mention leaves the
 * pending queue, so `refine.resolve` stopping early only defers work that the
 * next run finds waiting. Nothing marks an entity as scored, so this job always
 * starts from the oldest row, and a cap that bites means the rows past it are
 * never scored — not deferred, never. That is a silent hole, so when the cursor
 * is still live at the cap the job says so in its last line rather than looking
 * like a clean finish. It exists at all only because an unbounded loop inside a
 * scheduled Actions run is the other way to fail, and this one is visible.
 */
const MAX_PAGES = 200

/**
 * The idempotency key, and it needs a `window` for the reason `refine.resolve`
 * spells out: `jobs.idempotency_key` is permanently unique, so an unwindowed key
 * would mean a domain can be scored exactly once, ever.
 */
export const scoreJobKey = (domainId: string, window: string): string =>
  `refine.score:${domainId}:${window}`

export interface ScorePayload {
  domainId: string
}

/** Validated here, for the reason every other handler validates here. */
function parsePayload(raw: unknown): ScorePayload {
  const domainId = (raw as Partial<ScorePayload> | null)?.domainId
  if (typeof domainId !== "string" || domainId.trim().length === 0) {
    throw new Error("refine.score: payload.domainId must be a non-empty string")
  }
  return { domainId }
}

export interface ScoreHandlerDeps {
  /**
   * Where the receipts are read from.
   *
   * Required, unlike the resolve handler's writer. A scorer without evidence is
   * not a degraded scorer, it is a job that would report every entity as
   * unevidenced and write nothing — and it would do that indistinguishably from
   * a corpus that genuinely has no receipts yet.
   */
  evidence: EvidenceStore
}

export function createScoreHandler(deps: ScoreHandlerDeps): JobHandler {
  return async (ctx) => {
    const input = parsePayload(ctx.job.payload)
    const pack = ctx.packs.require(input.domainId)

    /**
     * The entity table is the pack's, so the page comes from the pack's repo.
     *
     * Named rather than optional-chained into nothing: a pack registered with a
     * score spec and no resolve spec has no table to score over, and the stage
     * would fail later with a message about scoring rather than about wiring.
     */
    const repo = pack.resolve?.repo
    if (!repo) throw new Error(`refine.score: pack "${input.domainId}" has no resolve spec`)

    const totals = { entities: 0, scored: 0, unevidenced: 0, unmeasurable: 0 }
    const written = new Map<string, number>()
    const factors = new Map<string, FactorReport>()
    let cursor: string | null = null
    let pages = 0

    while (pages < MAX_PAGES) {
      if (ctx.signal.aborted) break

      const page = await repo.page(cursor, SCORE_PAGE_SIZE)
      if (page.entities.length === 0) break
      // Counted after the read that produced work, not by the loop header: a
      // page is a page that was scored, and the number goes in a log line beside
      // the entity count it has to be consistent with.
      pages++

      await ctx.heartbeat(`scoring ${page.entities.length} entities in ${input.domainId}`)

      const report = await score({
        pack,
        // Structurally what `page` returns; the alias is here so that a future
        // page carrying more than an entity does not silently become a score
        // stage input.
        entities: page.entities satisfies readonly ScoreEntity<unknown>[],
        evidence: deps.evidence,
        signal: ctx.signal,
      })

      totals.entities += report.entities
      totals.scored += report.scored
      totals.unevidenced += report.unevidenced
      totals.unmeasurable += report.unmeasurable
      for (const s of report.scores) {
        written.set(s.name, (written.get(s.name) ?? 0) + s.written)
        for (const f of s.factors) {
          // Keyed by score *and* factor: one pack may legitimately weigh the
          // same factor into two scores, and summing them would make an honest
          // abstention look like twice as many.
          const key = `${s.name}.${f.name}`
          const seen = factors.get(key)
          if (seen) {
            seen.measured += f.measured
            seen.abstained += f.abstained
          } else {
            factors.set(key, { name: key, measured: f.measured, abstained: f.abstained })
          }
        }
      }

      cursor = page.cursor
      if (cursor === null) break
    }

    // Counts only, no names: ADR-0014 puts this log in a public Actions run.
    const scoreLine = [...written.entries()].map(([name, n]) => `${name}×${n}`).join(" ")
    await ctx.heartbeat(
      `${input.domainId}: ${totals.scored} scored of ${totals.entities} ` +
        `(${totals.unevidenced} unevidenced, ${totals.unmeasurable} unmeasurable, ${pages} pages)` +
        (scoreLine ? ` [${scoreLine}]` : ""),
    )

    /**
     * Factors that never measured anything, reported by name.
     *
     * This is the line worth reading in a nightly log. A factor abstaining
     * everywhere is not a quiet degradation — the stage drops it from the
     * denominator, so the score still comes out looking like a score, computed
     * from fewer things than the pack thinks it is computing from. The number is
     * right and the reading is thinner than anyone intended, and nothing else in
     * this pipeline would say so.
     */
    const silent = [...factors.values()].filter((f) => f.measured === 0 && f.abstained > 0)
    if (silent.length > 0) {
      await ctx.heartbeat(
        `${input.domainId}: never measured ${silent.map((f) => `${f.name}×${f.abstained}`).join(", ")}`,
      )
    }

    /**
     * The cap biting is reported, not thrown.
     *
     * Failing the job would retry it from the same first page and reach the same
     * cap, forever. The shortfall is a sizing fact about a growing table — the
     * fix is a bigger page or a scored watermark, neither of which a retry can
     * discover — so it goes in the log where someone reading the run will see it
     * against the entity count that caused it.
     */
    if (cursor !== null) {
      await ctx.heartbeat(`${input.domainId}: stopped at ${MAX_PAGES} pages with entities unscored`)
    }
  }
}
