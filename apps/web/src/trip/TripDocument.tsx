import { POSTCARD_ATTR, POSTCARD_NODE, type Postcard, postcardIdsIn } from "@dt/core"
import { Link, useParams } from "@tanstack/react-router"
import { Placeholder } from "@tiptap/extension-placeholder"
import { EditorContent, type Editor as TiptapEditor, useEditor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ApiError, api } from "../api"
import {
  dayToIso,
  shareTrip,
  type TripRecord,
  unshareTrip,
  usePatchTrip,
  useTrip,
} from "../trips/api"
import { dateRange, statusTag } from "../trips/format"
import { Failure } from "../trips/TripsHome"
import { CardStore, useCards } from "./cards"
import { DayLabels, PostcardNode, SlashCommand } from "./editor/extensions"
import { PlacePicker } from "./editor/PlacePicker"
import { SlashMenuView } from "./editor/SlashMenuView"
import { SlashMenu } from "./editor/slash"
import { MapView } from "./MapView"
import { photoPostcard } from "./photo"
import { snapshotOf } from "./places"
import { DocumentSaver, type SaveOutcome, statusLine } from "./saver"
import { TimelineView } from "./TimelineView"

/**
 * The Trip Document (P4.1, P4.2, P4.4, P4.5): a document you type into, with
 * Postcards as blocks, and the map and the timeline beside it as views derived
 * from it (§6.1).
 *
 * Read off the canvas's TRIP screen. The document column saves itself on a
 * debounce with the version it was loaded at; the rail reads the same cards the
 * document references and nothing else, so a card deleted from the text leaves
 * the map at once.
 */
export function TripDocument() {
  const { tripId } = useParams({ from: "/app/trips/$tripId" })
  const trip = useTrip(tripId)
  if (trip.isPending) return <p className="p-10 text-ink-faint text-sm">Opening the document…</p>
  if (trip.isError) {
    return (
      <div className="p-10">
        {trip.error instanceof ApiError && trip.error.status === 404 ? (
          <p className="text-ink-muted text-sm">No such trip.</p>
        ) : (
          <Failure error={trip.error} />
        )}
      </div>
    )
  }
  // Keyed on the trip, so moving between trips builds a fresh editor and store.
  return <Loaded key={trip.data.trip.id} record={trip.data} />
}

