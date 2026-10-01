import {
  type AiDisclosureValue,
  type AiShareValue,
  BLOCK_ATTR,
  BLOCK_TITLES,
  type BlockKind,
  type ComparablesParams,
  type ComparableValue,
  currentComparables,
  type DecisionValue,
  type FactRecord,
  formatCents,
  formatFact,
  type LaneValue,
  languageShares,
  type NeighboursValue,
  type PrototypeBootValue,
  type PrototypeBuildValue,
  type PrototypeConsoleValue,
  type PrototypeLiveValue,
  type PrototypeParams,
  type PrototypeScreenValue,
  paramsChanged,
  parseParams,
  type ReviewEarlyValue,
  type ReviewHoursValue,
  type ReviewLanguagesValue,
  type ReviewNegativeValue,
  type ReviewRecentValue,
  type ReviewsValue,
  type ReviewTrendValue,
  sourceOf,
} from "@rd/research"
import { searchTags, tagName } from "@rd/steam/tags"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { useEffect, useMemo, useState } from "react"
import { type BlockView, useReceipt } from "../api"
import { useDocContext } from "../context"
import { Dumbbells, HoursHistogram, priceTick, Scatter, ShareBars } from "./charts"
import { ago, CiteButton, decisionEvidence, Evidence, nameOf } from "./parts"

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
        {block.kind === "niche_map" && <NicheBody block={block} />}
        {block.kind === "review_signals" && <ReviewsBody block={block} />}
        {block.kind === "prototype" && <PrototypeBody block={block} />}
        {block.kind === "decision" && <DecisionBody block={block} />}
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
  niche_map: "STORE SEARCHES",
  review_signals: "REVIEWS API",
  prototype: "SANDBOX + CLOUD BROWSER",
  decision: "YOUR CALL",
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
        <span className="font-mono text-[10px] text-ink-faint tracking-wider">
          {KIND_TAGS[block.kind]}
        </span>
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
              <input
                type="checkbox"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
              />
              then the blocks below
            </label>
          )}
          <button
            type="button"
            title={block.estimate.label}
            disabled={!runnable(block)}
            onClick={() => run(block.id, downstream && cascade)}
            className="rounded-sm bg-ink px-3 py-1 font-medium text-paper text-xs hover:bg-night-raised disabled:opacity-40"
          >
            {block.kind === "decision"
              ? block.run
                ? "Record again"
                : "Record"
              : block.run
                ? "Run again"
                : "Run"}
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
        <p className="basis-full font-mono text-[10.5px] text-ink-faint">
          Costs: {block.estimate.label}
        </p>
      )}
    </div>
  )
}

/** A decision can only be recorded once it says something, and a prototype once it names a repository. */
const runnable = (b: BlockView): boolean =>
  b.kind === "decision"
    ? decisionParams(b).statement.length > 0
    : b.kind === "prototype"
      ? prototypeParams(b).repo.length > 0
      : true

function StaleBanner({ block }: { block: BlockView }) {
  const { run } = useDocContext()
  if (!block.stale || block.status === "queued" || block.status === "running") return null
  const asked = block.run && paramsChanged(block.kind, block.run.params, block.params)
  const message =
    block.kind === "decision"
      ? asked
        ? "You edited the decision or its evidence since it was recorded."
        : `${block.moves.length === 1 ? "A number" : `${block.moves.length} numbers`} it rests on ${block.moves.length === 1 ? "has" : "have"} moved since you decided. Check them below.`
      : asked
        ? "You changed the question since this ran. The answer below is for the old one."
        : "The block this reads from has changed since this ran."
  return (
    <div className="flex items-center gap-3 border-marker border-b bg-marker-soft px-4 py-2 text-sm">
      <span className="mr-auto">{message}</span>
      {(block.kind !== "decision" || asked) && runnable(block) && (
        <button
          type="button"
          onClick={() => run(block.id, false)}
          className="font-medium underline"
        >
          {block.kind === "decision" ? "Record again" : `Re-run (${block.estimate.label})`}
        </button>
      )}
    </div>
  )
}

