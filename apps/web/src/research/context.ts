import type { FactRecord } from "@rd/research"
import { createContext, useContext } from "react"
import type { BlockView, ReceiptFocus } from "./api"

/**
 * What a block or a chip inside the editor needs from the page: the blocks' current
 * answers, and the three things a reader does with a number — open its receipt,
 * cite it in the prose, and run the block again.
 *
 * Context works here because Tiptap renders React node views through portals
 * under `EditorContent`, which sits inside the provider.
 */
export interface DocContextValue {
  docId: string
  blocks: Map<string, BlockView>
  /** Every fact of every block's current run, by id. */
  facts: Map<string, FactRecord>
  /** Game names by subject (`app:413150`), from whichever block knows them. */
  names: Map<string, string>
  openReceipt(focus: ReceiptFocus): void
  cite(fact: FactRecord): void
  run(blockId: string, cascade: boolean): void
  patch(blockId: string, params: Record<string, unknown>): void
  /** Progress lines for runs started from this tab, by block id. */
  progress: Map<string, string>
}

export const DocContext = createContext<DocContextValue | null>(null)

export function useDocContext(): DocContextValue {
  const v = useContext(DocContext)
  if (!v) throw new Error("useDocContext outside a research document")
  return v
}
