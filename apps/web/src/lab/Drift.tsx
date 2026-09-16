import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { api } from "../api"
import { labKeys, useDriftExperiments, useDriftSeries, usePersonas } from "./queries"
import type { DriftPoint, DriftSeries } from "./types"
import { SOURCE_IDS } from "./types"
import { buttonClass, errorText, Field, inputClass, Note, Section } from "./ui"

/**
 * The drift experiment (P1.8): the same question, every day, from two identities.
 *
 * P1.7's split screen answers "do these two identities see the same thing?" on one
 * afternoon. This asks whether that answer holds up, which is a different claim and
 * needs a series rather than a pair — Phase 1's gate is a number about a week, not
 * about a moment.
 *
 * **Nothing here computes an overlap.** Every number on this page arrives from
 * `/lab/drift/:id`, which got it from `driftSeries` in `@samsara/harvest` — the same
 * arithmetic `/lab/compare` uses. The rule from `Compare.tsx` applies with more
 * force to a chart: a plot that recomputed its own points would be a second
 * implementation, and a chart is the most convincing thing on any screen.
 *
 * **A missing day is a gap, not a zero.** The API sends `overlap: null` for every
 * day that was not compared, and the line below is drawn in segments so that it
 * breaks across those days rather than sloping through them. An interpolated
 * segment would be a measurement nobody made, drawn in the same ink as the ones
 * they did.
 *
 * **One axis, and therefore one measure.** `meanRankShift` is a real number and is
 * not on the plot: it has a different scale, and two y-scales on one chart invent a
 * correlation the data does not contain. It lives in the table below, where it can
 * be read against the overlap of the same row.
 *
 * **Light only.** The Lab has no dark mode — no `dark:` variant appears anywhere in
 * `apps/web` — so the palette below is stepped for the white surface it actually
 * renders on and there is no second set of values pretending to be selected. When
 * the app gets a theme, this file gets a validated dark column, not an inversion.
 */

/**
 * Two colours, validated, and that is the whole palette.
 *
 * One series needs one hue (blue, the default sequential/slot-1 step) and no legend:
 * the section title says what is plotted. The gate rule is the single status colour
 * on the page, and it ships with its own text label, so the red is never carrying
 * the meaning alone. Checked against the surface it renders on rather than assumed:
 * `#2a78d6` + `#d03b3b` on `#ffffff`, all pairs — worst CVD ΔE 23.8, normal-vision
 * 31.6, both clear of the floors, and both clear 3:1 against the surface.
 */
const SERIES = "#2a78d6"
const GATE = "#d03b3b"
const SURFACE = "#ffffff"
const GRID = "#e1e0d9"
const AXIS = "#c3c2b7"
const MUTED = "#898781"

/**
 * The two lines that make this chart a decision rather than a picture.
 *
 * Phase 1's acceptance criterion is under 40% overlap for the two personas, and its
 * gate is: above 60%, stop and redesign the adapters before building the refine
 * pipeline. Those are the numbers the plot is read against, so they are drawn on it.
 */
const ACCEPTANCE = 0.4
const GATE_AT = 0.6

const W = 720
const H = 260
const PAD = { top: 16, right: 24, bottom: 40, left: 44 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

const percent = (v: number) => `${Math.round(v * 100)}%`

export function Drift() {
  const [selected, setSelected] = useState<string | null>(null)
  const [k, setK] = useState("")
  const experiments = useDriftExperiments()
  const series = useDriftSeries(selected, k ? Number(k) : null)

  return (
    <Section
      title="The same question, every day"
      hint="Two identities, one query, once per interval for a week. The plot is the overlap of their top k, day by day."
    >
      <CreateForm onCreated={setSelected} />

      {/* One row, above the chart, scoping everything below it. */}
      <div className="mt-4 flex flex-wrap items-end gap-3 border-neutral-100 border-t pt-4">
        <Field label="experiment">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value || null)}
            >
              <option value="">choose…</option>
              {(experiments.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.query} · {e.sourceId} · {e.days}d · {e.state}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="k (blank = as created)">
          {(id) => (
            <input
              id={id}
              className={`${inputClass} w-24`}
              type="number"
              min={1}
              max={100}
              value={k}
              onChange={(e) => setK(e.target.value)}
              placeholder="20"
            />
          )}
        </Field>
      </div>

      {series.isError && (
        <p className="mt-3">
          <Note tone="error">{errorText(series.error)}</Note>
        </p>
      )}
      {series.data && <SeriesView data={series.data} stale={series.isFetching} />}
    </Section>
  )
}

