import type {
  BlockKind,
  BlockRecord,
  CostEstimate,
  DocRecord,
  EvidenceMove,
  FactRecord,
  Locator,
  ReceiptRecord,
  RunRecord,
} from "@rd/research"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api"

/** The API's shapes, as `apps/api/src/research.ts` sends them. */

export interface DocSummary {
  id: string
  title: string
  updatedAt: string
  blocks: number
}

export interface BlockView extends BlockRecord {
  run: RunRecord | null
  facts: FactRecord[]
  stale: boolean
  items: number
  estimate: CostEstimate
  /** For a decision: the facts it cites, and the ones whose latest reading differs. */
  evidence: FactRecord[]
  moves: EvidenceMove[]
}

export interface DocResponse {
  doc: DocRecord
  blocks: BlockView[]
}

export interface ReceiptResponse {
  receipt: ReceiptRecord & { pairedWith: string | null; blockId: string }
  /** The page this receipt belongs to, in order: HTML, screenshot, replay. Just the receipt otherwise. */
  group: ReceiptRecord[]
}

/** What the receipt drawer is showing: a receipt, and where in it to look. */
export interface ReceiptFocus {
  receiptId: string
  locator: Locator
  /** The fact that sent the reader here, for the drawer's heading. */
  fact?: FactRecord
}

export const docKey = (id: string) => ["doc", id] as const

export function useDocs() {
  return useQuery({
    queryKey: ["docs"],
    queryFn: () => api<{ docs: DocSummary[] }>("/docs").then((r) => r.docs),
  })
}

export function useDoc(id: string) {
  return useQuery({
    queryKey: docKey(id),
    queryFn: () => api<DocResponse>(`/docs/${id}`),
    // The editor owns the content once loaded; a refetch only refreshes blocks.
    staleTime: Number.POSITIVE_INFINITY,
    // While a block is queued or running, look again. The stream below carries
    // the progress line; this carries the answer when it lands.
    refetchInterval: (q) =>
      q.state.data?.blocks.some((b) => b.status === "queued" || b.status === "running")
        ? 2500
        : false,
  })
}

export function useReceipt(id: string | null) {
  return useQuery({
    queryKey: ["receipt", id],
    queryFn: () => api<ReceiptResponse>(`/receipts/${id}`),
    enabled: id !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useFacts(ids: string[]) {
  const key = [...ids].sort().join(",")
  return useQuery({
    queryKey: ["facts", key],
    queryFn: () => api<{ facts: FactRecord[] }>(`/facts?ids=${key}`).then((r) => r.facts),
    enabled: ids.length > 0,
    staleTime: 30_000,
  })
}

export const createDoc = (title: string, content?: unknown) =>
  api<{ doc: DocRecord }>("/docs", {
    method: "POST",
    body: JSON.stringify({ title, content }),
  }).then((r) => r.doc)

export const saveDoc = (
  id: string,
  version: number,
  patch: { content?: unknown; title?: string },
) =>
  api<{ version: number }>(`/docs/${id}`, {
    method: "PUT",
    body: JSON.stringify({ version, ...patch }),
  })

export const createBlock = (docId: string, kind: BlockKind, params: unknown) =>
  api<{ block: BlockView }>(`/docs/${docId}/blocks`, {
    method: "POST",
    body: JSON.stringify({ kind, params }),
  }).then((r) => r.block)

/** Patch a block and fold the answer back into the cached document. */
export function useBlockMutations(docId: string) {
  const qc = useQueryClient()
  const put = (block: BlockView) =>
    qc.setQueryData<DocResponse>(docKey(docId), (d) =>
      d ? { ...d, blocks: d.blocks.map((b) => (b.id === block.id ? block : b)) } : d,
    )
  const refresh = () => qc.invalidateQueries({ queryKey: docKey(docId) })

  const patch = useMutation({
    mutationFn: ({ id, params }: { id: string; params: Record<string, unknown> }) =>
      api<{ block: BlockView }>(`/blocks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ params }),
      }),
    onSuccess: (r) => {
      put(r.block)
      // Pruning or retagging one block can make the ones reading from it stale.
      void refresh()
    },
  })

  const run = useMutation({
    mutationFn: ({ id, cascade }: { id: string; cascade: boolean }) =>
      api<{ jobId: string; deduped: boolean }>(`/blocks/${id}/run`, {
        method: "POST",
        body: JSON.stringify({ cascade }),
      }),
    onSuccess: () => void refresh(),
  })

  return { patch, run, refresh }
}

/**
 * A job's progress lines, from `/jobs/:id/events`. Read with `fetch` rather than
 * `EventSource`, which cannot send the bearer token.
 */
export async function followJob(
  jobId: string,
  onNote: (note: string, state: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}/events`, {
    headers: { authorization: `Bearer ${localStorage.getItem("dt.token") ?? "dev"}` },
    signal,
  })
  if (!res.ok || !res.body) return
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) return
    buf += value
    let i = buf.indexOf("\n\n")
    while (i >= 0) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const event = /^event: (.*)$/m.exec(frame)?.[1]
      const data = /^data: (.*)$/m.exec(frame)?.[1]
      if (event === "job.state" && data) {
        const d = JSON.parse(data) as { state: string; note: string | null }
        if (d.note) onNote(d.note, d.state)
      }
      if (event === "stream.closed") return
      i = buf.indexOf("\n\n")
    }
  }
}
