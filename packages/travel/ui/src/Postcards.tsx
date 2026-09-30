import type { Place, PostcardState } from "@dt/core"
import { type CSSProperties, type ReactNode, useState } from "react"
import { tiltStyle } from "./paper.js"
import {
  type Bbox,
  type CardEvidence,
  categoryLabel,
  locate,
  names,
  provenance,
} from "./place-card.js"
import {
  type ChecklistItem,
  checklistCount,
  type LinkKind,
  linkLine,
  localPercent,
  photoLine,
  sourceBadge,
  stateTag,
  whyRows,
} from "./postcard-rules.js"

/**
 * The Trip Document's Postcards (P4.1, with P4.9's paper), read off the canvas's
 * TRIP screen.
 *
 * Markup and nothing else: every judgement is a function in `postcards.ts` or
 * `place-card.ts`. They take their data and their callbacks as props and know
 * nothing about the editor, the API or where a card is saved — the web app's node
 * view supplies all three — so the same components render the read-only share page.
 */

const tilted = (id: string, max?: number) => tiltStyle(id, max) as CSSProperties

const monoLabel = "font-mono text-[10px] text-ink-muted tracking-[.1em]"

const smallButton =
  "flex-1 border border-ink bg-transparent py-1.5 font-mono text-[10px] text-ink tracking-[.06em] hover:bg-ink hover:text-surface disabled:opacity-40"

export interface PlacePostcardProps {
  id: string
  place: Place
  evidence: CardEvidence | null
  state: PostcardState
  bbox: Bbox
  /** Absent in read-only views, which then show no buttons. */
  onRefresh?: () => void
  onTogglePin?: () => void
  refreshing?: boolean
}

/**
 * A place in the document: names, the quote with its stamp, the meter, and a
 * locator — and the explanation of the score behind a click (§6.3: show the
 * algorithm).
 */