function CreateForm({ onCreated }: { onCreated: (id: string) => void }) {
  const personas = usePersonas()
  const client = useQueryClient()
  const [form, setForm] = useState({
    a: "",
    b: "",
    query: "",
    sourceId: SOURCE_IDS[0] as string,
    days: "7",
    k: "20",
    intervalMinutes: "1440",
  })

  const create = useMutation({
    mutationFn: () =>
      api<{ experiment: { id: string }; queued: number }>("/lab/drift", {
        method: "POST",
        body: JSON.stringify({
          sourceId: form.sourceId,
          query: form.query,
          personaAId: form.a,
          personaBId: form.b,
          days: Number(form.days),
          k: Number(form.k),
          intervalMinutes: Number(form.intervalMinutes),
        }),
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: labKeys.driftList })
      onCreated(result.experiment.id)
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <Field label="persona A">
        {(id) => (
          <PersonaSelect
            id={id}
            value={form.a}
            onChange={(a) => setForm((f) => ({ ...f, a }))}
            options={personas.data ?? []}
          />
        )}
      </Field>
      <Field label="persona B">
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
            className={`${inputClass} w-56`}
            required
            value={form.query}
            onChange={(e) => setForm((f) => ({ ...f, query: e.target.value }))}
            placeholder="asked verbatim, every day"
          />
        )}
      </Field>
      <Field label="source">
        {(id) => (
          <>
            <input
              id={id}
              className={inputClass}
              required
              list="source-ids-drift"
              value={form.sourceId}
              onChange={(e) => setForm((f) => ({ ...f, sourceId: e.target.value }))}
            />
            <datalist id="source-ids-drift">
              {SOURCE_IDS.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field label="days">
        {(id) => (
          <input
            id={id}
            className={`${inputClass} w-16`}
            type="number"
            min={1}
            max={14}
            value={form.days}
            onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))}
          />
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
      <Field label="interval (min)">
        {(id) => (
          <input
            id={id}
            className={`${inputClass} w-20`}
            type="number"
            min={1}
            value={form.intervalMinutes}
            onChange={(e) => setForm((f) => ({ ...f, intervalMinutes: e.target.value }))}
          />
        )}
      </Field>
      <button type="submit" className={buttonClass} disabled={create.isPending}>
        {create.isPending ? "queueing…" : "Start"}
      </button>
      {create.isError && <Note tone="error">{errorText(create.error)}</Note>}
      {create.isSuccess && (
        // The whole week is queued at creation, so the honest confirmation is a
        // count of jobs, not "started": nothing has run yet, and the first day is
        // due now rather than done now.
        <Note tone="ok">{create.data.queued} runs queued — the week is on the board.</Note>
      )}
    </form>
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

function SeriesView({ data, stale }: { data: DriftSeries; stale: boolean }) {
  const client = useQueryClient()
  const { experiment, summary } = data

  const stop = useMutation({
    mutationFn: () =>
      api<unknown>(`/lab/drift/${encodeURIComponent(experiment.id)}/stop`, { method: "POST" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: labKeys.driftList }),
  })

  return (
    // Held at reduced opacity while it refetches rather than replaced by a
    // skeleton: the plot keeps its frame and nothing jumps.
    <div className={`mt-4 border-neutral-100 border-t pt-4 ${stale ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="font-semibold text-2xl">
            {summary.meanOverlap === null ? "—" : percent(summary.meanOverlap)}
          </span>
          <span className="text-neutral-600 text-sm">
            mean overlap over {summary.comparedDays} measured day
            {summary.comparedDays === 1 ? "" : "s"}
            {summary.spread !== null && ` · spread ${percent(summary.spread)}`}
          </span>
        </div>
        <button
          type="button"
          className={buttonClass}
          disabled={experiment.state === "stopped" || stop.isPending}
          onClick={() => stop.mutate()}
        >
          {experiment.state === "stopped" ? "stopped" : "Stop"}
        </button>
      </div>

      <p className="mt-1 text-neutral-500 text-xs">
        {experiment.query} · {experiment.sourceId} · top {data.k} · every{" "}
        {experiment.intervalMinutes} min from {new Date(experiment.startedAt).toLocaleString()}
      </p>

      {/* Said in words as well as drawn, because the gaps are the part of this
          chart most easily misread — and because a number nobody can hover over
          still has to be readable. */}
      {summary.missingDays > 0 && (
        <Note tone="muted">
          {summary.missingDays} day{summary.missingDays === 1 ? "" : "s"} came due without two runs.
          Those are gaps in the line, not overlaps of zero.
        </Note>
      )}
      {summary.meanOverlap === null && (
        <Note tone="muted">
          Nothing has been compared yet. The line appears on the first day both identities return
          results.
        </Note>
      )}
      {experiment.state === "stopped" && (
        <Note tone="muted">
          Stopped. The remaining days are still queued and will be refused by the runner rather than
          run; the days already measured stay.
        </Note>
      )}

      <Plot data={data} />
      <TableView data={data} />
    </div>
  )
}

/**
 * The plot: overlap against day, in one hue, with the gate drawn on it.
 *
 * Only `compared` days carry a marker. The other three states are drawn as a small
 * hollow tick on the baseline — present, so the eye can see the week has a hole in
 * it, and clearly not a value, because it sits on no y-position of its own. Which
 * kind of hole it is comes from the hover readout and from the table, never from
 * the shape alone.
 */
function Plot({ data }: { data: DriftSeries }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const days = data.experiment.days
  const band = PLOT_W / days
  const x = (day: number) => PAD.left + band * (day + 0.5)
  const y = (value: number) => PAD.top + PLOT_H * (1 - value)

  // Segments, not one path. A run of consecutive compared days is joined; a day
  // that was never measured ends the segment and the next one starts after it.
  const segments: { day: number; overlap: number }[][] = []
  for (const point of data.points) {
    if (point.state !== "compared" || point.overlap === null) {
      if (segments.at(-1)?.length) segments.push([])
      continue
    }
    if (segments.length === 0) segments.push([])
    segments.at(-1)?.push({ day: point.day, overlap: point.overlap.overlap })
  }

  const measured = data.points.filter((p) => p.state === "compared" && p.overlap !== null)
  const last = measured.at(-1)
  const shown = hovered ?? pinned
  const point = shown === null ? null : data.points[shown]

  return (
    <figure className="relative mt-4">
      {/* `role="img"` with a label rather than a `<title>` child: the hit targets
          are HTML buttons layered over this, not shapes inside it, so nothing in
          here needs to be reachable and the picture can announce itself as one. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Overlap of the two personas' top ${data.k}, by day, over ${days} days`}
      >
        {/* Only the two extremes carry a gridline, so every other horizontal rule
            on this plot is a decision line rather than chrome. A 50% gridline was
            drawn here first and was indistinguishable from the 40% rule sitting a
            few pixels below it — two lines of the same weight meaning different
            things. Values between the rules are read from the label, the hover
            readout and the table, all of which are exact. */}
        {[0, 1].map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke={v === 0 ? AXIS : GRID}
              strokeWidth={1}
            />
            <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" fill={MUTED} fontSize={11}>
              {percent(v)}
            </text>
          </g>
        ))}

        {/* The decision lines. Labelled in ink, not in their own colour: text
            wearing the mark's colour is how a threshold stops being readable. */}
        {[
          { at: ACCEPTANCE, stroke: AXIS, label: "acceptance · 40%" },
          { at: GATE_AT, stroke: GATE, label: "gate · 60%" },
        ].map((rule) => (
          <g key={rule.label}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(rule.at)}
              y2={y(rule.at)}
              stroke={rule.stroke}
              strokeWidth={1}
            />
            {/* Left edge, because the endpoint label lives at the right one and
                the two collided the first time this was drawn. */}
            <text x={PAD.left + 4} y={y(rule.at) - 5} fill={MUTED} fontSize={10}>
              {rule.label}
            </text>
          </g>
        ))}

        {segments
          .filter((s) => s.length > 1)
          .map((s) => (
            <polyline
              key={s[0]?.day}
              points={s.map((p) => `${x(p.day)},${y(p.overlap)}`).join(" ")}
              fill="none"
              stroke={SERIES}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

        {data.points.map((p) =>
          p.state === "compared" && p.overlap !== null ? (
            <circle
              key={p.day}
              cx={x(p.day)}
              cy={y(p.overlap.overlap)}
              r={4.5}
              fill={SERIES}
              stroke={SURFACE}
              strokeWidth={2}
            />
          ) : (
            // Below the baseline, in the axis band. Drawn on the zero line at
            // first, where a hollow ring at 0% reads as an overlap of zero — the
            // one reading this whole file exists to prevent. Outside the value
            // area it can only mean "no point here".
            <circle
              key={p.day}
              cx={x(p.day)}
              cy={PAD.top + PLOT_H + 9}
              r={2.5}
              fill={SURFACE}
              stroke={MUTED}
              strokeWidth={1}
            />
          ),
        )}

        {/* One direct label, on the last measured day. A number on every point is
            the fastest way to make seven numbers unreadable. */}
        {last?.overlap &&
          (() => {
            // Flipped rather than clipped when the last measured day is the last
            // day: a label that runs off the plot is worse than no label.
            const room = x(last.day) + 44 < W - PAD.right
            return (
              <text
                x={x(last.day) + (room ? 8 : -8)}
                y={y(last.overlap.overlap) - 9}
                textAnchor={room ? "start" : "end"}
                fill="#52514e"
                fontSize={11}
              >
                {percent(last.overlap.overlap)}
              </text>
            )
          })()}

        {data.points.map((p) => (
          <text
            key={p.day}
            x={x(p.day)}
            y={H - PAD.bottom + 26}
            textAnchor="middle"
            fill={MUTED}
            fontSize={11}
          >
            {p.day + 1}
          </text>
        ))}
        {/* Beside the numbers rather than under them: set below the row it names,
            it landed on top of the last day's label. */}
        <text x={PAD.left - 8} y={H - PAD.bottom + 26} textAnchor="end" fill={MUTED} fontSize={10}>
          day
        </text>

        {shown !== null && (
          <line
            x1={x(shown)}
            x2={x(shown)}
            y1={PAD.top}
            y2={PAD.top + PLOT_H}
            stroke={AXIS}
            strokeWidth={1}
          />
        )}
      </svg>

      {/* The hit target is the whole column, in HTML rather than as a transparent
          rect inside the SVG: a real button is focusable, announces its label, and
          can be pressed. Pressing pins the readout, so a day's numbers can be read
          without a pointer held still — which is also what makes the hover layer an
          enhancement rather than the only way to a value. */}
      <div
        className="absolute flex"
        style={{
          left: `${(PAD.left / W) * 100}%`,
          top: `${(PAD.top / H) * 100}%`,
          width: `${(PLOT_W / W) * 100}%`,
          height: `${(PLOT_H / H) * 100}%`,
        }}
      >
        {data.points.map((p) => (
          <button
            key={p.day}
            type="button"
            // Explicitly reset rather than relying on the preflight: a column that
            // renders as a visible pill is a chart with seven grey buttons on it.
            className="flex-1 border-0 bg-transparent p-0 focus:outline-none focus-visible:bg-neutral-900/5"
            aria-label={describe(p)}
            aria-pressed={pinned === p.day}
            onPointerEnter={() => setHovered(p.day)}
            onPointerLeave={() => setHovered(null)}
            onFocus={() => setHovered(p.day)}
            onBlur={() => setHovered(null)}
            onClick={() => setPinned((d) => (d === p.day ? null : p.day))}
          />
        ))}
      </div>

      {point && (
        <div
          className="pointer-events-none absolute w-52 -translate-x-1/2 rounded border border-neutral-200 bg-white p-2 text-xs shadow-sm"
          style={{ left: `${(x(point.day) / W) * 100}%`, top: "0%" }}
        >
          <p className="font-semibold text-neutral-900 text-sm">
            {point.overlap && point.state === "compared"
              ? `${percent(point.overlap.overlap)} · ${point.overlap.shared} of ${point.overlap.comparable}`
              : STATE_TEXT[point.state]}
          </p>
          <p className="text-neutral-500">{describe(point)}</p>
        </div>
      )}
      <figcaption className="sr-only">
        Overlap of the two personas' top {data.k} results, one point per day.
      </figcaption>
    </figure>
  )
}

const STATE_TEXT: Record<DriftPoint["state"], string> = {
  compared: "compared",
  empty: "nothing to compare",
  missing: "no pair of runs",
  pending: "not due yet",
}

const describe = (p: DriftPoint): string => {
  const when = p.measuredAt
    ? `measured ${new Date(p.measuredAt).toLocaleString()}`
    : `due ${new Date(p.dueAt).toLocaleString()}`
  const sides = [p.a, p.b]
    .map((s) => (s ? `${s.outcome}, ${s.itemCount} items` : "no run"))
    .join(" · ")
  return `Day ${p.day + 1}: ${STATE_TEXT[p.state]} — ${when}. ${sides}.`
}

/**
 * The table twin, and the only place `meanRankShift` appears.
 *
 * Every value the hover layer shows is here without hovering, which is the rule
 * that keeps a tooltip an enhancement rather than a gate. It is also where the
 * second measure lives: rank shift answers "did the same results move?" while
 * overlap answers "were they the same results", and the two belong beside each
 * other in a row rather than on top of each other in a plot.
 */
function TableView({ data }: { data: DriftSeries }) {
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-neutral-500 text-xs">Table view</summary>
      <table className="mt-2 w-full text-left text-xs tabular-nums">
        <thead className="text-neutral-500">
          <tr>
            <th className="font-normal">day</th>
            <th className="font-normal">state</th>
            <th className="font-normal">overlap</th>
            <th className="font-normal">shared / comparable</th>
            <th className="font-normal">mean rank shift</th>
            <th className="font-normal">measured</th>
          </tr>
        </thead>
        <tbody className="text-neutral-700">
          {data.points.map((p) => (
            <tr key={p.day} className="border-neutral-100 border-t">
              <td>{p.day + 1}</td>
              <td className="text-neutral-500">{STATE_TEXT[p.state]}</td>
              {/* An em dash, never a 0: the difference between the two is the
                  whole reason this column can be trusted. */}
              <td>{p.overlap && p.state === "compared" ? percent(p.overlap.overlap) : "—"}</td>
              <td>{p.overlap ? `${p.overlap.shared} / ${p.overlap.comparable}` : "—"}</td>
              <td>{p.meanRankShift === null ? "—" : p.meanRankShift.toFixed(2)}</td>
              <td className="text-neutral-500">
                {p.measuredAt ? new Date(p.measuredAt).toLocaleString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}
