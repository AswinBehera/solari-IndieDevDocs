import { describe, expect, it } from "vitest"
import { driftIdempotencyKey, driftSeries, planDriftRuns } from "./drift.js"
import { overlapAt } from "./overlap.js"
import type { DriftExperimentRecord, HarvestRunRecord } from "./ports.js"

/**
 * The drift experiment's two pure halves: the week it plans, and the line it draws.
 *
 * Most of what follows is about the second half refusing to draw a point. The plot
 * has one y-axis and it means "how much did these two identities agree", and on
 * that axis a day nobody ran, a day that came back empty and a day where the two
 * genuinely shared nothing all render as zero. Only the last of those is a finding.
 * Everything else here is the plan being anchored to its own start rather than to
 * whenever the previous day happened to finish.
 */

const startedAt = new Date("2026-09-16T08:00:00.000Z")

const experiment = (over: Partial<DriftExperimentRecord> = {}): DriftExperimentRecord => ({
  id: "exp-1",
  domainId: "atlas",
  ownerId: "owner-1",
  sourceId: "fake.search",
  query: "ของกินอร่อย",
  personaAId: "persona-a",
  personaBId: "persona-b",
  days: 7,
  k: 20,
  intervalMinutes: 1440,
  startedAt,
  state: "running",
  ...over,
})

const run = (
  over: Partial<HarvestRunRecord> & { id: string; personaId: string },
): HarvestRunRecord => ({
  domainId: "atlas",
  sourceId: "fake.search",
  query: "ของกินอร่อย",
  sessionId: `session-${over.id}`,
  startedAt,
  endedAt: null,
  outcome: "ok",
  itemCount: 0,
  experiment: { id: "exp-1", day: 0 },
  ...over,
})

/** Both sides of one day, at the hour the plan asked for. */
const day = (
  n: number,
  over: { a?: Partial<HarvestRunRecord>; b?: Partial<HarvestRunRecord> } = {},
) => {
  const at = new Date(startedAt.getTime() + n * 1440 * 60_000)
  return [
    run({
      id: `a${n}`,
      personaId: "persona-a",
      startedAt: at,
      experiment: { id: "exp-1", day: n },
      itemCount: 2,
      ...over.a,
    }),
    run({
      id: `b${n}`,
      personaId: "persona-b",
      startedAt: at,
      experiment: { id: "exp-1", day: n },
      itemCount: 2,
      ...over.b,
    }),
  ]
}

const urls = (pairs: Record<string, string[]>) => new Map(Object.entries(pairs))

const later = new Date("2026-10-01T00:00:00.000Z")

describe("planning the week", () => {
  it("queues every day of it up front, both identities", () => {
    // Not a job that enqueues tomorrow when today finishes. That chain breaks once
    // and loses the rest of the week with nothing left in the queue to notice.
    const plans = planDriftRuns(experiment())
    expect(plans).toHaveLength(14)
    expect(new Set(plans.map((p) => p.idempotencyKey)).size).toBe(14)
  })

  it("puts the two identities next to each other, day by day", () => {
    const plans = planDriftRuns(experiment({ days: 3 }))
    expect(plans.map((p) => `${p.day}${p.personaId.at(-1)}`)).toEqual([
      "0a",
      "0b",
      "1a",
      "1b",
      "2a",
      "2b",
    ])
    // The pair for a day shares an hour. Asking one side in the morning and the
    // other at night would measure the afternoon along with the viewpoint.
    expect(plans[0]?.runAfter).toEqual(plans[1]?.runAfter)
  })

  it("anchors each day to the start, so a late day does not push the rest", () => {
    const plans = planDriftRuns(experiment({ days: 7 }))
    expect(plans.at(-1)?.runAfter).toEqual(new Date("2026-09-22T08:00:00.000Z"))
    // Six intervals after the start, not seven runs after each other: a week of
    // daily measurements has to stay a week even when three of them fire late.
    expect((plans.at(-1)?.runAfter.getTime() ?? 0) - startedAt.getTime()).toBe(6 * 1440 * 60_000)
  })

  it("honours an interval short enough to demonstrate", () => {
    // `intervalMinutes` is a column so the whole thing can be exercised end to end
    // in ten minutes. A week hard-coded would be provable only by faking a clock.
    const plans = planDriftRuns(experiment({ days: 3, intervalMinutes: 5 }))
    expect(plans.at(-1)?.runAfter).toEqual(new Date("2026-09-16T08:10:00.000Z"))
  })

  it("keys each cell by experiment, day and identity", () => {
    const [first] = planDriftRuns(experiment())
    expect(first?.idempotencyKey).toBe(driftIdempotencyKey("exp-1", 0, "persona-a"))
    // Stable across re-planning, which is what makes creating the same experiment
    // twice cost nothing: the queue's unique index refuses the second set.
    expect(planDriftRuns(experiment())[0]?.idempotencyKey).toBe(first?.idempotencyKey)
  })
})

