import type { FxRates } from "./adapter.js"

/**
 * USD per unit of each currency (P3.3), read from a keyless public source and
 * cached for the UTC day.
 *
 * The cache is per process: the worker is a scheduled run that exits between
 * drains, so in practice this is one fetch per run, not per day. That is fine at
 * eight probes a night; a shared cache is a table nobody needs yet.
 *
 * A failed fetch throws rather than returning stale or empty rates, because a
 * normalised figure computed from a guessed rate is worse than none. The engine
 * awaits this before opening any browser, so a failure here costs nothing.
 */
export const FX_URL = "https://open.er-api.com/v6/latest/USD"

export function dailyFx(
  fetchImpl: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
): () => Promise<FxRates> {
  let cached: { day: string; rates: FxRates } | null = null
  return async () => {
    const day = clock().toISOString().slice(0, 10)
    if (cached && cached.day === day) return cached.rates
    const res = await fetchImpl(FX_URL)
    if (!res.ok) throw new Error(`fx: rate source answered ${res.status}`)
    const body = (await res.json()) as { rates?: Record<string, unknown> }
    const perUsd = body.rates ?? {}
    const rates: Record<string, number> = { USD: 1 }
    for (const [code, value] of Object.entries(perUsd)) {
      // The source quotes units of currency per USD; the engine's contract is the inverse.
      if (typeof value === "number" && value > 0 && Number.isFinite(value)) rates[code] = 1 / value
    }
    cached = { day, rates }
    return rates
  }
}
