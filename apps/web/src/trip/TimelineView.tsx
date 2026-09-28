import type { Postcard } from "@dt/core"
import { type DragEvent, useState } from "react"
import type { CardStore } from "./cards"
import { dayHeading, type Placed, placeCards, tripDays } from "./days"
import { cardTitle, clockOf } from "./labels"

/**
 * The timeline view (P4.5): the document's Postcards grouped by day, and dragging
 * one to another day writes that day onto the Postcard.
 *
 * A card with no time of its own takes its day from the "Day N" heading it sits
 * under, and says so in a lighter ink — moving the heading moves the card. Dragging
 * it anywhere gives it a time of its own, which from then on wins over the heading.
 */
export function TimelineView({
  doc,
  cards,
  store,
  start,
  end,
  onFocus,
}: {
  doc: unknown
  cards: readonly Postcard[]
  store: CardStore
  start: Date | null
  end: Date | null
  onFocus: (id: string) => void
}) {
  const byId = new Map(cards.map((c) => [c.id, c]))
  const placed = placeCards(doc, byId, start)
  const days = tripDays(start, end)
  // Days that cards landed on outside the trip's range still get a group.
  for (const p of placed) {
    if (p.day && !days.some((d) => d.getTime() === p.day?.getTime())) days.push(p.day)
  }
  days.sort((a, b) => a.getTime() - b.getTime())
  const unscheduled = placed.filter((p) => p.day === null)
  const [over, setOver] = useState<string | null>(null)

  const drop = (target: Date | null) => (e: DragEvent) => {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData("text/postcard-id")
    const card = byId.get(id)
    if (!card) return
    // Keep the time of day when moving between days; a bare day is midnight.
    const hours = card.time?.start.getUTCHours() ?? 0
    const minutes = card.time?.start.getUTCMinutes() ?? 0
    const time = target
      ? { start: new Date(target.getTime() + (hours * 60 + minutes) * 60_000), end: null }
      : null
    void store.patch(
      id,
      { time: time ? { start: time.start.toISOString(), end: null } : null },
      { time },
    )
  }

  const group = (key: string, title: string, items: Placed[], target: Date | null) => (
    // A drop target for the pointer. The keyboard route to the same change is the
    // document itself: moving a card under another "Day N" heading.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    <section
      key={key}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(key)
      }}
      onDragLeave={() => setOver((o) => (o === key ? null : o))}
      onDrop={drop(target)}
      className={`mb-[18px] p-1 ${over === key ? "bg-surface outline-1 outline-accent-pink outline-dashed" : ""}`}
    >
      <h3 className="mb-2 font-mono text-[10px] text-ink-muted tracking-[.1em]">{title}</h3>
      {items.length === 0 && (
        <p className="border-rule border-t py-1.5 text-[13px] text-ink-faint">Nothing yet</p>
      )}
      {items.map((p) => {
        const card = byId.get(p.id)
        if (!card) return null
        return (
          <button
            type="button"
            key={p.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/postcard-id", p.id)}
            onClick={() => onFocus(p.id)}
            className="flex w-full cursor-grab items-baseline gap-2.5 border-rule border-t py-1.5 text-left text-[13px] hover:text-accent-pink"
          >
            <span className="w-11 flex-none font-mono text-[11px] text-accent-blue">
              {clockOf(card) || card.kind.toUpperCase().slice(0, 5)}
            </span>
            <span className={p.derived ? "text-ink-muted" : ""}>{cardTitle(card)}</span>
          </button>
        )
      })}
    </section>
  )

  return (
    <div className="flex-1 overflow-auto p-4">
      {days.map((d) =>
        group(
          d.toISOString(),
          dayHeading(d),
          placed.filter((p) => p.day?.getTime() === d.getTime()),
          d,
        ),
      )}
      {group("unscheduled", "UNSCHEDULED", unscheduled, null)}
      {placed.length === 0 && (
        <p className="px-1 text-[13px] text-ink-faint">
          Postcards land here by day: under a “Day 2” heading, from a photo’s time, or dragged.
        </p>
      )}
    </div>
  )
}
