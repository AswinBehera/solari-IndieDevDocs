import { id, timestamps } from "@samsara/core"
import { z } from "zod"

/** Where the traveller is in the arc. Drives daemon cadence, not just a badge colour. */
export const tripStatus = z.enum(["dreaming", "planning", "travelling", "done"])
export type TripStatus = z.infer<typeof tripStatus>

export const trip = z
  .object({
    id,
    userId: id,
    title: z.string().min(1),
    /** Canonical, not as typed. "Bangkok", never "bkk". */
    destinationCity: z.string().min(1),
    startDate: z.date().nullable(),
    endDate: z.date().nullable(),
    status: tripStatus,
  })
  .extend(timestamps.shape)
export type Trip = z.infer<typeof trip>

/** One document per trip in v1. Content is Tiptap/ProseMirror JSON. */
export const tripDocument = z
  .object({
    id,
    tripId: id,
    content: z.unknown(),
    version: z.number().int().positive(),
  })
  .extend(timestamps.shape)
export type TripDocument = z.infer<typeof tripDocument>

/**
 * The document's one custom node: a block that references a Postcard by id (P4.1).
 *
 * Named here, beside the document schema, because three places must agree on it —
 * the editor that writes it, the API that counts what it references, and the views
 * that draw only what the document still holds — and a string spelled three times
 * is a string spelled differently once.
 */
export const POSTCARD_NODE = "postcard"
export const POSTCARD_ATTR = "postcardId"

/**
 * Every Postcard id the document references, in document order, each once.
 *
 * **The document decides which Postcards exist**, not the table (§6.1: views are
 * derived from the document, never a second source of truth). A card deleted from
 * the text keeps its row — so that undo can bring it back — and simply stops being
 * counted, mapped or shared, because nothing here returns it.
 */
export function postcardIdsIn(content: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node !== "object" || node === null) return
    const n = node as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown }
    if (n.type === POSTCARD_NODE) {
      const id = n.attrs?.[POSTCARD_ATTR]
      if (typeof id === "string" && !seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    }
    walk(n.content)
  }
  walk(content)
  return out
}
