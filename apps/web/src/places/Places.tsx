import { PlaceGrid } from "@dt/ui"
import type { ReactNode } from "react"
import { usePlaces } from "./queries.js"
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
 * **It reads the table now, and the sample moved behind `?sample`.** The page was
 * first built on a fixed set because nothing had ever written a `places` row;
 * the refine chain now runs extract through score on its own, and the Phase 2
 * gate is a review of the top thirty real ones. The sample stays, because it is
 * still the only way to see the card in every state at once — but on its own URL,
 * so invented scores are never on screen beside measured ones, and an empty table
 * says it is empty rather than showing something that looks like results.
 *
 * It moves to `/places` in Phase 4, when the Trip Document gives it somewhere to be.
 */

/** Bangkok, wide enough for Nonthaburi and Samut Prakan — as `tier0.ts` draws it. */
const BANGKOK = [100.3, 13.5, 100.95, 14.0] as const

export function Places() {
  const sample = new URLSearchParams(window.location.search).has("sample")
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 bg-surface p-6 font-body text-ink">
      <header className="border-rule border-b pb-4">
        <h1 className="font-display text-3xl leading-tight">Places</h1>
        <p className="mt-1 text-ink-muted text-sm">
          {sample ? (
            <>
              Sample data with invented scores: the card in every state it can be in{" · "}
              <a href="/lab/places" className="underline decoration-rule">
                the real ones
              </a>
            </>
          ) : (
            <>
              The top thirty by local score, from the pipeline{" · "}
              <a href="/lab/places?sample" className="underline decoration-rule">
                sample cards
              </a>
            </>
          )}
          {" · "}
          <a href="/lab" className="underline decoration-rule">
            back to the Lab
          </a>
        </p>
      </header>

      {sample ? (
        <PlaceGrid places={samplePlaces} evidence={sampleEvidence} bbox={BANGKOK} />
      ) : (
        <Live />
      )}
    </main>
  )
}

function Live() {
  const places = usePlaces()
  if (places.isPending) return <Note>Loading places…</Note>
  if (places.isError) return <Note>Could not load places: {places.error.message}</Note>
  return (
    <PlaceGrid
      places={places.data.places}
      evidence={places.data.evidence}
      bbox={BANGKOK}
      empty={
        <Note>
          No places yet. The pipeline writes them once a harvest has been extracted and resolved;
          until then there is nothing here to rank.
        </Note>
      }
    />
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-ink-faint text-sm">{children}</p>
}
