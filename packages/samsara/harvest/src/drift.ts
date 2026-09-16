import type { HarvestOutcome } from "@samsara/core"
import { meanRankShift, type OverlapAtK, overlapAt } from "./overlap.js"
import type { DriftExperimentRecord, HarvestRunRecord } from "./ports.js"

/**
 * The drift experiment (P1.8): the same question, the same two identities, once a
 * day, for seven days — and the arithmetic that turns what came back into a line.
 *
 * Two pure functions and no I/O, for the reason `./overlap` is a separate entry
 * point: the schedule is written by a Worker under a 10 ms CPU ceiling that cannot
 * load Playwright, and the series is read by the same one. Everything here is
 * data-in, data-out, so all of it is tested without a database, a browser or a
 * clock that has to be faked.
 *
 * **Why an experiment is fourteen queued rows and not a recurring tick.** The
 * obvious design is a job that runs, does today's pair, and enqueues tomorrow's.
 * It is one row instead of fourteen and it is wrong here: the chain has a single
 * point of failure at every link, and under ADR-0014 a scheduled runner can be
 * cancelled between any two statements. A chain that breaks on day 3 loses days 4
 * to 7 silently — there is no row left that was ever going to ask. Enqueuing the
 * whole plan up front makes a dead runner produce *late* days rather than missing
 * ones, because `jobs.run_after` is already the column that holds work until its
 * time and the claim query already orders by it.
 *
 * The cost is that the plan cannot be changed once it is queued, only stopped.
 * That is the right way round for something that spends browser minutes.
 */

/** One queued harvest: which day, which identity, and when it becomes claimable. */
export interface DriftRunPlan {
  day: number
  personaId: string
  /** Not before this. The queue holds it; the runner may still be late. */
  runAfter: Date
  /**
   * Stable across re-planning, which is what makes creating the same experiment
   * twice cost nothing. The queue's unique index on `idempotency_key` does the
   * refusing; nothing here has to check first.
   */
  idempotencyKey: string
}

export const driftIdempotencyKey = (experimentId: string, day: number, personaId: string): string =>
  `drift:${experimentId}:${day}:${personaId}`

/** When day `n` becomes claimable. Anchored to the plan, never to "now". */
export const driftDayDueAt = (experiment: DriftExperimentRecord, day: number): Date =>
  new Date(experiment.startedAt.getTime() + day * experiment.intervalMinutes * 60_000)

/**
 * Every run the experiment will ever ask for, in the order they become due.
 *
 * **Day-major, and the two identities adjacent.** The runner drains one job at a
 * time (the workflow's concurrency group), so the pair for a day is asked minutes
 * apart rather than hours. That matters more than it looks: a ranked surface
 * reshuffles itself through the day, and two sides of a comparison separated by an
 * afternoon measure the afternoon as well as the viewpoint. Interleaving by
 * identity instead — all of A's week, then all of B's — would make every point on
 * the plot a comparison between two different days.
 *
 * **Anchored to `startedAt`, not to the previous run.** Each day's `runAfter` is
 * `startedAt + day × interval`, so a day that fires six hours late does not push
 * the rest of the week six hours later. Seven daily ticks stay a week rather than
 * becoming eight days. What the plot draws is still the *actual* time each run
 * started, per ADR-0014 — the schedule says when it was asked for, and the run row
 * says when it happened, and the two are allowed to differ visibly.
 */
export function planDriftRuns(experiment: DriftExperimentRecord): DriftRunPlan[] {
  const plans: DriftRunPlan[] = []
  for (let day = 0; day < experiment.days; day++) {
    const runAfter = driftDayDueAt(experiment, day)
    for (const personaId of [experiment.personaAId, experiment.personaBId]) {
      plans.push({
        day,
        personaId,
        runAfter,
        idempotencyKey: driftIdempotencyKey(experiment.id, day, personaId),
      })
    }
  }
  return plans
}

/** One side of one day: the run that happened, without the items it produced. */
export interface DriftRun {
  runId: string
  personaId: string
  outcome: HarvestOutcome
  itemCount: number
  startedAt: Date
  endedAt: Date | null
}

/**
 * What a day is, and the four things it can be.
 *
 * The distinction this carries is the whole reason the series is not an array of
 * numbers. Every state below would otherwise be plotted as a zero, and a zero on
 * this chart means "the two identities agreed on nothing" — the single most
 * interesting finding the experiment can produce. Three of the four states are
 * *absence of a measurement*, and drawing them as the finding would manufacture it.
 *
 * - `pending` — not due yet. Nothing has gone wrong.
 * - `missing` — due, and one or both sides have no run. The schedule did not fire,
 *   or the persona was banned, or the runner never woke. A hole, and visible.
 * - `empty` — both ran, and there is nothing to compare: one of them came back
 *   with no items, so `comparable` is 0. The overlap figure is 0 and it is not a
 *   measurement.
 * - `compared` — both ran, both returned items, the number means what it says.
 */
export type DriftPointState = "pending" | "missing" | "empty" | "compared"

