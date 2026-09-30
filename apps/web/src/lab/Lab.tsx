import { Compare } from "./Compare"
import { Drift } from "./Drift"
import { Mentions } from "./Mentions"
import { Personas } from "./Personas"
import { RunHarvest } from "./RunHarvest"

/**
 * The Persona Lab (P1.7), at `/lab`.
 *
 * **An engine-facing tool that happens to live in the travel app.** The nouns on
 * this page are personas, sources, queries, items and mentions — every one of them
 * a thing the engine has a stage for. That is not decoration: it is the same rule
 * `pnpm check:seam` enforces one directory over, applied here by hand because
 * `apps/` is allowed travel vocabulary and so the check would not catch it.
 *
 * P2.2 put the first travel word on the screen, and it is worth being exact about
 * why it is allowed. `Mentions` renders a place name because a mention *is* the
 * extract stage's output and cannot be reviewed without showing what it claimed —
 * the question being asked is "did the extractor read the post correctly", which
 * is a question about the engine. What remains forbidden is the same thing as
 * before: a "places found" count, a ranking, a map. Those measure the product, and
 * the day one appears here the Lab has stopped being a lab.
 *
 * **What it is for.** Whether two identities asking a surface the same question
 * get the same answer. Three sections in the order the work happens: the
 * identities exist, one of them asks, and then two of them are compared. The
 * comparison is the point; the first two sections exist so that there is
 * something to compare without a psql session. The fourth asks the same question
 * for a week, because one afternoon's comparison is a fact and a week's is a
 * finding (P1.8). The fifth is what the engine then made of the items it kept
 * (P2.2) — the first section that reads the corpus rather than producing it.
 */

export function Lab() {
  return (
    // `w-full`: with `mx-auto` and no width, a column flex child sizes to its
    // content, and the tables below made the whole page 551px on a phone.
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pt-10 pb-16 sm:px-6">
      <header>
        <p className="mb-2 font-mono text-[11px] text-ink-faint tracking-[.1em]">
          /lab · BUILT ON SOLARI · INTERNAL
        </p>
        <h1 className="font-display text-[44px] leading-none tracking-tight">Searches</h1>
        <p className="mt-2 text-ink-muted text-sm">
          The identities that browse, the questions they ask, and what came back.
        </p>
      </header>

      <Personas />
      <RunHarvest />
      <Compare />
      <Drift />
      <Mentions />
    </main>
  )
}