function Footer({ block }: { block: BlockView }) {
  const r = block.run
  if (!r) return null
  const s = r.stats
  const parts = [
    `ran ${ago(r.startedAt)}`,
    `${s.facts} ${s.facts === 1 ? "fact" : "facts"} from ${s.receipts} ${s.receipts === 1 ? "receipt" : "receipts"}`,
    s.requests > 0 ? `${s.requests} requests` : null,
    s.browserSessions > 0
      ? `${s.browserSessions} Solari browser sessions (${s.browserMinutes.toFixed(1)} min)`
      : null,
  ].filter(Boolean)
  return (
    <div className="border-rule border-t px-4 py-2 font-mono text-[10.5px] text-ink-faint">
      <span className={OUTCOME_CLASS[r.outcome]}>{r.outcome.toUpperCase()}</span> ·{" "}
      {parts.join(" · ")}
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

  const listed = rows.filter(
    (f) => kept.has(f.id) || excluded.has((f.value as ComparableValue).appid),
  )
  const spare = rows.filter(
    (f) => !kept.has(f.id) && !excluded.has((f.value as ComparableValue).appid),
  )

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

      <Scatter
        points={rows.flatMap((f) => {
          const v = f.value as ComparableValue
          return kept.has(f.id) && v.priceCents && v.reviewCount
            ? [{ key: f.id, x: v.reviewCount, y: v.priceCents, label: v.name, fact: f }]
            : []
        })}
        xLabel="reviews (log)"
        yLabel="price"
        yFormat={priceTick}
        caption="The kept comparables by review count and price, from the search rows. Dashed lines are the medians. Click a dot for its row."
      />

      {listed.length > 0 && (
        <ol className="mt-3 divide-y divide-rule border-rule border-y">
          {listed.map((f) => (
            <ComparableRow
              key={f.id}
              fact={f}
              struck={excluded.has((f.value as ComparableValue).appid)}
              params={params}
              block={block}
            />
          ))}
        </ol>
      )}
      {spare.length > 0 && (
        <div className="mt-2 text-xs">
          <button
            type="button"
            onClick={() => setShowSpare(!showSpare)}
            className="text-ink-muted underline"
          >
            {showSpare ? "Hide" : "Show"} {spare.length} more from the same search
          </button>
          {showSpare && (
            <ol className="mt-2 divide-y divide-rule border-rule border-y opacity-70">
              {spare.map((f) => (
                <ComparableRow
                  key={f.id}
                  fact={f}
                  struck={false}
                  params={params}
                  block={block}
                  spare
                />
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
      <span className="hidden w-24 font-mono text-[11px] text-ink-faint sm:block">
        {v.released}
      </span>
      <span className="w-14 text-right font-mono text-[11px]">
        {v.priceCents === null
          ? "—"
          : v.priceCents === 0
            ? "Free"
            : `$${(v.priceCents / 100).toFixed(2)}`}
      </span>
      <span className="w-28 text-right font-mono text-[11px] text-ink-muted">
        {v.reviewPct === null
          ? "no reviews"
          : `${v.reviewPct}% of ${(v.reviewCount ?? 0).toLocaleString("en-US")}`}
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

export function TagPicker({
  tagIds,
  onChange,
}: {
  tagIds: number[]
  onChange: (ids: number[]) => void
}) {
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
          <span
            key={t}
            className="flex items-center gap-1 rounded-sm bg-marker px-2 py-0.5 text-[13px]"
          >
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
            placeholder={
              tagIds.length === 0 ? "Add a Steam tag: roguelike, cozy, deckbuilder…" : "+ tag"
            }
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
          Reads each comparable's store page in a Solari cloud browser: price, reviews, tags, and
          whether the page carries Steam's AI-generated content disclosure. Every cell links to the
          API response or the screenshot it came from.
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
                    {r.release && (
                      <div className="font-mono text-[10.5px] text-ink-faint">
                        {formatFact(r.release)}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-[12px]">
                    {r.price ? <Evidence fact={r.price} /> : "—"}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-[12px]">
                    {r.reviews ? (
                      <Evidence fact={r.reviews}>{reviewsShort(r.reviews)}</Evidence>
                    ) : (
                      "—"
                    )}
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
                    {r.tags ? (
                      <Evidence fact={r.tags}>
                        {(r.tags.value as string[]).slice(0, 4).join(", ")}
                      </Evidence>
                    ) : (
                      "—"
                    )}
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
      <Evidence
        fact={fact}
        className={v.disclosed ? "bg-marker px-1 font-medium text-xs" : "text-ink-muted text-xs"}
      >
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
          Counts the snapshot's store pages that carry Steam's AI-generated content disclosure.
          Pages that could not be read are left out of the count and named, never treated as clean.
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
                <span className="text-signal-amber">
                  {" "}
                  {v.unread} could not be read and are not counted.
                </span>
              )}
            </p>
            {v.disclosedApps.length > 0 && (
              <p className="mt-1 text-ink-muted text-sm">
                {v.disclosedApps.map((a) => a.name).join(", ")}
              </p>
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

// ---- niche breadth --------------------------------------------------------------------

function NicheBody({ block }: { block: BlockView }) {
  const { patch } = useDocContext()
  const p = parseParams("niche_map", block.params)
  const lanes = p.ok ? p.value.neighbours : 6
  const home = block.facts.find((f) => f.key === "lane" && f.subject === "set")
  const neighbours = block.facts.find((f) => f.key === "neighbours")
  const narrower = block.facts
    .filter((f) => f.key === "lane" && f.subject.startsWith("tag:"))
    .sort((a, b) => (a.value as LaneValue).total - (b.value as LaneValue).total)
  const broader = block.facts.filter((f) => f.key === "lane" && f.subject.startsWith("without:"))
  const h = home?.value as LaneValue | undefined
  const n = neighbours?.value as NeighboursValue | undefined

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <SourcePicker block={block} kind="comparables" />
        <label className="flex items-center gap-1.5 text-ink-muted text-xs">
          Lanes
          <select
            value={lanes}
            onChange={(e) => patch(block.id, { neighbours: Number(e.target.value) })}
            className="rounded-sm border border-rule bg-paper px-1 py-0.5 text-ink"
          >
            {[3, 4, 5, 6, 8, 10].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!block.run && (
        <p className="mt-4 text-ink-faint text-sm">
          Searches Steam for the niche, then for the niche plus each tag its games most often carry
          besides, and for the niche minus each of its own tags. Every count is one store search,
          kept as a receipt.
        </p>
      )}
      {home && h && (
        <>
          <p className="mt-4 flex flex-wrap items-baseline gap-2 text-[15px]">
            <Evidence fact={home} className="font-serif text-[26px] leading-none">
              {h.total.toLocaleString("en-US")}
            </Evidence>
            <span>games in this niche.</span>
            <CiteButton fact={home} />
          </p>
          <p className="mt-1 text-ink-muted text-sm">{laneSummary(h)}</p>
        </>
      )}
      {neighbours && n && n.baseline.length > 0 && (
        <p className="mt-2 text-sm">
          Nearly all of them are also tagged{" "}
          <Evidence fact={neighbours}>{n.baseline.map((t) => t.name).join(", ")}</Evidence>, so
          those describe the niche rather than split it.
        </p>
      )}
      {narrower.length > 0 && home && h && (
        <Scatter
          points={[home, ...narrower].flatMap((f) => {
            const v = f.value as LaneValue
            return v.medianReviews
              ? [
                  {
                    key: f.id,
                    x: v.total,
                    y: v.medianReviews,
                    label: v.pivot ? `+ ${v.pivot.name}` : "this niche",
                    fact: f,
                    emphasis: !v.pivot,
                  },
                ]
              : []
          })}
          xLabel="games in the lane (log)"
          yLabel="median reviews"
          yLog
          yFormat={(n) => n.toLocaleString("en-US")}
          labelled={narrower.length + 1}
          corner="↖ fewer games, more reviews each"
          caption="The niche and each lane one tag narrower: how many games it holds against how many reviews its typical game gets. Up and to the left is less crowded and better attended."
        />
      )}
      {narrower.length > 0 && h && (
        <div className="mt-4">
          <h4 className="font-mono text-[10px] text-ink-faint uppercase tracking-wider">
            One tag narrower: lanes inside the niche
          </h4>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-rule border-b text-left font-mono text-[10px] text-ink-faint uppercase tracking-wider">
                  <th className="py-1.5 pr-3 font-normal">Add</th>
                  <th className="py-1.5 pr-3 font-normal">Games</th>
                  <th className="py-1.5 pr-3 font-normal">Median price</th>
                  <th className="py-1.5 pr-3 font-normal">Median reviews</th>
                  <th className="py-1.5 font-normal">Most reviewed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {narrower.map((f) => (
                  <LaneRow key={f.id} fact={f} of={h.total} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-ink-faint text-xs">
            Medians are over each lane's first 25 games in Steam's relevance order, paid games only
            for price.
          </p>
        </div>
      )}
      {broader.length > 0 && h && (
        <div className="mt-4">
          <h4 className="font-mono text-[10px] text-ink-faint uppercase tracking-wider">
            One tag broader: what the niche sits in
          </h4>
          <ul className="mt-1 divide-y divide-rule border-rule border-y text-sm">
            {broader.map((f) => {
              const v = f.value as LaneValue
              return (
                <li key={f.id} className="flex flex-wrap items-baseline gap-2 py-1.5">
                  <span className="w-40 text-ink-muted">without {v.pivot?.name}</span>
                  <Evidence fact={f} className="font-mono text-[12px]">
                    {v.total.toLocaleString("en-US")} games
                  </Evidence>
                  <span className="font-mono text-[11px] text-ink-faint">
                    {h.total > 0 ? `${Math.round(v.total / h.total)}× the niche` : ""}
                  </span>
                  <span className="ml-auto">
                    <CiteButton fact={f} />
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function laneSummary(l: LaneValue): string {
  const parts = [
    l.medianPriceCents !== null
      ? `median price ${formatCents(l.medianPriceCents)}`
      : "mostly free or unpriced",
    l.medianReviews !== null ? `median ${l.medianReviews.toLocaleString("en-US")} reviews` : null,
    l.medianPositivePct !== null ? `${l.medianPositivePct}% positive` : null,
  ].filter(Boolean)
  return `Across its first ${l.sampled}: ${parts.join(", ")}.`
}

function LaneRow({ fact, of }: { fact: FactRecord; of: number }) {
  const v = fact.value as LaneValue
  const share = of > 0 ? Math.max(2, Math.round((v.total / of) * 100)) : 0
  return (
    <tr className="align-top">
      <td className="py-1.5 pr-3">
        + {v.pivot?.name}
        {v.overlap && (
          <div className="font-mono text-[10.5px] text-ink-faint">
            {v.overlap.carry} of the niche's first {v.overlap.of}
          </div>
        )}
      </td>
      <td className="py-1.5 pr-3">
        <div className="flex items-center gap-2">
          <Evidence fact={fact} className="w-14 font-mono text-[12px]">
            {v.total.toLocaleString("en-US")}
          </Evidence>
          <span className="h-1.5 w-20 rounded-full bg-surface-raised">
            <span
              className="block h-1.5 rounded-full bg-ink"
              style={{ width: `${Math.min(100, share)}%` }}
            />
          </span>
          <CiteButton fact={fact} />
        </div>
      </td>
      <td className="py-1.5 pr-3 font-mono text-[12px]">
        {v.medianPriceCents !== null ? formatCents(v.medianPriceCents) : "—"}
      </td>
      <td className="py-1.5 pr-3 font-mono text-[12px]">
        {v.medianReviews !== null ? v.medianReviews.toLocaleString("en-US") : "—"}
        {v.medianPositivePct !== null && (
          <span className="text-ink-faint"> · {v.medianPositivePct}%</span>
        )}
      </td>
      <td className="py-1.5 text-[12px] text-ink-muted">{v.top.map((t) => t.name).join(", ")}</td>
    </tr>
  )
}

// ---- reviews ---------------------------------------------------------------------------

interface ReviewRow {
  subject: string
  recent?: FactRecord
  negative?: FactRecord
  languages?: FactRecord
  unavailable?: FactRecord
}

function ReviewsBody({ block }: { block: BlockView }) {
  const { names, blocks } = useDocContext()
  const lane = (key: FactRecord["key"]) =>
    block.facts.find((f) => f.key === key && f.subject === "set")
  const early = lane("review.early")
  const hours = lane("review.hours")
  const trend = lane("review.trend")
  const languages = lane("review.languages")
  const rows = useMemo(() => {
    const by = new Map<string, ReviewRow>()
    for (const f of block.facts) {
      if (f.subject === "set") continue
      const row = by.get(f.subject) ?? { subject: f.subject }
      if (f.key === "review.recent") row.recent = f
      if (f.key === "review.negative") row.negative = f
      if (f.key === "review.languages") row.languages = f
      if (f.key === "unavailable") row.unavailable = f
      by.set(f.subject, row)
    }
    return [...by.values()]
  }, [block.facts])
  // All-time scores come from the comparables block's search rows, which is what
  // the trend compares against.
  const allTime = useMemo(() => {
    const src = blocks.get(sourceOf(block.kind, block.params) ?? "")
    const m = new Map<string, number | null>()
    for (const f of src?.facts ?? [])
      if (f.key === "comparable") m.set(f.subject, (f.value as ComparableValue).reviewPct)
    return m
  }, [blocks, block.kind, block.params])

  const e = early?.value as ReviewEarlyValue | undefined
  const h = hours?.value as ReviewHoursValue | undefined
  const t = trend?.value as ReviewTrendValue | undefined
  return (
    <div>
      <SourcePicker block={block} kind="comparables" />
      {!block.run && (
        <p className="mt-4 text-ink-faint text-sm">
          Reads two pages of each comparable's Steam reviews: the newest 100, and the newest 100
          negative ones. It counts hours played, the refund window and languages. No reviewer's
          words or name are copied into the document; the pages are kept as receipts.
        </p>
      )}
      {early && e && (
        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
          <Evidence fact={early} className="font-serif text-[52px] leading-[0.9]">
            {e.pct}%
          </Evidence>
          <div className="min-w-[240px] flex-1 pb-1 text-[15px]">
            <p>
              of {e.of.toLocaleString("en-US")} negative reviews were written with under 2 hours
              played, inside Steam's refund window. Steam marks {e.refunded} of the {e.of} as
              refunded.
            </p>
            <div className="mt-2">
              <CiteButton fact={early} />
            </div>
          </div>
        </div>
      )}
      {(hours || trend || languages) && (
        <ul className="mt-4 divide-y divide-rule border-rule border-y text-sm">
          {hours && h && (
            <li className="flex flex-wrap items-baseline gap-2 py-1.5">
              <span className="w-44 text-ink-muted">Hours played at review</span>
              <Evidence fact={hours}>
                positive {h.medianHoursUp ?? "?"} h, negative {h.medianHoursDown ?? "?"} h
              </Evidence>
              <span className="font-mono text-[11px] text-ink-faint">medians</span>
              <span className="ml-auto">
                <CiteButton fact={hours} />
              </span>
            </li>
          )}
          {trend && t && (
            <li className="flex flex-wrap items-baseline gap-2 py-1.5">
              <span className="w-44 text-ink-muted">Reviewed worse lately</span>
              <Evidence fact={trend}>
                {t.lower.length} of {t.judged} games
              </Evidence>
              <span className="text-[12px] text-ink-muted">
                {t.lower.map((g) => `${g.name} (${g.recentPct}% vs ${g.allTimePct}%)`).join(", ")}
              </span>
              <span className="ml-auto">
                <CiteButton fact={trend} />
              </span>
            </li>
          )}
          {languages && (
            <li className="flex flex-wrap items-baseline gap-2 py-1.5">
              <span className="w-44 text-ink-muted">Who is writing</span>
              <Evidence fact={languages} />
              <span className="ml-auto">
                <CiteButton fact={languages} />
              </span>
            </li>
          )}
        </ul>
      )}
      {hours && h?.buckets && <HoursHistogram fact={hours} buckets={h.buckets} />}
      {rows.length > 0 && (
        <>
          <h4 className="mt-5 font-mono text-[10px] text-ink-faint uppercase tracking-wider">
            Newest reviews against all-time score
          </h4>
          <Dumbbells
            margin={t?.margin ?? 5}
            rows={rows.flatMap((r) => {
              const rv = r.recent?.value as ReviewRecentValue | undefined
              const all = allTime.get(r.subject)
              return r.recent && rv && all != null
                ? [
                    {
                      key: r.subject,
                      label: nameOf(names, r.subject),
                      from: all,
                      to: rv.pct,
                      fact: r.recent,
                      note: `${rv.spanDays} d`,
                    },
                  ]
                : []
            })}
          />
          <h4 className="mt-5 font-mono text-[10px] text-ink-faint uppercase tracking-wider">
            Negative reviews written inside the refund window
          </h4>
          <ShareBars
            unit="negative reviews under 2 h"
            pooled={e?.pct ?? null}
            rows={rows.flatMap((r) => {
              const nv = r.negative?.value as ReviewNegativeValue | undefined
              return r.negative && nv
                ? [
                    {
                      key: r.subject,
                      label: nameOf(names, r.subject),
                      n: nv.early,
                      of: nv.sampled,
                      fact: r.negative,
                    },
                  ]
                : []
            })}
          />
          <p className="mt-1 text-ink-faint text-xs">
            The dashed line is the lane's pooled share. A pale bar has under 20 negative reviews in
            its sample and swings far on one review.
          </p>
        </>
      )}
      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-rule border-b text-left font-mono text-[10px] text-ink-faint uppercase tracking-wider">
                <th className="py-1.5 pr-3 font-normal">Game</th>
                <th className="py-1.5 pr-3 font-normal">Newest 100</th>
                <th className="py-1.5 pr-3 font-normal">Negative at</th>
                <th className="py-1.5 pr-3 font-normal">Under 2 h</th>
                <th className="py-1.5 font-normal">Languages</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((r) => {
                const rv = r.recent?.value as ReviewRecentValue | undefined
                const nv = r.negative?.value as ReviewNegativeValue | undefined
                const all = allTime.get(r.subject)
                return (
                  <tr key={r.subject} className="align-top">
                    <td className="py-1.5 pr-3">{nameOf(names, r.subject)}</td>
                    {r.unavailable ? (
                      <td colSpan={4} className="py-1.5">
                        <Evidence fact={r.unavailable} className="text-signal-red text-xs">
                          reviews not readable
                        </Evidence>
                      </td>
                    ) : (
                      <>
                        <td className="py-1.5 pr-3 font-mono text-[12px]">
                          {r.recent && rv ? (
                            <>
                              <Evidence fact={r.recent}>{rv.pct}%</Evidence>
                              {all != null && <span className="text-ink-faint"> vs {all}%</span>}
                              <div className="text-[10.5px] text-ink-faint">
                                over {rv.spanDays} days
                              </div>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-[12px]">
                          {r.negative && nv ? (
                            <Evidence fact={r.negative}>
                              {nv.medianHours !== null ? `${nv.medianHours} h` : "—"}
                            </Evidence>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-[12px]">
                          {nv ? (
                            <>
                              {nv.early} of {nv.sampled}
                              {nv.refunded > 0 && (
                                <span className="text-ink-faint"> · {nv.refunded} refunded</span>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-1.5 text-[12px] text-ink-muted">
                          {r.languages ? (
                            <Evidence fact={r.languages}>
                              {languageShares(r.languages.value as ReviewLanguagesValue, 2)}
                            </Evidence>
                          ) : (
                            "—"
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="mt-1.5 text-ink-faint text-xs">
            "Newest 100" is the share positive among each game's latest 100 reviews, against its
            all-time score from the store search. Hours are hours played when the review was
            written.
          </p>
        </div>
      )}
    </div>
  )
}

// ---- decision --------------------------------------------------------------------------

function decisionParams(b: BlockView) {
  const p = parseParams("decision", b.params)
  return p.ok ? p.value : { statement: "", evidence: [] }
}

/** Which game a cited fact is about. Lanes and whole-set facts already say what they cover. */
const subjectLabel = (names: Map<string, string>, subject: string): string | null =>
  subject.startsWith("app:") ? nameOf(names, subject) : null

function DecisionBody({ block }: { block: BlockView }) {
  const { patch, attaching, setAttaching, blocks, names } = useDocContext()
  const params = decisionParams(block)
  const [draft, setDraft] = useState(params.statement)
  const recorded = block.facts.find((f) => f.key === "decision")
  const value = recorded?.value as DecisionValue | undefined
  const evidence = decisionEvidence(block)
  const byId = new Map(block.evidence.map((f) => [f.id, f]))
  const moves = new Map(block.moves.map((m) => [m.factId, m.now]))
  const collecting = attaching === block.id
  const save = () =>
    draft.trim() !== params.statement && patch(block.id, { statement: draft.trim() })
  const swap = (from: string, to: string | null) =>
    patch(block.id, {
      evidence: to
        ? evidence.map((id) => (id === from ? to : id))
        : evidence.filter((id) => id !== from),
    })

  return (
    <div>
      <textarea
        value={draft}
        rows={2}
        maxLength={500}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        placeholder="The call: price it at $14.99, skip multiplayer, ship in Early Access…"
        aria-label="Decision"
        className="field-sizing-content w-full resize-none rounded-sm border border-rule bg-paper px-3 py-2 font-serif text-[19px] leading-snug outline-none focus:border-ink"
      />
      <div className="mt-3 flex items-center gap-3">
        <h4 className="mr-auto font-mono text-[10px] text-ink-faint uppercase tracking-wider">
          Rests on{" "}
          {evidence.length === 0
            ? "nothing yet"
            : `${evidence.length} ${evidence.length === 1 ? "number" : "numbers"}`}
        </h4>
        <button
          type="button"
          onClick={() => setAttaching(collecting ? null : block.id)}
          className={`rounded-sm border px-2 py-0.5 text-xs ${collecting ? "border-ink bg-marker" : "border-rule text-ink-muted hover:border-ink hover:text-ink"}`}
        >
          {collecting ? "Done attaching" : "Attach evidence"}
        </button>
      </div>
      {evidence.length > 0 && (
        <ul className="mt-1.5 divide-y divide-rule border-rule border-y text-sm">
          {evidence.map((id) => {
            const f = byId.get(id)
            if (!f) {
              return (
                <li key={id} className="flex items-center gap-2 py-1.5 text-ink-faint">
                  <span className="mr-auto">A number that is no longer in this document</span>
                  <button
                    type="button"
                    onClick={() => swap(id, null)}
                    className="text-xs underline"
                  >
                    remove
                  </button>
                </li>
              )
            }
            const moved = moves.has(id)
            const now = moves.get(id) ?? null
            const from = blocks.get(f.blockId)
            return (
              <li key={id} className="py-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="w-40 shrink-0 truncate font-mono text-[10.5px] text-ink-faint">
                    {from ? BLOCK_TITLES[from.kind] : "a removed block"}
                  </span>
                  {subjectLabel(names, f.subject) && (
                    <span className="text-ink-muted">{subjectLabel(names, f.subject)}</span>
                  )}
                  <Evidence
                    fact={f}
                    className={moved ? "line-through decoration-signal-amber" : ""}
                  />
                  <span className="ml-auto">
                    <button
                      type="button"
                      onClick={() => swap(id, null)}
                      className="text-ink-faint text-xs hover:text-ink"
                    >
                      remove
                    </button>
                  </span>
                </div>
                {moved && (
                  <div className="mt-1 ml-42 flex flex-wrap items-baseline gap-2 text-signal-amber text-xs">
                    {now ? (
                      <>
                        now <Evidence fact={now} className="text-ink" />
                        <button
                          type="button"
                          onClick={() => swap(id, now.id)}
                          className="font-medium underline"
                        >
                          Take the new reading
                        </button>
                      </>
                    ) : (
                      "the latest run did not read this at all"
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {recorded && value && (
        <p className="mt-3 flex flex-wrap items-baseline gap-2 text-ink-muted text-xs">
          <Evidence fact={recorded}>Recorded {ago(recorded.createdAt)}</Evidence>
          with {value.evidence.length} {value.evidence.length === 1 ? "number" : "numbers"} as they
          stood.
          <CiteButton fact={recorded} label="Cite the decision" />
        </p>
      )}
      {!recorded && (
        <p className="mt-3 text-ink-faint text-sm">
          Write the call, attach the numbers it rests on, then Record. If a block later reads one of
          them differently, this block says so; it never changes by itself.
        </p>
      )}
    </div>
  )
}

// ---- prototype --------------------------------------------------------------------

function prototypeParams(b: BlockView): PrototypeParams {
  const p = parseParams("prototype", b.params)
  return p.ok ? p.value : { repo: "", ref: "", dir: "", keepMinutes: 15 }
}

const KEEP_CHOICES = [0, 5, 15, 30, 60]

const momentRank = (f: FactRecord) => ((f.value as PrototypeScreenValue).moment === "boot" ? 0 : 1)

/** Re-renders once a minute, so a live build turns back into screenshots when its time is up. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}

function PrototypeBody({ block }: { block: BlockView }) {
  const { patch } = useDocContext()
  const params = prototypeParams(block)
  const [draft, setDraft] = useState(params)
  const now = useNow()
  const byKey = (key: string) => block.facts.find((f) => f.key === key)
  const build = byKey("prototype.build")
  const boot = byKey("prototype.boot")
  const consoleFact = byKey("prototype.console")
  const live = byKey("prototype.live")
  const liveValue = live?.value as PrototypeLiveValue | undefined
  const playable = liveValue && Date.parse(liveValue.until) > now ? liveValue : null
  const shots = block.facts
    .filter((f) => f.key === "prototype.screen")
    .sort((a, b) => momentRank(a) - momentRank(b))
  const save = (next: Partial<PrototypeParams>) => {
    const merged = { ...draft, ...next }
    setDraft(merged)
    if (paramsChanged("prototype", params, merged) || merged.keepMinutes !== params.keepMinutes)
      patch(block.id, merged)
  }
  const field =
    "rounded-sm border border-rule bg-paper px-2 py-1 font-mono text-xs outline-none focus:border-ink"

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <input
          value={draft.repo}
          onChange={(e) => setDraft({ ...draft, repo: e.target.value })}
          onBlur={() => save({ repo: draft.repo.trim() })}
          placeholder="https://github.com/you/your-web-build"
          aria-label="Git repository"
          className={`${field} min-w-64 flex-1`}
        />
        <input
          value={draft.ref}
          onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
          onBlur={() => save({ ref: draft.ref.trim() })}
          placeholder="branch"
          aria-label="Branch or tag"
          className={`${field} w-28`}
        />
        <input
          value={draft.dir}
          onChange={(e) => setDraft({ ...draft, dir: e.target.value })}
          onBlur={() => save({ dir: draft.dir.trim() })}
          placeholder="folder with index.html"
          aria-label="Folder holding index.html"
          className={`${field} w-44`}
        />
        <select
          value={draft.keepMinutes}
          onChange={(e) => save({ keepMinutes: Number(e.target.value) })}
          aria-label="How long to keep it playable"
          className={field}
        >
          {KEEP_CHOICES.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? "record only" : `playable ${m} min`}
            </option>
          ))}
        </select>
      </div>

      {!block.run && (
        <p className="mt-3 text-ink-faint text-sm">
          A static web build: a repository whose folder holds an index.html (an HTML5 export from
          Godot, Unity, Phaser or plain JS). A Solari sandbox clones and serves it, a cloud browser
          records it booting and taking input, and the document keeps it playable for a while.
        </p>
      )}

      {playable ? (
        <LiveBuild live={playable} poster={shots[0]} />
      ) : (
        shots.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {shots.map((f) => (
              <Shot key={f.id} fact={f} />
            ))}
          </div>
        )
      )}
      {liveValue && !playable && (
        <p className="mt-1.5 text-ink-faint text-xs">
          Was playable until {new Date(liveValue.until).toLocaleTimeString("en-GB")}; run again to
          play it.
        </p>
      )}

      {(build || boot) && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {build && <BuildLine fact={build} />}
          {boot && <BootLine fact={boot} />}
          {consoleFact && <ConsoleLines fact={consoleFact} />}
        </ul>
      )}
    </div>
  )
}

/** The build itself, in the page. Mounted on a click, so opening the document never starts a game. */
function LiveBuild({ live, poster }: { live: PrototypeLiveValue; poster: FactRecord | undefined }) {
  const [playing, setPlaying] = useState(false)
  const until = new Date(live.until).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })
  return (
    <div className="mt-3">
      <div className="relative aspect-[16/10] overflow-hidden rounded-sm border border-rule bg-night">
        {playing ? (
          <iframe
            src={live.url}
            title="The prototype, running in a Solari sandbox"
            sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-popups"
            allow="fullscreen; gamepad; autoplay"
            className="absolute inset-0 size-full"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="group absolute inset-0 flex items-center justify-center"
          >
            {poster && (
              <ShotImage
                fact={poster}
                className="absolute inset-0 size-full object-cover opacity-60"
              />
            )}
            <span className="relative rounded-sm bg-paper px-4 py-2 font-medium text-ink text-sm shadow-card group-hover:bg-marker">
              ▶ Play the build
            </span>
          </button>
        )}
      </div>
      <p className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[10.5px] text-ink-faint">
        <span>Running in a Solari sandbox until {until}, then stopped.</span>
        <a href={live.url} target="_blank" rel="noreferrer" className="underline">
          open in a new tab
        </a>
        <span>The link carries an access token: do not paste it into a share.</span>
      </p>
    </div>
  )
}

function ShotImage({ fact, className }: { fact: FactRecord; className: string }) {
  const { data } = useReceipt(fact.receiptId)
  if (!data) return null
  const moment = (fact.value as PrototypeScreenValue).moment
  return (
    <img
      src={`/receipts/${data.receipt.ref}`}
      alt={moment === "boot" ? "The build after it booted" : "The build after a click and keys"}
      className={className}
    />
  )
}

function Shot({ fact }: { fact: FactRecord }) {
  return (
    <figure>
      <Evidence fact={fact} className="block w-full no-underline">
        <ShotImage
          fact={fact}
          className="aspect-[16/10] w-full rounded-sm border border-rule object-cover"
        />
      </Evidence>
      <figcaption className="mt-1 font-mono text-[10.5px] text-ink-faint">
        {formatFact(fact)}
      </figcaption>
    </figure>
  )
}

function BuildLine({ fact }: { fact: FactRecord }) {
  const v = fact.value as PrototypeBuildValue
  return (
    <li className="flex flex-wrap items-baseline gap-2">
      <span className="w-20 shrink-0 font-mono text-[10.5px] text-ink-faint">BUILD</span>
      <Evidence fact={fact} />
      <span className="text-ink-muted text-xs">
        {(v.bytes / 1_048_576).toFixed(1)} MB
        {v.committedAt && `, committed ${ago(v.committedAt)}`}
      </span>
      <CiteButton fact={fact} />
    </li>
  )
}

function BootLine({ fact }: { fact: FactRecord }) {
  const v = fact.value as PrototypeBootValue
  const notes = [
    v.canvas ? `${v.canvas.width}×${v.canvas.height} canvas` : "no canvas element",
    v.changedAfterInput === null
      ? null
      : v.changedAfterInput
        ? "the screen changed after input"
        : "the screen did not change after input",
    v.failedRequests > 0 ? `${v.failedRequests} failed requests` : null,
  ].filter(Boolean)
  return (
    <li className="flex flex-wrap items-baseline gap-2">
      <span className="w-20 shrink-0 font-mono text-[10.5px] text-ink-faint">BOOT</span>
      <Evidence
        fact={fact}
        className={v.errors > 0 || v.loadMs === null ? "text-signal-red" : ""}
      />
      <span className="text-ink-muted text-xs">{notes.join(", ")}</span>
      <CiteButton fact={fact} />
    </li>
  )
}

function ConsoleLines({ fact }: { fact: FactRecord }) {
  const v = fact.value as PrototypeConsoleValue
  if (v.errors.length === 0 && v.failed.length === 0) return null
  return (
    <li className="flex items-baseline gap-2">
      <span className="w-20 shrink-0 font-mono text-[10.5px] text-ink-faint">CONSOLE</span>
      <div className="min-w-0 space-y-0.5">
        {[...v.errors, ...v.failed].slice(0, 4).map((line) => (
          <p key={line} className="truncate font-mono text-[11px] text-signal-red" title={line}>
            {line}
          </p>
        ))}
        <Evidence fact={fact} className="text-xs">
          the whole log
        </Evidence>
      </div>
    </li>
  )
}
