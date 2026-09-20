import { PlaceGrid } from "@dt/ui"
import { sampleEvidence, samplePlaces } from "./sample.js"

/**
 * The Place Postcard grid (P2.7), at `/lab/places`.
 *
 * **Not a section of the Persona Lab, and the path is the only thing they share.**
 * `Lab.tsx` sets a rule for itself: the Lab talks about personas, sources, queries
 * and items, and "the day a places count, a ranking or a map appears here the Lab
 * has stopped being a lab". This page is all three of those things. So it is a
 * separate page under `/lab/*` — a staging area for travel surfaces that are not
 * ready to be the app — rather than a sixth section below `Mentions`.
 *
 * It moves to `/places` in Phase 4, when the Trip Document gives it somewhere to
 * be, and at that point it reads the API instead of a fixture.
 */

/** Bangkok, wide enough for Nonthaburi and Samut Prakan — as `tier0.ts` draws it. */
const BANGKOK = [100.3, 13.5, 100.95, 14.0] as const

export function Places() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 bg-surface p-6 font-body text-ink">
      <header className="border-rule border-b pb-4">
        <h1 className="font-display text-3xl leading-tight">Places</h1>
        <p className="mt-1 text-ink-muted text-sm">
          Sorted by local score. Sample data — the pipeline has produced no Places yet, so this is
          the card in every state it can be in.{" "}
          <a href="/lab" className="underline decoration-rule">
            back to the Lab
          </a>
        </p>
      </header>

      <PlaceGrid
        places={samplePlaces}
        evidence={sampleEvidence}
        bbox={BANGKOK}
        empty={<p className="text-ink-faint text-sm">No places yet.</p>}
      />
    </main>
  )
}
