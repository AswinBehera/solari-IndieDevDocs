import { CHARACTER_SOURCES } from "@dt/travel-pack/characters"
import { askAs } from "@dt/travel-pack/interests"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api"
import { useHarvests } from "../lab/queries"
import type { Harvest, Item, Persona } from "../lab/types"
import { errorText } from "../lab/ui"

/**
 * Send a character exploring, and what they brought back.
 *
 * The button queues one `persona.explore` job; the worker turns it into at most
 * eight ordinary harvests, one per (interest, source), asked in the character's
 * language. The list below is those harvests, polled only while one is expected
 * (`useHarvests`), and each opens onto the posts it kept.
 */

const MAX_HARVESTS = 8

// Matched on the part before the dot too, so `pantip.tag` reads "Pantip" rather
// than showing its adapter id.
const sourceLabel = (id: string) =>
  CHARACTER_SOURCES.find((s) => s.id === id)?.label ??
  CHARACTER_SOURCES.find((s) => s.id.split(".")[0] === id.split(".")[0])?.label ??
  id

/** A run's result in a traveller's words; "0 kept · blocked" read as our own failure. */
function runLine(run: { outcome: string | null; itemCount: number }): string {
  const posts = `${run.itemCount} post${run.itemCount === 1 ? "" : "s"}`
  switch (run.outcome) {
    case null:
    case "running":
      return "browsing…"
    case "ok":
      return posts
    case "partial":
      return `${posts} · page cut short`
    case "empty":
      return "nothing found"
    case "blocked":
      return "the site didn't let them in · try later"
    default:
      return "didn't finish · try later"
  }
}

export function Outings({ persona }: { persona: Persona }) {
  const [city, setCity] = useState("Bangkok")
  const [sentAt, setSentAt] = useState<number | null>(null)
  const harvests = useHarvests(persona.id, sentAt)
  const interests = persona.traits?.interests ?? []
  const sources = persona.traits?.sources ?? ["youtube.search"]
  const plan = interests
    .flatMap((interest) => {
      const asked = askAs(interest, city, persona.locale)
      return sources.map((sourceId) => ({ interest, sourceId, query: asked?.query ?? null }))
    })
    .slice(0, MAX_HARVESTS)

  const send = useMutation({
    mutationFn: () =>
      api<{ jobId: string; deduped: boolean }>(
        `/lab/personas/${encodeURIComponent(persona.id)}/explore`,
        { method: "POST", body: JSON.stringify({ city: city.trim() }) },
      ),
    onSuccess: () => setSentAt(Date.now()),
  })

  const unwell = persona.health === "banned" || persona.health === "retired"
  const runs = harvests.data ?? []

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="rounded-xl border border-ink border-dashed p-4">
        <p className="font-mono text-[10px] text-ink-faint tracking-[.1em]">SEND OUT</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-ink-muted">Explore</span>
            <input
              aria-label="City"
              className="w-32 rounded-lg border border-rule bg-surface px-2 py-1 text-sm"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => send.mutate()}
            disabled={send.isPending || unwell || plan.length === 0 || !city.trim()}
            className="rounded-full bg-accent-pink px-5 py-2 font-medium text-sm text-white disabled:opacity-40"
          >
            {send.isPending ? "Sending…" : `Send ${persona.name} out searching`}
          </button>
        </div>
        {plan.length === 0 && (
          <p className="mt-2 text-ink-faint text-xs">
            Give them something to care about first, then save.
          </p>
        )}
        {unwell && (
          <p className="mt-2 text-signal-red text-xs">
            {persona.name} is {persona.health}. Add someone new.
          </p>
        )}
        {plan.length > 0 && (
          <ol className="mt-3 flex flex-col gap-1 text-xs">
            {plan.map((s) => (
              <li
                key={`${s.sourceId}:${s.interest}`}
                className="flex flex-wrap items-baseline gap-x-2"
              >
                <span className="w-20 flex-none font-mono text-[10px] text-ink-faint uppercase">
                  {sourceLabel(s.sourceId)}
                </span>
                {s.query ? (
                  <span className="text-ink">{s.query}</span>
                ) : (
                  <span className="text-ink-faint italic">
                    {s.interest}, translated by the model
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        {send.isError && <p className="mt-2 text-signal-red text-xs">{errorText(send.error)}</p>}
        {send.data && (
          <p className="mt-2 text-signal-green text-xs">
            {send.data.deduped
              ? "Already on their way. One search an hour per question."
              : "On their way. The worker opens a browser for each search; results land below."}
          </p>
        )}
      </div>

      <div>
        <p className="font-mono text-[10px] text-ink-faint tracking-[.1em]">
          WHAT THEY FOUND · {runs.length} SEARCH{runs.length === 1 ? "" : "ES"}
        </p>
        {harvests.isError && (
          <p className="mt-2 text-signal-red text-xs">{errorText(harvests.error)}</p>
        )}
        {runs.length === 0 && !harvests.isPending && (
          <p className="mt-2 text-ink-muted text-sm">
            Nothing yet. Send them out and their searches appear here as they finish.
          </p>
        )}
        <ul className="mt-2 flex flex-col gap-2">
          {runs.slice(0, 12).map((run) => (
            <Run key={run.id} run={run} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function Run({ run }: { run: Harvest }) {
  const [open, setOpen] = useState(false)
  const items = useQuery({
    queryKey: ["lab", "items", run.id],
    queryFn: () =>
      api<{ items: Item[] }>(`/lab/harvests/${encodeURIComponent(run.id)}/items?limit=8`),
    select: (d) => d.items,
    enabled: open,
  })
  const tone =
    run.outcome === null || run.outcome === "running"
      ? "text-ink-faint"
      : run.outcome === "ok"
        ? "text-signal-green"
        : run.outcome === "partial"
          ? "text-accent-gold"
          : "text-signal-red"
  return (
    <li className="rounded-lg border border-rule bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-left"
      >
        <span className="font-mono text-[10px] text-ink-faint uppercase">
          {sourceLabel(run.sourceId)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{run.query}</span>
        <span className={`text-xs ${tone}`}>{runLine(run)}</span>
      </button>
      {open && (
        <div className="border-rule border-t px-3 py-2">
          {items.isPending && <p className="text-ink-faint text-xs">Loading…</p>}
          {items.isError && <p className="text-signal-red text-xs">{errorText(items.error)}</p>}
          {items.data?.length === 0 && (
            <p className="text-ink-faint text-xs">Nothing kept from this one.</p>
          )}
          <ol className="flex flex-col gap-1.5">
            {(items.data ?? []).map((item) => (
              <li key={item.id} className="text-xs">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="line-clamp-1 font-medium text-ink underline decoration-rule"
                >
                  {item.title ?? item.url}
                </a>
                {item.text && <p className="line-clamp-2 text-ink-muted">{item.text}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  )
}
