import { categoryLabel, localPercent } from "@dt/ui"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import type { WirePlace } from "../../places/queries"
import { searchPlaces } from "../places"

/**
 * `/place`'s search (P4.2): the table's Places whose name contains what is typed,
 * strongest local score first, "with the local/tourist meter visible in results".
 *
 * Its own input rather than the text after `/place` in the document, so a search
 * in Thai does not leave half a word in the paragraph when it is abandoned.
 */

type Result = Awaited<ReturnType<typeof searchPlaces>>[number]

export function PlacePicker({
  rect,
  city,
  onPick,
  onClose,
}: {
  rect: DOMRect
  city: string
  onPick: (result: Result) => void
  onClose: () => void
}) {
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200)
    return () => clearTimeout(t)
  }, [q])

  const results = useQuery({
    queryKey: ["places", "search", debounced],
    queryFn: () => searchPlaces(debounced),
    enabled: debounced.length > 0,
    staleTime: 60_000,
  })
  const rows = results.data ?? []

  return (
    <div
      className="fixed z-30 w-[560px] max-w-[calc(100vw-32px)] bg-ink text-surface shadow-[0_20px_50px_-20px_rgba(0,0,0,.6)]"
      style={{ left: rect.left, top: rect.bottom + 8 }}
    >
      <div className="flex justify-between border-white/10 border-b px-3.5 py-3 font-mono text-[10px] text-surface/60 tracking-[.1em]">
        <span>PLACES · {city.toUpperCase()} · SORTED BY LOCAL SCORE</span>
        <span>{debounced ? `${rows.length} RESULT${rows.length === 1 ? "" : "S"}` : ""}</span>
      </div>
      <input
        // biome-ignore lint/a11y/noAutofocus: the picker opens because someone is about to type into it
        autoFocus
        value={q}
        placeholder="A name, in Thai or English"
        onChange={(e) => {
          setQ(e.target.value)
          setSelected(0)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose()
          else if (e.key === "ArrowDown") setSelected((s) => Math.min(s + 1, rows.length - 1))
          else if (e.key === "ArrowUp") setSelected((s) => Math.max(s - 1, 0))
          else if (e.key === "Enter") {
            const row = rows[selected]
            if (row) onPick(row)
          } else return
          e.preventDefault()
        }}
        onBlur={() => setTimeout(onClose, 150)}
        className="w-full bg-transparent px-3.5 py-2.5 font-body text-surface placeholder:text-surface/40 focus:outline-none"
      />
      {results.isError && (
        <p className="px-3.5 pb-3 text-signal-red text-sm">{results.error.message}</p>
      )}
      {debounced && !results.isPending && rows.length === 0 && (
        <p className="px-3.5 pb-3 text-sm text-surface/60">No place by that name yet.</p>
      )}
      {rows.map((r, i) => (
        <Row key={r.place.id} place={r.place} active={i === selected} onPick={() => onPick(r)} />
      ))}
    </div>
  )
}

function Row({ place, active, onPick }: { place: WirePlace; active: boolean; onPick: () => void }) {
  const pct = localPercent(place)
  const primary = place.localName ?? place.canonicalName
  const secondary = place.localName ? place.canonicalName : null
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault()
        onPick()
      }}
      className={`grid w-full grid-cols-[1fr_120px] items-center gap-3.5 border-white/5 border-b px-3.5 py-2.5 text-left ${
        active ? "bg-accent-blue" : "hover:bg-accent-blue"
      }`}
    >
      <div className="min-w-0">
        <div className="truncate font-display text-[19px]">
          {primary}{" "}
          {secondary && <span className="font-body text-[13px] text-surface/60">{secondary}</span>}
        </div>
        <div className="mt-0.5 text-surface/60 text-xs">
          {categoryLabel[place.category].toLowerCase()} · {place.evidenceCount} evidence
          {place.geo ? "" : " · no coordinate"}
        </div>
      </div>
      <div>
        <div className="flex justify-between font-mono text-[9px] text-surface/60">
          <span>T</span>
          <span className="text-accent-gold">{pct === null ? "—" : `L ${pct}%`}</span>
        </div>
        <div className="mt-[3px] h-1 bg-white/10">
          <div className="h-full bg-accent-gold" style={{ width: `${pct ?? 0}%` }} />
        </div>
      </div>
    </button>
  )
}
