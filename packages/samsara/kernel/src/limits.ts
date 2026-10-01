import { type MeterId, meterId } from "@samsara/core"
import { z } from "zod"

/**
 * The ceilings, in one file.
 *
 * Every number here is a **count**, never a price. Rates drift, currencies move,
 * and a guard that converts at runtime is a guard that can be wrong about whether
 * it is allowed to spend. The rate each count was derived from is in the comment
 * beside it, with the date it was read, so re-deriving is a two-minute job rather
 * than an archaeology project.
 *
 * Derived 11 September 2026 against a hard $20 total.
 */
export const DEFAULT_CEILINGS: Record<MeterId, number> = {
  /** ~$8 at ~$0.002/browser-minute (Starter calculator, 11 Sep 2026). Loose on
   *  purpose: a disciplined demo needs ~1,000, and this is the cheap meter. */
  "solari.minutes": 4_000,
}

/**
 * Lifetime ceilings: what may ever be spent, not what may be spent today. The day
 * ceilings above reset at midnight UTC and would let a prepaid balance drain over a
 * week of normal days. Only the metered-in-money meters have one; a meter absent
 * here is counted in `global.total` but never refused by it.
 *
 * Set 29 September 2026 against the operator's cap of $16 of Solari spend.
 */
export const DEFAULT_TOTALS: Partial<Record<MeterId, number>> = {
  /** ~$16 at ~$0.002/browser-minute (the rate above). */
  "solari.minutes": 8_000,
}

/** Env var name per meter. Keeps the mapping in one place rather than inline. */
const ENV_VAR: Record<MeterId, string> = {
  "solari.minutes": "BUDGET_SOLARI_MINUTES",
}

const ceilingValue = z.coerce.number().positive().finite()

/**
 * Read ceilings from the environment, falling back to the derived defaults.
 *
 * Takes the environment as an argument, with no default, so this file is safe to
 * import into the Workers runtime, which has no `process`. `loadCeilings` in
 * `ceilings.ts` is the Node caller that defaults it.
 *
 * A present-but-unparseable value throws rather than falling back. Silently
 * ignoring `BUDGET_SOLARI_MINUTES=four thousand` and running on the default is
 * exactly the failure a budget guard exists to prevent.
 */
export function ceilingsFrom(env: Record<string, string | undefined>): Record<MeterId, number> {
  const out = { ...DEFAULT_CEILINGS }
  for (const meter of meterId.options) {
    const raw = env[ENV_VAR[meter]]
    if (raw === undefined || raw === "") continue
    const parsed = ceilingValue.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`${ENV_VAR[meter]} must be a positive number, got ${JSON.stringify(raw)}`)
    }
    out[meter] = parsed.data
  }
  return out
}

/**
 * Read lifetime ceilings from `<ENV_VAR>_TOTAL` (for example
 * `BUDGET_SOLARI_MINUTES_TOTAL`), falling back to `DEFAULT_TOTALS`. Same rules as
 * `ceilingsFrom`: an unparseable value throws.
 */
export function totalsFrom(
  env: Record<string, string | undefined>,
): Partial<Record<MeterId, number>> {
  const out = { ...DEFAULT_TOTALS }
  for (const meter of meterId.options) {
    const name = `${ENV_VAR[meter]}_TOTAL`
    const raw = env[name]
    if (raw === undefined || raw === "") continue
    const parsed = ceilingValue.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`)
    }
    out[meter] = parsed.data
  }
  return out
}
