import type {
  EvidenceWriter,
  LookupPort,
  PendingMentionReader,
  ResolutionCache,
} from "@samsara/refine"
import { MENTION_LIST_LIMIT, resolve } from "@samsara/refine"
import type { JobHandler } from "./handlers.js"

/**
 * The `refine.resolve` job type: pending mentions turned into entities.
 *
 * **One handler for every domain**, like `refine.extract` and `harvest.run`. The
 * pack arrives through `ctx.packs` keyed by the payload's `domainId`, and the
 * tiers, the city and the geocoder all live behind it. Nothing travel-specific
 * appears in this file.
 *
 * **Scoped to a domain rather than to a run**, which is the one place this
 * handler deliberately differs from `refine.extract`. Extraction's unit of work
 * is a harvest run because that is what produces the items. Resolution's is the
 * pending queue, because its whole economy is the cache: mentions of one shop
 * arrive from many runs over many weeks, and they share a resolution key. A job
 * scoped to a run would partition the queue along the one axis that has nothing
 * to do with the key, and the second run to mention a place would pay for a
 * lookup the first had already answered.
 *
 * **Re-running is safe.** Every key is committed as it is decided, so a job that
 * is killed halfway has still banked what it finished, and the next run reads a
 * shorter queue. Nothing here is charged twice: a key the cache already knows is
 * answered without asking the pack at all.
 */

/**
 * How many pages of pending mentions one job will drain.
 *
 * A page is `MENTION_LIST_LIMIT`, so this is a ceiling of a few hundred mentions
 * per job. It exists because ADR-0014 runs this in a GitHub Actions job with a
 * wall clock, not because a larger number would be wrong.
 *
 * Draining several pages rather than refusing, which is what `refine.extract`
 * does when its read bound cannot cover a run — the difference is worth being
 * precise about, because the two look like the same situation and are not.
 * Extract's bound is a correctness problem: its skip query is keyed per item, so
 * reading the first hundred of a larger run would mark the run done with the
 * remainder unreadable. Here a resolved mention leaves the pending set, so the
 * next page is new work by construction and there is no state that can record
 * progress that did not happen. A backlog longer than this bound is an ordinary
 * queue with a backlog, not a job that failed.
 */
const MAX_PAGES = 5

/**
 * The idempotency key, and it needs a `window` the caller supplies.
 *
 * `jobs.idempotency_key` is a permanent unique index — it collides against
 * succeeded rows, not only queued ones — so `refine.resolve:<domainId>` would
 * mean a domain can be resolved exactly once ever, which for a job whose entire
 * purpose is to drain a queue that keeps refilling is the wrong shape entirely.
 *
 * The window is whatever makes two enqueues mean two different intents: a date
 * for the weekly cron, a run id for a chain from `refine.extract`. It is the
 * caller's to choose because only the caller knows why it is asking, and a
 * default here would silently make every caller's answer the same one.
 */
export const resolveJobKey = (domainId: string, window: string): string =>
  `refine.resolve:${domainId}:${window}`

export interface ResolvePayload {
  domainId: string
}

/**
 * Payload validation, in the handler — same reasoning as `refine.extract`. The
 * queue column is `jsonb` and anything holding the connection string can write a
 * row, so a hand-written `INSERT` with a typo must not become a geocoder spend
 * against a domain nobody meant.
 */
function parsePayload(raw: unknown): ResolvePayload {
  const domainId = (raw as Partial<ResolvePayload> | null)?.domainId
  if (typeof domainId !== "string" || domainId.trim().length === 0) {
    throw new Error("refine.resolve: payload.domainId must be a non-empty string")
  }
  return { domainId }
}

export interface ResolveHandlerDeps {
  pending: PendingMentionReader
  cache: ResolutionCache
  /**
   * Absent when no geocoder is configured, and that is a supported deployment.
   *
   * Tier 2 is the only tier that costs anything and the only one that can be
   * refused, so a runner without it still resolves everything Tiers 0 and 1 can
   * reach. ADR-0017's acceptance criterion is that those two carry at least four
   * fifths, which means a keyless runner should be missing the minority of the
   * corpus — and if it is missing much more than that, the ratio has told us
   * something before a key was ever bought.
   */
  lookup?: LookupPort
  /**
   * Where a resolved mention's evidence row goes (P2.5).
   *
   * Optional, and absent it nothing is written — which was the repository's
   * state until P2.5 and the reason the score stage had an empty table to read.
   * It is here rather than in a stage of its own because this handler is the one
   * moment a mention has just acquired an entity id; a later stage would have to
   * rediscover that by scanning the two largest tables we have.
   *
   * It stays optional because the alternative is worse: a required port makes
   * every existing caller — the tests, the backfill tool — construct a database
   * writer to run a stage that does not need one, and resolution is still
   * correct without it. What is lost is receipts, which the report counts.
   */
  evidence?: EvidenceWriter
}

