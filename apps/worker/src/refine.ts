import type { HarvestRunStore, RawItemStore } from "@samsara/harvest"
import { ITEM_LIST_LIMIT } from "@samsara/harvest"
import type { LlmClient } from "@samsara/llm"
import type { ExtractItem, MentionSink } from "@samsara/refine"
import { extract } from "@samsara/refine"
import { chain, type Queue } from "./chain.js"
import type { JobHandler } from "./handlers.js"
import { resolveJobKey } from "./resolve.js"

/**
 * The `refine.extract` job type: one harvest run's items, read by a model.
 *
 * **One handler for every domain**, like `harvest.run`, and for the same reason.
 * The pack arrives through `ctx.packs` keyed by the payload's `domainId`, so the
 * only travel-specific thing in the path is a line in `packs.ts`. A
 * `refine.extract.travel` job type would be the seam breaking where nothing
 * typechecks it.
 *
 * **Scoped to a run rather than to "whatever is unextracted".** A scan is a job
 * that is allowed to take a minute and this is not that job — but the real reason
 * is P2.6: the pipeline is `harvest.run -> refine.extract` chained through the
 * queue, so the unit of work has to be the thing a harvest produces. A backfill
 * over old runs is then N of these jobs, each individually retryable, rather than
 * one job that gets further each time it is killed.
 *
 * **Re-running is safe and nearly free.** `extract()` asks the sink which items it
 * has already seen at this pack version and skips them, so a retried job pays only
 * for what the first attempt did not finish. Bumping `pack.version` is how a
 * changed prompt asks for its corpus back.
 */

/**
 * The idempotency key for one run's extraction, and the pack version is in it
 * deliberately.
 *
 * `jobs.idempotency_key` is a permanent unique index: it collides against
 * succeeded and dead rows, not only queued ones. So `refine.extract:<runId>`
 * would mean a run can be extracted exactly once *ever*, and a corrected prompt
 * could never ask for its corpus back through the queue — the one recovery the
 * pack version exists to provide would be the one the queue forbids.
 *
 * Keying on the version instead makes the queue agree with `extract()`, which
 * already skips on `(domainId, packVersion, rawItemId)`. Bump `pack.version` and
 * both the job and the mentions want doing again, in the same breath, without
 * anything else in the system having to know that rule.
 */
/** An extraction batch's answer cap; see the call below for why it is not the default. */
export const EXTRACT_MAX_OUTPUT_TOKENS = 16_000

export const refineJobKey = (domainId: string, packVersion: string, harvestRunId: string): string =>
  `refine.extract:${domainId}:${packVersion}:${harvestRunId}`

export interface RefinePayload {
  domainId: string
  harvestRunId: string
}

/**
 * Payload validation, in the handler — same reasoning as `harvest.run`. The queue
 * column is `jsonb` and anything holding the connection string can write a row, so
 * a hand-written `INSERT` with a typo must not become a model call against
 * `undefined` at a dollar a thousand items.
 */
function parsePayload(raw: unknown): RefinePayload {
  const p = (raw ?? {}) as Partial<RefinePayload>
  for (const key of ["domainId", "harvestRunId"] as const) {
    const value = p[key]
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`refine.extract: payload.${key} must be a non-empty string`)
    }
  }
  return { domainId: p.domainId as string, harvestRunId: p.harvestRunId as string }
}

export interface RefineHandlerDeps {
  runs: Pick<HarvestRunStore, "byId">
  items: Pick<RawItemStore, "listByRun">
  sink: MentionSink
  /**
   * Absent when the runner booted without `OPENROUTER_API_KEY`.
   *
   * Optional for the same reason the browser launcher is: the rest of the runner
   * is exercisable without a provider key, and a process that refuses to boot
   * without one makes the no-op job untestable in CI. A keyless runner claims this
   * job and fails it by name, which is louder than never claiming it — a job
   * nobody claims looks identical to a queue that is empty.
   */
  llm?: LlmClient
  /**
   * Where the resolve job is queued once this run's mentions are written.
   * Absent, nothing is chained — which is how the tests and the bake-off call it.
   */
  queue?: Queue
}

