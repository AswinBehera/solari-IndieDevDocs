import { useQuery } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { api } from "../api"
import { usePersonas } from "./queries"
import type { Comparison, Item, Side } from "./types"
import { SOURCE_IDS } from "./types"
import { buttonClass, errorText, Field, inputClass, Note, Section } from "./ui"

/**
 * The split screen: one question, two identities, side by side.
 *
 * **The number is not computed here.** `overlap` arrives from the API, which got
 * it from `overlapAt` in `@samsara/harvest` — the same function the offline signal
 * matrix uses. P1.7 says "rough UI is fine; correctness of the comparison is not",
 * and the way to keep that true is to have exactly one implementation of the
 * comparison in the codebase. A browser that recomputed the intersection from the
 * two lists it rendered would be a second implementation, and the day the two
 * disagreed the screen would be the convincing one.
 *
 * **`shared / comparable`, never `shared / k`.** A source that answered with
 * twelve results cannot share twenty, and dividing by the k that was asked for
 * would report that shortfall as disagreement — a thin page read as a different
 * one. Both numbers are on screen for the same reason they are both in the
 * result: a comparison where `comparable` is far below `k` is a comparison to
 * read differently, not one to hide.
 */

/**
 * `noun` is what the two sides are called. The Lab says "persona"; the Locals
 * page embeds this same form and says "local", the word a traveller has there.
 */
