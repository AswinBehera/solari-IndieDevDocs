import type { BudgetWindow, MeterId } from "@samsara/core"
import { err, type Failure, failure, ok, type Result } from "./result.js"

/**
 * The budget guard (plan section 2.4). Three meters, not one.
 *
 * Two honest limitations, stated here because they are properties of the design
 * rather than bugs to be found later:
 *
 * 1. **The guard refuses before, and accounts after.** Browser minutes are not
 *    knowable in advance, so the guard checks that a meter is under its ceiling
 *    before an operation starts and records the actual cost when it ends. The
 *    maximum overshoot is therefore one operation — bounded by that operation's
 *    hard deadline. At a 4-minute deadline against a 4,000-minute ceiling, that is
 *    0.1%. Where the cost *is* knowable up front (tokens, geocoding calls), pass it
 *    as `requested` and the refusal becomes exact.
 * 2. **It is not a distributed lock.** Two runners can both pass a check at 99% of
 *    a ceiling. The `add` path is an atomic upsert so the count stays correct, and
 *    the next check refuses. For a demo with one scheduled runner this is
 *    sufficient; it would not be for concurrent production traffic.
 */

export interface CounterKey {
  meter: MeterId
  window: BudgetWindow
  windowKey: string
}

/**
 * Where counters live. An interface rather than a direct database call so the
 * guard can be tested without Postgres, and so a dry run can use a store that
 * forgets — which is the only safe way to rehearse a spend.
 */
export interface CounterStore {
  /** Current totals. A key with no row reads as 0. */
  read(keys: readonly CounterKey[]): Promise<Map<string, number>>
  /** Atomically add and return the new total. */
  add(key: CounterKey, amount: number): Promise<number>
}

export const counterKeyString = (k: CounterKey): string => `${k.meter}|${k.window}|${k.windowKey}`

/** What the spend is attributable to. Shapes the three windows of section 2.4. */
export interface SpendScope {
  /** Opaque caller id. Absent when the system is spending on its own behalf. */
  ownerId?: string | null
  /** Engine purpose plus the run it belongs to, e.g. `harvest` and a run id. */
  purpose?: string
  runId?: string
}

/** `Date` in, ISO date out. UTC, so a runner's timezone cannot shift a window. */
export const dayKey = (at: Date): string => at.toISOString().slice(0, 10)

/**
 * Which counters a given spend touches. `global.day` and `global.total` always
 * (the total is counted even when it has no ceiling, so setting one later starts
 * from real usage rather than zero); the other two only
 * when the scope carries what they slice by. A missing owner is not an error — the
 * system opens sessions for itself — it simply means that window does not apply.
 */
export function keysFor(meter: MeterId, scope: SpendScope, at: Date): CounterKey[] {
  const keys: CounterKey[] = [
    { meter, window: "global.day", windowKey: dayKey(at) },
    { meter, window: "global.total", windowKey: "all" },
  ]
  if (scope.ownerId) {
    keys.push({ meter, window: "owner.day", windowKey: `${scope.ownerId}:${dayKey(at)}` })
  }
  if (scope.purpose && scope.runId) {
    keys.push({ meter, window: "purpose.run", windowKey: `${scope.purpose}:${scope.runId}` })
  }
  return keys
}

export interface BudgetGuardOptions {
  store: CounterStore
  ceilings: Record<MeterId, number>
  /**
   * Per-window ceiling as a fraction of the global one. A single caller may not
   * take the whole day, and a single run may not take a whole caller's day.
   */
  windowFractions?: Partial<Record<BudgetWindow, number>>
  /**
   * Lifetime ceilings, per meter. The day ceilings reset; these never do, which is
   * what a prepaid provider balance needs. A meter with none is counted, not capped.
   */
  totals?: Partial<Record<MeterId, number>>
  clock?: () => Date
}

const DEFAULT_FRACTIONS: Record<BudgetWindow, number> = {
  "global.day": 1,
  "owner.day": 0.25,
  "purpose.run": 0.05,
  "global.total": 1,
}

export class BudgetGuard {
  private readonly store: CounterStore
  private readonly ceilings: Record<MeterId, number>
  private readonly fractions: Record<BudgetWindow, number>
  private readonly totals: Partial<Record<MeterId, number>>
  private readonly clock: () => Date

  constructor(opts: BudgetGuardOptions) {
    this.store = opts.store
    this.ceilings = opts.ceilings
    this.fractions = { ...DEFAULT_FRACTIONS, ...opts.windowFractions }
    this.totals = opts.totals ?? {}
    this.clock = opts.clock ?? (() => new Date())
  }

  ceilingFor(meter: MeterId, window: BudgetWindow): number {
    if (window === "global.total") return this.totals[meter] ?? Number.POSITIVE_INFINITY
    return this.ceilings[meter] * this.fractions[window]
  }

  /**
   * May this spend happen? `requested` is the known cost where there is one, and 0
   * where there is not — a check with 0 still refuses an already-exhausted meter,
   * which is the case that matters for browser minutes.
   */
  async check(
    meter: MeterId,
    requested: number,
    scope: SpendScope = {},
  ): Promise<Result<void, Failure>> {
    const keys = keysFor(meter, scope, this.clock())
    const totals = await this.store.read(keys)
    for (const key of keys) {
      const used = totals.get(counterKeyString(key)) ?? 0
      const ceiling = this.ceilingFor(meter, key.window)
      // `used >= ceiling` is the separate clause, not a tidier way of writing the
      // second one. A meter sitting exactly on its ceiling is exhausted, and the
      // callers that matter most — browser sessions, whose cost is unknowable in
      // advance — ask with `requested: 0`. Without this clause they would be
      // waved through forever at exactly 100%.
      if (used >= ceiling || used + requested > ceiling) {
        return err(
          failure(
            "budget",
            `meter ${meter} exhausted for window ${key.window} (${key.windowKey}): ` +
              `${used} used + ${requested} requested exceeds ceiling ${ceiling}`,
            { meter, ceiling, used, requested },
          ),
        )
      }
    }
    return ok(undefined)
  }

  /** Account for a spend that happened. Never refuses: the money is already gone. */
  async record(meter: MeterId, amount: number, scope: SpendScope = {}): Promise<void> {
    if (amount <= 0) return
    const keys = keysFor(meter, scope, this.clock())
    for (const key of keys) await this.store.add(key, amount)
  }

  /**
   * Check, run, then account for whatever it actually cost. The callback reports
   * its own cost because only it knows: a browser session knows its minutes, an
   * LLM call knows its token usage.
   */
  async spend<T>(
    meter: MeterId,
    scope: SpendScope,
    estimate: number,
    fn: () => Promise<{ value: T; cost: number }>,
  ): Promise<Result<T, Failure>> {
    const allowed = await this.check(meter, estimate, scope)
    if (!allowed.ok) return allowed
    let cost = estimate
    try {
      const { value, cost: actual } = await fn()
      cost = actual
      return ok(value)
    } finally {
      // In `finally` deliberately: a failed operation still spent what it spent,
      // and a guard that only counts successes undercounts exactly when things are
      // going wrong.
      await this.record(meter, cost, scope)
    }
  }
}
