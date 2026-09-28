import { type Postcard, postcardIdsIn } from "@dt/core"
import { useQuery } from "@tanstack/react-query"
import { useParams } from "@tanstack/react-router"
import { EditorContent, useEditor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { useMemo } from "react"
import { CardStore } from "../trip/cards"
import { placeCards, tripDays } from "../trip/days"
import { DayLabels, PostcardNode } from "../trip/editor/extensions"
import { MapView } from "../trip/MapView"
import { recordFromWire, type TripRecord, type WirePostcard, type WireTrip } from "../trips/api"
import { dateRange } from "../trips/format"

/**
 * The read-only link (P4.8): "the scrapbook export", for someone with no account.
 *
 * The same document through the same editor with editing off, so a Postcard on
 * the share page is exactly the card its owner sees, minus the controls — there
 * is no second renderer to drift. Read off the canvas's SHARE screen: a midnight
 * map band with the title laid over it, the document below, and a small "Made
 * with Doen Thang" mark at the foot.
 */

type SharedBody = {
  trip: Omit<WireTrip, "userId">
  document: { content: unknown; version: number; updatedAt: string }
  postcards: WirePostcard[]
}

async function readShare(token: string): Promise<TripRecord> {
  // Unauthenticated on purpose: the token in the path is the whole key.
  const res = await fetch(`/api/share/${encodeURIComponent(token)}`)
  if (res.status === 404) throw new Error("gone")
  if (!res.ok) throw new Error(`api returned ${res.status}`)
  const body = (await res.json()) as SharedBody
  return recordFromWire({ ...body, trip: { ...body.trip, userId: "" } })
}

export function SharePage() {
  const { token } = useParams({ from: "/s/$token" })
  const shared = useQuery({
    queryKey: ["share", token],
    queryFn: () => readShare(token),
    retry: false,
  })
  if (shared.isPending) return <p className="p-10 font-body text-ink-faint text-sm">Opening…</p>
  if (shared.isError) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-surface p-10 font-body">
        <p className="text-ink-muted">
          {shared.error.message === "gone"
            ? "This link has been turned off, or never existed."
            : `Could not open this link: ${shared.error.message}`}
        </p>
      </main>
    )
  }
  return <Shared record={shared.data} />
}

function Shared({ record }: { record: TripRecord }) {
  const { trip } = record
  const store = useMemo(() => new CardStore(trip.id, record.postcards), [trip.id, record.postcards])
  const editor = useEditor({
    editable: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] } }),
      PostcardNode.configure({ store, city: trip.destinationCity, editable: false }),
      DayLabels.configure({ start: () => trip.startDate }),
    ],
    content: record.document.content as object,
    editorProps: { attributes: { class: "trip-doc", "aria-label": "Trip document" } },
  })
  const referenced = new Set(postcardIdsIn(record.document.content))
  const cards: Postcard[] = record.postcards.filter((c) => referenced.has(c.id))
  const days = new Set(
    placeCards(record.document.content, new Map(cards.map((c) => [c.id, c])), trip.startDate)
      .map((p) => p.day?.getTime())
      .filter((d) => d !== undefined),
  ).size
  const dayCount = Math.max(days, tripDays(trip.startDate, trip.endDate).length)

  return (
    <main className="min-h-dvh bg-surface font-body text-ink">
      <header className="relative flex h-[260px] flex-col bg-accent-blue">
        <MapView cards={cards} city={trip.destinationCity} onFocus={focus} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-4 bg-linear-to-b from-transparent to-accent-blue/90 px-8 pt-10 pb-5">
          <div className="min-w-0">
            <p className="font-mono text-[11px] text-accent-gold tracking-[.1em]">
              {trip.destinationCity.toUpperCase()} · {dateRange(trip.startDate, trip.endDate)}
            </p>
            <h1 className="mt-1.5 font-display font-normal text-[34px] text-surface leading-tight">
              {trip.title}
            </h1>
          </div>
          <span className="ml-auto flex-none font-mono text-[10px] text-surface/60 tracking-[.1em]">
            READ ONLY · v{record.document.version}
          </span>
        </div>
      </header>
      <article className="mx-auto max-w-[680px] px-6 pt-10 pb-16">
        <EditorContent editor={editor} />
        <footer className="mt-14 flex items-baseline justify-between border-rule border-t pt-5">
          <a href="/" className="text-[13px] text-ink-muted">
            Made with <span className="font-display text-[18px] text-ink">Doen Thang</span>
          </a>
          <span className="font-mono text-[10px] text-ink-muted tracking-[.1em]">
            {cards.length} POSTCARD{cards.length === 1 ? "" : "S"} · {dayCount} DAY
            {dayCount === 1 ? "" : "S"}
          </span>
        </footer>
      </article>
    </main>
  )
}

function focus(id: string) {
  const el = document.querySelector(`[data-postcard-id="${CSS.escape(id)}"]`)
  el?.scrollIntoView({ behavior: "smooth", block: "center" })
}
