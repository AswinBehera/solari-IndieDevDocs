import type { Place } from "@dt/core"
import type { ReactNode } from "react"
import {
  type Bbox,
  byLocalScore,
  type CardEvidence,
  categoryLabel,
  locate,
  type Meter,
  meters,
  names,
  provenance,
} from "./place-card.js"

/**
 * The Place Postcard, v0 (P2.7).
 *
 * Markup and nothing else: every judgement it makes — which name leads, what a
 * tier means in words, whether a coordinate is where it claims to be — is decided
 * in `place-card.ts` and tested there. If a question about this card can be
 * answered by reading a function, that is where the answer should be.
 *
 * **v0, and the plan says so.** P4.9 is the design pass — the rotation on hover,
 * the stamp-like badges, the physical-object feel the canvas draws. What is here
 * is the canvas's palette and type scale applied honestly to the right fields, so
 * that the day the pipeline produces Places there is somewhere to look at them.
 */
export function PlaceCard({
  place,
  evidence,
  bbox,
}: {
  place: Place
  /** One quote, or none. The API picks which; the card does not rank evidence. */
  evidence?: CardEvidence | null
  /** The frame the locator draws in — usually the city's bbox. */
  bbox: Bbox
}) {
  const name = names(place)
  const [local, tourist] = meters(place)

  return (
    <article className="flex flex-col gap-3 border border-rule bg-surface-raised p-4 font-body text-ink">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            className={`font-display leading-tight ${name.primaryIsLocal ? "text-2xl" : "text-xl"}`}
          >
            {name.primary}
          </h3>
          {name.secondary && <p className="truncate text-ink-muted text-sm">{name.secondary}</p>}
        </div>
        <span className="shrink-0 border border-rule px-2 py-0.5 font-mono text-ink-muted text-xs uppercase tracking-wide">
          {categoryLabel[place.category]}
        </span>
      </header>

      <Locator place={place} bbox={bbox} />

      <Quote evidence={evidence ?? null} evidenceCount={place.evidenceCount} />

      <div className="flex flex-col gap-2">
        <Bar meter={local} tint="bg-accent-pink" />
        <Bar meter={tourist} tint="bg-accent-blue" />
      </div>
    </article>
  )
}

/**
 * A frame with a dot in it, and deliberately not a basemap.
 *
 * MapLibre and Protomaps are the map (ADR-0008, ADR-0018), and P4.4 is where the
 * map view lands. Putting a live map instance inside every card of a grid would
 * mean one GL context per card for a thumbnail nobody pans — so this draws the
 * one thing the thumbnail is for: whether the place is where the city is. The
 * coordinate is printed beside it because at this size a dot alone is not
 * checkable, and P2.3's false positives are exactly the case where someone needs
 * to read the number.
 */
function Locator({ place, bbox }: { place: Place; bbox: Bbox }) {
  const origin = provenance(place)
  if (!place.geo) {
    return (
      <p className="border border-rule border-dashed px-2 py-3 text-center text-ink-faint text-xs">
        {origin} — this place cannot appear on the map
      </p>
    )
  }

  const at = locate(place.geo, bbox)
  return (
    <div className="flex items-center gap-3">
      <svg
        viewBox="0 0 100 100"
        className="size-12 shrink-0 border border-rule bg-surface"
        role="img"
        aria-label={`${place.canonicalName} at ${place.geo.lat.toFixed(4)}, ${place.geo.lng.toFixed(4)}`}
      >
        <circle
          cx={at.x * 100}
          cy={at.y * 100}
          r={7}
          className={at.outside ? "fill-none stroke-accent-pink" : "fill-accent-pink"}
          strokeWidth={3}
        />
      </svg>
      <div className="min-w-0 text-xs">
        <p className="text-ink-muted">{origin}</p>
        <p className="font-mono text-ink-faint">
          {place.geo.lat.toFixed(4)}, {place.geo.lng.toFixed(4)}
        </p>
        {at.outside && (
          <p className="text-accent-pink">Outside {place.city} — check this resolution</p>
        )}
      </div>
    </div>
  )
}