export interface DriftPoint {
  day: number
  /** When the plan asked for this day. */
  dueAt: Date
  /**
   * When it actually happened: the later of the two runs' start times, or null.
   *
   * The later rather than the earlier, because a pair is only complete once both
   * sides have asked, and this is the x-axis of a plot whose point is that the
   * schedule is best-effort. A day that fired eighteen hours late should sit
   * eighteen hours late on the chart, not where it was meant to be.
   */
  measuredAt: Date | null
  a: DriftRun | null
  b: DriftRun | null
  /** Null unless both sides ran. Never 0 standing in for "we did not ask". */
  overlap: OverlapAtK | null
  /**
   * How far the shared results moved, among those that survived.
   *
   * Carried beside the overlap because the two answer different questions and the
   * headline one cannot tell "the same twenty, reordered" from "the same twenty".
   * For a drift measurement that distinction is the finding: a week of 0.95
   * overlap with a mean shift of 8 is a surface reshuffling itself daily, which
   * reads nothing like a week of 0.95 overlap with a shift of 0.
   */
  meanRankShift: number | null
  state: DriftPointState
}

export interface DriftSummary {
  /** Days whose state is `compared` — the only ones the mean is taken over. */
  comparedDays: number
  /** Days that were due and did not produce a pair. */
  missingDays: number
  /** Mean overlap across compared days, or null when there are none. */
  meanOverlap: number | null
  /**
   * Spread of the compared days: `max - min`.
   *
   * The number the gate actually wants a second look at. A mean of 0.3 across
   * seven days that ranged 0.28–0.32 is a stable effect; the same mean across days
   * that ranged 0.05–0.62 is a surface that happens to average to an effect, and
   * the plan's threshold would read the same in both cases.
   */
  spread: number | null
  /** True once the last day is due. Derived here rather than stored. */
  complete: boolean
}

export interface DriftSeries {
  k: number
  points: DriftPoint[]
  summary: DriftSummary
}

const toRun = (run: HarvestRunRecord): DriftRun => ({
  runId: run.id,
  personaId: run.personaId,
  outcome: run.outcome,
  itemCount: run.itemCount,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
})

/**
 * The plan, plus what came back, as one line per day.
 *
 * `runs` is every run carrying this experiment's id; `urlsByRun` is the ranked
 * identifiers for those runs, already bounded to k by whoever read them. Both are
 * handed in rather than fetched, so this whole file is testable without a database
 * and so the caller — a Worker with a query budget — decides how many round trips
 * the plot costs.
 *
 * **The first run per side per day wins.** A retried job can produce a second run
 * for the same cell, and the honest choice is the one that was asked at the time
 * the plan asked for it. Taking the newest instead would let a retry that landed
 * hours later be compared against a sibling that ran on time.
 */
export function driftSeries(
  experiment: DriftExperimentRecord,
  runs: readonly HarvestRunRecord[],
  urlsByRun: ReadonlyMap<string, readonly string[]>,
  k: number,
  now: Date,
): DriftSeries {
  const byDay = new Map<number, HarvestRunRecord[]>()
  for (const run of runs) {
    if (run.experiment === null || run.experiment.id !== experiment.id) continue
    const bucket = byDay.get(run.experiment.day)
    if (bucket) bucket.push(run)
    else byDay.set(run.experiment.day, [run])
  }

  const points: DriftPoint[] = []
  for (let day = 0; day < experiment.days; day++) {
    const dueAt = driftDayDueAt(experiment, day)
    const bucket = (byDay.get(day) ?? [])
      .slice()
      .sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime())
    const pick = (personaId: string) => bucket.find((r) => r.personaId === personaId) ?? null
    const aRun = pick(experiment.personaAId)
    const bRun = pick(experiment.personaBId)

    if (!aRun || !bRun) {
      points.push({
        day,
        dueAt,
        measuredAt: null,
        a: aRun ? toRun(aRun) : null,
        b: bRun ? toRun(bRun) : null,
        overlap: null,
        meanRankShift: null,
        // Due and incomplete is a hole; not yet due is just Tuesday.
        state: dueAt.getTime() <= now.getTime() ? "missing" : "pending",
      })
      continue
    }

    const left = urlsByRun.get(aRun.id) ?? []
    const right = urlsByRun.get(bRun.id) ?? []
    const overlap = overlapAt(left, right, k)
    points.push({
      day,
      dueAt,
      measuredAt: new Date(Math.max(aRun.startedAt.getTime(), bRun.startedAt.getTime())),
      a: toRun(aRun),
      b: toRun(bRun),
      overlap,
      meanRankShift: meanRankShift(left, right, k),
      // `comparable === 0` is a page that came back with nothing, and `overlapAt`
      // reports 0 for it — arithmetically right, and a lie as a plotted point.
      state: overlap.comparable === 0 ? "empty" : "compared",
    })
  }

  const compared = points.filter((p) => p.state === "compared")
  const overlaps = compared.map((p) => p.overlap?.overlap ?? 0)
  return {
    k,
    points,
    summary: {
      comparedDays: compared.length,
      missingDays: points.filter((p) => p.state === "missing").length,
      meanOverlap:
        overlaps.length === 0 ? null : overlaps.reduce((s, v) => s + v, 0) / overlaps.length,
      spread: overlaps.length === 0 ? null : Math.max(...overlaps) - Math.min(...overlaps),
      complete: driftDayDueAt(experiment, experiment.days - 1).getTime() <= now.getTime(),
    },
  }
}
