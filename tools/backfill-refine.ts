/**
 * Queue `refine.extract` for harvest runs that predate the chaining (P2.6).
 *
 * `harvest.run` now enqueues the extraction of what it just found, so from here
 * on the pipeline feeds itself. Everything harvested before that — Phase 1's
 * acceptance week, P1.6's Pantip and Maps runs, the golden corpus — has items in
 * `raw_items` and nothing pointing at them. This is the one-time sweep, and it is
 * also the recovery path for the one case where the chaining gives up: a harvest
 * whose follow-on enqueue failed succeeds anyway, deliberately, because re-running
 * it would re-spend a browser session to repair an INSERT. That decision is only
 * honest if the gap is findable afterwards without knowing it happened. This file
 * is what makes it findable: it reads the runs table, not a list of regrets.
 *
 * **Re-running it is safe and nearly free.** Two independent dedupes sit under it.
 * The job's idempotency key is `refine.extract:<domain>:<packVersion>:<runId>`, so
 * a second sweep collides with the first rather than queueing twice; and inside
 * the handler, `extract()` asks the sink which items it has already seen at this
 * pack version and skips them. Bumping `pack.version` defeats both at once, on
 * purpose — that is how a corrected prompt asks for its corpus back.
 *
 * **The rest of the pipeline follows on its own.** Each extraction queues the
 * domain's `refine.resolve`, which queues `refine.dedup`, which queues
 * `refine.score` (see `apps/worker/src/chain.ts`) — so this sweep is the only
 * thing an operator has to start. None of those three spends: resolve runs
 * Tiers 0 and 1 against our own tables and no runner has a Tier 2 key.
 *
 * **It queues spend rather than spending.** Nothing here calls a model. It writes
 * rows that a runner will later act on, which is worse than spending directly in
 * one specific way: the bill arrives somewhere else, later, attributed to a job
 * nobody remembers starting. So `--commit` is required, the default prints what it
 * would do, and both paths print the estimated cost first.
 *
 * Usage:
 *   npx tsx --env-file=.env tools/backfill-refine.ts <domainId> [--commit]
 *   ./tools/with-hosted-env.sh npx tsx tools/backfill-refine.ts travel --commit
 *
 * The second form is the one that matters: `DATABASE_URL` in `.env` points at
 * local Docker and must keep doing so. See `with-hosted-env.sh`.
 */

import { createPackRegistry } from "../apps/worker/src/packs.js"
import { refineJobKey } from "../apps/worker/src/refine.js"
import { RUN_LIST_LIMIT } from "../packages/samsara/harvest/src/ports.js"
import { PostgresHarvestRunStore } from "../packages/samsara/harvest/src/postgres.js"
import { PostgresJobStore } from "../packages/samsara/kernel/src/stores/postgres.js"
import { createDb } from "../packages/travel/db/src/index.js"

/**
 * Dollars per item, from the bake-off of 18 September 2026: `deepseek-v4-flash`
 * read 50 golden items for $0.0092. It is an estimate and is printed as one — the
 * golden items are forum posts of a particular length, and a corpus of Maps
 * reviews will not cost the same per item. It is here so that "queue 2,000 items"
 * is a sentence with a number attached rather than a shrug.
 */
const DOLLARS_PER_ITEM = 0.0092 / 50

function usage(message: string): never {
  console.error(`backfill-refine: ${message}`)
  console.error("usage: tools/backfill-refine.ts <domainId> [--commit]")
  process.exit(1)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const commit = args.includes("--commit")
  const domainId = args.find((a) => !a.startsWith("--"))
  if (!domainId) usage("a domainId is required")

  const url = process.env.DATABASE_URL
  if (!url) usage("DATABASE_URL is not set")

  // From the runner's own registry, not a literal. If this tool and the worker
  // disagreed about the pack version they would disagree about the idempotency
  // key, and the sweep would queue a duplicate of every job the chaining already
  // wrote — which is exactly the failure the key exists to prevent.
  const pack = createPackRegistry().get(domainId)
  if (!pack) usage(`no pack registered for "${domainId}"; nothing could extract those runs`)

  const database = createDb(url)
  try {
    const runs = new PostgresHarvestRunStore(database.db)
    const jobs = new PostgresJobStore(database.db)

    const all = await runs.list({ limit: RUN_LIST_LIMIT })
    if (all.length === RUN_LIST_LIMIT) {
      // The same refusal the handler makes about `ITEM_LIST_LIMIT`, for the same
      // reason: a bounded read that silently returns its bound cannot be told
      // apart from a complete one, and a backfill that quietly covered the newest
      // fifty runs would report success over the runs it never saw. `list` takes
      // no cursor, so the honest fix is a paged read on the port rather than a
      // larger number here — and until then, refusing is what keeps the gap
      // visible.
      console.error(
        `backfill-refine: the run list returned its ${RUN_LIST_LIMIT}-row bound, so older runs ` +
          "cannot be seen from here. Add a paged read to HarvestRunStore before sweeping.",
      )
      process.exit(1)
    }

    const targets = all.filter((run) => run.domainId === domainId && run.itemCount > 0)
    const items = targets.reduce((n, run) => n + run.itemCount, 0)

    console.log(`${all.length} run(s) in the table, ${targets.length} in "${domainId}" with items`)
    console.log(`${items} item(s), pack ${pack.id}@${pack.version}`)
    console.log(`estimated ~$${(items * DOLLARS_PER_ITEM).toFixed(4)} if every item is unread`)
    console.log("(items already extracted at this pack version are skipped by the handler)")

    if (!commit) {
      console.log("\n--commit not given, so nothing was queued. Runs that would be:")
      for (const run of targets) {
        console.log(`  ${run.id}  ${run.sourceId}  ${run.itemCount} item(s)  ${run.outcome}`)
      }
      return
    }

    let queued = 0
    let deduped = 0
    for (const run of targets) {
      const result = await jobs.enqueue({
        type: "refine.extract",
        domainId,
        idempotencyKey: refineJobKey(domainId, pack.version, run.id),
        payload: { domainId, harvestRunId: run.id },
        // Below a harvest, which is what a browser session is waiting on. A
        // backfill is by definition not urgent: its corpus has been sitting there
        // for a week.
        priority: -1,
      })
      if (result.deduped) deduped += 1
      else queued += 1
    }

    console.log(`\nqueued ${queued}, already queued ${deduped}`)
  } finally {
    await database.sql.end({ timeout: 5 })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
