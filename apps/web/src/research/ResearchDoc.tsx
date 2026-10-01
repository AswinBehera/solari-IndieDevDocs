import {
  BLOCK_ATTR,
  BLOCK_NODE,
  type BlockKind,
  type ComparableValue,
  FACT_ATTR,
  FACT_NODE,
  type FactRecord,
} from "@rd/research"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useParams } from "@tanstack/react-router"
import { Placeholder } from "@tiptap/extension-placeholder"
import { TextSelection } from "@tiptap/pm/state"
import { type Editor, EditorContent, useEditor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ApiError } from "../api"
import {
  createBlock,
  type DocResponse,
  docKey,
  followJob,
  type ReceiptFocus,
  saveDoc,
  useBlockMutations,
  useDoc,
} from "./api"
import { DocContext, type DocContextValue } from "./context"
import { FactChipNode, ResearchBlockNode, SlashCommand } from "./editor/extensions"
import { SlashMenuView } from "./editor/SlashMenuView"
import { SlashMenu } from "./editor/slash"
import { ReceiptDrawer } from "./receipts/ReceiptDrawer"
import { DocumentSaver, type SaveOutcome, statusLine } from "./saver"

/**
 * A research document: prose you write, research blocks that answer questions
 * about Steam, and chips that carry the blocks' numbers into your sentences. Every
 * number opens the receipt it was read from.
 */
export function ResearchDoc() {
  const { docId } = useParams({ from: "/app/docs/$docId" })
  const q = useDoc(docId)
  if (q.error) {
    return (
      <div className="mx-auto max-w-[760px] px-6 py-16 text-sm">
        {q.error instanceof ApiError && q.error.status === 404 ? (
          <p className="text-ink-muted">No such document.</p>
        ) : (
          <p className="text-signal-red">Could not load the document: {q.error.message}</p>
        )}
        <Link to="/" className="mt-4 inline-block underline">
          All documents
        </Link>
      </div>
    )
  }
  if (!q.data) return <p className="px-6 py-16 text-center text-ink-faint text-sm">Loading…</p>
  return <Loaded key={docId} initial={q.data} docId={docId} />
}

/** Which block kind a new block of `kind` reads from, if any. */
const SOURCE_KIND: Record<BlockKind, BlockKind | null> = {
  comparables: null,
  store_snapshot: "comparables",
  slop_share: "store_snapshot",
  niche_map: "comparables",
  decision: null,
}

