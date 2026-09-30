import { tapeFor } from "./paper.js"
import type { Slang } from "./postcard-rules.js"

/**
 * The scrapbook pieces the Postcards share: tape that holds a card to the page
 * and the Thai word stuck on a place. The shapes are `.sb-*` classes in
 * `theme.css`; which word and where the tape goes are decided in the rules files.
 */

/** A strip of washi tape across the card's top edge, placed by the card's id. */
export function Tape({ id }: { id: string }) {
  const t = tapeFor(id)
  return (
    <span
      className={`sb-tape -top-2.5 z-10 ${t.colour === "pink" ? "" : t.colour}`}
      style={{ left: `${t.left}%`, rotate: `${t.angle}deg` }}
      aria-hidden
    />
  )
}

/**
 * A round sticker with a Thai word, romanised and glossed. "HEARD" when a local
 * wrote it about the place, "SAY IT" when it is a phrase to use there.
 */
export function SlangSticker({ slang, tilt = -8 }: { slang: Slang; tilt?: number }) {
  return (
    <span
      title={
        slang.heard
          ? `A local wrote "${slang.thai}" about this place: ${slang.gloss}.`
          : `A phrase to use here: ${slang.gloss}.`
      }
      style={{ rotate: `${tilt}deg` }}
      className={`sb-sticker inline-flex size-[92px] flex-none flex-col items-center justify-center text-center leading-tight ${
        slang.heard ? "bg-accent-pink text-paper" : "bg-accent-gold text-paper"
      }`}
    >
      <span className="font-mono text-[7px] tracking-[.14em] opacity-80">
        {slang.heard ? "HEARD" : "SAY IT"}
      </span>
      <span className="text-[19px] font-semibold leading-none">{slang.thai}</span>
      <span className="mt-0.5 font-display text-[13px] italic">{slang.roman}</span>
      <span className="max-w-[72px] font-mono text-[7px] tracking-[.04em] opacity-90">
        {slang.gloss.toUpperCase()}
      </span>
    </span>
  )
}