export function createResolveHandler(deps: ResolveHandlerDeps): JobHandler {
  return async (ctx) => {
    const input = parsePayload(ctx.job.payload)

    // Throws and names the registered ids. A job carrying a domain nobody
    // registered means the runner shipped without the pack.
    const pack = ctx.packs.require(input.domainId)

    const totals = {
      mentions: 0,
      keys: 0,
      cached: 0,
      asked: 0,
      resolved: 0,
      unresolvable: 0,
      evidence: 0,
    }
    const tiers = new Map<number, number>()
    const deferrals = new Map<string, number>()
    let invalid = 0
    let pages = 0

    while (pages < MAX_PAGES) {
      if (ctx.signal.aborted) break

      const mentions = await deps.pending.pending(input.domainId, MENTION_LIST_LIMIT)
      if (mentions.length === 0) break
      // Counted here rather than in a loop header, because every `break` below
      // this line happens *after* a page was resolved: the header form reported
      // one page fewer than the job did, and a job that drained a single page
      // logged "0 pages" beside the mentions it had just resolved.
      pages++

      await ctx.heartbeat(`resolving ${mentions.length} mentions for ${input.domainId}`)

      const report = await resolve({
        pack,
        mentions,
        cache: deps.cache,
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
        ...(deps.evidence ? { evidence: deps.evidence } : {}),
        signal: ctx.signal,
      })

      totals.mentions += report.mentions
      totals.keys += report.keys
      totals.cached += report.cached
      totals.asked += report.asked
      totals.resolved += report.resolved
      totals.unresolvable += report.unresolvable
      totals.evidence += report.evidence
      invalid += report.invalid
      for (const t of report.tiers) tiers.set(t.tier, (tiers.get(t.tier) ?? 0) + t.count)
      for (const d of report.deferrals)
        deferrals.set(d.reason, (deferrals.get(d.reason) ?? 0) + d.count)

      /**
       * Stop when nothing moved, even though the page was not empty.
       *
       * A page where every key deferred is a page that will come back identical:
       * `pending()` is oldest-first, and a deferred key stays pending. Without
       * this, a spent geocoder quota would make the loop re-read the same
       * hundred rows `MAX_PAGES` times, spending the whole job's wall clock
       * discovering the same refusal five times over.
       */
      if (report.resolved === 0 && report.unresolvable === 0) break

      // A short page is the end of the queue.
      if (mentions.length < MENTION_LIST_LIMIT) break
    }

    // Counts only, no text: ADR-0014 puts this log in a public Actions run.
    const tierLine = [...tiers.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([tier, count]) => `t${tier}×${count}`)
      .join(" ")
    await ctx.heartbeat(
      `${input.domainId}: ${totals.resolved} resolved, ${totals.unresolvable} unresolvable ` +
        `from ${totals.keys} keys over ${totals.mentions} mentions ` +
        `(${totals.cached} cached, ${totals.asked} asked, ${invalid} invalid, ${pages} pages, ` +
        `${totals.evidence} evidence)` +
        (tierLine ? ` [${tierLine}]` : ""),
    )

    /**
     * Deferrals are reported, not thrown.
     *
     * The opposite of `refine.extract`, which fails its job when the report
     * carries failures — and the difference is what `deferred` means. An
     * unextracted item is lost work: nothing records that it was skipped, so
     * only a failed job puts it back in reach. A deferred key is *already*
     * recorded as pending with its attempt count incremented; the next run picks
     * it up whether this job succeeds or fails. Failing here would retry the
     * whole page to re-learn a refusal the cache has already written down, and
     * would turn an ordinary spent quota into a red build every day until the
     * month rolled over.
     */
    if (deferrals.size > 0) {
      const summary = [...deferrals.entries()].map(([reason, count]) => `${reason}×${count}`)
      await ctx.heartbeat(`${input.domainId}: deferred ${summary.join(", ")}`)
    }
  }
}
