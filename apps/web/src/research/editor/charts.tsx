import { type FactRecord, formatCents, median } from "@rd/research"
import { useState } from "react"
import { useDocContext } from "../context"

/**
 * Small SVG charts for block cards. Every mark is a fact: clicking it opens the
 * receipt it was read from, the same as clicking an underlined number. Drawn by
 * hand rather than with a chart library, because each chart is a few dozen marks
 * and must use the page's own tokens.
 */

const W = 640
const C = {
  ink: "var(--color-ink)",
  muted: "var(--color-ink-muted)",
  faint: "var(--color-ink-faint)",
  rule: "var(--color-rule)",
  marker: "var(--color-marker)",
  soft: "var(--color-marker-soft)",
  red: "var(--color-signal-red)",
  paper: "var(--color-paper)",
}
const MONO = { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 10 }

type Scale = { at: (v: number) => number; ticks: number[] }

function linear(lo: number, hi: number, from: number, to: number, count = 4): Scale {
  const span = hi - lo || 1
  const step = niceStep(span / count)
  const first = Math.ceil(lo / step) * step
  const ticks: number[] = []
  for (let t = first; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100)
  return { at: (v) => from + ((v - lo) / span) * (to - from), ticks }
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

/** Log scale over positive values, ticked at 1, 2 and 5 times powers of ten. */
function log(lo: number, hi: number, from: number, to: number): Scale {
  const a = Math.log10(Math.max(lo, 1))
  const b = Math.log10(Math.max(hi, lo * 1.5, 2))
  const within = (ms: number[]) => {
    const out: number[] = []
    for (let e = Math.floor(a); e <= Math.ceil(b); e++)
      for (const m of ms) {
        const t = m * 10 ** e
        if (t >= 10 ** a && t <= 10 ** b) out.push(t)
      }
    return out
  }
  // A range under a decade gets one or two 1-2-5 ticks; fill it in.
  const coarse = within([1, 2, 5])
  const ticks = coarse.length < 3 ? within([1, 1.5, 2, 3, 5, 7]) : coarse
  const thinned = ticks.length > 7 ? ticks.filter((t) => String(t)[0] === "1") : ticks
  return {
    at: (v) => from + ((Math.log10(Math.max(v, 1)) - a) / (b - a || 1)) * (to - from),
    ticks: thinned,
  }
}

const compact = (n: number): string =>
  n >= 1_000_000
    ? `${n / 1_000_000}M`
    : n >= 1000
      ? `${Math.round(n / 100) / 10}k`.replace(".0k", "k")
      : String(n)

function useOpen() {
  const { openReceipt } = useDocContext()
  return (fact: FactRecord) =>
    openReceipt({ receiptId: fact.receiptId, locator: fact.locator, fact })
}

function Frame({
  height,
  label,
  children,
  caption,
}: {
  height: number
  label: string
  children: React.ReactNode
  caption?: React.ReactNode
}) {
  return (
    <figure className="mt-4">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={label}
        className="block h-auto w-full"
      >
        {children}
      </svg>
      {caption && <figcaption className="mt-1 text-ink-faint text-xs">{caption}</figcaption>}
    </figure>
  )
}

// ---- scatter ----------------------------------------------------------------------------

export interface Point {
  key: string
  x: number
  y: number
  label: string
  fact: FactRecord
  /** Drawn filled with the marker colour, and always labelled. */
  emphasis?: boolean
  /** Drawn hollow: present but not counted. */
  muted?: boolean
}

/**
 * A scatter with a log x axis. The `labelled` points with the largest x get a
 * name; the rest show theirs on hover. Dashed lines mark the medians.
 */
export function Scatter({
  points,
  xLabel,
  yLabel,
  yLog = false,
  yFormat = String,
  labelled = 4,
  caption,
  corner,
}: {
  points: Point[]
  xLabel: string
  yLabel: string
  yLog?: boolean
  yFormat?: (v: number) => string
  labelled?: number
  caption?: React.ReactNode
  /** Text for the top-left corner, where few games and a high y meet. */
  corner?: string
}) {
  const open = useOpen()
  const [hover, setHover] = useState<string | null>(null)
  if (points.length === 0) return null
  const H = 250
  const pad = { l: 46, r: 16, t: 14, b: 34 }
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = log(Math.min(...xs) * 0.8, Math.max(...xs) * 1.25, pad.l, W - pad.r)
  const y = yLog
    ? log(Math.min(...ys) * 0.8, Math.max(...ys) * 1.25, H - pad.b, pad.t)
    : linear(0, Math.max(...ys) * 1.1, H - pad.b, pad.t)
  const counted = points.filter((p) => !p.muted)
  const mx = median(counted.map((p) => p.x))
  const my = median(counted.map((p) => p.y))
  const named = new Set(
    [...points]
      .sort((a, b) => b.x - a.x)
      .slice(0, labelled)
      .map((p) => p.key),
  )
  for (const p of points) if (p.emphasis) named.add(p.key)
  const labels = placeLabels(
    points
      .filter((p) => named.has(p.key))
      .sort((a, b) => Number(!!b.emphasis) - Number(!!a.emphasis) || b.x - a.x)
      .map((p) => ({ key: p.key, cx: x.at(p.x), cy: y.at(p.y), text: p.label })),
    points.map((p) => ({ cx: x.at(p.x), cy: y.at(p.y) })),
    { l: pad.l, r: W - pad.r, t: pad.t, b: H - pad.b },
  )
  // The emphasised point is drawn last, so neighbours cannot cover it.
  const drawn = [...points].sort((a, b) => Number(!!a.emphasis) - Number(!!b.emphasis))

  return (
    <Frame height={H} label={`${yLabel} against ${xLabel}`} caption={caption}>
      {x.ticks.map((t) => (
        <g key={`x${t}`}>
          <line
            x1={x.at(t)}
            x2={x.at(t)}
            y1={pad.t}
            y2={H - pad.b}
            stroke={C.rule}
            strokeWidth={0.6}
          />
          <text x={x.at(t)} y={H - pad.b + 13} textAnchor="middle" fill={C.faint} style={MONO}>
            {compact(t)}
          </text>
        </g>
      ))}
      {y.ticks.map((t) => (
        <g key={`y${t}`}>
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={y.at(t)}
            y2={y.at(t)}
            stroke={C.rule}
            strokeWidth={0.6}
          />
          <text x={pad.l - 6} y={y.at(t) + 3} textAnchor="end" fill={C.faint} style={MONO}>
            {yFormat(t)}
          </text>
        </g>
      ))}
      <text x={W - pad.r} y={H - 4} textAnchor="end" fill={C.muted} style={MONO}>
        {xLabel} →
      </text>
      <text x={pad.l} y={pad.t - 4} fill={C.muted} style={MONO}>
        ↑ {yLabel}
      </text>
      {corner && (
        <text x={pad.l + 6} y={pad.t + 12} fill={C.faint} style={{ ...MONO, fontStyle: "italic" }}>
          {corner}
        </text>
      )}
      {mx !== null && (
        <line
          x1={x.at(mx)}
          x2={x.at(mx)}
          y1={pad.t}
          y2={H - pad.b}
          stroke={C.muted}
          strokeDasharray="3 3"
          strokeWidth={0.8}
        />
      )}
      {my !== null && (
        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={y.at(my)}
          y2={y.at(my)}
          stroke={C.muted}
          strokeDasharray="3 3"
          strokeWidth={0.8}
        />
      )}
      {drawn.map((p) => {
        const cx = x.at(p.x)
        const cy = y.at(p.y)
        const placed = labels.get(p.key)
        const show = placed !== undefined || hover === p.key
        const right = placed ? placed.right : cx < W - 150
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a <button>
          <g
            key={p.key}
            role="button"
            tabIndex={0}
            onClick={() => open(p.fact)}
            onKeyDown={(e) => e.key === "Enter" && open(p.fact)}
            onMouseEnter={() => setHover(p.key)}
            onMouseLeave={() => setHover(null)}
            className="cursor-pointer"
          >
            <title>{`${p.label}: open the receipt`}</title>
            <circle cx={cx} cy={cy} r={12} fill="transparent" />
            <circle
              cx={cx}
              cy={cy}
              r={p.emphasis ? 6 : 4.5}
              fill={p.muted ? C.paper : p.emphasis || hover === p.key ? C.marker : C.ink}
              stroke={C.ink}
              strokeWidth={p.emphasis ? 1.5 : 1}
            />
            {show && (
              <text
                x={cx + (right ? 8 : -8)}
                y={(placed?.cy ?? cy) + 3.5}
                textAnchor={right ? "start" : "end"}
                fill={C.ink}
                stroke={C.paper}
                strokeWidth={3}
                paintOrder="stroke"
                style={{ fontSize: 11 }}
              >
                {p.label}
              </text>
            )}
          </g>
        )
      })}
    </Frame>
  )
}

