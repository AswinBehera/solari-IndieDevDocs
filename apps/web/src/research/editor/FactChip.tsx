import { FACT_ATTR, type FactRecord, formatFact } from "@rd/research"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { useFacts } from "../api"
import { useDocContext } from "../context"
import { nameOf } from "./parts"

/**
 * A cited number inside a sentence. Prints the fact's value, never a copy, and
 * opens its receipt on click.
 *
 * A fact belongs to one run. When its block has run again since, the chip still
 * prints what was cited (that is what the sentence was written about) but says it
 * is from an older run, so the writer can re-cite or rewrite.
 */
export function FactChip({ node }: ReactNodeViewProps) {
  const id = String(node.attrs[FACT_ATTR] ?? "")
  const { facts, blocks } = useDocContext()
  const current = facts.get(id)
  // Only ask the API when the fact is not in any block's current run.
  const older = useFacts(current ? [] : [id])
  const fact: FactRecord | undefined = current ?? older.data?.[0]
  const block = fact ? blocks.get(fact.blockId) : undefined
  const outdated = fact !== undefined && block?.run?.id !== fact.runId

  return (
    <NodeViewWrapper as="span" className="rd-chip">
      {fact ? <Chip fact={fact} outdated={outdated} /> : (
        <span className="rounded-sm bg-surface-raised px-1 font-mono text-[0.8em] text-ink-faint">
          {older.isLoading ? "…" : "missing fact"}
        </span>
      )}
    </NodeViewWrapper>
  )
}

function Chip({ fact, outdated }: { fact: FactRecord; outdated: boolean }) {
  const { openReceipt, names } = useDocContext()
  const about = fact.subject === "set" ? "" : `${nameOf(names, fact.subject)}: `
  return (
    <button
      type="button"
      onClick={() => openReceipt({ receiptId: fact.receiptId, locator: fact.locator, fact })}
      title={`${about}${fact.key}${outdated ? " (from an older run; the block has run again since)" : ""}. Click for the receipt.`}
      className={`mx-px inline rounded-sm px-1 align-baseline font-medium hover:outline hover:outline-ink ${
        outdated ? "border border-ink-faint border-dashed text-ink-muted" : "bg-marker"
      }`}
    >
      {formatFact(fact)}
      <sup className="ml-0.5 font-mono text-[0.6em] text-ink-muted">↗</sup>
    </button>
  )
}
