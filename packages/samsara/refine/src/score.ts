import type { Explanation, ScoreSet } from "@samsara/core"
import type { DomainPack, FactorReading, ScoreFactor } from "./pack.js"
import type { EvidenceRecord, EvidenceStore } from "./ports.js"

/**
 * The score stage: entities in, `ScoreSet`s out, every number accompanied by the
 * reasons that produced it.
 *
 * Generic to the last line, like the three stages before it. It knows that a
 * pack has some named scores, that each is a weighted list of factors, and that
 * a factor reads a number off evidence rows it does not open. It does not know
 * what any of them mean — and section 2.5 draws the line in exactly those words:
 * "`localScore` is a travel word; `scores.local` is a key in a generic map."
 *
 * Four decisions carry weight here.
 *
 * **1. The engine does the arithmetic, not the pack.** The plan's section 3
 * sketches this member as `score(e, ev): ScoreSet` — one method per pack,
 * returning the finished map. P2.5's own entry overrules it: "generic weighted
 * scorer … **from factor functions the pack supplies**". With a method, every
 * claim this stage makes about explainability is a claim about code that lives
 * somewhere else, and a pack could return `{ value: 0.9, because: [] }` without
 * anything noticing. With factors, the engine computes the value *from* the
 * contributions, so a score and its reasons cannot disagree: `because` is not a
 * description of the calculation, it is the calculation.
 *
 * **2. A factor that cannot measure abstains, and abstaining is not zero.** This
 * is the decision that most changes what gets produced. A forum thread reports
 * no view count; a caption arrives with no language recorded. A factor over
 * either has nothing to read, and scoring it zero would mean a place found on
 * Pantip is punished, invisibly and permanently, for the shape of the surface it
 * was found on. So `measure` may return `null`, and a factor that returns it is
 * dropped from the numerator *and the denominator*: the score is the weighted
 * mean of what could actually be read, and a score where nothing could be read
 * is absent rather than 0.
 *
 * **3. An entity with no evidence is not written at all.** It is counted, under
 * its own name, and the row keeps whatever it had. A zero with an empty
 * `because` renders identically to a place that was measured and came out badly,
 * and the whole point of product principle 3 is that a reader can tell those
 * apart. It is the same refusal P2.4 made about the embedding key: a number
 * nobody can account for looks like a measurement, which is worse than a gap.
 *
 * **4. The whole page's evidence is read in one query.** `EvidenceStore` takes a
 * list of entity ids and returns a map, and this stage calls it exactly once per
 * page. Evidence is the one table in this pipeline that grows without bound —
 * one row per claim, forever — and a per-entity read would turn a page of two
 * hundred into two hundred round trips against the largest table we have.
 */

/**
 * An entity as the stage is handed it, with the id its pack's repo gave it.
 *
 * Handed in rather than fetched, for the reason `DedupEntity` states at length:
 * paging and its bounded-read refusal belong to the job handler, and the stage
 * that would have to invent a cursor is the wrong place to decide what a page
 * is. Unlike dedup, the order within a page means nothing here — scoring one
 * entity cannot change another's answer.
 */
export interface ScoreEntity<TEntity> {
  id: string
  entity: TEntity
}

export interface ScoreOptions<TMention, TEntity> {
  pack: DomainPack<TMention, TEntity>
  /** One page. Order is not significant; see `ScoreEntity`. */
  entities: readonly ScoreEntity<TEntity>[]
  evidence: EvidenceStore
  signal?: AbortSignal
}

/** What one factor did over a page, which is the number worth watching. */
export interface FactorReport {
  name: string
  /** Readings returned. */
  measured: number
  /**
   * Readings declined for want of anything to read.
   *
   * Reported per factor rather than summed, because the interesting failure is a
   * single factor abstaining everywhere — a language share over a corpus where
   * nothing records a language, an engagement ratio over a source that reports
   * none. Summed into one total it reads as mild, spread across factors; split
   * out it reads as "this factor is not measuring anything", which is what it is.
   */
  abstained: number
}

export interface ScoreReport {
  /** Entities handed in. */
  entities: number
  /** Entities a `ScoreSet` was written for. */
  scored: number
  /**
   * Entities with no evidence rows at all, which are left unwritten.
   *
   * Before P2.5 nothing in this repository wrote the `evidence` table, so the
   * first honest reading of this counter is "all of them" — and that is the
   * point of having it. See decision 3.
   */
  unevidenced: number
  /**
   * Entities that had evidence and still produced no score, because every factor
   * of every score abstained. Distinct from `unevidenced`: one is a corpus with
   * nothing in it, the other is a corpus that does not carry what the pack
   * measures, and they are fixed by different work.
   */
  unmeasurable: number
  /** Per score name, in the pack's own order. */
  scores: { name: string; written: number; factors: FactorReport[] }[]
  /** True when the signal fired and the page was left part-finished. */
  cancelled: boolean
}