const textWidth = (s: string) => s.length * 6.3 + 4

/**
 * Greedy label placement: each label, in priority order, tries the right of its
 * point, then the left, then a line above or below. A label that fits nowhere is
 * left to hover, which beats two names printed through each other.
 */
function placeLabels(
  wanted: { key: string; cx: number; cy: number; text: string }[],
  dots: { cx: number; cy: number }[],
  area: { l: number; r: number; t: number; b: number },
): Map<string, { right: boolean; cy: number }> {
  type Box = { x0: number; x1: number; y0: number; y1: number }
  const taken: Box[] = []
  const hits = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
  const out = new Map<string, { right: boolean; cy: number }>()
  for (const w of wanted) {
    const width = textWidth(w.text)
    for (const [right, dy] of [
      [true, 0],
      [false, 0],
      [true, -13],
      [true, 13],
      [false, -13],
      [false, 13],
    ] as const) {
      const x0 = right ? w.cx + 6 : w.cx - 6 - width
      const box = { x0, x1: x0 + width, y0: w.cy + dy - 7, y1: w.cy + dy + 7 }
      if (box.x0 < area.l - 40 || box.x1 > area.r + 8 || box.y0 < area.t || box.y1 > area.b)
        continue
      const onDot = dots.some(
        (d) =>
          (d.cx !== w.cx || d.cy !== w.cy) &&
          hits(box, { x0: d.cx - 5, x1: d.cx + 5, y0: d.cy - 5, y1: d.cy + 5 }),
      )
      if (onDot || taken.some((t) => hits(t, box))) continue
      taken.push(box)
      out.set(w.key, { right, cy: w.cy + dy })
      break
    }
  }
  return out
}

