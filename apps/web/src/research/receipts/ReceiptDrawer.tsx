import {
  type Box,
  type FactRecord,
  formatFact,
  type Locator,
  type ReceiptRecord,
  sha256Hex,
} from "@rd/research"
import { useQuery } from "@tanstack/react-query"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { type ReceiptFocus, useFacts, useReceipt } from "../api"
import { useDocContext } from "../context"
import { ago, nameOf } from "../editor/parts"

/**
 * The receipt behind a number: what was read, when, by what, and where in it the
 * number sits. The bytes are fetched and hashed again here, so "this is what the
 * run saw" is checked in the reader's browser rather than taken on trust.
 */
export function ReceiptDrawer({ focus, onClose }: { focus: ReceiptFocus; onClose: () => void }) {
  const { data, error, isLoading } = useReceipt(focus.receiptId)
  const [tab, setTab] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // One page's receipts: its HTML, the screenshot and the session replay. A boxed
  // fact is best seen on the screenshot, whichever of them it cites.
  const group = data?.group ?? []
  const shotId = group.find((r) => r.kind === "screenshot")?.id
  useEffect(() => {
    setTab(focus.locator.box && shotId ? shotId : focus.receiptId)
  }, [focus, shotId])

  const shown = group.find((r) => r.id === tab) ?? data?.receipt

  return (
    <aside
      aria-label="Receipt"
      className="fixed inset-y-0 right-0 z-40 flex w-[min(680px,100vw)] flex-col border-rule border-l bg-paper shadow-[-20px_0_60px_-30px_rgba(0,0,0,.35)]"
    >
      <div className="flex items-start gap-3 border-rule border-b bg-night px-5 py-4 text-surface">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] text-marker tracking-[0.18em]">RECEIPT</p>
          <FactHeading fact={focus.fact} />
        </div>
        <button type="button" onClick={onClose} aria-label="Close receipt" className="text-2xl text-surface/70 leading-none hover:text-surface">
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-5 text-ink-faint text-sm">Loading…</p>}
        {error && <p className="p-5 text-signal-red text-sm">{error.message}</p>}
        {data && shown && (
          <>
            {group.length > 1 && (
              <div className="flex gap-1 border-rule border-b px-5 pt-3">
                {group.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setTab(r.id)}
                    className={`-mb-px rounded-t-sm border px-3 py-1.5 text-xs ${
                      shown.id === r.id ? "border-rule border-b-paper bg-paper font-medium" : "border-transparent text-ink-muted"
                    }`}
                  >
                    {KIND_LABEL[r.kind]}
                  </button>
                ))}
              </div>
            )}
            <Meta receipt={shown} />
            <Body receipt={shown} locator={focus.locator} />
          </>
        )}
      </div>
    </aside>
  )
}

const KIND_LABEL: Record<ReceiptRecord["kind"], string> = {
  json: "API response",
  html: "Store page HTML",
  screenshot: "Screenshot",
  replay: "Session replay",
  computation: "Computation",
}

const RUNTIME_LABEL: Record<ReceiptRecord["runtime"], string> = {
  api: "Steam's public API, over HTTP",
  browser: "A Solari cloud browser",
  sandbox: "A Solari sandbox",
  desktop: "A Solari desktop",
  derived: "Computed from other facts, no network",
}

function FactHeading({ fact }: { fact: FactRecord | undefined }) {
  const { names } = useDocContext()
  if (!fact) return <p className="mt-1 font-serif text-2xl">A receipt</p>
  return (
    <>
      <p className="mt-1 font-serif text-[26px] leading-tight">{formatFact(fact)}</p>
      <p className="mt-0.5 text-sm text-surface/70">
        {fact.subject === "set" ? "About the whole list" : nameOf(names, fact.subject)} · {fact.key}
      </p>
    </>
  )
}

function useBytes(receipt: ReceiptRecord) {
  return useQuery({
    queryKey: ["receipt-bytes", receipt.ref],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const res = await fetch(`/receipts/${receipt.ref}`)
      if (!res.ok) throw new Error(`The archived bytes are not here (${res.status}). Receipts stay on the machine that ran the block.`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { bytes, sha256: await sha256Hex(bytes) }
    },
  })
}

