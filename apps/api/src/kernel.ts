import { ceilingsFrom } from "@samsara/kernel/limits"
import type { OpsSnapshot } from "@samsara/kernel/ops"
import { Hono } from "hono"
import { requireAuth, type Verifier } from "./auth.js"

/**
 * The ops dashboard's read (P5.5), at `/lab/kernel`.
 *
 * Its own file and mount for the reason `places.ts` gives: `lab.ts` is about
 * personas, sources and items. Mounted before `/lab` so its middleware runs once.
 *
 * Ceilings are laid over the reader's counters here rather than in SQL, because
 * they are constants and `BUDGET_*` overrides live in the Worker's environment.
 */
export interface KernelDeps {
  /** Per-request, for the Hyperdrive reason `jobs` gives in `index.ts`. */
  reader: (env: unknown) => { snapshot(now?: Date): Promise<OpsSnapshot> }
  verifier: Verifier
  clock?: () => Date
}

export function kernelRoutes(deps: KernelDeps) {
  const routes = new Hono<{ Bindings: Record<string, unknown> }>()
  routes.use("*", requireAuth(deps.verifier))

  routes.get("/", async (c) => {
    const now = deps.clock?.() ?? new Date()
    const snap = await deps.reader(c.env).snapshot(now)
    // `ceilingsFrom` reads only `BUDGET_*`; the rest of the bindings are ignored.
    const ceilings = ceilingsFrom(c.env as Record<string, string | undefined>)
    const meters = Object.entries(ceilings).map(([meter, ceiling]) => ({
      meter,
      ceiling,
      used: snap.used[meter as keyof typeof ceilings] ?? 0,
    }))
    return c.json({
      now: now.toISOString(),
      open: snap.open,
      minutesToday: snap.minutesToday,
      meters,
      adapters: snap.adapters.map((a) => ({
        ...a,
        blockedRate: a.total === 0 ? 0 : a.blocked / a.total,
      })),
      personas: snap.personas,
    })
  })

  return routes
}