/** One factor's reading, kept beside the factor so weights survive the fold. */
interface Weighted {
  factor: ScoreFactor<unknown>
  reading: FactorReading
}

/**
 * Check what a pack returned, and refuse rather than repair it.
 *
 * Clamping was the first version and it is wrong in a way that only shows up in
 * the explanation: a factor returning 1.4 would be clamped to 1, the score would
 * stay in range, and the contributions would no longer sum to the value they are
 * supposed to account for. A reader doing the arithmetic in their head would
 * find it did not work and have nowhere to look. So a factor out of range is a
 * bug in the pack, and it is named as one.
 */
const checkReading = (factor: ScoreFactor<unknown>, reading: FactorReading): void => {
  if (!Number.isFinite(reading.value) || reading.value < 0 || reading.value > 1) {
    throw new Error(
      `score factor "${factor.name}" returned a value outside [0,1]: ${reading.value}`,
    )
  }
}

const checkWeight = (factor: ScoreFactor<unknown>): void => {
  if (!Number.isFinite(factor.weight) || factor.weight <= 0) {
    throw new Error(`score factor "${factor.name}" has a weight of ${factor.weight}`)
  }
}

export async function score<TMention, TEntity>(
  opts: ScoreOptions<TMention, TEntity>,
): Promise<ScoreReport> {
  const { pack } = opts

  const spec = pack.score
  if (!spec) {
    // By name, like the two stages before it. A pack with no factors has nothing
    // to score with, and a run that reported a clean sweep over an empty spec
    // would be indistinguishable from one that worked.
    throw new Error(`domain pack "${pack.id}" has no score spec`)
  }
  if (!pack.resolve) {
    // There is nothing to score that resolution did not write, and `writeScores`
    // lives on the resolve spec's repo — the same dependency dedup declares, for
    // the same reason.
    throw new Error(`domain pack "${pack.id}" has no resolve spec`)
  }
  const repo = pack.resolve.repo

  const names = Object.keys(spec.scores)
  const factorReports = new Map<string, Map<string, FactorReport>>()
  for (const name of names) {
    const perFactor = new Map<string, FactorReport>()
    for (const factor of spec.scores[name] ?? []) {
      checkWeight(factor as ScoreFactor<unknown>)
      perFactor.set(factor.name, { name: factor.name, measured: 0, abstained: 0 })
    }
    factorReports.set(name, perFactor)
  }

  const report: ScoreReport = {
    entities: opts.entities.length,
    scored: 0,
    unevidenced: 0,
    unmeasurable: 0,
    scores: names.map((name) => ({
      name,
      written: 0,
      factors: [...(factorReports.get(name)?.values() ?? [])],
    })),
    cancelled: false,
  }
  const written = new Map(report.scores.map((row) => [row.name, row]))

  const evidence = await opts.evidence.forEntities(
    pack.id,
    opts.entities.map((row) => row.id),
  )

  for (const { id, entity } of opts.entities) {
    if (opts.signal?.aborted) {
      // Stop where we are. Each entity's scores are written on their own and
      // this stage is idempotent over a page, so the next run picks up the rest.
      report.cancelled = true
      break
    }

    const rows: readonly EvidenceRecord[] | undefined = evidence.get(id)
    if (rows === undefined || rows.length === 0) {
      report.unevidenced++
      continue
    }

    const scores: ScoreSet = {}
    for (const name of names) {
      const factors = spec.scores[name] ?? []
      const readings: Weighted[] = []
      const perFactor = factorReports.get(name)

      for (const factor of factors) {
        const reading = factor.measure(entity, rows)
        const tally = perFactor?.get(factor.name)
        if (reading === null) {
          if (tally) tally.abstained++
          continue
        }
        checkReading(factor as ScoreFactor<unknown>, reading)
        if (tally) tally.measured++
        readings.push({ factor: factor as ScoreFactor<unknown>, reading })
      }

      const total = readings.reduce((sum, r) => sum + r.factor.weight, 0)
      // Every factor abstained. The score is left out of the map rather than
      // written as zero — see decision 2 — and because the whole set is replaced
      // on write, a key that stops being measurable stops being stored.
      if (total === 0) continue

      const because: Explanation[] = readings.map(({ factor, reading }) => ({
        factor: factor.name,
        // The share of the whole, not the raw weighted term, so that the
        // contributions sum to the value a reader is looking at. This is the
        // arithmetic the explanation exists to make checkable.
        contribution: (factor.weight * reading.value) / total,
        // Copied, not aliased. `Explanation` is the stored shape and a pack's
        // factor is free to hand back an array it still holds a reference to.
        evidenceIds: [...reading.evidenceIds],
      }))

      scores[name] = {
        value: because.reduce((sum, e) => sum + e.contribution, 0),
        because,
      }
      const row = written.get(name)
      if (row) row.written++
    }

    if (Object.keys(scores).length === 0) {
      report.unmeasurable++
      continue
    }

    await repo.writeScores(id, scores)
    report.scored++
  }

  return report
}