export const priceTick = (cents: number): string => formatCents(cents).replace(".00", "")

// ---- hours histogram ----------------------------------------------------------------------

/**
 * Positive reviews above the axis and negative ones below, by hours played at
 * review. The first two buckets, Steam's refund window, are shaded.
 */
export function HoursHistogram({
  fact,
  buckets,
}: {
  fact: FactRecord
  buckets: { label: string; up: number; down: number }[]
}) {
  const open = useOpen()
  const H = 220
  const pad = { l: 62, r: 16, t: 18, b: 18 }
  const mid = (H - pad.b + pad.t) / 2
  const peak = Math.max(1, ...buckets.flatMap((b) => [b.up, b.down]))
  const half = mid - pad.t - 4
  const band = (W - pad.l - pad.r) / buckets.length
  const bar = band * 0.62
  const tall = (n: number) => (n / peak) * half
  return (
    <Frame
      height={H}
      label="Reviews by hours played at review"
      caption="Hours played when the review was written, pooled over every sampled review. The shaded columns are Steam's two-hour refund window."
    >
      <rect
        x={pad.l}
        y={pad.t - 6}
        width={band * 2}
        height={H - pad.t - pad.b + 12}
        fill={C.soft}
      />
      <text x={pad.l + 4} y={pad.t + 2} fill={C.muted} style={MONO}>
        refund window
      </text>
      <text x={pad.l - 6} y={mid - half / 2} textAnchor="end" fill={C.ink} style={MONO}>
        positive
      </text>
      <text x={pad.l - 6} y={mid + half / 2 + 6} textAnchor="end" fill={C.red} style={MONO}>
        negative
      </text>
      {buckets.map((b, i) => {
        const x = pad.l + i * band + (band - bar) / 2
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a <button>
          <g
            key={b.label}
            role="button"
            tabIndex={0}
            onClick={() => open(fact)}
            onKeyDown={(e) => e.key === "Enter" && open(fact)}
            className="cursor-pointer"
          >
            <title>{`${b.label}: ${b.up} positive, ${b.down} negative`}</title>
            <rect x={x} y={mid - tall(b.up)} width={bar} height={tall(b.up)} fill={C.ink} />
            <rect x={x} y={mid} width={bar} height={tall(b.down)} fill={C.red} opacity={0.85} />
            {b.up > 0 && (
              <text
                x={x + bar / 2}
                y={mid - tall(b.up) - 3}
                textAnchor="middle"
                fill={C.muted}
                style={MONO}
              >
                {b.up}
              </text>
            )}
            {b.down > 0 && (
              <text
                x={x + bar / 2}
                y={mid + tall(b.down) + 11}
                textAnchor="middle"
                fill={C.muted}
                style={MONO}
              >
                {b.down}
              </text>
            )}
          </g>
        )
      })}
      <line x1={pad.l} x2={W - pad.r} y1={mid} y2={mid} stroke={C.ink} strokeWidth={0.8} />
      {buckets.map((b, i) => (
        <text
          key={b.label}
          x={pad.l + i * band + band / 2}
          y={H - 3}
          textAnchor="middle"
          fill={C.faint}
          style={MONO}
        >
          {b.label}
        </text>
      ))}
    </Frame>
  )
}

