/**
 * The Postcard as a physical object (P4.9): paper laid on the page slightly askew,
 * straightening when the pointer reaches it.
 *
 * The tilt is derived from the card's id rather than chosen at random, because a
 * random tilt re-rolls on every render and a card that twitches each time the
 * document saves reads as a bug, not as paper. The same id always lies at the same
 * angle, on every screen and in the share view.
 */

/** Degrees either side of level. The canvas stays inside ±0.7. */
export const MAX_TILT = 0.7

/** FNV-1a over the id's UTF-16 units: small, stable, and spread well enough for this. */
function hash(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** A tilt in `[-max, max]` degrees, rounded to a tenth so the CSS is readable. */
export function tiltFor(id: string, max = MAX_TILT): number {
  const unit = (hash(id) % 2001) / 1000 - 1
  return Math.round(unit * max * 10) / 10
}

/**
 * The card's angle, as a custom property rather than a `transform`.
 *
 * An inline `transform` outranks every class, so a hover rule could only
 * straighten the card with `!important`. Setting `--tilt` inline and reading it
 * through `rotate` in `PAPER` keeps the rest angle per card and the hover in CSS.
 */
export function tiltStyle(id: string, max = MAX_TILT): Record<"--tilt", string> {
  return { "--tilt": `${tiltFor(id, max)}deg` }
}

/**
 * Paper on the page: white, a hairline edge, its own shadow, resting at `--tilt`
 * and straightening with a small lift when the pointer arrives.
 */
export const PAPER =
  "border border-track bg-paper shadow-postcard rotate-(--tilt) transition-[rotate,translate,box-shadow] duration-200 hover:rotate-0 hover:-translate-y-[3px] hover:shadow-postcard-lift"