export function Compare({ noun = "persona" }: { noun?: "persona" | "local" } = {}) {
  const personas = usePersonas()
  const [form, setForm] = useState({ a: "", b: "", query: "", sourceId: "", k: "20" })
  // The submitted values, not the typed ones. A query that ran on every keystroke
  // would spend four database reads per character against an account-wide ceiling.
  const [asked, setAsked] = useState<typeof form | null>(null)

  const comparison = useQuery({
    queryKey: ["lab", "compare", asked],
    enabled: asked !== null,
    queryFn: () => {
      const q = asked as typeof form
      const params = new URLSearchParams({ a: q.a, b: q.b, query: q.query, k: q.k })
      if (q.sourceId) params.set("sourceId", q.sourceId)
      return api<Comparison>(`/lab/compare?${params.toString()}`)
    },
    retry: false,
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setAsked({ ...form })
  }

  const names = new Map((personas.data ?? []).map((p) => [p.id, p.name]))

  return (
    <Section
      title={`Two ${noun}s, one question`}
      hint="The newest run each identity has for this exact query. Not the best run — the newest, whatever it returned."
    >
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label={`${noun} A`}>
          {(id) => (
            <PersonaSelect
              id={id}
              value={form.a}
              onChange={(a) => setForm((f) => ({ ...f, a }))}
              options={personas.data ?? []}
            />
          )}
        </Field>
        <Field label={`${noun} B`}>
          {(id) => (
            <PersonaSelect
              id={id}
              value={form.b}
              onChange={(b) => setForm((f) => ({ ...f, b }))}
              options={personas.data ?? []}
            />
          )}
        </Field>
        <Field label="query">
          {(id) => (
            <input
              id={id}
              className={`${inputClass} w-64`}
              required
              value={form.query}
              onChange={(e) => setForm((f) => ({ ...f, query: e.target.value }))}
              placeholder="exactly as it was harvested"
            />
          )}
        </Field>
        <Field label="source (optional)">
          {(id) => (
            <>
              <input
                id={id}
                className={inputClass}
                list="source-ids-compare"
                value={form.sourceId}
                onChange={(e) => setForm((f) => ({ ...f, sourceId: e.target.value }))}
                placeholder="any"
              />
              <datalist id="source-ids-compare">
                {SOURCE_IDS.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="k">
          {(id) => (
            <input
              id={id}
              className={`${inputClass} w-16`}
              type="number"
              min={1}
              max={100}
              value={form.k}
              onChange={(e) => setForm((f) => ({ ...f, k: e.target.value }))}
            />
          )}
        </Field>
        <button type="submit" className={buttonClass} disabled={comparison.isFetching}>
          {comparison.isFetching ? "comparing…" : "Compare"}
        </button>
      </form>

      {comparison.isError && (
        <p className="mt-3">
          <Note tone="error">{errorText(comparison.error)}</Note>
        </p>
      )}

      {comparison.data && <Result data={comparison.data} names={names} />}
    </Section>
  )
}

function PersonaSelect({
  id,
  value,
  onChange,
  options,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  options: readonly { id: string; name: string; locality: string }[]
}) {
  return (
    <select
      id={id}
      className={inputClass}
      required
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">choose…</option>
      {options.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} · {p.locality}
        </option>
      ))}
    </select>
  )
}

function Result({ data, names }: { data: Comparison; names: Map<string, string> }) {
  const { overlap } = data
  const percent = overlap.comparable === 0 ? null : Math.round(overlap.overlap * 100)
  return (
    <div className="mt-4 border-neutral-100 border-t pt-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-semibold text-2xl tabular-nums">
          {percent === null ? "—" : `${percent}%`}
        </span>
        <span className="text-neutral-600 text-sm tabular-nums">
          {overlap.shared} of {overlap.comparable} shared
        </span>
        <span className="text-neutral-400 text-xs tabular-nums">asked for k={overlap.k}</span>
      </div>

      {overlap.comparable === 0 ? (
        // "Nothing in common" and "nothing to compare" are different findings, and
        // a 0% that means the second one is the most misleading number this page
        // could print. `comparable` is what separates them, so it says which.
        <Note tone="muted">
          Nothing to compare: at least one side has no run for this exact query. That is missing
          data, not disagreement.
        </Note>
      ) : (
        overlap.comparable < overlap.k && (
          <Note tone="muted">
            One side returned fewer than {overlap.k} items, so the comparison is over{" "}
            {overlap.comparable}. The percentage is out of what could have matched, not out of k.
          </Note>
        )
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Column side={data.a} label="A" name={names.get(data.a.personaId)} other={data.b} />
        <Column side={data.b} label="B" name={names.get(data.b.personaId)} other={data.a} />
      </div>
    </div>
  )
}

function Column({
  side,
  label,
  name,
  other,
}: {
  side: Side
  label: string
  name: string | undefined
  other: Side
}) {
  const otherUrls = new Set(other.items.map((item) => item.url))
  return (
    <div>
      <h3 className="font-medium text-sm">
        {label} · {name ?? side.personaId.slice(0, 8)}
      </h3>
      {side.harvest ? (
        <p className="text-neutral-500 text-xs">
          {side.harvest.sourceId} · {new Date(side.harvest.startedAt).toLocaleString()} ·{" "}
          {side.harvest.outcome ?? "running"} · {side.harvest.itemCount} items
        </p>
      ) : (
        <Note tone="muted">No run for this query.</Note>
      )}
      <ol className="mt-2 flex flex-col gap-2">
        {side.items.map((item) => (
          <Row key={item.id} item={item} shared={otherUrls.has(item.url)} />
        ))}
      </ol>
    </div>
  )
}

/**
 * A shared row is marked, and the mark is only ever a highlight.
 *
 * This membership test is for reading, not for arithmetic: the headline number
 * above comes from the API. If the two ever disagree the bug is worth knowing
 * about, which is an argument for marking rows this way rather than having the
 * API send a flag per item and make the disagreement impossible to notice.
 */
function Row({ item, shared }: { item: Item; shared: boolean }) {
  return (
    <li
      className={`rounded border p-2 text-sm ${
        shared ? "border-emerald-300 bg-emerald-50" : "border-neutral-200"
      }`}
    >
      <div className="flex gap-2">
        <span className="text-neutral-400 text-xs tabular-nums">{item.rank + 1}</span>
        <div className="min-w-0">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-medium text-neutral-900 hover:underline"
          >
            {item.title ?? item.url}
          </a>
          <p className="truncate text-neutral-500 text-xs">{item.url}</p>
          {item.text && (
            <p className="mt-1 line-clamp-3 text-neutral-600 text-xs">
              {item.text}
              {item.truncated && <span className="text-neutral-400"> (truncated)</span>}
            </p>
          )}
          {item.engagement && (
            <p className="mt-1 text-neutral-400 text-xs tabular-nums">
              {/* `null` is "the source does not publish this", which is not zero. */}
              {item.engagement.views !== null && <>{item.engagement.views} views </>}
              {item.engagement.likes !== null && <>· {item.engagement.likes} likes </>}
              {item.engagement.comments !== null && <>· {item.engagement.comments} comments</>}
            </p>
          )}
        </div>
      </div>
    </li>
  )
}