export function PlacePostcard(props: PlacePostcardProps) {
  const { place, evidence, state } = props
  const [open, setOpen] = useState(false)
  const name = names(place)
  const tag = stateTag(state)
  const pct = localPercent(place)
  const why = whyRows(place)
  const editable = props.onRefresh !== undefined || props.onTogglePin !== undefined

  return (
    <div
      style={tilted(props.id)}
      className="rotate-(--tilt) cursor-pointer border border-track bg-paper px-6 py-[22px] shadow-postcard transition-[rotate,translate,box-shadow] duration-200 hover:-translate-y-0.5 hover:rotate-0 hover:shadow-postcard-lift"
    >
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[minmax(0,1fr)_128px]">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="min-w-0 text-left"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className={`${monoLabel} uppercase`}>{categoryLabel[place.category]}</span>
            <span className="size-[3px] rounded-full bg-ink-faint" aria-hidden />
            <span className={`${monoLabel} uppercase`}>{place.city}</span>
            <span
              className={`ml-auto border px-1.5 py-0.5 font-mono text-[10px] tracking-[.1em] ${tag.className}`}
            >
              {tag.label}
            </span>
          </div>
          <div className="font-display text-[30px] leading-[1.05] tracking-tight">
            {name.primary}
          </div>
          {name.secondary && (
            <div className="mt-1 text-[15px] text-ink-muted">{name.secondary}</div>
          )}
          {evidence ? (
            <>
              <div className="mt-3.5 border-accent-gold border-l-2 pl-3 text-sm italic leading-snug">
                “{evidence.quote}”
              </div>
              <div className="mt-2 flex items-center gap-2 text-ink-muted text-xs">
                <Stamp sourceId={evidence.sourceId} />
                <span>
                  {evidence.language ? `${evidence.language} · ` : ""}
                  {place.evidenceCount} piece{place.evidenceCount === 1 ? "" : "s"} of evidence
                </span>
              </div>
            </>
          ) : (
            <p className="mt-3.5 text-ink-faint text-sm">
              {place.evidenceCount === 0 ? "No evidence yet" : "No quote kept for this place"}
            </p>
          )}
          <LocalMeter pct={pct} />
          {open && (
            <div className="mt-3.5 border border-[#c9c3b4] border-dashed bg-surface px-3.5 py-3 text-[13px] leading-normal">
              <div className={`${monoLabel} mb-2`}>WHY THIS SCORE</div>
              {why.length === 0 ? (
                <p className="text-ink-muted">Nothing has scored this place yet.</p>
              ) : (
                why.map((w) => (
                  <div
                    key={w.label}
                    className="flex justify-between gap-3 border-track border-b py-[3px]"
                  >
                    <span>{w.label}</span>
                    <span className="font-mono text-accent-blue">{w.points}</span>
                  </div>
                ))
              )}
              <div className="mt-2 text-ink-muted">{provenance(place)}</div>
            </div>
          )}
        </button>
        <div className="flex flex-col gap-2.5">
          <MapThumb place={place} bbox={props.bbox} />
          {editable && (
            <div className="flex gap-1.5">
              <button
                type="button"
                className={smallButton}
                onClick={props.onRefresh}
                disabled={props.refreshing}
              >
                {props.refreshing ? "…" : "REFRESH"}
              </button>
              <button type="button" className={smallButton} onClick={props.onTogglePin}>
                {state === "pinned" ? "UNPIN" : "PIN"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** A source's stamp: small, uppercase, slightly crooked, as if pressed by hand. */
export function Stamp({ sourceId }: { sourceId: string }) {
  const badge = sourceBadge(sourceId)
  return (
    <span
      className={`inline-block -rotate-2 px-1.5 py-0.5 font-mono text-[9px] tracking-[.1em] ${badge.className}`}
    >
      {badge.label}
    </span>
  )
}

/** TOURIST ← → LOCAL, as the canvas draws it: one gradient bar to the local share. */
export function LocalMeter({ pct }: { pct: number | null }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex justify-between font-mono text-[10px] text-ink-muted tracking-[.08em]">
        <span>TOURIST</span>
        <span className="text-accent-blue">{pct === null ? "NOT SCORED" : `LOCAL ${pct}%`}</span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-[3px] bg-track">
        {pct !== null && (
          <div
            className="absolute inset-y-0 left-0 bg-linear-to-r from-accent-blue to-accent-pink"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * The midnight square with a dot in it. Where the dot sits is where the place is
 * inside the city's frame — the grid card's locator at postcard size — and the
 * coordinate is printed because a dot alone cannot be checked.
 */
function MapThumb({ place, bbox }: { place: Place; bbox: Bbox }) {
  const at = place.geo ? locate(place.geo, bbox) : null
  return (
    <div className="relative h-32 overflow-hidden rounded-[2px] bg-accent-blue">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.07)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.07)_1px,transparent_1px)] bg-size-[16px_16px]" />
      {at ? (
        <>
          <div
            className={`absolute size-2.5 -translate-1/2 rounded-full shadow-[0_0_0_5px_rgba(255,45,149,.25)] ${
              at.outside ? "border-2 border-accent-pink" : "bg-accent-pink"
            }`}
            style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
          />
          <div className="absolute bottom-1.5 left-2 font-mono text-[9px] text-white/70">
            {place.geo?.lat.toFixed(4)}, {place.geo?.lng.toFixed(4)}
          </div>
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center px-2 text-center font-mono text-[9px] text-white/60 tracking-[.08em]">
          NO COORDINATE
        </div>
      )}
    </div>
  )
}

/** A note: the one card that is not white. Editable in place when given `onChange`. */
export function NotePostcard({
  id,
  text,
  onChange,
}: {
  id: string
  text: string
  onChange?: (text: string) => void
}) {
  return (
    <div
      style={tilted(id, 0.5)}
      className="rotate-(--tilt) bg-note px-5 py-4 text-[15px] leading-normal shadow-postcard"
    >
      <div className="mb-1.5 font-mono text-[10px] text-ink-faint tracking-[.1em]">NOTE</div>
      {onChange ? (
        <AutoText value={text} onChange={onChange} placeholder="Write the thing you will forget." />
      ) : (
        <p className="whitespace-pre-wrap">{text}</p>
      )}
    </div>
  )
}

export function ChecklistPostcard({
  id,
  items,
  onChange,
}: {
  id: string
  items: readonly ChecklistItem[]
  onChange?: (items: ChecklistItem[]) => void
}) {
  const [draft, setDraft] = useState("")
  const set = (i: number, item: ChecklistItem) =>
    onChange?.(items.map((it, j) => (j === i ? item : it)))
  return (
    <div
      style={tilted(id, 0.5)}
      className="max-w-[480px] rotate-(--tilt) bg-paper px-[22px] py-[18px] shadow-postcard"
    >
      <div className="mb-2.5 font-mono text-[10px] text-ink-faint tracking-[.1em]">
        CHECKLIST · {checklistCount(items)}
      </div>
      {items.map((item, i) => (
        <label
          // Items have no ids of their own; position is their identity in the list.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={i}
          className="flex cursor-pointer items-center gap-3 border-[#efebe0] border-b py-[7px] text-[15px] hover:text-accent-pink"
        >
          <input
            type="checkbox"
            checked={item.done}
            disabled={!onChange}
            onChange={(e) => set(i, { ...item, done: e.target.checked })}
            className="size-4 flex-none appearance-none border-[1.5px] border-ink checked:bg-ink"
          />
          <span className={item.done ? "text-ink-faint line-through" : ""}>{item.text}</span>
          {onChange && (
            <button
              type="button"
              aria-label={`remove ${item.text}`}
              onClick={(e) => {
                e.preventDefault()
                onChange(items.filter((_, j) => j !== i))
              }}
              className="ml-auto font-mono text-[10px] text-ink-faint hover:text-signal-red"
            >
              ×
            </button>
          )}
        </label>
      ))}
      {onChange && (
        <form
          className="pt-2"
          onSubmit={(e) => {
            e.preventDefault()
            const text = draft.trim()
            if (!text) return
            onChange([...items, { text, done: false }])
            setDraft("")
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a thing, then Enter"
            className="w-full bg-transparent py-1 text-[15px] placeholder:text-ink-faint focus:outline-none"
          />
        </form>
      )}
    </div>
  )
}

export function LinkPostcard({
  id,
  url,
  kind,
  onChangeUrl,
  children,
}: {
  id: string
  url: string
  kind: LinkKind
  onChangeUrl?: (url: string) => void
  /** The price panel, for a hotel link. */
  children?: ReactNode
}) {
  const [draft, setDraft] = useState(url)
  return (
    <div
      style={tilted(id, 0.4)}
      className="rotate-(--tilt) border border-track bg-paper px-[18px] py-3.5 shadow-postcard"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="font-mono text-[10px] text-ink-faint tracking-[.1em]">LINK</span>
        {url && !onChangeUrl ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="min-w-0 truncate font-mono text-accent-blue text-xs"
          >
            {url}
          </a>
        ) : (
          <form
            className="min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault()
              onChangeUrl?.(draft.trim())
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => draft.trim() !== url && onChangeUrl?.(draft.trim())}
              placeholder="Paste a URL, then Enter"
              className="w-full bg-transparent font-mono text-accent-blue text-xs placeholder:text-ink-faint focus:outline-none"
            />
          </form>
        )}
      </div>
      {url && <p className="mt-2.5 text-ink-muted text-sm">{linkLine(kind)}</p>}
      {children}
    </div>
  )
}

export function PhotoPostcard({
  id,
  image,
  caption,
  geo,
  takenAt,
  onChangeCaption,
}: {
  id: string
  /** A data URL or an object URL; null while nothing has been dropped in. */
  image: string | null
  caption: string
  geo: unknown
  takenAt: string | null
  onChangeCaption?: (caption: string) => void
}) {
  return (
    <div
      style={tilted(id, 1.2)}
      className="w-[300px] max-w-full rotate-(--tilt) bg-paper px-3 pt-3 pb-3.5 shadow-postcard"
    >
      <div className="relative h-[200px] overflow-hidden bg-[linear-gradient(160deg,#2b2f4a,#16204a_60%,#0d1330)]">
        {image ? (
          <img src={image} alt={caption || "photo"} className="size-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] text-white/50 tracking-[.1em]">
            NO IMAGE
          </div>
        )}
      </div>
      <div className="mt-2.5 flex justify-between gap-3 font-mono text-[10px] text-ink-muted tracking-[.06em]">
        {onChangeCaption ? (
          <input
            defaultValue={caption}
            onBlur={(e) => e.target.value !== caption && onChangeCaption(e.target.value)}
            placeholder="CAPTION"
            className="min-w-0 flex-1 bg-transparent uppercase placeholder:text-ink-faint focus:outline-none"
          />
        ) : (
          <span className="uppercase">{caption}</span>
        )}
        <span className="flex-none">{photoLine(geo, takenAt)}</span>
      </div>
    </div>
  )
}

/** A card whose row is gone — shown rather than silently dropped. */
export function MissingPostcard({ onRemove }: { onRemove?: () => void }) {
  return (
    <div className="border border-rule border-dashed px-4 py-3 text-ink-faint text-sm">
      This Postcard could not be found.{" "}
      {onRemove && (
        <button type="button" onClick={onRemove} className="underline decoration-rule">
          Remove it from the document
        </button>
      )}
    </div>
  )
}

/** A textarea that grows with what is typed, so a note never scrolls inside itself. */
function AutoText({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}): ReactNode {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={Math.max(1, value.split("\n").length)}
      className="w-full resize-none bg-transparent leading-normal placeholder:text-ink-faint focus:outline-none [field-sizing:content]"
    />
  )
}
