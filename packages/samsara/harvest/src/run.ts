import { randomUUID } from "node:crypto"
import type { HarvestOutcome, SourceId } from "@samsara/core"
import {
  Blocked,
  err,
  type Failure,
  failure,
  type Kernel,
  type Logger,
  ok,
  type Result,
  type SessionSpend,
  silentLogger,
} from "@samsara/kernel"
import {
  type Capture,
  type CaptureContext,
  type CapturePersona,
  harvest,
  type ItemDraft,
  type SourceAdapter,
} from "@samsara/sources"
import { immediatePacer, type Pacer } from "./pace.js"
import type {
  CaptureArchive,
  ExperimentCell,
  HarvestRunStore,
  RawItemRow,
  RawItemStore,
} from "./store.js"

/**
 * One identity asking one source one question, once (plan section 3, `HarvestRun`).
 *
 * The orchestration exists to hold five things in the right order, and the order is
 * the whole content of this file:
 *
 * 1. The run row is written **before** the browser opens. A session that is killed
 *    mid-harvest — the normal residue of a cancelled Actions run under ADR-0014 —
 *    must leave a `running` row that somebody can reconcile, not nothing at all.
 * 2. The capture is archived **before** it is parsed. Parsing is the step most
 *    likely to throw on a page that changed shape overnight, and a throw that
 *    discards the bytes proving what changed turns a ten-minute fix into a
 *    re-harvest.
 * 3. Items are written before the run is marked `ok`, so `ok` never describes a
 *    run whose items are not there.
 * 4. The run is finished on every path, including the failures.
 * 5. The persona is told what happened, because a refusal is a health verdict and
 *    the whole ban detector is downstream of somebody recording one.
 */

/** The narrow slice of a persona store this needs. Not the whole port. */
export interface PersonaSink {
  recordSession(
    personaId: string,
    outturn: { minutes: number; outcome: "ok" | "blocked" | "error" | "timeout"; at: Date },
  ): Promise<void>
}

export interface HarvestDeps {
  kernel: Kernel
  runs: HarvestRunStore
  items: RawItemStore
  archive: CaptureArchive
  /**
   * Optional: a harvest against a memory store in a test has no persona rows to
   * update. Absent in production would be a bug, which is why the caller that
   * assembles this in `apps/worker` passes it unconditionally.
   */
  personas?: PersonaSink
  pacer?: Pacer
  logger?: Logger
  clock?: () => Date
  newId?: () => string
}

export interface HarvestInput {
  domainId: string
  persona: CapturePersona
  query: string
  /** Sticky egress and provider profile, when the persona has them. */
  proxySession?: string | null
  profileId?: string | null
  deadlineMs?: number
  attempts?: number
  /** On for the first runs of a new adapter, off by default (section 8). */
  recording?: boolean
  /**
   * The designed measurement this run is a cell of, when it is one.
   *
   * Passed straight through to the run row and looked at nowhere else here. A
   * harvest asked for by an experiment opens the same browser, asks the same
   * question and is paced by the same limiter as one somebody asked for by hand —
   * the pairing key is the only difference, and it exists so the series can be
   * drawn later, not so this function can behave differently.
   */
  experiment?: ExperimentCell | null
}

export interface HarvestReport {
  runId: string
  sourceId: SourceId
  outcome: HarvestOutcome
  itemCount: number
  /** Summed across attempts, including the ones that failed. */
  minutes: number
  sessions: number
  rawRef: string | null
  /** What refused, when something did. Never the page's own text. */
  refusedBy: string | null
}

