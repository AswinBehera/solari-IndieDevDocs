import { PlaceGrid } from "@dt/ui"
import { type ReactNode, useState } from "react"
import { usePlaces } from "./queries.js"
import { sampleEvidence, samplePlaces } from "./sample.js"
import {
  gateLine,
  loadVerdicts,
  saveVerdicts,
  tally,
  toggle,
  type Verdict,
  type Verdicts,
} from "./verdicts"

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

const CATEGORIES = [
  "food",
  "drink",
  "market",
  "temple",
  "nature",
  "nightlife",
  "shop",
  "other",
] as const

/** Phase 2's acceptance, in its own numbers: 100 places with a coordinate, 30 above 0.7. */
const ACCEPT_WITH_GEO = 100
const ACCEPT_STRONG = 30

export function Places() {
  const sample = new URLSearchParams(window.location.search).has("sample")
  const [category, setCategory] = useState<string | null>(null)
  const places = usePlaces(sample ? null : category)
  const summary = places.data?.summary ?? null
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 pt-10 pb-20 font-body text-ink sm:px-12">
      <header className="flex flex-wrap items-end gap-5">
        <div>
          <p className="mb-2 font-mono text-[11px] text-ink-faint tracking-[.1em]">
            /lab/places · {sample ? "SAMPLE" : "BANGKOK"} · SORTED BY LOCAL SCORE
          </p>
          <h1 className="font-display text-[44px] leading-none tracking-tight">Places</h1>
          {!sample && summary && (
            <p className="mt-2 font-display text-[22px] leading-tight">
              {summary.total} place{summary.total === 1 ? "" : "s"}. {summary.strong} above 0.7.
            </p>
          )}
          {sample && (
            <p className="mt-2 font-display text-[22px] leading-tight">
              Every state a card can be in.
            </p>
          )}
          <p className="mt-2 text-ink-muted text-sm">
            {sample ? (
              <>
                Invented scores.{" "}
                <a href="/lab/places" className="underline decoration-rule">
                  The real ones
                </a>
              </>
            ) : (
              <>
                {summary &&
                  `${summary.withGeo} with a coordinate. Acceptance: ${ACCEPT_WITH_GEO} with a coordinate, ${ACCEPT_STRONG} above 0.7 — `}
                {summary && summary.withGeo >= ACCEPT_WITH_GEO && summary.strong >= ACCEPT_STRONG
                  ? "met. "
                  : summary
                    ? "not yet. "
                    : ""}
                <a href="/lab/places?sample" className="underline decoration-rule">
                  Sample cards
                </a>
              </>
            )}
          </p>
        </div>
        {!sample && (
          <div className="ml-auto flex flex-wrap gap-1.5 font-mono text-[11px] tracking-[.08em]">
            {[null, ...CATEGORIES].map((c) => (
              <button
                key={c ?? "all"}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className={`border px-3 py-1.5 ${
                  category === c
                    ? "border-ink bg-ink text-surface"
                    : "border-rule bg-paper text-ink hover:border-ink"
                }`}
              >
                {(c ?? "all").toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </header>

      {sample ? (
        <PlaceGrid places={samplePlaces} evidence={sampleEvidence} bbox={BANGKOK} />
      ) : (
        <Live query={places} />
      )}
    </main>
  )
}

function Live({ query }: { query: ReturnType<typeof usePlaces> }) {
  const [verdicts, setVerdicts] = useState<Verdicts>(() => loadVerdicts())
  if (query.isPending) return <Note>Loading places…</Note>
  if (query.isError) return <Note>Could not load places: {query.error.message}</Note>
  const ids = query.data.places.map((p) => p.id)
  const mark = (id: string, v: Verdict) => {
    const next = toggle(verdicts, id, v)
    setVerdicts(next)
    saveVerdicts(next)
  }
  return (
    <>
      {ids.length > 0 && (
        <p className="-mt-2 font-mono text-[11px] text-ink-muted tracking-[.06em]">
          GATE REVIEW · {gateLine(tally(verdicts, ids)).toUpperCase()}
        </p>
      )}
      <PlaceGrid
        places={query.data.places}
        evidence={query.data.evidence}
        bbox={BANGKOK}
        empty={
          <Note>
            No places yet. The pipeline writes them once a harvest has been extracted and resolved;
            until then there is nothing here to rank.
          </Note>
        }
        footer={(place) => (
          <div className="flex items-center justify-end gap-1.5 border-track border-t pt-3">
            <span className="mr-auto font-mono text-[10px] text-ink-faint tracking-[.1em]">
              {place.evidenceCount} EVIDENCE
            </span>
            {(["real", "wrong"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={verdicts[place.id] === v}
                onClick={() => mark(place.id, v)}
                className={`border px-2.5 py-1 font-mono text-[11px] ${
                  verdicts[place.id] === v
                    ? v === "wrong"
                      ? "border-signal-red bg-signal-red text-white"
                      : "border-signal-green bg-signal-green text-white"
                    : "border-rule text-ink-muted hover:border-ink"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        )}
      />
    </>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-ink-faint text-sm">{children}</p>
}
