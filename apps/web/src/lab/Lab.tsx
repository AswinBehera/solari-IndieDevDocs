import { Compare } from "./Compare"
import { Drift } from "./Drift"
import { Personas } from "./Personas"
import { RunHarvest } from "./RunHarvest"

/**
 * The Persona Lab (P1.7), at `/lab`.
 *
 * **An engine-facing tool that happens to live in the travel app.** Every noun on
 * this page is a persona, a source, a query or an item; none of them is a place, a
 * trip or a restaurant. That is not decoration — it is the same rule
 * `pnpm check:seam` enforces one directory over, applied here by hand because
 * `apps/` is allowed travel vocabulary and so the check would not catch it. The
 * day this page grows a "places found" column is the day the Lab has started
 * measuring the product instead of the engine.
 *
 * **What it is for.** Whether two identities asking a surface the same question
 * get the same answer. Three sections in the order the work happens: the
 * identities exist, one of them asks, and then two of them are compared. The
 * comparison is the point; the first two sections exist so that there is
 * something to compare without a psql session. The fourth asks the same question
 * for a week, because one afternoon's comparison is a fact and a week's is a
 * finding (P1.8).
 */

export function Lab() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 p-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Persona Lab</h1>
        <p className="text-neutral-500 text-sm">
          Internal. Identities, the questions they ask, and what came back —{" "}
          <a href="/" className="underline">
            back to the app
          </a>
          .
        </p>
      </header>

      <Personas />
      <RunHarvest />
      <Compare />
      <Drift />
    </main>
  )
}