// ---- recent against all-time ----------------------------------------------------------------

export interface Dumbbell {
  key: string
  label: string
  from: number
  to: number
  fact: FactRecord
  /** The window `to` covers, printed beside the row. */
  note?: string
}

/**
 * Each game's all-time score (hollow) and its newest reviews' score (filled),
 * joined. Red when the newest run at least `margin` points lower.
 */
export function Dumbbells({ rows, margin }: { rows: Dumbbell[]; margin: number }) {
  const open = useOpen()
  if (rows.length === 0) return null
  const rowH = 22
  const pad = { l: 170, r: 116, t: 20, b: 20 }
  const H = pad.t + rows.length * rowH + pad.b
  const lo = Math.max(
    0,
    Math.floor((Math.min(...rows.flatMap((r) => [r.from, r.to])) - 5) / 10) * 10,
  )
  const x = linear(lo, 100, pad.l, W - pad.r, 5)
  return (
    <Frame
      height={H}
      label="Recent score against all-time score"
      caption={`○ all-time score from the store search, ● the newest reviews. Red: at least ${margin} points lower lately.`}
    >
      {x.ticks.map((t) => (
        <g key={t}>
          <line
            x1={x.at(t)}
            x2={x.at(t)}
            y1={pad.t - 6}
            y2={H - pad.b}
            stroke={C.rule}
            strokeWidth={0.6}
          />
          <text x={x.at(t)} y={pad.t - 9} textAnchor="middle" fill={C.faint} style={MONO}>
            {t}%
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const cy = pad.t + i * rowH + rowH / 2
        const worse = r.to <= r.from - margin
        const colour = worse ? C.red : C.ink
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a <button>
          <g
            key={r.key}
            role="button"
            tabIndex={0}
            onClick={() => open(r.fact)}
            onKeyDown={(e) => e.key === "Enter" && open(r.fact)}
            className="cursor-pointer"
          >
            <title>{`${r.label}: ${r.from}% all-time, ${r.to}% lately`}</title>
            <rect x={0} y={cy - rowH / 2} width={W} height={rowH} fill="transparent" />
            <text
              x={pad.l - 10}
              y={cy + 4}
              textAnchor="end"
              fill={C.ink}
              style={{ fontSize: 11.5 }}
            >
              {r.label.length > 26 ? `${r.label.slice(0, 25)}…` : r.label}
            </text>
            <line
              x1={x.at(r.from)}
              x2={x.at(r.to)}
              y1={cy}
              y2={cy}
              stroke={colour}
              strokeWidth={2}
            />
            <circle
              cx={x.at(r.from)}
              cy={cy}
              r={4}
              fill={C.paper}
              stroke={C.ink}
              strokeWidth={1.2}
            />
            <circle cx={x.at(r.to)} cy={cy} r={4.5} fill={colour} />
            <text x={W - pad.r + 8} y={cy + 3.5} fill={worse ? C.red : C.faint} style={MONO}>
              {r.to - r.from > 0 ? "+" : ""}
              {r.to - r.from} pts{r.note ? ` · ${r.note}` : ""}
            </text>
          </g>
        )
      })}
    </Frame>
  )
}