export async function runHarvest<P>(
  adapter: SourceAdapter<P>,
  deps: HarvestDeps,
  input: HarvestInput,
): Promise<Result<HarvestReport, Failure>> {
  const logger = deps.logger ?? silentLogger
  const clock = deps.clock ?? (() => new Date())
  const newId = deps.newId ?? randomUUID
  const pacer = deps.pacer ?? immediatePacer

  if (input.query.trim().length === 0) {
    return err(failure("config", "harvest needs a query; an empty one asks the source nothing"))
  }

  const runId = newId()
  const spends: SessionSpend[] = []
  // A holder rather than two `let`s: the assignments happen inside the callback,
  // which TypeScript's control-flow analysis cannot see, so a plain `let` stays
  // narrowed to `null` and every later use is an error about `never`. Reading
  // through a property resets that narrowing at the `withBrowser` call.
  const held: { capture: Capture<P> | null; drafts: readonly ItemDraft[] } = {
    capture: null,
    drafts: [],
  }

  const result = await deps.kernel.withBrowser(
    "harvest",
    {
      country: input.persona.country,
      locale: input.persona.locale,
      timezoneId: input.persona.timezoneId,
      personaId: input.persona.id,
      domainId: input.domainId,
      ...(input.proxySession ? { proxySession: input.proxySession } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.deadlineMs ? { deadlineMs: input.deadlineMs } : {}),
      ...(input.recording ? { recording: true } : {}),
      ...(input.attempts ? { attempts: input.attempts } : {}),
      onSession: (spend) => spends.push(spend),
    },
    async (page, signal) => {
      // Inside the session, so a slow source is paced against the deadline that is
      // already running rather than in addition to it. Outside, a pacer that waits
      // 30 seconds would silently add 30 seconds to every harvest's wall clock and
      // nothing would attribute it.
      await pacer.wait(adapter.id, signal)

      const ctx: CaptureContext = { page, persona: input.persona, logger, signal }
      const attempt = await harvest(adapter, ctx, input.query)

      // Thrown from inside the callback so the kernel classifies it and the retry
      // policy sees it: `blocked` is the one kind `retry.ts` refuses to retry,
      // because asking again only teaches the source that this identity retries.
      if (attempt.capture.refusedBy) {
        held.capture = attempt.capture
        throw new Blocked(attempt.capture.refusedBy)
      }

      held.capture = attempt.capture
      held.drafts = attempt.items
      return attempt
    },
  )

  const endedAt = clock()
  const minutes = spends.reduce((sum, s) => sum + s.minutes, 0)
  const sessionId = spends[spends.length - 1]?.sessionId ?? null

  // Written now rather than before the launch, because `sessionId` is the column
  // that makes a run traceable and it does not exist until a session has opened.
  // The cost is the one stated in the header — a run killed between the launch and
  // here leaves a session row and no harvest row — and that is the right trade:
  // the session row is the one that carries the *bill*, and an unbilled orphan
  // harvest row is bookkeeping, while an unattributed session is money.
  await deps.runs.start({
    id: runId,
    domainId: input.domainId,
    personaId: input.persona.id,
    sourceId: adapter.id,
    query: input.query,
    sessionId: sessionId ?? runId,
    startedAt: spends[0] ? new Date(endedAt.getTime() - minutes * 60_000) : endedAt,
    experiment: input.experiment ?? null,
  })

  // Archive first, parse second — even on the failure path. A refused capture is
  // the most valuable artefact a harvest produces, because it is the evidence for
  // what the viewpoint was refused by.
  let rawRef: string | null = null
  let archiveFailed = false
  const capture = held.capture
  if (capture) {
    try {
      rawRef = await deps.archive.put(runId, capture)
    } catch {
      // Fatal to the run, which is not the obvious call, so: `rawRef` is a
      // required column, and an item stored without one can never be re-extracted
      // — it is a row that looks like evidence and can never be re-read when the
      // extraction model changes, which is the entire reason captures are stored.
      // Writing those rows would trade a loud outage for a quiet corruption.
      //
      // The cost is that a bucket outage re-spends browser minutes on retry. That
      // is accepted: the alternative is making `rawRef` nullable, which makes
      // every downstream reader handle a case that exists only because storage was
      // briefly down.
      archiveFailed = true
      logger.emit({
        at: endedAt.toISOString(),
        event: "attempt.failed",
        purpose: "harvest",
        kind: "internal",
        message: "capture archive failed; items not written",
        attempts: spends.length,
      })
    }
  }

  const outcome: HarvestOutcome = archiveFailed
    ? "error"
    : !result.ok
      ? result.error.kind === "blocked"
        ? "blocked"
        : "error"
      : held.drafts.length === 0
        ? "empty"
        : "ok"

  let rows: RawItemRow[] = []
  if (result.ok && capture && rawRef !== null) {
    // The index *is* the rank: `parse` returns what the surface showed, in the
    // order it showed it, and this is the last place that order still exists.
    // Everything downstream reads rows back from Postgres, where insertion order
    // is not a promise.
    rows = held.drafts.map((draft, rank) => ({
      id: newId(),
      harvestRunId: runId,
      sourceId: adapter.id,
      rank,
      url: draft.url,
      title: draft.title,
      text: draft.text,
      languageGuess: draft.languageGuess,
      mediaRefs: draft.mediaRefs,
      engagement: draft.engagement,
      capturedAt: capture.capturedAt,
      rawRef,
    }))
    if (rows.length > 0) await deps.items.insertMany(rows)
  }

  await deps.runs.finish(runId, outcome, rows.length, endedAt)

  // The persona hears about it whatever happened. A harvest that refuses to record
  // a refusal is a harvest that keeps a banned identity in rotation.
  if (deps.personas) {
    for (const spend of spends) {
      const verdict =
        spend.outcome === "ok" || spend.outcome === "blocked" || spend.outcome === "timeout"
          ? spend.outcome
          : "error"
      await deps.personas.recordSession(input.persona.id, {
        minutes: spend.minutes,
        outcome: verdict,
        at: endedAt,
      })
    }
  }

  const report: HarvestReport = {
    runId,
    sourceId: adapter.id,
    outcome,
    itemCount: rows.length,
    minutes,
    sessions: spends.length,
    rawRef,
    refusedBy: capture?.refusedBy ?? null,
  }

  // A refusal is a *result*, not an error: it is reported as `ok` with an outcome
  // of `blocked`, because the caller asked what happened and this is what happened.
  // Only a failure that left us knowing nothing — a provider outage, a timeout with
  // no capture, bytes we could not store — comes back as `err`.
  if (archiveFailed) {
    return err(
      failure("internal", `capture archive failed for run ${runId}; no items were written`),
    )
  }
  if (!result.ok && outcome !== "blocked") return err(result.error)
  return ok(report)
}
