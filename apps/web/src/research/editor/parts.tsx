import { type FactRecord, formatFact } from "@rd/research"
import type { ReactNode } from "react"
import { useDocContext } from "../context"

/** Small pieces every block view draws: a value that opens its receipt, and a cite button. */

/** A fact's value, printed; clicking it opens the receipt it was read from. */
export function Evidence({
  fact,
  children,
  className = "",
}: {
  fact: FactRecord
  children?: ReactNode
  className?: string
}) {
  const { openReceipt } = useDocContext()
  return (
    <button
      type="button"
      title="Open the receipt this was read from"
      onClick={() => openReceipt({ receiptId: fact.receiptId, locator: fact.locator, fact })}
      className={`rounded-sm text-left underline decoration-marker decoration-2 underline-offset-[3px] hover:bg-marker-soft ${className}`}
    >
      {children ?? formatFact(fact)}
    </button>
  )
}

export function CiteButton({ fact, label = "Cite" }: { fact: FactRecord; label?: string }) {
  const { cite } = useDocContext()
  return (
    <button
      type="button"
      title="Put this number in your prose, linked to its receipt"
      // Never take focus: the editor refocuses a frame later, and keys typed in
      // between would land on this button (a space would cite a second time).
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => cite(fact)}
      className="rounded-sm border border-rule px-1.5 py-px font-mono text-[10px] text-ink-muted uppercase tracking-wider hover:border-ink hover:text-ink"
    >
      {label}
    </button>
  )
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

export const nameOf = (names: Map<string, string>, subject: string): string =>
  names.get(subject) ?? subject.replace(/^app:/, "App ")
