import { BLOCK_ATTR, BLOCK_NODE } from "@rd/research"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { createBlock, createDoc, saveDoc, useDocs } from "./api"
import { ago } from "./editor/parts"
import { TagPicker } from "./editor/BlockCard"
import { tagName } from "./tags"

/**
 * The front page: your research documents, and "Scout a niche", which writes the
 * first one for you: comparables → store snapshot → AI share, chained, with the
 * headings a pitch or a postmortem would want.
 */
export function DocsHome() {
  const docs = useDocs()
  const [tags, setTags] = useState<number[]>([492])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const qc = useQueryClient()

  const scout = async () => {
    setBusy(true)
    setError(null)
    try {
      const named = tags.filter((t) => t !== 492).map(tagName)
      const title = named.length > 0 ? `${named.join(" + ")}: is the lane crowded?` : "Is the lane crowded?"
      const doc = await createDoc(title)
      const comp = await createBlock(doc.id, "comparables", { tagIds: tags, limit: 8 })
      const snap = await createBlock(doc.id, "store_snapshot", { source: comp.id })
      const share = await createBlock(doc.id, "slop_share", { source: snap.id })
      const block = (id: string) => ({ type: BLOCK_NODE, attrs: { [BLOCK_ATTR]: id } })
      const h2 = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] })
      const p = (text?: string) => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" })
      const content = {
        type: "doc",
        content: [
          p("The question: is there room on Steam for another game in this lane, and what does it cost to be in it?"),
          h2("Who is already here"),
          p("Strike anything that is not really a comparable. The blocks below read the list as you leave it."),
          block(comp.id),
          h2("What they charge, and how they are received"),
          block(snap.id),
          h2("How much of it is AI-made"),
          block(share.id),
          h2("What I conclude"),
          p("Write here. Press Cite on any number above and it lands in your sentence, linked to its receipt."),
          p(),
        ],
      }
      await saveDoc(doc.id, doc.version, { content })
      await qc.invalidateQueries({ queryKey: ["docs"] })
      await navigate({ to: "/docs/$docId", params: { docId: doc.id } })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const blank = async () => {
    const doc = await createDoc("Untitled research")
    await navigate({ to: "/docs/$docId", params: { docId: doc.id } })
  }

  return (
    <div className="mx-auto w-full max-w-[920px] px-4 pt-12 pb-24 sm:px-8">
      <h1 className="max-w-[640px] font-serif text-[46px] leading-[1.05]">
        Research your niche on Steam. <span className="bg-marker px-1">Every number</span> keeps its receipt.
      </h1>
      <p className="mt-4 max-w-[600px] text-[17px] text-ink-muted">
        Write the case for your game the way you would anyway. The numbers in it come from Steam's store,
        read by an API call or by a Solari cloud browser, and each one opens the response or the screenshot it
        came from.
      </p>

      <section className="mt-10 rounded-md border border-rule bg-paper p-5 shadow-card">
        <p className="font-mono text-[10px] text-ink-faint tracking-[0.18em]">START HERE</p>
        <h2 className="mt-1 font-serif text-[28px]">Scout a niche</h2>
        <p className="mt-1 mb-4 text-ink-muted text-sm">
          Describe your game in two or three Steam tags. You get a document that finds the comparables, reads
          their store pages, and counts how many disclose generative AI.
        </p>
        <div className="rounded-sm border border-rule px-3 py-2">
          <TagPicker tagIds={tags} onChange={setTags} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || tags.length < 2}
            onClick={() => void scout()}
            className="rounded-sm bg-ink px-4 py-2 font-medium text-paper text-sm disabled:opacity-40"
          >
            {busy ? "Writing it…" : "Create the document"}
          </button>
          <span className="text-ink-faint text-xs">
            {tags.length < 2 ? "Add at least one more tag." : "Nothing runs until you press Run."}
          </span>
          <button type="button" onClick={() => void blank()} className="ml-auto text-ink-muted text-sm underline">
            or start blank
          </button>
        </div>
        {error && <p className="mt-3 text-signal-red text-sm">{error}</p>}
      </section>

      <section className="mt-12">
        <h2 className="mb-3 font-mono text-[11px] text-ink-faint tracking-[0.18em]">YOUR DOCUMENTS</h2>
        {docs.isLoading && <p className="text-ink-faint text-sm">Loading…</p>}
        {docs.error && <p className="text-signal-red text-sm">Could not reach the API: {docs.error.message}</p>}
        {docs.data?.length === 0 && <p className="text-ink-faint text-sm">None yet.</p>}
        <ul className="divide-y divide-rule border-rule border-y">
          {docs.data?.map((d) => (
            <li key={d.id}>
              <Link
                to="/docs/$docId"
                params={{ docId: d.id }}
                className="flex items-baseline gap-4 py-3 hover:bg-surface-raised"
              >
                <span className="flex-1 font-serif text-[22px] leading-tight">{d.title || "Untitled research"}</span>
                <span className="font-mono text-[11px] text-ink-faint">
                  {d.blocks} {d.blocks === 1 ? "block" : "blocks"} · {ago(d.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