/**
 * The quote, verbatim, or an honest account of why there isn't one.
 *
 * `placeMention.quote` is capped at 200 characters and copied unbroken from the
 * item, because a paraphrase of a review is not evidence of anything. The card
 * honours that by not truncating: if the extractor kept it inside the cap, the
 * reader sees all of it.
 */
function Quote({
  evidence,
  evidenceCount,
}: {
  // Required and nullable rather than optional: `exactOptionalPropertyTypes` is
  // on, so an omitted prop and an explicit `undefined` are different things, and
  // an internal component that only ever gets called one way should say so.
  evidence: CardEvidence | null
  evidenceCount: number
}) {
  if (!evidence) {
    return (
      <p className="text-ink-faint text-xs">
        {evidenceCount === 0
          ? "No evidence yet"
          : `${evidenceCount} piece${evidenceCount === 1 ? "" : "s"} of evidence, none quoted here`}
      </p>
    )
  }
  return (
    <figure className="border-accent-blue border-l-2 pl-3">
      <blockquote
        className="text-ink text-sm leading-snug"
        {...(evidence.language ? { lang: evidence.language } : {})}
      >
        {evidence.quote}
      </blockquote>
      <figcaption className="mt-1 font-mono text-ink-faint text-xs">
        <a href={evidence.sourceUrl} className="underline decoration-rule">
          {evidence.sourceId}
        </a>
        {evidenceCount > 1 && <span> · 1 of {evidenceCount}</span>}
      </figcaption>
    </figure>
  )
}

/**
 * A score, and the reasons behind it one click away.
 *
 * Product principle 3 is to show the algorithm, and `Explanation[]` exists so a
 * card can. They are behind a `<details>` rather than always visible because a
 * grid of cards each listing its factors is unreadable, and `<details>` is the
 * one disclosure that needs no JavaScript, no library and no ARIA of its own.
 */
function Bar({ meter, tint }: { meter: Meter; tint: string }) {
  const percent = `${Math.round(meter.fraction * 100)}%`
  const bar = (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-ink-muted text-xs">{meter.label}</span>
      {/* Decorative, and hidden from assistive technology on purpose: the label
          and the reading either side of it already say "Local 0.87", so a
          `role="meter"` here would make a screen reader announce the same score
          twice. The bar is how the number looks, not a second source of it. */}
      <span className="h-1.5 grow bg-rule" aria-hidden>
        <span className={`block h-full ${tint}`} style={{ width: percent }} />
      </span>
      <span className="w-8 shrink-0 text-right font-mono text-ink-faint text-xs">
        {meter.reading}
      </span>
    </div>
  )

  if (meter.because.length === 0) return bar

  return (
    <details className="group">
      <summary className="cursor-pointer list-none">{bar}</summary>
      <ul className="mt-1 ml-16 flex flex-col gap-0.5">
        {meter.because.map((reason) => (
          <li key={reason.factor} className="flex justify-between gap-2 text-ink-faint text-xs">
            <span>{reason.factor}</span>
            <span className="font-mono">
              {reason.contribution >= 0 ? "+" : ""}
              {reason.contribution.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * The grid P2.7 asks for: strongest local signal first.
 *
 * Sorting lives here rather than in the page so that every caller gets the same
 * order, including the one that eventually renders it inside the Trip Document.
 */
export function PlaceGrid({
  places,
  evidence,
  bbox,
  empty,
}: {
  places: readonly Place[]
  /** Quote per place id. A place with no entry renders without one. */
  evidence?: Readonly<Record<string, CardEvidence>>
  bbox: Bbox
  empty?: ReactNode
}) {
  if (places.length === 0) return <>{empty}</>
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[...places].sort(byLocalScore).map((place) => (
        <PlaceCard
          key={place.id}
          place={place}
          evidence={evidence?.[place.id] ?? null}
          bbox={bbox}
        />
      ))}
    </div>
  )
}
