import { categoryLabel, localPercent } from "@dt/ui"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import type { WirePlace } from "../../places/queries"
import { type OsmMatch, promoteOsm, searchPlaces } from "../places"

/**
 * `/place`'s search (P4.2): the table's Places whose name contains what is typed,
 * strongest local score first, "with the local/tourist meter visible in results".
 *
 * Below them, what OpenStreetMap knows by that name and no harvest has scored
 * yet. Picking one makes it a place (`POST /places/osm`), so the card pins a real
 * row with a coordinate; when a harvest later mentions it, dedup merges into that
 * row and the card's REFRESH picks up the scores.
 *
 * Its own input rather than the text after `/place` in the document, so a search
 * in Thai does not leave half a word in the paragraph when it is abandoned.
 */

type Result = Awaited<ReturnType<typeof promoteOsm>>

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
  const [promoting, setPromoting] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

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
  const scored = results.data?.places ?? []
  const osm = results.data?.osm ?? []
  const total = scored.length + osm.length

  // One cursor over both lists: scored rows first, then the map's.
  const pick = async (i: number) => {
    const row = scored[i]
    if (row) return onPick(row)
    const match = osm[i - scored.length]
    if (!match || promoting) return
    setPromoting(match.osmId)
    setFailure(null)
    try {
      onPick(await promoteOsm(match.osmId))
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Could not add that place.")
    } finally {
      setPromoting(null)
    }
  }

  return (
    <div
      className="fixed z-30 w-[560px] max-w-[calc(100vw-32px)] bg-ink text-surface shadow-[0_20px_50px_-20px_rgba(0,0,0,.6)]"
      style={{ left: Math.min(rect.left, window.innerWidth - 576), top: rect.bottom + 8 }}
    >
      <div className="flex justify-between border-white/10 border-b px-3.5 py-3 font-mono text-[10px] text-surface/60 tracking-[.1em]">
        <span>PLACES · {city.toUpperCase()}</span>
        <span>{debounced ? `${total} RESULT${total === 1 ? "" : "S"}` : ""}</span>
      </div>
      <input
        // biome-ignore lint/a11y/noAutofocus: the picker opens because someone is about to type into it
        autoFocus
        value={q}
        placeholder="A name, in Thai or English"
        aria-label="Search places"
        onChange={(e) => {
          setQ(e.target.value)
          setSelected(0)
          setFailure(null)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose()
          else if (e.key === "ArrowDown") setSelected((s) => Math.min(s + 1, total - 1))
          else if (e.key === "ArrowUp") setSelected((s) => Math.max(s - 1, 0))
          else if (e.key === "Enter") void pick(selected)
          else return
          e.preventDefault()
        }}
        onBlur={() => setTimeout(() => !promoting && onClose(), 150)}
        className="w-full bg-transparent px-3.5 py-2.5 font-body text-surface placeholder:text-surface/40 focus:outline-none"
      />
      {results.isError && (
        <p className="px-3.5 pb-3 text-signal-red text-sm">{results.error.message}</p>
      )}
      {failure && (
        <p role="alert" className="px-3.5 pb-3 text-signal-red text-sm">
          {failure}
        </p>
      )}
      {debounced && !results.isPending && total === 0 && (
        <p className="px-3.5 pb-3 text-sm text-surface/60">
          Nothing by that name. Try the Thai name, or a shorter part of it.
        </p>
      )}
      {scored.length > 0 && <Heading>SCORED BY LOCAL MENTIONS</Heading>}
      {scored.map((r, i) => (
        <Row key={r.place.id} place={r.place} active={i === selected} onPick={() => void pick(i)} />
      ))}
      {osm.length > 0 && <Heading>OPENSTREETMAP · NOT SCORED YET</Heading>}
      {osm.map((m, i) => (
        <MapRow
          key={m.osmId}
          match={m}
          active={scored.length + i === selected}
          busy={promoting === m.osmId}
          onPick={() => void pick(scored.length + i)}
        />
      ))}
    </div>
  )
}

function Heading({ children }: { children: string }) {
  return (
    <div className="border-white/5 border-b px-3.5 pt-2.5 pb-1.5 font-mono text-[9px] text-surface/50 tracking-[.12em]">
      {children}
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
          {categoryLabel[place.category].toLowerCase()} · {place.evidenceCount} mention
          {place.evidenceCount === 1 ? "" : "s"}
          {place.geo ? "" : " · not on the map yet"}
        </div>
      </div>
      <div title="Share of mentions from locals">
        <div className="flex justify-between font-mono text-[9px] text-surface/60">
          <span>TOURIST</span>
          <span className="text-accent-gold">{pct === null ? "—" : `LOCAL ${pct}%`}</span>
        </div>
        <div className="mt-[3px] h-1 bg-white/10">
          <div className="h-full bg-accent-gold" style={{ width: `${pct ?? 0}%` }} />
        </div>
      </div>
    </button>
  )
}

function MapRow({
  match,
  active,
  busy,
  onPick,
}: {
  match: OsmMatch
  active: boolean
  busy: boolean
  onPick: () => void
}) {
  const primary = match.localName ?? match.name
  const secondary = match.localName ? match.name : null
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
        <div className="mt-0.5 truncate text-surface/60 text-xs">
          <span>
            {categoryLabel[match.category].toLowerCase()} ·{" "}
            {match.formalName ? `formally ${match.formalName}` : "on the map"}
          </span>
        </div>
      </div>
      <div className="text-right font-mono text-[9px] text-surface/50 tracking-[.1em]">
        {busy ? "ADDING…" : "NOT SCORED YET"}
      </div>
    </button>
  )
}
