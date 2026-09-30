// @rd/research — the research document's model, shared by the API, the worker and the page.

export * from "./derive.js"
export * from "./model.js"

/** The Tiptap node names, here so the API's counting and the editor's schema agree. */
export const BLOCK_NODE = "researchBlock" as const
export const BLOCK_ATTR = "blockId" as const
export const FACT_NODE = "factChip" as const
export const FACT_ATTR = "factId" as const

/** Every block id referenced by a document, in order, deduplicated. */
export function blockIdsIn(content: unknown): string[] {
  const seen = new Set<string>()
  const walk = (n: unknown) => {
    const node = n as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }
    if (!node || typeof node !== "object") return
    if (node.type === BLOCK_NODE && typeof node.attrs?.[BLOCK_ATTR] === "string") {
      seen.add(node.attrs[BLOCK_ATTR] as string)
    }
    for (const c of node.content ?? []) walk(c)
  }
  walk(content)
  return [...seen]
}

export const PACKAGE = "@rd/research" as const
