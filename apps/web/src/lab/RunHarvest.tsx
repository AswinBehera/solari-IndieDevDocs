import { useMutation } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { api } from "../api"
import { useHarvests, usePersonas } from "./queries"
import type { Harvest } from "./types"
import { SOURCE_IDS } from "./types"
import { buttonClass, errorText, Field, inputClass, Note, Section } from "./ui"

/**
 * Start a harvest, and watch for the run it produces.
 *
 * **It posts to `/jobs`, not to a Lab route.** The Lab has no way of its own to
 * start work: `harvest.run` already has an owner from the verified token, an
 * idempotency key, the enqueue-then-dispatch order and the double-dispatch
 * refusal of ADR-0016. A `/lab/harvest` endpoint would be a second door into the
 * same queue, and the second door is the one that forgets the refusal.
 *
 * **No idempotency key, deliberately.** A key derived from the question — this
 * persona, this source, this query — would make the Lab unable to ask the same
 * question twice, which is precisely what the drift experiment does: the same
 * query, the same identity, a week apart. Double-clicks are held off by disabling
 * the button while the request is in flight, which is the cost a double-click
 * actually has here.
 */

interface Enqueued {
  id: string
  deduped: boolean
  dispatched: boolean
}

export function RunHarvest() {
  const personas = usePersonas()
  const [personaId, setPersonaId] = useState("")
  const [sourceId, setSourceId] = useState<string>(SOURCE_IDS[0])
  const [query, setQuery] = useState("")
  const [domainId, setDomainId] = useState("travel")
  const [enqueuedAt, setEnqueuedAt] = useState<number | null>(null)

  const harvests = useHarvests(personaId || null, enqueuedAt)

  const start = useMutation({
    mutationFn: () =>
      api<Enqueued>("/jobs", {
        method: "POST",
        body: JSON.stringify({
          type: "harvest.run",
          domainId,
          payload: { personaId, sourceId, query, domainId },
        }),
      }),
    onSuccess: () => setEnqueuedAt(Date.now()),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    start.mutate()
  }

  return (
    <Section
      title="Run a harvest"
      hint="One identity, one source, one question. The job is queued; the runner opens the browser."
    >
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="persona">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              required
              value={personaId}
              onChange={(e) => setPersonaId(e.target.value)}
            >
              <option value="">choose…</option>
              {(personas.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.locality}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="source">
          {(id) => (
            <>
              {/* See `SOURCE_IDS`: suggestions, not a closed list. The worker's registry
              is the thing that decides what may actually be opened. */}
              <input
                id={id}
                className={inputClass}
                required
                list="source-ids"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
              />
              <datalist id="source-ids">
                {SOURCE_IDS.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="query">
          {(id) => (
            <input
              id={id}
              className={`${inputClass} w-64`}
              required
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ร้านอาหารอร่อย อารีย์"
            />
          )}
        </Field>
        <Field label="domain">
          {(id) => (
            <input
              id={id}
              className={`${inputClass} w-24`}
              required
              value={domainId}
              onChange={(e) => setDomainId(e.target.value)}
            />
          )}
        </Field>
        <button type="submit" className={buttonClass} disabled={start.isPending || !personaId}>
          {start.isPending ? "queueing…" : "Queue harvest"}
        </button>
      </form>

      {start.isError && (
        <p className="mt-2">
          <Note tone="error">{errorText(start.error)}</Note>
        </p>
      )}
      {start.data && (
        <p className="mt-2">
          <Note tone={start.data.dispatched ? "ok" : "muted"}>
            job <span className="font-mono">{start.data.id.slice(0, 8)}</span>
            {start.data.deduped && " · already queued"}
            {start.data.dispatched
              ? " · a runner was dispatched"
              : " · queued; cron will pick it up"}
          </Note>
        </p>
      )}

      <Runs personaId={personaId} rows={harvests.data ?? []} error={harvests.error} />
    </Section>
  )
}

function Runs({
  personaId,
  rows,
  error,
}: {
  personaId: string
  rows: readonly Harvest[]
  error: unknown
}) {
  if (!personaId) {
    return (
      <p className="mt-3">
        <Note tone="muted">Choose a persona to see its runs.</Note>
      </p>
    )
  }
  if (error) {
    return (
      <p className="mt-3">
        <Note tone="error">{errorText(error)}</Note>
      </p>
    )
  }
  if (rows.length === 0) {
    return (
      <p className="mt-3">
        <Note tone="muted">No runs for this persona yet.</Note>
      </p>
    )
  }
  return (
    <div className="mt-4 overflow-x-auto border-neutral-100 border-t pt-3">
      <table className="w-full text-left text-sm">
        <thead className="text-neutral-500 text-xs">
          <tr>
            <th className="py-1 pr-3 font-normal">started</th>
            <th className="py-1 pr-3 font-normal">source</th>
            <th className="py-1 pr-3 font-normal">query</th>
            <th className="py-1 pr-3 font-normal">outcome</th>
            <th className="py-1 font-normal">items</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-neutral-100 border-t">
              <td className="py-1 pr-3 text-neutral-500 text-xs tabular-nums">
                {new Date(r.startedAt).toLocaleString()}
              </td>
              <td className="py-1 pr-3 font-mono text-xs">{r.sourceId}</td>
              <td className="py-1 pr-3">{r.query}</td>
              <td className="py-1 pr-3">
                <Outcome outcome={r.outcome} />
              </td>
              <td className="py-1 tabular-nums">{r.itemCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Outcome({ outcome }: { outcome: Harvest["outcome"] }) {
  // `null` is a run that has started and not finished — the runner writes the row
  // when it opens the session — so it reads as running, not as a missing value.
  if (outcome === null) return <span className="text-neutral-400">running…</span>
  const colour =
    outcome === "ok"
      ? "text-emerald-700"
      : outcome === "partial"
        ? "text-amber-700"
        : "text-red-600"
  return <span className={colour}>{outcome}</span>
}