function Loaded({ initial, docId }: { initial: DocResponse; docId: string }) {
  const qc = useQueryClient()
  const blocksList = useDoc(docId).data?.blocks ?? initial.blocks
  const { patch, run, refresh } = useBlockMutations(docId)

  const [title, setTitle] = useState(initial.doc.title)
  const titleRef = useRef(title)
  const saver = useMemo(
    () =>
      new DocumentSaver({
        version: initial.doc.version,
        save: async (content, version): Promise<SaveOutcome> => {
          try {
            const r = await saveDoc(docId, version, { content, title: titleRef.current })
            return { saved: true, version: r.version }
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
              return {
                saved: false,
                version: (e.body as { version?: number } | null)?.version ?? version,
              }
            }
            throw e
          }
        },
      }),
    [docId, initial.doc.version],
  )
  const status = useSyncExternalStore(
    (fn) => saver.subscribe(fn),
    () => saver.status,
  )

  // ---- what the blocks know --------------------------------------------------------

  const blocks = useMemo(() => new Map(blocksList.map((b) => [b.id, b])), [blocksList])
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const facts = useMemo(() => {
    const m = new Map<string, FactRecord>()
    for (const b of blocksList) for (const f of b.facts) m.set(f.id, f)
    return m
  }, [blocksList])
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of facts.values()) {
      if (f.key === "comparable" && !m.has(f.subject))
        m.set(f.subject, (f.value as ComparableValue).name)
      if (f.key === "name") m.set(f.subject, String(f.value))
    }
    return m
  }, [facts])

  // ---- runs and their progress -------------------------------------------------------

  const [progress, setProgress] = useState<Map<string, string>>(new Map())
  const streams = useRef(new Map<string, AbortController>())
  useEffect(() => {
    const all = streams.current
    return () => {
      for (const c of all.values()) c.abort()
    }
  }, [])

  const startRun = useCallback(
    (blockId: string, cascade: boolean) => {
      run.mutate(
        { id: blockId, cascade },
        {
          onSuccess: ({ jobId }) => {
            streams.current.get(blockId)?.abort()
            const ctl = new AbortController()
            streams.current.set(blockId, ctl)
            const set = (line: string | null) =>
              setProgress((p) => {
                const n = new Map(p)
                if (line === null) n.delete(blockId)
                else n.set(blockId, line)
                return n
              })
            followJob(jobId, (note) => set(note), ctl.signal)
              .catch(() => {})
              .finally(() => {
                set(null)
                void refresh()
              })
          },
        },
      )
    },
    [run, refresh],
  )

  // ---- the editor --------------------------------------------------------------------

  const menu = useMemo(() => new SlashMenu(), [])
  const editorRef = useRef<Editor | null>(null)
  const lastCaret = useRef<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** A new block reads from the nearest block of the kind it needs above where it goes. */
  const sourceAbove = (editor: Editor, pos: number, kind: BlockKind): string | null => {
    let found: string | null = null
    editor.state.doc.nodesBetween(0, pos, (node) => {
      if (node.type.name !== BLOCK_NODE) return
      const b = blocksRef.current.get(String(node.attrs[BLOCK_ATTR]))
      if (b?.kind === kind) found = b.id
    })
    if (found) return found
    // None above: any block of that kind in the document.
    for (const b of blocksRef.current.values()) if (b.kind === kind) return b.id
    return null
  }

  const addBlock = async (kind: BlockKind, pos: number) => {
    const editor = editorRef.current
    if (!editor) return
    setError(null)
    const needs = SOURCE_KIND[kind]
    let params: Record<string, unknown>
    if (needs) {
      const source = sourceAbove(editor, pos, needs)
      if (!source) {
        setError(
          needs === "comparables"
            ? "This block reads its niche from a comparables block. Add /comparables first."
            : "The AI share counts a snapshot's pages. Add /snapshot first.",
        )
        return
      }
      params = { source }
    } else if (kind === "comparables") {
      // Indie: every game this tool is for carries it, and the writer adds the rest.
      params = { tagIds: [492] }
    } else {
      params = {}
    }
    try {
      const block = await createBlock(docId, kind, params)
      qc.setQueryData<DocResponse>(docKey(docId), (d) =>
        d ? { ...d, blocks: [...d.blocks, block] } : d,
      )
      blocksRef.current = new Map(blocksRef.current).set(block.id, block)
      editor
        .chain()
        .focus()
        .insertContentAt(pos, [
          { type: BLOCK_NODE, attrs: { [BLOCK_ATTR]: block.id } },
          { type: "paragraph" },
        ])
        .run()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] } }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "paragraph" ? "Write, or type / to add research" : "",
      }),
      ResearchBlockNode,
      FactChipNode,
      SlashCommand.configure({
        menu,
        onPick: (item, props) => {
          props.editor.chain().focus().deleteRange(props.range).run()
          void addBlock(item.id, props.range.from)
        },
      }),
    ],
    content: initial.doc.content as object,
    editorProps: { attributes: { class: "rd-doc", "aria-label": "Research document" } },
    onUpdate: ({ editor }) => saver.change(editor.getJSON()),
    onSelectionUpdate: ({ editor }) => {
      const s = editor.state.selection
      if (s instanceof TextSelection) lastCaret.current = s.head
    },
  })
  editorRef.current = editor

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

  /**
   * Cite: the chip goes where the caret last was in the prose. With no caret yet,
   * into a new paragraph under the block the fact came from.
   */
  const cite = useCallback((fact: FactRecord) => {
    const ed = editorRef.current
    if (!ed) return
    const chip = { type: FACT_NODE, attrs: { [FACT_ATTR]: fact.id } }
    const pos = lastCaret.current
    const doc = ed.state.doc
    if (pos !== null && pos <= doc.content.size && doc.resolve(pos).parent.isTextblock) {
      ed.chain()
        .focus()
        .insertContentAt(pos, [chip, { type: "text", text: " " }])
        .run()
      return
    }
    let after = doc.content.size
    doc.descendants((node, p) => {
      if (node.type.name === BLOCK_NODE && node.attrs[BLOCK_ATTR] === fact.blockId)
        after = p + node.nodeSize
    })
    ed.chain()
      .focus()
      .insertContentAt(after, { type: "paragraph", content: [chip, { type: "text", text: " " }] })
      .run()
  }, [])

  const [focus, setFocus] = useState<ReceiptFocus | null>(null)
  const closeDrawer = useCallback(() => setFocus(null), [])
  const [attaching, setAttaching] = useState<string | null>(null)
  const attachingTo = attaching ? blocks.get(attaching) : undefined
  useEffect(() => {
    if (!attaching) return
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAttaching(null)
    window.addEventListener("keydown", esc)
    return () => window.removeEventListener("keydown", esc)
  }, [attaching])

  const ctx: DocContextValue = {
    docId,
    blocks,
    facts,
    names,
    progress,
    openReceipt: setFocus,
    cite,
    run: startRun,
    patch: (id, params) => patch.mutate({ id, params }, { onError: (e) => setError(e.message) }),
    attaching: attachingTo ? attaching : null,
    setAttaching,
  }

  const onTitle = (t: string) => {
    setTitle(t)
    titleRef.current = t
    if (editor) saver.change(editor.getJSON())
  }

  return (
    <DocContext.Provider value={ctx}>
      <div className={`transition-[padding] ${focus ? "xl:pr-[680px]" : ""}`}>
        <div className="mx-auto w-full max-w-[860px] px-4 pt-8 pb-40 sm:px-12">
          <div className="mb-6 flex items-center justify-between gap-4 text-sm">
            <Link to="/" className="text-ink-muted hover:text-ink">
              ← All documents
            </Link>
            <span
              className={`font-mono text-[11px] ${status.kind === "conflict" || status.kind === "error" ? "text-signal-red" : "text-ink-faint"}`}
            >
              {statusLine(status)}
            </span>
          </div>
          <textarea
            value={title}
            rows={1}
            onChange={(e) => onTitle(e.target.value.replace(/\n/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                editor?.commands.focus("start")
              }
            }}
            placeholder="Untitled research"
            aria-label="Document title"
            className="field-sizing-content mb-4 w-full resize-none bg-transparent font-serif text-[44px] leading-[1.1] outline-none placeholder:text-ink-faint"
          />
          <EditorContent editor={editor} />
          {error && (
            <p
              role="alert"
              className="mt-4 rounded-sm border border-signal-red/40 px-3 py-2 text-signal-red text-sm"
            >
              {error}
            </p>
          )}
          <SlashMenuView menu={menu} />
        </div>
      </div>
      {attachingTo && (
        <div className="-translate-x-1/2 fixed bottom-5 left-1/2 z-30 flex items-center gap-4 rounded-md bg-night px-4 py-2.5 text-paper text-sm shadow-card">
          <span>
            Collecting evidence: press <b>Attach</b> beside any number in the document.
          </span>
          <button
            type="button"
            onClick={() => setAttaching(null)}
            className="rounded-sm bg-marker px-2.5 py-0.5 font-medium text-ink"
          >
            Done
          </button>
        </div>
      )}
      {focus && <ReceiptDrawer focus={focus} onClose={closeDrawer} />}
    </DocContext.Provider>
  )
}
