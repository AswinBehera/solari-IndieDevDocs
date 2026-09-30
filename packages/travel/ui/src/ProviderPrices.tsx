import { type CSSProperties, type ReactNode, useState } from "react"
import { tiltStyle } from "./paper.js"
import type { OfferRow } from "./postcard-rules.js"

/**
 * The Price Postcard: one hotel, a link per booking site, each read from the
 * same viewpoint, so the reader can see which site is cheaper today.
 *
 * It used to read one link from seven countries. That answered "does the price
 * depend on where you are", which is interesting and not what a traveller asks;
 * they ask which site to book on, and whether anyone has a code. So: one row per
 * site, one country for all of them, and the codes the Deal hunter found under it.
 *
 * Markup only. "Cheapest" and the verdict line are decided in `postcard-rules.ts`.
 */

const monoLabel = "font-mono text-[10px] text-ink-muted tracking-[.1em]"

const COUNTRY: Record<string, string> = {
  us: "USA",
  gb: "UK",
  de: "GERMANY",
  jp: "JAPAN",
  sg: "SINGAPORE",
  in: "INDIA",
  au: "AUSTRALIA",
  th: "THAILAND",
}

const day = (iso: string | null) =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })
    : null

export function ProviderPricesPostcard({
  id,
  viewpoint,
  rows,
  verdict,
  checking = false,
  error = null,
  onCheck,
  onAddUrl,
  validateUrl,
  children,
}: {
  id: string
  /** Where every site is read from, as a two-letter country code. */
  viewpoint: string
  rows: OfferRow[]
  verdict: string | null
  checking?: boolean
  error?: string | null
  /** Reads every site not yet read. Absent on the share page. */
  onCheck?: () => void
  onAddUrl?: (url: string) => void
  validateUrl?: (url: string) => string | null
  /** The codes strip, drawn under the prices. */
  children?: ReactNode
}) {
  const unread = rows.filter((r) => r.status === "unchecked").length
  const reading = rows.some((r) => r.status === "reading")
  const title = rows[0]?.checkIn
    ? `${rows[0].nights === 1 ? "1 night" : `${rows[0].nights ?? "?"} nights`} from ${day(rows[0].checkIn)}`
    : "Paste a hotel page from each site"
  return (
    <div
      style={tiltStyle(id, 0.4) as CSSProperties}
      className="relative rotate-(--tilt) border border-track bg-paper px-6 pt-6 pb-5 shadow-postcard"
    >
      <span className="sb-tape -top-2.5 left-8 rotate-[-4deg]" aria-hidden />
      <ViewpointStamp country={viewpoint} />
      {/* Tall enough that the stamp never sits on the first row. */}
      <div className="min-h-[84px] pr-24">
        <p className={monoLabel}>PRICES BY SITE</p>
        <p className="mt-1 font-display text-[26px] leading-tight">{title}</p>
      </div>

      <ul className="mt-2 flex flex-col gap-2.5">
        {rows.map((r) => (
          <OfferLine key={r.url} row={r} />
        ))}
      </ul>

      {onAddUrl && rows.length < 4 && (
        <AddSite onAdd={onAddUrl} {...(validateUrl ? { validate: validateUrl } : {})} />
      )}

      {onCheck && unread > 0 && (
        <button
          type="button"
          onClick={onCheck}
          disabled={checking}
          className="mt-4 border border-ink px-3 py-1.5 font-mono text-[11px] tracking-[.08em] hover:bg-ink hover:text-surface disabled:opacity-40"
        >
          {checking
            ? "STARTING…"
            : `CHECK ${unread === rows.length ? "PRICES" : `${unread} MORE`} FROM ${COUNTRY[viewpoint] ?? viewpoint.toUpperCase()}`}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-signal-red text-xs">
          {error}
        </p>
      )}
      {reading && (
        <p className="mt-3 text-ink-faint text-xs">
          A browser in the {COUNTRY[viewpoint] ?? viewpoint} is opening each page. Usually under a
          minute; you can leave and come back.
        </p>
      )}
      {verdict && <p className="mt-4 font-display text-[20px] leading-snug">{verdict}</p>}
      {rows.some((r) => r.usd !== null) && (
        <p className="mt-1 text-ink-muted text-xs">
          What each site showed a visitor from the {COUNTRY[viewpoint] ?? viewpoint} today. Sites
          differ on tax and member rates, so open the snapshot before you book.
        </p>
      )}
      {children}
    </div>
  )
}

/** A postage stamp saying where the prices were read from. */
function ViewpointStamp({ country }: { country: string }) {
  return (
    <div className="absolute top-4 right-5 rotate-[5deg]">
      <div className="sb-stamp">
        <div className="flex w-[74px] flex-col items-center border border-accent-blue/40 px-1 py-1.5 text-accent-blue">
          <span className="font-mono text-[8px] tracking-[.1em]">VIEWED FROM</span>
          <span className="font-display text-[26px] leading-none">{country.toUpperCase()}</span>
          <span className="font-mono text-[8px] tracking-[.1em]">SAMSARA</span>
        </div>
      </div>
    </div>
  )
}