function Loaded({ record }: { record: TripRecord }) {
  const tripId = record.trip.id
  const [trip, setTrip] = useState(record.trip)
  const patchTrip = usePatchTrip(tripId)
  const store = useMemo(() => new CardStore(tripId, record.postcards), [tripId, record.postcards])
  const menu = useMemo(() => new SlashMenu(), [])
  const saver = useMemo(
    () =>
      new DocumentSaver({
        version: record.document.version,
        save: async (content, version): Promise<SaveOutcome> => {
          try {
            const body = await api<{ version: number }>(`/trips/${tripId}/document`, {
              method: "PUT",
              body: JSON.stringify({ content, version }),
            })
            return { saved: true, version: body.version }
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
              const current = (e.body as { version?: number } | null)?.version ?? version
              return { saved: false, version: current }
            }
            throw e
          }
        },
      }),
    [tripId, record.document.version],
  )
  const saveStatus = useSyncExternalStore(
    (fn) => saver.subscribe(fn),
    () => saver.status,
  )

  const [doc, setDoc] = useState<unknown>(record.document.content)
  const [picker, setPicker] = useState<{ rect: DOMRect } | null>(null)
  const editorRef = useRef<TiptapEditor | null>(null)
  const startRef = useRef<Date | null>(trip.startDate)
  startRef.current = trip.startDate
  const photoInput = useRef<HTMLInputElement>(null)

  const insertCard = (card: Postcard) => {
    editorRef.current
      ?.chain()
      .focus()
      .insertContent([
        { type: POSTCARD_NODE, attrs: { [POSTCARD_ATTR]: card.id } },
        { type: "paragraph" },
      ])
      .run()
  }

  const create = async (input: Parameters<CardStore["create"]>[0]) => {
    try {
      insertCard(await store.create(input))
    } catch (e) {
      store.lastError = e instanceof Error ? e.message : String(e)
      setError(store.lastError)
    }
  }
  const [error, setError] = useState<string | null>(null)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] } }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "paragraph" ? "Type, or / for a Postcard" : "",
      }),
      PostcardNode.configure({ store, city: trip.destinationCity, editable: true }),
      SlashCommand.configure({
        menu,
        onPick: (item, props) => {
          // Where the caret is, read before the `/place` text is deleted: afterwards
          // the suggestion's anchor is gone and its rect is wherever it fell back to.
          const rect = props.clientRect?.() ?? null
          props.editor.chain().focus().deleteRange(props.range).run()
          switch (item.id) {
            case "place":
              setPicker({ rect: rect ?? new DOMRect(200, 200, 0, 0) })
              return
            case "note":
              void create({ kind: "note", payload: { text: "" } })
              return
            case "checklist":
              void create({ kind: "checklist", payload: { items: [] } })
              return
            case "link":
              void create({ kind: "link", payload: { url: "" } })
              return
            case "price":
              void create({ kind: "price", payload: { offers: [], viewpoint: "us" } })
              return
            case "photo":
              photoInput.current?.click()
              return
          }
        },
      }),
      DayLabels.configure({ start: () => startRef.current }),
    ],
    content: record.document.content as object,
    editorProps: { attributes: { class: "trip-doc", "aria-label": "Trip document" } },
    onUpdate: ({ editor }) => {
      const json = editor.getJSON()
      saver.change(json)
      setDoc(json)
    },
  })
  editorRef.current = editor

  // Save on the way out: switching tabs, closing the window, following a link.
  useEffect(() => {
    const flush = () => void saver.flush()
    const hidden = () => document.visibilityState === "hidden" && flush()
    document.addEventListener("visibilitychange", hidden)
    window.addEventListener("pagehide", flush)
    return () => {
      flush()
      document.removeEventListener("visibilitychange", hidden)
      window.removeEventListener("pagehide", flush)
    }
  }, [saver])

  const allCards = useCards(store)
  const referenced = new Set(postcardIdsIn(doc))
  const inDocument = allCards.filter((c) => referenced.has(c.id))

  const focusCard = (id: string) => {
    const el = document.querySelector(`[data-postcard-id="${CSS.escape(id)}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    el.classList.add("card-flash")
    setTimeout(() => el.classList.remove("card-flash"), 1200)
  }

  const tag = statusTag(trip.status)
  const patch = (p: Parameters<typeof patchTrip.mutate>[0], local: Partial<typeof trip>) => {
    setTrip((t) => ({ ...t, ...local }))
    patchTrip.mutate(p)
  }

  return (
    <div className="grid flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="mx-auto w-full max-w-[820px] px-6 pt-8 pb-32 sm:px-[72px]">
        <Link to="/" className="mb-6 inline-block text-ink-muted text-sm hover:text-ink">
          ← All trips
        </Link>
        <div className="mb-3.5 flex flex-wrap gap-4 font-mono text-[11px] text-ink-faint tracking-[.08em]">
          <span>{trip.destinationCity.toUpperCase()}</span>
          <DatesEditor
            start={trip.startDate}
            end={trip.endDate}
            onChange={(start, end) =>
              patch(
                {
                  startDate: start ? dayToIso(start) : null,
                  endDate: end ? dayToIso(end) : null,
                  ...(start && trip.status === "dreaming" ? { status: "planning" as const } : {}),
                },
                {
                  startDate: start ? new Date(dayToIso(start)) : null,
                  endDate: end ? new Date(dayToIso(end)) : null,
                  ...(start && trip.status === "dreaming" ? { status: "planning" as const } : {}),
                },
              )
            }
          />
          <span className={tag.className.replace(/border-\S+/, "")}>{tag.label}</span>
          <ShareControl tripId={tripId} initial={record.shareToken} />
        </div>
        <TitleEditor
          value={trip.title}
          onChange={(title) => patch({ title }, { title })}
          onEnter={() => editor?.commands.focus("start")}
        />
        <EditorContent editor={editor} />
        {editor && <AddButton editor={editor} />}
        {error && (
          <p className="mt-4 text-signal-red text-sm">Could not add that Postcard: {error}</p>
        )}
      </div>

      <Rail
        cards={inDocument}
        doc={doc}
        store={store}
        city={trip.destinationCity}
        start={trip.startDate}
        end={trip.endDate}
        status={statusLine(saveStatus)}
        conflict={saveStatus.kind === "conflict"}
        onFocus={focusCard}
      />

      <SlashMenuView menu={menu} />
      {picker && (
        <PlacePicker
          rect={picker.rect}
          city={trip.destinationCity}
          onClose={() => setPicker(null)}
          onPick={(r) => {
            setPicker(null)
            void create({
              kind: "place",
              placeId: r.place.id,
              payload: snapshotOf(r.place, r.evidence, new Date()),
              geo: r.place.geo,
              sourceRefs: [],
            })
          }}
        />
      )}
      <input
        ref={photoInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ""
          if (file) await create(await photoPostcard(file))
        }}
      />
    </div>
  )
}

/** The title is the document's first line: a large serif sentence, saved on blur. */
function TitleEditor({
  value,
  onChange,
  onEnter,
}: {
  value: string
  onChange: (v: string) => void
  onEnter: () => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const next = draft.trim()
    if (next && next !== value) onChange(next)
    else setDraft(value)
  }
  return (
    <textarea
      aria-label="Trip title"
      value={draft}
      rows={1}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          commit()
          onEnter()
        }
      }}
      className="mb-5 w-full resize-none bg-transparent font-display text-[44px] leading-[1.05] tracking-tight focus:outline-none focus:shadow-[inset_0_-2px_0_var(--color-accent-pink)] sm:text-[60px] [field-sizing:content]"
    />
  )
}

/**
 * The `/` menu, for people who have not found `/`. The placeholder is the only
 * other cue, and it shows only on an empty line with the caret in it — and on a
 * phone `/` is behind the symbols keyboard. Types the `/` at the end of the
 * document, on a fresh line, so the menu that opens is the same one.
 */
function AddButton({ editor }: { editor: TiptapEditor }) {
  const add = () => {
    const last = editor.state.doc.lastChild
    const emptyLine = last?.type.name === "paragraph" && last.content.size === 0
    const chain = editor.chain().focus("end")
    if (!emptyLine) chain.insertContent({ type: "paragraph" })
    chain.insertContent("/").run()
  }
  return (
    <button
      type="button"
      onClick={add}
      className="mt-6 inline-flex items-center gap-2 rounded-full border border-ink/25 border-dashed px-4 py-2 text-ink-muted text-sm hover:border-ink hover:text-ink"
    >
      <span className="text-base leading-none">+</span> Add a Postcard
      <span className="font-mono text-[11px] text-ink-faint">or type /</span>
    </button>
  )
}

/** The dates in the meta line, which open into two date inputs when clicked. */
function DatesEditor({
  start,
  end,
  onChange,
}: {
  start: Date | null
  end: Date | null
  onChange: (start: string | null, end: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "")
  const [a, setA] = useState(day(start))
  const [b, setB] = useState(day(end))
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tracking-[.08em] hover:text-ink"
        title="Change dates"
      >
        {dateRange(start, end)}
      </button>
    )
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        setOpen(false)
        onChange(a || null, a && b && b >= a ? b : null)
      }}
    >
      <input
        type="date"
        aria-label="first day"
        value={a}
        onChange={(e) => setA(e.target.value)}
        className="bg-transparent"
      />
      →
      <input
        type="date"
        aria-label="last day"
        value={b}
        min={a}
        onChange={(e) => setB(e.target.value)}
        className="bg-transparent"
      />
      <button type="submit" className="border border-ink px-1.5 text-ink">
        SET
      </button>
    </form>
  )
}

function Rail({
  cards,
  doc,
  store,
  city,
  start,
  end,
  status,
  conflict,
  onFocus,
}: {
  cards: Postcard[]
  doc: unknown
  store: CardStore
  city: string
  start: Date | null
  end: Date | null
  status: string
  conflict: boolean
  onFocus: (id: string) => void
}) {
  const [tab, setTab] = useState<"map" | "timeline">("map")
  const tabClass = (on: boolean) =>
    `flex-1 border-b-2 py-2.5 ${on ? "border-accent-pink text-ink" : "border-transparent text-ink-faint hover:text-ink"}`
  return (
    <aside className="sticky top-[81px] flex h-[calc(100dvh-81px)] flex-col border-rule border-l bg-surface-raised max-lg:static max-lg:h-[420px] max-lg:border-t max-lg:border-l-0">
      <div className="flex border-rule border-b font-mono text-[10px] tracking-[.1em]">
        <button type="button" className={tabClass(tab === "map")} onClick={() => setTab("map")}>
          MAP
        </button>
        <button
          type="button"
          className={tabClass(tab === "timeline")}
          onClick={() => setTab("timeline")}
        >
          TIMELINE
        </button>
      </div>
      {tab === "map" ? (
        <MapView cards={cards} city={city} onFocus={onFocus} />
      ) : (
        <TimelineView
          doc={doc}
          cards={cards}
          store={store}
          start={start}
          end={end}
          onFocus={onFocus}
        />
      )}
      <div className="flex justify-end border-rule border-t px-3.5 py-2.5 text-ink-muted text-xs">
        {conflict ? (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-signal-red"
          >
            {status}
          </button>
        ) : (
          <span>{status}</span>
        )}
      </div>
    </aside>
  )
}

/**
 * The read-only link (P4.8), from the document's meta line: SHARE mints it, the
 * link is shown with a copy button, and STOP turns it off for everyone at once.
 */
function ShareControl({ tripId, initial }: { tripId: string; initial: string | null }) {
  const [token, setToken] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const url = token ? `${window.location.origin}/s/${token}` : null
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  if (!url) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => run(async () => setToken(await shareTrip(tripId)))}
        className="ml-auto tracking-[.08em] hover:text-ink disabled:opacity-50"
      >
        SHARE
      </button>
    )
  }
  return (
    <span className="ml-auto flex items-center gap-3">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="max-w-[220px] truncate text-accent-blue normal-case"
      >
        {url.replace(/^https?:\/\//, "")}
      </a>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard?.writeText(url)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="hover:text-ink"
      >
        {copied ? "COPIED" : "COPY"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await unshareTrip(tripId)
            setToken(null)
          })
        }
        className="hover:text-signal-red disabled:opacity-50"
      >
        STOP
      </button>
    </span>
  )
}
