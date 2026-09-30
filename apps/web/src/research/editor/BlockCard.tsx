import {
  type AiDisclosureValue,
  type AiShareValue,
  BLOCK_ATTR,
  BLOCK_TITLES,
  type BlockKind,
  type ComparablesParams,
  type ComparableValue,
  currentComparables,
  type FactRecord,
  formatFact,
  parseParams,
  paramsChanged,
  type ReviewsValue,
  sourceOf,
} from "@rd/research"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { useMemo, useState } from "react"
import type { BlockView } from "../api"
import { useDocContext } from "../context"
import { searchTags, tagName } from "../tags"
import { ago, CiteButton, Evidence, nameOf } from "./parts"

/**
 * One research block in the document. The node holds an id; this draws the block
 * that id names from the page's context: its question (editable), its answer (the
 * facts of its last run, each opening its receipt), and what running it would cost.
 */
export function BlockCard({ node, deleteNode, selected }: ReactNodeViewProps) {
  const id = String(node.attrs[BLOCK_ATTR] ?? "")
  const { blocks } = useDocContext()
  const block = blocks.get(id)
  return (
    <NodeViewWrapper className="my-6" data-block-id={id}>
      <div
        className={`rd-block overflow-hidden rounded-md border bg-paper shadow-card ${
          selected ? "border-ink" : "border-rule"
        }`}
      >
        {block ? (
          <Card block={block} onRemove={deleteNode} />
        ) : (
          <div className="flex items-center justify-between px-4 py-3 text-ink-faint text-sm">
            <span>This block is missing from the database.</span>
            <button type="button" onClick={deleteNode} className="underline">
              Remove
            </button>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  )
}

function Card({ block, onRemove }: { block: BlockView; onRemove: () => void }) {
  return (
    <>
      <Header block={block} onRemove={onRemove} />
      <StaleBanner block={block} />
      <div className="px-4 pt-3 pb-4">
        {block.kind === "comparables" && <ComparablesBody block={block} />}
        {block.kind === "store_snapshot" && <SnapshotBody block={block} />}
        {block.kind === "slop_share" && <ShareBody block={block} />}
      </div>
      <Footer block={block} />
    </>
  )
}

// ---- chrome ---------------------------------------------------------------------

const KIND_TAGS: Record<BlockKind, string> = {
  comparables: "STORE SEARCH",
  store_snapshot: "API + CLOUD BROWSER",
  slop_share: "DERIVED",
}

function Header({ block, onRemove }: { block: BlockView; onRemove: () => void }) {
  const { run, progress, blocks } = useDocContext()
  const busy = block.status === "queued" || block.status === "running"
  const downstream = [...blocks.values()].some((b) => sourceOf(b.kind, b.params) === block.id)
  const [cascade, setCascade] = useState(true)
  const line = progress.get(block.id)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-rule border-b bg-surface-raised px-4 py-2.5">
      <div className="mr-auto flex items-baseline gap-2.5">
        <span className="font-serif text-[21px] leading-none">{BLOCK_TITLES[block.kind]}</span>
        <span className="font-mono text-[10px] text-ink-faint tracking-wider">{KIND_TAGS[block.kind]}</span>
      </div>
      {busy ? (
        <span className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
          <span className="size-2 animate-pulse rounded-full bg-signal-amber" />
          {block.status === "queued" ? "Queued" : (line ?? "Running")}
        </span>
      ) : (
        <>
          {downstream && (
            <label className="flex items-center gap-1.5 text-ink-muted text-xs">
              <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
              then the blocks below
            </label>
          )}
          <button
            type="button"
            title={block.estimate.label}
            onClick={() => run(block.id, downstream && cascade)}
            className="rounded-sm bg-ink px-3 py-1 font-medium text-paper text-xs hover:bg-night-raised"
          >
            {block.run ? "Run again" : "Run"}
          </button>
        </>
      )}
      <button
        type="button"
        aria-label="Remove block from document"
        title="Remove from the document (its runs and receipts are kept)"
        onClick={onRemove}
        className="text-ink-faint hover:text-ink"
      >
        ×
      </button>
      {!busy && (
        <p className="basis-full font-mono text-[10.5px] text-ink-faint">Costs: {block.estimate.label}</p>
      )}
    </div>
  )
}

function StaleBanner({ block }: { block: BlockView }) {
  const { run } = useDocContext()
  if (!block.stale || block.status === "queued" || block.status === "running") return null
  const asked = block.run && paramsChanged(block.kind, block.run.params, block.params)
  return (
    <div className="flex items-center gap-3 border-marker border-b bg-marker-soft px-4 py-2 text-sm">
      <span className="mr-auto">
        {asked
          ? "You changed the question since this ran. The answer below is for the old one."
          : "The block this reads from has changed since this ran."}
      </span>
      <button type="button" onClick={() => run(block.id, false)} className="font-medium underline">
        Re-run ({block.estimate.label})
      </button>
    </div>
  )
}

function Footer({ block }: { block: BlockView }) {
  const r = block.run
  if (!r) return null
  const s = r.stats
  const parts = [
    `ran ${ago(r.startedAt)}`,
    `${s.facts} facts from ${s.receipts} receipts`,
    s.requests > 0 ? `${s.requests} requests` : null,
    s.browserSessions > 0 ? `${s.browserSessions} Solari browser sessions (${s.browserMinutes.toFixed(1)} min)` : null,
  ].filter(Boolean)
  return (
    <div className="border-rule border-t px-4 py-2 font-mono text-[10.5px] text-ink-faint">
      <span className={OUTCOME_CLASS[r.outcome]}>{r.outcome.toUpperCase()}</span> · {parts.join(" · ")}
      {r.note && <p className="mt-1 whitespace-pre-wrap text-signal-red">{r.note}</p>}
    </div>
  )
}

const OUTCOME_CLASS: Record<string, string> = {
  ok: "text-signal-green",
  partial: "text-signal-amber",
  failed: "text-signal-red",
  blocked: "text-signal-red",
  running: "text-ink-muted",
}

// ---- comparables ------------------------------------------------------------------

function comparablesParams(block: BlockView): ComparablesParams {
  const p = parseParams("comparables", block.params)
  return p.ok ? p.value : { tagIds: [], sort: "relevance", limit: 12, exclude: [] }
}

function ComparablesBody({ block }: { block: BlockView }) {
  const { patch } = useDocContext()
  const params = comparablesParams(block)
  const matches = block.facts.find((f) => f.key === "matches")
  const rows = block.facts.filter((f) => f.key === "comparable")
  const kept = new Set(currentComparables(block.facts, params).map((f) => f.id))
  const excluded = new Set(params.exclude)
  const [showSpare, setShowSpare] = useState(false)
  const set = (p: Partial<ComparablesParams>) => patch(block.id, p)

  const listed = rows.filter((f) => kept.has(f.id) || excluded.has((f.value as ComparableValue).appid))
  const spare = rows.filter((f) => !kept.has(f.id) && !excluded.has((f.value as ComparableValue).appid))

  return (
    <div>
      <TagPicker tagIds={params.tagIds} onChange={(tagIds) => set({ tagIds })} />
      <div className="mt-2.5 flex flex-wrap items-center gap-4 text-ink-muted text-xs">
        <label className="flex items-center gap-1.5">
          Order
          <select
            value={params.sort}
            onChange={(e) => set({ sort: e.target.value as ComparablesParams["sort"] })}
            className="rounded-sm border border-rule bg-paper px-1 py-0.5 text-ink"
          >
            <option value="relevance">Steam's relevance</option>
            <option value="reviews">Most reviewed</option>
            <option value="released">Newest</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Keep
          <select
            value={params.limit}
            onChange={(e) => set({ limit: Number(e.target.value) })}
            className="rounded-sm border border-rule bg-paper px-1 py-0.5 text-ink"
          >
            {[4, 6, 8, 10, 12, 15, 20, 25].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          games
        </label>
      </div>

      {matches && (
        <p className="mt-4 flex flex-wrap items-baseline gap-2 text-[15px]">
          <Evidence fact={matches} className="font-serif text-[26px] leading-none">
            {Number(matches.value).toLocaleString("en-US")}
          </Evidence>
          <span>games on Steam carry all of these tags.</span>
          <CiteButton fact={matches} />
        </p>
      )}
      {!block.run && (
        <p className="mt-4 text-ink-faint text-sm">
          Pick two or three tags that describe your game, then Run. One store search, no browser.
        </p>
      )}

      {listed.length > 0 && (
        <ol className="mt-3 divide-y divide-rule border-rule border-y">
          {listed.map((f) => (
            <ComparableRow key={f.id} fact={f} struck={excluded.has((f.value as ComparableValue).appid)} params={params} block={block} />
          ))}
        </ol>
      )}
      {spare.length > 0 && (
        <div className="mt-2 text-xs">
          <button type="button" onClick={() => setShowSpare(!showSpare)} className="text-ink-muted underline">
            {showSpare ? "Hide" : "Show"} {spare.length} more from the same search
          </button>
          {showSpare && (
            <ol className="mt-2 divide-y divide-rule border-rule border-y opacity-70">
              {spare.map((f) => (
                <ComparableRow key={f.id} fact={f} struck={false} params={params} block={block} spare />
              ))}
            </ol>
          )}
        </div>
      )}
      {excluded.size > 0 && (
        <p className="mt-2 text-ink-faint text-xs">
          {excluded.size} struck out: kept in the list, left out of everything that reads from it.
        </p>
      )}
    </div>
  )
}

function ComparableRow({
  fact,
  struck,
  params,
  block,
  spare = false,
}: {
  fact: FactRecord
  struck: boolean
  params: ComparablesParams
  block: BlockView
  spare?: boolean
}) {
  const { patch } = useDocContext()
  const v = fact.value as ComparableValue
  const toggle = () =>
    patch(block.id, {
      exclude: struck ? params.exclude.filter((a) => a !== v.appid) : [...params.exclude, v.appid],
    })
  return (
    <li className={`flex items-center gap-3 py-1.5 text-sm ${struck ? "text-ink-faint" : ""}`}>
      <span className={`min-w-0 flex-1 truncate ${struck ? "line-through" : ""}`}>
        <Evidence fact={fact}>{v.name}</Evidence>
      </span>
      <span className="hidden w-24 font-mono text-[11px] text-ink-faint sm:block">{v.released}</span>
      <span className="w-14 text-right font-mono text-[11px]">
        {v.priceCents === null ? "—" : v.priceCents === 0 ? "Free" : `$${(v.priceCents / 100).toFixed(2)}`}
      </span>
      <span className="w-28 text-right font-mono text-[11px] text-ink-muted">
        {v.reviewPct === null ? "no reviews" : `${v.reviewPct}% of ${(v.reviewCount ?? 0).toLocaleString("en-US")}`}
      </span>
      {!spare && (
        <button
          type="button"
          onClick={toggle}
          title={struck ? "Put it back" : "Not a real comparable: leave it out of everything below"}
          className="w-14 text-right text-[11px] text-ink-muted hover:text-ink"
        >
          {struck ? "restore" : "strike"}
        </button>
      )}
    </li>
  )
}

export function TagPicker({ tagIds, onChange }: { tagIds: number[]; onChange: (ids: number[]) => void }) {
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  const hits = q.trim() ? searchTags(q, tagIds) : []
  const add = (id: number) => {
    if (tagIds.length >= 5) return
    onChange([...tagIds, id])
    setQ("")
    setActive(0)
  }
  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5">
        {tagIds.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded-sm bg-marker px-2 py-0.5 text-[13px]">
            {tagName(t)}
            {tagIds.length > 1 && (
              <button
                type="button"
                aria-label={`Remove tag ${tagName(t)}`}
                onClick={() => onChange(tagIds.filter((x) => x !== t))}
                className="text-ink-muted hover:text-ink"
              >
                ×
              </button>
            )}
          </span>
        ))}
        {tagIds.length < 5 && (
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, hits.length - 1))
              else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0))
              else if (e.key === "Enter" && hits[active]) add(hits[active][0])
              else if (e.key === "Escape") setQ("")
              else return
              e.preventDefault()
            }}
            placeholder={tagIds.length === 0 ? "Add a Steam tag: roguelike, cozy, deckbuilder…" : "+ tag"}
            aria-label="Add a Steam tag"
            className="min-w-[140px] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-ink-faint"
          />
        )}
      </div>
      {hits.length > 0 && (
        <ul className="absolute z-20 mt-1 w-64 rounded-sm border border-rule bg-paper py-1 shadow-card">
          {hits.map((t, i) => (
            <li key={t[0]}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  add(t[0])
                }}
                className={`w-full px-3 py-1 text-left text-sm ${i === active ? "bg-marker-soft" : ""}`}
              >
                {t[1]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- snapshot ----------------------------------------------------------------------

/** A source picker for a derived block: which block of `kind` it reads from. */
function SourcePicker({ block, kind }: { block: BlockView; kind: BlockKind }) {
  const { blocks, patch } = useDocContext()
  const current = sourceOf(block.kind, block.params)
  const options = [...blocks.values()].filter((b) => b.kind === kind)
  return (
    <label className="flex items-center gap-2 text-ink-muted text-xs">
      Reads from
      <select
        value={current ?? ""}
        onChange={(e) => patch(block.id, { source: e.target.value })}
        className="max-w-[320px] rounded-sm border border-rule bg-paper px-1 py-0.5 text-ink"
      >
        {!current && <option value="">Pick a block</option>}
        {options.map((b) => (
          <option key={b.id} value={b.id}>
            {describe(b)}
          </option>
        ))}
      </select>
    </label>
  )
}

function describe(b: BlockView): string {
  if (b.kind === "comparables") {
    const p = comparablesParams(b)
    return `${BLOCK_TITLES.comparables}: ${p.tagIds.map(tagName).join(" + ")}`
  }
  return BLOCK_TITLES[b.kind]
}

interface SnapshotRow {
  subject: string
  name?: FactRecord
  price?: FactRecord
  reviews?: FactRecord
  ai?: FactRecord
  tags?: FactRecord
  release?: FactRecord
  unavailable?: FactRecord
}

function SnapshotBody({ block }: { block: BlockView }) {
  const { names } = useDocContext()
  const rows = useMemo(() => {
    const by = new Map<string, SnapshotRow>()
    for (const f of block.facts) {
      const row = by.get(f.subject) ?? { subject: f.subject }
      if (f.key === "name") row.name = f
      if (f.key === "price") row.price = f
      if (f.key === "reviews") row.reviews = f
      if (f.key === "ai.disclosure") row.ai = f
      if (f.key === "tags") row.tags = f
      if (f.key === "release") row.release = f
      if (f.key === "unavailable") row.unavailable = f
      by.set(f.subject, row)
    }
    return [...by.values()]
  }, [block.facts])

  return (
    <div>
      <SourcePicker block={block} kind="comparables" />
      {!block.run && (
        <p className="mt-4 text-ink-faint text-sm">
          Reads each comparable's store page in a Solari cloud browser: price, reviews, tags, and whether the page
          carries Steam's AI-generated content disclosure. Every cell links to the API response or the
          screenshot it came from.
        </p>
      )}
      {rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-rule border-b text-left font-mono text-[10px] text-ink-faint uppercase tracking-wider">
                <th className="py-1.5 pr-3 font-normal">Game</th>
                <th className="py-1.5 pr-3 font-normal">Price</th>
                <th className="py-1.5 pr-3 font-normal">Reviews</th>
                <th className="py-1.5 pr-3 font-normal">AI disclosure</th>
                <th className="py-1.5 font-normal">Top tags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((r) => (
                <tr key={r.subject} className="align-top">
                  <td className="py-1.5 pr-3">
                    {r.name ? <Evidence fact={r.name} /> : nameOf(names, r.subject)}
                    {r.release && <div className="font-mono text-[10.5px] text-ink-faint">{formatFact(r.release)}</div>}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-[12px]">{r.price ? <Evidence fact={r.price} /> : "—"}</td>
                  <td className="py-1.5 pr-3 font-mono text-[12px]">
                    {r.reviews ? <Evidence fact={r.reviews}>{reviewsShort(r.reviews)}</Evidence> : "—"}
                  </td>
                  <td className="py-1.5 pr-3">
                    {r.ai ? (
                      <AiCell fact={r.ai} />
                    ) : r.unavailable ? (
                      <Evidence fact={r.unavailable} className="text-signal-red text-xs">
                        page not readable
                      </Evidence>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-1.5 text-[12px] text-ink-muted">
                    {r.tags ? <Evidence fact={r.tags}>{(r.tags.value as string[]).slice(0, 4).join(", ")}</Evidence> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function reviewsShort(f: FactRecord): string {
  const r = f.value as ReviewsValue
  if (r.total === 0) return "none yet"
  return `${Math.round((r.positive / r.total) * 100)}% of ${r.total.toLocaleString("en-US")}`
}

function AiCell({ fact }: { fact: FactRecord }) {
  const v = fact.value as AiDisclosureValue
  return (
    <span className="flex items-center gap-1.5">
      <Evidence fact={fact} className={v.disclosed ? "bg-marker px-1 font-medium text-xs" : "text-ink-muted text-xs"}>
        {v.disclosed ? "Discloses AI" : "None"}
      </Evidence>
      {v.disclosed && <CiteButton fact={fact} />}
    </span>
  )
}

// ---- share -----------------------------------------------------------------------

function ShareBody({ block }: { block: BlockView }) {
  const share = block.facts.find((f) => f.key === "ai.share")
  const v = share?.value as AiShareValue | undefined
  return (
    <div>
      <SourcePicker block={block} kind="store_snapshot" />
      {!share && (
        <p className="mt-4 text-ink-faint text-sm">
          Counts the snapshot's store pages that carry Steam's AI-generated content disclosure. Pages that
          could not be read are left out of the count and named, never treated as clean.
        </p>
      )}
      {share && v && (
        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
          <Evidence fact={share} className="font-serif text-[64px] leading-[0.9]">
            {v.pct}%
          </Evidence>
          <div className="min-w-[240px] flex-1 pb-1 text-[15px]">
            <p>
              {v.disclosed} of {v.total} store pages disclose generative AI.
              {v.unread > 0 && (
                <span className="text-signal-amber"> {v.unread} could not be read and are not counted.</span>
              )}
            </p>
            {v.disclosedApps.length > 0 && (
              <p className="mt-1 text-ink-muted text-sm">{v.disclosedApps.map((a) => a.name).join(", ")}</p>
            )}
            <div className="mt-2">
              <CiteButton fact={share} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
