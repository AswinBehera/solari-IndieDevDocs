import type { ReactNode } from "react"
import { type KernelResponse, usedFraction, useKernel } from "./queries"

/**
 * The ops dashboard (P5.5), at `/lab/kernel`: what the engine is doing and what
 * it has left to spend. Read-only, and fetched once per visit.
 */
export function Kernel() {
  const q = useKernel()
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 pt-10 pb-20 font-body text-ink sm:px-12">
      <header>
        <p className="mb-2 font-mono text-[11px] text-ink-faint tracking-[.1em]">
          /lab/kernel · BUILT ON SOLARI · INTERNAL
        </p>
        <h1 className="font-display text-[44px] leading-none tracking-tight">Spend</h1>
      </header>
      {q.isPending ? (
        <Note>Loading…</Note>
      ) : q.isError ? (
        <Note>Could not load the kernel: {q.error.message}</Note>
      ) : (
        <Board data={q.data} />
      )}
    </main>
  )
}

function Board({ data }: { data: KernelResponse }) {
  const minutes = data.minutesToday.reduce((sum, m) => sum + m.minutes, 0)
  const peak = Math.max(1, ...data.minutesToday.map((m) => m.minutes))
  const total = data.adapters.reduce((sum, a) => sum + a.total, 0)
  const blocked = data.adapters.reduce((sum, a) => sum + a.blocked, 0)
  const healthy = data.personas.filter((p) => p.health === "healthy").length
  const kpis = [
    { label: "OPEN SESSIONS", value: String(data.open.length), sub: "running now" },
    { label: "MINUTES TODAY", value: minutes.toFixed(1), sub: "all purposes, UTC day" },
    {
      label: "BLOCKED · 24H",
      value: total === 0 ? "—" : `${Math.round((blocked / total) * 100)}%`,
      sub: `${blocked} of ${total} sessions`,
    },
    { label: "PERSONAS HEALTHY", value: `${healthy}/${data.personas.length}`, sub: "on the board" },
  ]
  return (
    <div className="grid grid-cols-12 gap-5">
      {kpis.map((k) => (
        <div
          key={k.label}
          className="col-span-6 border border-rule bg-paper px-5 py-4 lg:col-span-3"
        >
          <div className="font-mono text-[10px] text-ink-muted tracking-[.1em]">{k.label}</div>
          <div className="mt-2 font-display text-[42px] leading-none">{k.value}</div>
          <div className="mt-1.5 text-ink-muted text-xs">{k.sub}</div>
        </div>
      ))}

      <Panel className="col-span-12 lg:col-span-5" title="Minutes today by purpose">
        {data.minutesToday.length === 0 ? (
          <Note>No sessions today.</Note>
        ) : (
          data.minutesToday.map((m) => (
            <Bar
              key={m.purpose}
              label={m.purpose}
              fraction={m.minutes / peak}
              value={m.minutes.toFixed(1)}
            />
          ))
        )}
        <h3 className="mt-6 mb-3 font-mono text-[10px] text-ink-muted tracking-[.1em]">
          BUDGET TODAY · {data.now.slice(0, 10)} UTC
        </h3>
        {data.meters.map((m) => (
          <Bar
            key={m.meter}
            label={m.meter}
            fraction={usedFraction(m.used, m.ceiling)}
            value={`${m.used.toLocaleString()} / ${m.ceiling.toLocaleString()}`}
            wide
          />
        ))}
      </Panel>

      <section className="col-span-12 bg-ink px-5 py-4 text-surface lg:col-span-7">
        <div className="mb-3 flex justify-between font-mono text-[10px] text-ink-faint tracking-[.1em]">
          <span>LIVE SESSIONS</span>
          <span>{data.open.length} OPEN</span>
        </div>
        {data.open.length === 0 ? (
          <p className="font-mono text-[12px] text-ink-faint">None running.</p>
        ) : (
          data.open.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-2.5 border-white/10 border-t py-2 font-mono text-[11px]"
            >
              <span className="h-2 w-2 rounded-full bg-[#C9A227]" />
              <span>{s.purpose}</span>
              <span className="text-[#C9A227]">{s.country}</span>
              <span className="ml-auto text-ink-faint">
                {s.startedAt.slice(11, 19)} · {s.id.slice(0, 8)}
              </span>
            </div>
          ))
        )}
      </section>

      <Panel className="col-span-12 lg:col-span-6" title="Blocked rate per adapter · 24h">
        {data.adapters.length === 0 ? (
          <Note>No sessions in the last 24 hours.</Note>
        ) : (
          data.adapters.map((a) => (
            <Bar
              key={a.domainId}
              label={a.domainId}
              fraction={a.blockedRate}
              value={`${Math.round(a.blockedRate * 100)}% · ${a.blocked}/${a.total}`}
              wide
            />
          ))
        )}
      </Panel>

      <Panel className="col-span-12 lg:col-span-6" title="Persona health board">
        {data.personas.length === 0 ? (
          <Note>No personas.</Note>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {data.personas.map((p) => (
              <div key={p.id} className="flex items-center gap-2.5 border border-rule px-3 py-2.5">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    p.health === "healthy"
                      ? "bg-[#2E7D4F]"
                      : p.health === "degraded"
                        ? "bg-[#C9A227]"
                        : "bg-[#B3261E]"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px]">{p.name}</div>
                  <div className="text-ink-muted text-[11px]">
                    {p.country} · {p.sessions} sessions · {p.blocks} blocks
                  </div>
                </div>
                <span className="font-mono text-[10px] text-ink-muted tracking-[.06em]">
                  {p.health.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

function Panel({
  title,
  className,
  children,
}: {
  title: string
  className: string
  children: ReactNode
}) {
  return (
    <section className={`border border-rule bg-paper px-5 py-4 ${className}`}>
      <h2 className="mb-3.5 font-mono text-[10px] text-ink-muted tracking-[.1em]">
        {title.toUpperCase()}
      </h2>
      {children}
    </section>
  )
}

function Bar({
  label,
  fraction,
  value,
  wide,
}: {
  label: string
  fraction: number
  value: string
  wide?: boolean
}) {
  return (
    <div
      className={`grid items-center gap-3 py-1.5 ${wide ? "grid-cols-[130px_1fr_110px]" : "grid-cols-[130px_1fr_44px]"}`}
    >
      <span className="truncate font-mono text-[11px]">{label}</span>
      <div className="h-2 bg-rule/60">
        <div
          className="h-full bg-ink"
          style={{ width: `${Math.min(1, Math.max(0, fraction)) * 100}%` }}
        />
      </div>
      <span className="text-right font-mono text-[11px]">{value}</span>
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[12px] text-ink-muted">{children}</p>
}