describe("drawing the series", () => {
  it("reports the figure the engine's own primitive does", () => {
    const e = experiment({ days: 1 })
    const runs = day(0)
    const u = urls({
      a0: ["https://x.test/1", "https://x.test/2"],
      b0: ["https://x.test/2", "https://x.test/9"],
    })
    const series = driftSeries(e, runs, u, 20, later)
    expect(series.points[0]?.overlap).toEqual(
      overlapAt(
        ["https://x.test/1", "https://x.test/2"],
        ["https://x.test/2", "https://x.test/9"],
        20,
      ),
    )
    expect(series.points[0]?.state).toBe("compared")
  })

  it("calls a day that has not come round yet pending, not missing", () => {
    const e = experiment({ days: 3 })
    const now = new Date(startedAt.getTime() + 60_000)
    const series = driftSeries(e, day(0), urls({ a0: ["u1"], b0: ["u1"] }), 20, now)
    expect(series.points.map((p) => p.state)).toEqual(["compared", "pending", "pending"])
    // A week in progress is not a week with holes in it, and the summary has to
    // say so or every experiment looks broken for its first six days.
    expect(series.summary.missingDays).toBe(0)
    expect(series.summary.complete).toBe(false)
  })

  it("calls a day that was due and never ran missing, and leaves its overlap null", () => {
    const e = experiment({ days: 2 })
    const series = driftSeries(e, day(0), urls({ a0: ["u1"], b0: ["u1"] }), 20, later)
    const [, second] = series.points
    expect(second?.state).toBe("missing")
    // Null rather than 0. Zero is the most interesting reading this experiment can
    // produce — two identities shown nothing in common — and a day the scheduler
    // slept through must not be able to manufacture it.
    expect(second?.overlap).toBeNull()
    expect(second?.meanRankShift).toBeNull()
    expect(series.summary.missingDays).toBe(1)
  })

  it("calls a day missing when only one side ran", () => {
    const e = experiment({ days: 1 })
    const [a] = day(0)
    const series = driftSeries(e, a ? [a] : [], urls({ a0: ["u1"] }), 20, later)
    expect(series.points[0]?.state).toBe("missing")
    // The side that did run is still carried, because "B was banned on Thursday"
    // is the explanation for the hole and belongs next to it.
    expect(series.points[0]?.a?.runId).toBe("a0")
    expect(series.points[0]?.b).toBeNull()
  })

  it("separates a day with nothing to compare from a day of no agreement", () => {
    const e = experiment({ days: 2 })
    const runs = [...day(0), ...day(1, { b: { outcome: "blocked", itemCount: 0 } })]
    const u = urls({ a0: ["u1"], b0: ["u2"], a1: ["u1"] })
    const series = driftSeries(e, runs, u, 20, later)
    // Day 0: both ran, both returned something, and they shared none of it. That
    // is a real 0.
    expect(series.points[0]?.state).toBe("compared")
    expect(series.points[0]?.overlap?.overlap).toBe(0)
    // Day 1: B was blocked and returned nothing. `overlapAt` says 0 here too,
    // arithmetically correctly and as a plotted point dishonestly.
    expect(series.points[1]?.state).toBe("empty")
    expect(series.points[1]?.overlap?.comparable).toBe(0)
    expect(series.summary.comparedDays).toBe(1)
    expect(series.summary.meanOverlap).toBe(0)
  })

  it("averages and spreads only over the days it actually compared", () => {
    const e = experiment({ days: 3 })
    const runs = [...day(0), ...day(2)]
    const u = urls({
      a0: ["u1", "u2"],
      b0: ["u1", "u2"],
      a2: ["u1", "u2"],
      b2: ["u3", "u4"],
    })
    const series = driftSeries(e, runs, u, 20, later)
    expect(series.summary.comparedDays).toBe(2)
    expect(series.summary.missingDays).toBe(1)
    expect(series.summary.meanOverlap).toBe(0.5)
    // A mean of 0.5 that ranges 0 to 1 is not the same finding as a mean of 0.5
    // that never left 0.5, and the plan's threshold cannot tell them apart.
    expect(series.summary.spread).toBe(1)
  })

  it("has no mean at all when nothing was compared", () => {
    const series = driftSeries(experiment({ days: 2 }), [], new Map(), 20, later)
    expect(series.summary.meanOverlap).toBeNull()
    expect(series.summary.spread).toBeNull()
  })

  it("plots each day where it actually happened, not where it was asked for", () => {
    const e = experiment({ days: 1 })
    const late = new Date(startedAt.getTime() + 18 * 3_600_000)
    const runs = day(0, { b: { startedAt: late } })
    const point = driftSeries(e, runs, urls({ a0: ["u1"], b0: ["u1"] }), 20, later).points[0]
    expect(point?.dueAt).toEqual(startedAt)
    // The later of the two, because a pair is only complete once both sides asked —
    // and under ADR-0014 the gap between asked-for and happened is the thing the
    // chart is allowed to show rather than hide.
    expect(point?.measuredAt).toEqual(late)
  })

  it("takes the run that happened first when a retry produced two", () => {
    const e = experiment({ days: 1 })
    const retry = run({
      id: "a0-retry",
      personaId: "persona-a",
      experiment: { id: "exp-1", day: 0 },
      startedAt: new Date(startedAt.getTime() + 6 * 3_600_000),
    })
    const series = driftSeries(
      e,
      [...day(0), retry],
      urls({ a0: ["u1"], "a0-retry": ["u9"], b0: ["u1"] }),
      20,
      later,
    )
    // The honest cell is the one asked at the time the plan asked for it; the
    // retry landed six hours from its sibling and would be a different afternoon.
    expect(series.points[0]?.a?.runId).toBe("a0")
    expect(series.points[0]?.overlap?.shared).toBe(1)
  })

  it("ignores runs belonging to a different experiment", () => {
    const e = experiment({ days: 1 })
    const stray = run({
      id: "other",
      personaId: "persona-a",
      experiment: { id: "exp-2", day: 0 },
    })
    const loose = run({ id: "loose", personaId: "persona-a", experiment: null })
    const series = driftSeries(e, [stray, loose], new Map(), 20, later)
    expect(series.points[0]?.state).toBe("missing")
  })

  it("is complete once the last day is due, whether or not it ran", () => {
    const e = experiment({ days: 2 })
    const onLastDay = new Date(startedAt.getTime() + 1440 * 60_000)
    // Derived from the plan and the clock, never stored: a `complete` column is
    // wrong the first moment something updates it and the run does not happen.
    expect(driftSeries(e, [], new Map(), 20, onLastDay).summary.complete).toBe(true)
    expect(
      driftSeries(e, [], new Map(), 20, new Date(onLastDay.getTime() - 1)).summary.complete,
    ).toBe(false)
  })
})
