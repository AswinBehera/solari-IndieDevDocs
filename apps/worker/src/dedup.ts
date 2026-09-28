import type { EntityLinks } from "@samsara/refine"
import { dedup } from "@samsara/refine"
import { chain, type Queue } from "./chain.js"
import type { JobHandler } from "./handlers.js"
import { scoreJobKey } from "./score.js"

/**
 * `refine.dedup` job type: the entity table walked once, oldest first, and its
 * duplicates collapsed.
 *
 * P2.4 built the stage and no job ran it, so the chain from resolve to score
 * had a gap in the middle. This is that job, and it is shaped like
 * `refine.score` because it walks the same table through the same port.
 *
 * **One handler for every domain**, like every other verb in this directory.
 *
 * **Scoped to a domain, not a run**, for the reason the stage's own header
 * gives: the duplicates worth collapsing are two rows written weeks apart, and
 * no single run can see both of them.
 *
 * **It passes the stage the ids it has already walked**, and that is the one
 * line in this file that is not bookkeeping. The stage decides which of two
 * duplicates survives from where the match sits in the page; before this job
 * existed nobody paged, and a match outside the page could only be older. A job
 * walking oldest-first breaks that the moment two duplicates land on different
 * pages — the older is reached first, finds the newer outside its page, and was
 * merged into it. `earlier` is what tells the stage which side of the cursor a
 * match is on.
 *
 * **Re-running is safe.** A merge is repoint-then-merge (ADR-0014's order), so a
 * job cut in half leaves either a finished merge or a duplicate the next run
 * finds by the same keys.
 */

/**
 * Entities per page. The stage asks the repo one question per entity, so this
 * is a granularity for heartbeats and cancellation rather than a query size.
 */
const DEDUP_PAGE_SIZE = 100

/**
 * How many pages one job will walk — ten thousand entities, the same ceiling as
 * `refine.score` and for the same reason: nothing marks an entity as deduped, so
 * every job starts from the oldest row, and a cap that bites leaves the newest
 * rows unexamined. That is reported rather than thrown, because a retry would
 * reach the same cap.
 */
const MAX_PAGES = 100

/** Windowed for the reason `resolveJobKey` gives. */
export const dedupJobKey = (domainId: string, window: string): string =>
  `refine.dedup:${domainId}:${window}`

export interface DedupPayload {
  domainId: string
}

/** Validated here, for the reason every other handler validates here. */
function parsePayload(raw: unknown): DedupPayload {
  const domainId = (raw as Partial<DedupPayload> | null)?.domainId
  if (typeof domainId !== "string" || domainId.trim().length === 0) {
    throw new Error("refine.dedup: payload.domainId must be a non-empty string")
  }
  return { domainId }
}

export interface DedupHandlerDeps {
  /** The engine's pointers into the pack's table. Required: a merge without it orphans evidence. */
  links: EntityLinks
  /** Where the score job is queued once the table is settled. Absent, nothing is chained. */
  queue?: Queue
}

export function createDedupHandler(deps: DedupHandlerDeps): JobHandler {
  return async (ctx) => {
    const input = parsePayload(ctx.job.payload)
    const pack = ctx.packs.require(input.domainId)

    // Both refused before the first page is read, by name, rather than by the
    // stage one page in — a pack wired without either is a deployment mistake,
    // and the message should be about wiring.
    const repo = pack.resolve?.repo
    if (!repo) throw new Error(`refine.dedup: pack "${input.domainId}" has no resolve spec`)
    if (!pack.dedupKeys) throw new Error(`refine.dedup: pack "${input.domainId}" has no dedupKeys`)

    const totals = {
      entities: 0,
      examined: 0,
      keyless: 0,
      merged: 0,
      evidence: 0,
      mentions: 0,
      resolutions: 0,
    }
    const kinds = new Map<string, number>()
    const earlier = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    let cancelled = false

    while (pages < MAX_PAGES) {
      if (ctx.signal.aborted) {
        cancelled = true
        break
      }

      const page = await repo.page(cursor, DEDUP_PAGE_SIZE)
      if (page.entities.length === 0) break
      pages++

      await ctx.heartbeat(`deduplicating ${page.entities.length} entities in ${input.domainId}`)

      const report = await dedup({
        pack,
        entities: page.entities,
        links: deps.links,
        earlier,
        signal: ctx.signal,
      })

      totals.entities += report.entities
      totals.examined += report.examined
      totals.keyless += report.keyless
      totals.merged += report.merged
      totals.evidence += report.evidence
      totals.mentions += report.mentions
      totals.resolutions += report.resolutions
      for (const k of report.keys) kinds.set(k.kind, (kinds.get(k.kind) ?? 0) + k.count)

      // After the stage, not before: the page's own positions answer for its own
      // rows, and this set is only ever about pages already finished.
      for (const row of page.entities) earlier.add(row.id)

      if (report.cancelled) {
        cancelled = true
        break
      }
      cursor = page.cursor
      if (cursor === null) break
    }

    // Counts only, no names: ADR-0014 puts this log in a public Actions run.
    const keyLine = [...kinds.entries()].map(([kind, n]) => `${kind}×${n}`).join(" ")
    await ctx.heartbeat(
      `${input.domainId}: ${totals.merged} merged of ${totals.entities} ` +
        `(${totals.examined} examined, ${totals.keyless} keyless, ${pages} pages; moved ` +
        `${totals.evidence} evidence, ${totals.mentions} mentions, ${totals.resolutions} resolutions)` +
        (keyLine ? ` [${keyLine}]` : ""),
    )

    if (cursor !== null && !cancelled && pages >= MAX_PAGES) {
      await ctx.heartbeat(
        `${input.domainId}: stopped at ${MAX_PAGES} pages with entities unexamined`,
      )
    }

    /**
     * A cancelled walk throws rather than returning, and that is not a failure.
     *
     * The runner reads a normal return as `succeeded`, whatever the signal says,
     * and only a throw under an aborted signal releases the job back to the queue
     * without charging an attempt. A walk cut off at page three is not a walk that
     * finished: returning would mark it done and leave the rest of the table
     * unexamined until some later chain happened to come by. Released, it starts
     * again from the oldest row — every merge so far is committed and the next
     * pass finds nothing to redo — and chains the score when it actually ends.
     */
    if (cancelled) {
      throw new Error(`refine.dedup: cancelled after ${pages} pages, released to finish later`)
    }

    if (!pack.score) return
    await chain(ctx, deps.queue, {
      type: "refine.score",
      domainId: input.domainId,
      idempotencyKey: scoreJobKey(input.domainId, ctx.job.id),
    })
  }
}
