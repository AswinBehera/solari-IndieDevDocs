import type { MeterId } from "@samsara/core"
import { ceilingsFrom, totalsFrom } from "./limits.js"

export { ceilingsFrom, DEFAULT_CEILINGS, DEFAULT_TOTALS, totalsFrom } from "./limits.js"

/**
 * `ceilingsFrom` over `process.env`, for the Node callers. Kept apart from
 * `limits.ts` because the default parameter names `process`, which the Workers
 * runtime the API is compiled against does not have.
 */
export function loadCeilings(
  env: Record<string, string | undefined> = process.env,
): Record<MeterId, number> {
  return ceilingsFrom(env)
}

/** `totalsFrom` over `process.env`; see `loadCeilings`. */
export function loadTotals(
  env: Record<string, string | undefined> = process.env,
): Partial<Record<MeterId, number>> {
  return totalsFrom(env)
}