export function createRefineHandler(deps: RefineHandlerDeps): JobHandler {
  return async (ctx) => {
    const input = parsePayload(ctx.job.payload)

    if (!deps.llm) {
      // `config`, so not retried: a missing key will not appear in thirty seconds.
      throw new Error("refine.extract: OPENROUTER_API_KEY is not set, so no model can be called")
    }

    // Throws and names the registered ids. A job carrying a domain nobody
    // registered means the runner shipped without the pack.
    const pack = ctx.packs.require(input.domainId)

    const run = await deps.runs.byId(input.harvestRunId)
    if (!run) throw new Error(`refine.extract: no such harvest run: ${input.harvestRunId}`)
    if (run.domainId !== input.domainId) {
      // Not pedantry. The pack decides the schema the mentions are stored under
      // and the version the skip is keyed on, so extracting a run under the wrong
      // domain writes rows that look extracted and can never be corrected by
      // re-running — `extractedIds` would report them as already done.
      throw new Error(
        `refine.extract: run ${run.id} belongs to domain ${run.domainId}, not ${input.domainId}`,
      )
    }

    const rows = await deps.items.listByRun(input.harvestRunId, ITEM_LIST_LIMIT)
    if (rows.length < run.itemCount) {
      // `listByRun` is bounded by `ITEM_LIST_LIMIT`, a bound written for a Lab
      // screen a person scrolls. Extracting the first hundred and stopping would
      // be worse than refusing: the skip query is keyed per item, so the run would
      // read as done and the remainder would never be revisited. When a source
      // starts returning more than this, the fix is a paged read on the port, not
      // a bigger number here.
      throw new Error(
        `refine.extract: run ${run.id} recorded ${run.itemCount} items but the store returned ` +
          `${rows.length}; the ${ITEM_LIST_LIMIT}-item read bound cannot cover this run`,
      )
    }

    if (rows.length === 0) {
      // A blocked or empty harvest. Not a failure of this job — there is simply
      // nothing to read, and spending a call to discover that is the mistake.
      await ctx.heartbeat(`run ${run.id} has no items to extract`)
      return
    }

    await ctx.heartbeat(`extracting ${rows.length} items from run ${run.id}`)

    const items: ExtractItem[] = rows.map((row) => ({
      id: row.id,
      sourceId: row.sourceId,
      url: row.url,
      title: row.title,
      text: row.text,
      languageGuess: row.languageGuess,
    }))

    const report = await extract({
      pack,
      llm: deps.llm,
      items,
      sink: deps.sink,
      // Harvested public forum posts are the exact case ADR-0012 allows a `:free`
      // route for, and this handler reads `raw_items`, which is public content by
      // construction. Said explicitly rather than left to the `private` default,
      // because the default is the careful one and this is the one place where the
      // careful answer is also the wrong description of the data. The day anything
      // routes a user's own text through here, this line is the one to find.
      sensitivity: "public",
      scope: { purpose: "refine", runId: run.id },
      // Double `complete()`'s default. A batch of ten short YouTube items already
      // answers in ~5,700 output tokens on deepseek-v4-flash (29–30 September hosted
      // logs), so a batch of long Thai ones overran 8,000 and failed as `config`,
      // which is not retried. Output tokens are the cheap side of this call.
      maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
    })

    // Counts only, no text: ADR-0014 puts this log in a public Actions run. The
    // per-attempt token and dollar metering already happened inside `complete()`.
    await ctx.heartbeat(
      `run ${run.id}: ${report.mentions} mentions from ${report.sent} items ` +
        `(${report.skipped} already done, ${report.invalid} invalid, ` +
        `${report.calls} calls for ${report.batches} batches)`,
    )

    if (report.failures.length > 0) {
      // `extract()` swallows call failures and returns an ordinary-looking report —
      // the bake-off lost a whole measurement to exactly that, and a silent
      // partial extraction here would mark the run done with half its items
      // unread. Failing the job is what puts the items back in reach of a retry.
      const summary = report.failures.map((f) => `${f.kind}×${f.count}`).join(", ")
      throw new Error(
        `refine.extract: run ${run.id} left ${report.failures.reduce((n, f) => n + f.count, 0)} ` +
          `items unextracted (${summary})`,
      )
    }

    // After the failure check, so a partial extraction is retried before the
    // corpus moves on. A pack that cannot resolve has nowhere to send it.
    if (!pack.resolve) return
    await chain(ctx, deps.queue, {
      type: "refine.resolve",
      domainId: input.domainId,
      idempotencyKey: resolveJobKey(input.domainId, ctx.job.id),
    })
  }
}
