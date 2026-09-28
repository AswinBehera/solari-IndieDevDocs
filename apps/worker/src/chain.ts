import type { JobStore } from "@samsara/kernel"
import type { JobContext } from "./handlers.js"

/**
 * How one refine stage hands the corpus to the next.
 *
 * P2.6 chained `harvest.run -> refine.extract` and stopped there, which left
 * three registered handlers that nothing ever enqueued: resolve, dedup and score
 * were stages that ran in a test and nowhere else. This is the rest of the
 * chain, and it is deliberately the same shape as the first link — the stage
 * that just finished queues the one after it, through the same `jobs` table,
 * with an idempotency key.
 *
 * **Which stage comes next is read off the pack, not written down here.** A pack
 * with no `resolve` spec stops after extraction; one with no `dedupKeys` goes
 * from resolve straight to score; one with no `score` spec stops after dedup.
 * The engine's order is fixed and the pack's declarations decide how much of it
 * applies, which is the same rule the stages themselves already follow when they
 * refuse a pack by name.
 */

/** What a chaining handler needs from the queue. Absent means "do not chain". */
export type Queue = Pick<JobStore, "enqueue">

export interface NextStage {
  type: string
  domainId: string
  idempotencyKey: string
}

/**
 * Queue the stage after this one, and never fail the job that did the work.
 *
 * Not fatal, for a reason that is stronger here than it was for `harvest.run`.
 * Resolve, dedup and score are all scoped to a *domain*, not to the job that
 * queued them: each drains the whole pending queue or walks the whole entity
 * table. So a link that fails to enqueue is covered by the next link that
 * succeeds, from any run, and failing the upstream job instead would retry work
 * that is already committed in order to repair one INSERT.
 *
 * The window in every key is the upstream job's id. Not the harvest run's id,
 * which is what `resolveJobKey`'s comment first suggested: `refine.extract`'s own
 * key carries the pack version, so bumping it extracts a run a second time, and a
 * resolve keyed on the run would collide with the first extraction's succeeded
 * row and never run. A job id is one per upstream job and stable across that
 * job's retries, which is exactly the dedupe a chain wants.
 */
export async function chain(
  ctx: JobContext,
  queue: Queue | undefined,
  next: NextStage,
): Promise<void> {
  if (!queue) return
  try {
    const { deduped } = await queue.enqueue({
      type: next.type,
      domainId: next.domainId,
      idempotencyKey: next.idempotencyKey,
      payload: { domainId: next.domainId },
    })
    await ctx.heartbeat(
      deduped ? `${next.type} for ${next.domainId} was already queued` : `queued ${next.type}`,
    )
  } catch (error) {
    // The error's class only, never its message, which may carry a connection
    // string — the same rule as the harvest chain, for the same public log.
    const kind = error instanceof Error ? error.name : "unknown"
    await ctx.heartbeat(`could not queue ${next.type} (${kind}); the next chain covers it`)
  }
}
