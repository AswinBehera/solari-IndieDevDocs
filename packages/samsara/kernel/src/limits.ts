import { type MeterId, meterId } from "@samsara/core"
import { z } from "zod"

/**
 * The ceilings, in one file, as plan section 8 requires.
 *
 * Every number here is a **count**, never a price. Rates drift, currencies move,
 * and a guard that converts at runtime is a guard that can be wrong about whether
 * it is allowed to spend. The rate each count was derived from is in the comment
 * beside it, with the date it was read, so re-deriving is a two-minute job rather
 * than an archaeology project.
 *
 * Derived 11 September 2026 against a hard $20 total (section 8).
 */
export const DEFAULT_CEILINGS: Record<MeterId, number> = {
  /** ~$8 at ~$0.002/browser-minute (Starter calculator, 11 Sep 2026). Loose on
   *  purpose: a disciplined demo needs ~1,000, and this is the cheap meter. */
  "solari.minutes": 4_000,
  /** ~$3 total for input+output combined, split below. Rate depends on the routed
   *  model (ADR-0012) and must be read at P2.1, not assumed — the ceiling is set so
   *  that even a bad model choice cannot exhaust the budget silently. */
  "llm.input.tokens": 20_000_000,
  "llm.output.tokens": 4_000_000,
  /** $0, and deliberately still a meter (ADR-0017). Resolution is tiered: the
   *  coordinate usually comes out of the harvested artifact itself, and failing that
   *  from an OSM extract in our own Postgres — neither costs anything. Only the last
   *  tier calls a hosted geocoder, on a free tier (LocationIQ 5,000/day, read 11 Sep
   *  2026), so this count guards a quota rather than a bill.
   *
   *  It mostly guards *us*. A resolver making more than a few hundred hosted calls a
   *  day is failing at the two free tiers above it, and the fix is the resolver, not
   *  a higher number here. Held far below the provider's own limit for that reason. */
  "geocode.calls": 800,
}

/** Env var name per meter. Keeps the mapping in one place rather than inline. */
const ENV_VAR: Record<MeterId, string> = {
  "solari.minutes": "BUDGET_SOLARI_MINUTES",
  "llm.input.tokens": "BUDGET_LLM_INPUT_TOKENS",
  "llm.output.tokens": "BUDGET_LLM_OUTPUT_TOKENS",
  "geocode.calls": "BUDGET_GEOCODE_CALLS",
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
 * ignoring `BUDGET_GEOCODE_CALLS=eight hundred` and running on the default is
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