function Meta({ receipt }: { receipt: ReceiptRecord }) {
  const bytes = useBytes(receipt)
  const verified = bytes.data ? bytes.data.sha256 === receipt.sha256 : null
  const isComputation = receipt.url.startsWith("computation:")
  const rows: [string, ReactNode][] = [
    ["Read by", RUNTIME_LABEL[receipt.runtime]],
    [
      "Source",
      isComputation ? (
        <code className="font-mono text-xs">{receipt.url}</code>
      ) : (
        <a href={receipt.url} target="_blank" rel="noreferrer" className="break-all font-mono text-link text-xs underline">
          {receipt.url}
        </a>
      ),
    ],
    ["Captured", `${new Date(receipt.capturedAt).toLocaleString("en-GB")} (${ago(receipt.capturedAt)})`],
  ]
  if (receipt.viewpoint) rows.push(["Viewpoint", receipt.viewpoint.toUpperCase()])
  if (receipt.sessionId) rows.push(["Browser session", <code key="s" className="font-mono text-xs">{receipt.sessionId}</code>])
  if (receipt.profile) rows.push(["Profile", <code key="p" className="font-mono text-xs">{receipt.profile}</code>])
  rows.push([
    "SHA-256",
    <span key="h" className="font-mono text-xs">
      {receipt.sha256.slice(0, 16)}… · {(receipt.bytes / 1024).toFixed(1)} KB ·{" "}
      {verified === null ? (
        <span className="text-ink-faint">{bytes.error ? "bytes not available here" : "checking…"}</span>
      ) : verified ? (
        <span className="text-signal-green">bytes match ✓</span>
      ) : (
        <span className="text-signal-red">bytes DO NOT match</span>
      )}
    </span>,
  ])
  return (
    <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 px-5 py-4 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-faint text-xs leading-5">{k}</dt>
          <dd className="min-w-0">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Body({ receipt, locator }: { receipt: ReceiptRecord; locator: Locator }) {
  const bytes = useBytes(receipt)
  if (bytes.error) return <p className="px-5 pb-5 text-signal-amber text-sm">{bytes.error.message}</p>
  if (!bytes.data) return null
  switch (receipt.kind) {
    case "screenshot":
      return <Screenshot src={`/receipts/${receipt.ref}`} box={locator.box} />
    case "html":
      return <Html text={new TextDecoder().decode(bytes.data.bytes)} locator={locator} />
    case "json":
    case "computation":
      return <Json text={new TextDecoder().decode(bytes.data.bytes)} locator={locator} />
    case "replay":
      return <Replay bytes={bytes.data.bytes} />
  }
}

// ---- replay ----------------------------------------------------------------------

/**
 * The browser session, played back from its rrweb recording. The player is loaded
 * only when a replay is opened. It rebuilds the page in an iframe sandboxed
 * without scripts, so, like the HTML, Steam's code never runs on our origin.
 */
function Replay({ bytes }: { bytes: Uint8Array }) {
  const target = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const events = useMemo(
    () =>
      new TextDecoder()
        .decode(bytes)
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { type: number; timestamp: number }),
    [bytes],
  )

  useEffect(() => {
    const el = target.current
    if (!el) return
    let player: { $destroy(): void } | null = null
    let gone = false
    Promise.all([import("rrweb-player"), import("rrweb-player/dist/style.css")])
      .then(([{ default: Player }]) => {
        if (gone) return
        // A Svelte component: `$destroy` is there at runtime, but its types come
        // from `svelte`, which this app does not install.
        player = new Player({
          target: el,
          props: { events: events as never, width: el.clientWidth, height: 420, autoPlay: false, skipInactive: true },
        }) as unknown as { $destroy(): void }
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
    return () => {
      gone = true
      player?.$destroy()
    }
  }, [events])

  const first = events[0]
  const last = events.at(-1)
  const seconds = first && last ? Math.round((last.timestamp - first.timestamp) / 1000) : 0
  return (
    <div className="space-y-2 px-5 pb-5">
      <p className="text-ink-muted text-xs">
        What the cloud browser did on this page: {events.length} recorded events over {seconds} s.
      </p>
      {failed && <p className="text-signal-amber text-xs">The player did not load: {failed}</p>}
      <div ref={target} className="overflow-hidden rounded-sm border border-rule" />
    </div>
  )
}

// ---- screenshot ------------------------------------------------------------------

function Screenshot({ src, box }: { src: string; box: Box | undefined }) {
  const frame = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [shown, setShown] = useState(0)

  useEffect(() => {
    if (!natural || !box || !frame.current) return
    const scale = shown / natural.w
    frame.current.scrollTop = Math.max(0, box.y * scale - 120)
  }, [natural, box, shown])

  const scale = natural ? shown / natural.w : 1
  return (
    <div className="px-5 pb-5">
      {box && <p className="mb-2 text-ink-muted text-xs">The marked region is where the number was read.</p>}
      <div ref={frame} className="relative max-h-[70vh] overflow-y-auto rounded-sm border border-rule bg-night">
        <img
          src={src}
          alt="The store page as the cloud browser saw it"
          className="block w-full"
          onLoad={(e) => {
            const img = e.currentTarget
            setNatural({ w: img.naturalWidth, h: img.naturalHeight })
            setShown(img.clientWidth)
          }}
        />
        {natural && box && (
          <div
            className="pointer-events-none absolute border-[3px] border-marker bg-marker/20 shadow-[0_0_0_9999px_rgba(22,28,38,.35)]"
            style={{ left: box.x * scale - 4, top: box.y * scale - 4, width: box.width * scale + 8, height: box.height * scale + 8 }}
          />
        )}
      </div>
    </div>
  )
}

// ---- html ------------------------------------------------------------------------

function Excerpt({ text, quote }: { text: string; quote: string }) {
  const i = text.indexOf(quote)
  if (i < 0) return <p className="text-signal-amber text-xs">The quoted text is not in these bytes verbatim.</p>
  const before = text.slice(Math.max(0, i - 360), i)
  const after = text.slice(i + quote.length, i + quote.length + 360)
  return (
    <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded-sm bg-surface-raised p-3 font-mono text-[11px] text-ink-muted leading-relaxed">
      …{before}
      <mark className="bg-marker text-ink">{quote}</mark>
      {after}…
    </pre>
  )
}

/** An absence, checked: the text the reader looked for is not in these bytes. */
function Absent({ text, absent }: { text: string; absent: string }) {
  const found = text.includes(absent)
  return (
    <p className="text-xs">
      Looked for <mark className="bg-marker px-1 text-ink">{absent}</mark>:{" "}
      {found ? (
        <span className="text-signal-red">it IS in these bytes</span>
      ) : (
        <span className="text-signal-green">not in these bytes ✓</span>
      )}
    </p>
  )
}

function Html({ text, locator }: { text: string; locator: Locator }) {
  const [render, setRender] = useState(false)
  return (
    <div className="space-y-3 px-5 pb-5">
      {locator.selector && (
        <p className="text-xs">
          Read from <code className="rounded-sm bg-surface-raised px-1 font-mono">{locator.selector}</code>
        </p>
      )}
      {locator.quote ? <Excerpt text={text} quote={locator.quote} /> : null}
      {locator.absent ? <Absent text={text} absent={locator.absent} /> : null}
      <button type="button" onClick={() => setRender(!render)} className="text-ink-muted text-xs underline">
        {render ? "Hide the page" : "Render the archived page (scripts off; loads Steam's images)"}
      </button>
      {render && (
        <iframe
          title="Archived store page"
          sandbox=""
          srcDoc={text}
          className="h-[70vh] w-full rounded-sm border border-rule bg-paper"
        />
      )}
    </div>
  )
}

// ---- json ------------------------------------------------------------------------

/** `$.413150.data.name`, `$.results[0].id` → the value there. */
export function atPath(root: unknown, path: string): { found: boolean; value: unknown } {
  const parts = path.replace(/^\$\.?/, "").match(/[^.[\]]+|\[\d+\]/g) ?? []
  let cur: unknown = root
  for (const p of parts) {
    const key = p.startsWith("[") ? Number(p.slice(1, -1)) : p
    if (cur === null || typeof cur !== "object" || !(key in (cur as object))) return { found: false, value: undefined }
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return { found: true, value: cur }
}

function Json({ text, locator }: { text: string; locator: Locator }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown }
    } catch {
      return { ok: false as const }
    }
  }, [text])
  const [whole, setWhole] = useState(false)
  if (!parsed.ok) return <pre className="px-5 pb-5 font-mono text-xs">{text.slice(0, 4000)}</pre>
  const at = locator.path ? atPath(parsed.value, locator.path) : null
  const pretty = JSON.stringify(parsed.value, null, 2)
  return (
    <div className="space-y-3 px-5 pb-5">
      {locator.path && at && (
        <div>
          <p className="mb-1 text-xs">
            At <code className="rounded-sm bg-marker px-1 font-mono">{locator.path}</code>
            {!at.found && <span className="text-signal-amber"> (not found in these bytes)</span>}
          </p>
          {at.found && typeof at.value === "string" && locator.quote ? (
            <Excerpt text={at.value} quote={locator.quote} />
          ) : at.found ? (
            <pre className="max-h-[40vh] overflow-auto rounded-sm bg-marker-soft p-3 font-mono text-[12px]">
              {typeof at.value === "string" && at.value.length > 2000
                ? `${at.value.slice(0, 2000)}…`
                : JSON.stringify(at.value, null, 2)}
            </pre>
          ) : null}
        </div>
      )}
      {locator.from && locator.from.length > 0 && <FromFacts ids={locator.from} />}
      <button type="button" onClick={() => setWhole(!whole)} className="text-ink-muted text-xs underline">
        {whole ? "Hide" : "Show"} the whole {(text.length / 1024).toFixed(1)} KB
      </button>
      {whole && (
        <pre className="max-h-[60vh] overflow-auto rounded-sm bg-surface-raised p-3 font-mono text-[11px] leading-relaxed">
          {pretty.length > 200_000 ? `${pretty.slice(0, 200_000)}\n…` : pretty}
        </pre>
      )}
    </div>
  )
}

/** A computation's inputs, each opening its own receipt: the chain back to Steam. */
function FromFacts({ ids }: { ids: string[] }) {
  const { data } = useFacts(ids)
  const { openReceipt, names } = useDocContext()
  if (!data) return null
  return (
    <div>
      <p className="mb-1 text-xs">Computed from {data.length} facts, each with its own receipt:</p>
      <ul className="divide-y divide-rule rounded-sm border border-rule text-sm">
        {data.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => openReceipt({ receiptId: f.receiptId, locator: f.locator, fact: f })}
              className="flex w-full justify-between gap-3 px-3 py-1.5 text-left hover:bg-marker-soft"
            >
              <span className="truncate">{nameOf(names, f.subject)}</span>
              <span className="flex-none text-ink-muted">{formatFact(f)} ↗</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