// ---- share bars --------------------------------------------------------------------------

export interface ShareBar {
  key: string
  label: string
  n: number
  of: number
  fact: FactRecord
}

/** Fewer reviews than this in a game's sample, and its bar is drawn pale. */
const THIN_SAMPLE = 20

/** One bar per game: `n` of `of`, as a share, with the lane's pooled share as a line. */
export function ShareBars({
  rows,
  pooled,
  unit,
}: {
  rows: ShareBar[]
  pooled: number | null
  unit: string
}) {
  const open = useOpen()
  if (rows.length === 0) return null
  const rowH = 20
  const pad = { l: 170, r: 116, t: 16, b: 8 }
  const H = pad.t + rows.length * rowH + pad.b
  const x = linear(0, 100, pad.l, W - pad.r, 4)
  return (
    <Frame height={H} label={`Share of ${unit} per game`}>
      {x.ticks.map((t) => (
        <text key={t} x={x.at(t)} y={pad.t - 5} textAnchor="middle" fill={C.faint} style={MONO}>
          {t}%
        </text>
      ))}
      {rows.map((r, i) => {
        const y0 = pad.t + i * rowH
        const pct = r.of > 0 ? (r.n / r.of) * 100 : 0
        const thin = r.of < THIN_SAMPLE
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a <button>
          <g
            key={r.key}
            role="button"
            tabIndex={0}
            onClick={() => open(r.fact)}
            onKeyDown={(e) => e.key === "Enter" && open(r.fact)}
            className="cursor-pointer"
          >
            <title>{`${r.label}: ${r.n} of ${r.of} ${unit}${thin ? " (too few to read alone)" : ""}`}</title>
            <text
              x={pad.l - 10}
              y={y0 + 13}
              textAnchor="end"
              fill={C.ink}
              style={{ fontSize: 11.5 }}
            >
              {r.label.length > 26 ? `${r.label.slice(0, 25)}…` : r.label}
            </text>
            <rect x={pad.l} y={y0 + 4} width={W - pad.l - pad.r} height={rowH - 8} fill={C.soft} />
            <rect
              x={pad.l}
              y={y0 + 4}
              width={x.at(pct) - pad.l}
              height={rowH - 8}
              fill={C.red}
              opacity={thin ? 0.3 : 0.85}
            />
            <text x={W - pad.r + 8} y={y0 + 13} fill={C.faint} style={MONO}>
              {r.n} of {r.of}
              {thin ? " · few" : ""}
            </text>
          </g>
        )
      })}
      {pooled !== null && (
        <g>
          <line
            x1={x.at(pooled)}
            x2={x.at(pooled)}
            y1={pad.t - 2}
            y2={H - pad.b + 2}
            stroke={C.ink}
            strokeDasharray="3 2"
            strokeWidth={1}
          />
        </g>
      )}
    </Frame>
  )
}