function OfferLine({ row }: { row: OfferRow }) {
  const tone =
    row.status === "price"
      ? "text-ink"
      : row.status === "blocked"
        ? "text-signal-red"
        : "text-ink-faint"
  return (
    <li className="flex min-h-[40px] flex-wrap items-center gap-x-3 gap-y-1 border-rule border-b border-dashed pb-2.5">
      <a
        href={row.url}
        target="_blank"
        rel="noreferrer noopener"
        className="w-28 flex-none font-display text-[20px] leading-none underline decoration-rule"
      >
        {row.provider?.label ?? new URL(row.url).hostname.replace(/^www\./, "")}
      </a>
      <span className={`font-mono text-[13px] ${tone}`}>{row.label}</span>
      {row.cheapest && (
        <span className="sb-starburst w-[46px] rotate-[-12deg] bg-accent-gold font-mono text-[8px] text-paper leading-tight">
          <span className="text-center">
            BEST
            <br />
            DEAL
          </span>
        </span>
      )}
      {row.nights !== null && row.status === "price" && (
        <span className="font-mono text-[10px] text-ink-faint tracking-[.06em]">
          {row.nights === 1 ? "1 NIGHT" : `${row.nights} NIGHTS`} ·{" "}
          {day(row.checkIn)?.toUpperCase()}
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">
        {row.usd !== null && (
          <span className="font-mono text-[13px] text-ink-muted">≈ ${row.usd.toFixed(0)}</span>
        )}
        {row.screenshotRef && (
          <a
            href={`/shots/${row.screenshotRef}`}
            target="_blank"
            rel="noreferrer noopener"
            className="border border-rule bg-surface px-1.5 py-0.5 font-mono text-[9px] text-accent-blue tracking-[.08em] hover:border-accent-blue"
          >
            SNAPSHOT
          </a>
        )}
      </span>
    </li>
  )
}

function AddSite({
  onAdd,
  validate,
}: {
  onAdd: (url: string) => void
  validate?: (url: string) => string | null
}) {
  const [draft, setDraft] = useState("")
  const [refusal, setRefusal] = useState<string | null>(null)
  return (
    <form
      className="mt-3"
      onSubmit={(e) => {
        e.preventDefault()
        const next = draft.trim()
        if (!next) return
        const why = validate?.(next) ?? null
        setRefusal(why)
        if (why) return
        onAdd(next)
        setDraft("")
      }}
    >
      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setRefusal(null)
        }}
        placeholder="+ Paste the same hotel on another site, then Enter"
        aria-label="Another site's hotel page"
        aria-invalid={refusal ? true : undefined}
        className="w-full bg-transparent font-mono text-accent-blue text-xs placeholder:text-ink-faint focus:outline-none"
      />
      {refusal && (
        <p role="alert" className="mt-1 text-signal-red text-xs">
          {refusal}
        </p>
      )}
    </form>
  )
}

/** One code as the API folds it: the pack's `DealCode`, restated for a package that cannot import it. */
export interface DealStub {
  provider: string
  code: string
  offer: string | null
  expires: string | null
  conditions: string | null
  quote: string
  seenOn: { sourceId: string; url: string; at: string }
  sightings: number
}

/** What the Deal hunter searched, so an empty strip is a finding and not a blank. */
export interface DealSearch {
  runs: number
  blocked: number
  items: number
  lastAt: string | null
  queries: string[]
}

const SOURCE: Record<string, string> = {
  "pantip.tag": "Pantip",
  "pantip.forum": "Pantip",
  "pantip.topic": "Pantip",
  "youtube.search": "YouTube",
}

/**
 * Discount codes, as ticket stubs, each with where it was seen and a plain
 * "not verified": nobody applied it at checkout.
 */
export function DealStubs({
  deals,
  searched,
  hunter,
}: {
  deals: DealStub[]
  searched: DealSearch | null
  /** The character who went looking, and where to meet them. */
  hunter?: { name: string; href: string }
}) {
  return (
    <div className="mt-5 border-rule border-t pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className={monoLabel}>CODES FROM LOCALS</p>
        {hunter && (
          <a
            href={hunter.href}
            className="font-mono text-[10px] text-accent-pink tracking-[.08em] underline"
          >
            ASK {hunter.name.toUpperCase()} TO LOOK AGAIN →
          </a>
        )}
      </div>
      {deals.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-3">
          {deals.slice(0, 4).map((d) => (
            <Stub key={`${d.provider}:${d.code}`} deal={d} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-ink-muted text-sm">
          {searched && searched.runs > 0
            ? `${hunter?.name ?? "Our deal hunter"} searched ${searched.runs - searched.blocked} times in Thai and read ${searched.items} posts. Nobody wrote out a working code, so none is shown. We won't make one up.`
            : "Nobody has looked for codes yet."}
        </p>
      )}
      {searched && searched.queries.length > 0 && (
        <p className="mt-2 font-mono text-[10px] text-ink-faint tracking-[.04em]">
          SEARCHED: {searched.queries.slice(0, 4).join(" · ")}
        </p>
      )}
    </div>
  )
}

function Stub({ deal }: { deal: DealStub }) {
  const [copied, setCopied] = useState(false)
  const seen = new Date(deal.seenOn.at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  })
  return (
    <li className="sb-stub flex min-w-[220px] bg-note">
      <div className="flex flex-1 flex-col gap-0.5 border-accent-gold border-r border-dashed py-2.5 pr-3 pl-5">
        <span className="font-mono text-[9px] text-ink-faint tracking-[.1em]">
          {deal.provider.toUpperCase()}
          {deal.offer ? ` · ${deal.offer}` : ""}
        </span>
        <span className="font-mono text-[18px] text-ink tracking-[.08em]">{deal.code}</span>
        <a
          href={deal.seenOn.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[11px] text-ink-muted underline decoration-rule"
        >
          seen on {SOURCE[deal.seenOn.sourceId] ?? deal.seenOn.sourceId} · {seen}
          {deal.sightings > 1 ? ` · ${deal.sightings}×` : ""}
        </a>
        <span className="font-mono text-[9px] text-signal-red tracking-[.08em]">NOT VERIFIED</span>
      </div>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(deal.code)
          setCopied(true)
        }}
        className="px-3 pr-5 font-mono text-[10px] text-accent-blue tracking-[.08em]"
      >
        {copied ? "COPIED" : "COPY"}
      </button>
    </li>
  )
}
