import { Link, Outlet, useRouterState } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useHealth } from "./health"

/**
 * The frame every signed-in page sits in: the brand, the nav, and the strip under
 * them that says what the machinery is doing.
 *
 * Read off the design canvas's top bar, including its "TRAVEL OS" tag, which is
 * product language and stays (ADR-0011). The nav is grouped the way the canvas
 * groups it — the product, then the lab — and holds only pages that exist; the
 * canvas's Hundred Eyes and Plans groups arrive with their screens.
 *
 * The strip is where the canvas puts the kernel's live line ("Reading Yaowarat
 * from a Thai IP"). Until an endpoint reports sessions, it carries the one thing
 * P0.6's dev shell existed to show: whether the API answers at all — the same
 * `/health` call, which deliberately never touches Postgres.
 */

interface NavItem {
  to: string
  label: string
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const NAV: NavGroup[] = [
  { label: "PRODUCT", items: [{ to: "/", label: "Trips" }] },
  // The kernel, with a face: the characters who do the browsing. Its own group
  // because it is the part of the product that is not a trip planner.
  { label: "SAMSARA", items: [{ to: "/samsara", label: "Characters" }] },
  // The lab, named for a traveller: what it is, not what the code calls it.
  {
    label: "UNDER THE HOOD",
    items: [
      { to: "/lab", label: "Lab" },
      { to: "/lab/places", label: "Place scores" },
      { to: "/lab/kernel", label: "Spend & jobs" },
    ],
  },
]

/** Longest match wins, so `/lab/places` does not also light up `/lab`. */
export function activeNav(pathname: string, groups: readonly NavGroup[] = NAV): string | null {
  let best: string | null = null
  for (const group of groups) {
    for (const item of group.items) {
      const matches =
        item.to === "/"
          ? pathname === "/" || pathname.startsWith("/trips") || pathname === "/onboarding"
          : pathname === item.to || pathname.startsWith(`${item.to}/`)
      if (matches && (best === null || item.to.length > best.length)) best = item.to
    }
  }
  return best
}

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = activeNav(pathname)
  return (
    <div className="flex min-h-dvh flex-col bg-surface font-body text-ink">
      <header className="sticky top-0 z-20 flex min-h-13 flex-wrap items-center gap-5 border-rule border-b bg-surface px-7 py-2">
        <Link to="/" className="flex flex-none items-baseline gap-2 whitespace-nowrap">
          <span className="font-display text-[22px] tracking-tight">Doen Thang</span>
          <span className="font-mono text-[10px] text-ink-faint tracking-[.08em]">TRAVEL OS</span>
        </Link>
        <nav className="flex min-w-0 flex-1 flex-wrap justify-end gap-x-3 gap-y-0.5 text-xs">
          {NAV.map((group) => (
            <div key={group.label} className="flex items-center gap-0.5 whitespace-nowrap">
              <span className="mr-1 font-mono text-[9px] text-ink-faint tracking-[.1em]">
                {group.label}
              </span>
              {group.items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`border-b-2 px-1.5 py-1 ${
                    active === item.to
                      ? "border-accent-pink text-ink"
                      : "border-transparent text-ink-muted hover:text-ink"
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </header>
      <StatusStrip />
      <Outlet />
    </div>
  )
}

/**
 * Only when something is wrong. "API up" on every page told a traveller nothing
 * and read as a developer's console left open.
 */
function StatusStrip() {
  const health = useHealth()
  if (!health.isError) return null
  const line: { tone: "up" | "down" | "waiting"; text: ReactNode } = health.isPending
    ? { tone: "waiting", text: "Checking the API…" }
    : health.isError
      ? {
          tone: "down",
          text: "Can't reach the server right now. Changes won't save until it's back.",
        }
      : { tone: "up", text: "API up" }
  const dot =
    line.tone === "up" ? "bg-accent-pink" : line.tone === "down" ? "bg-red-700" : "bg-rule"
  return (
    <div className="flex items-center gap-3.5 overflow-hidden whitespace-nowrap border-rule border-b bg-surface-raised px-7 py-1 font-mono text-[10px] text-ink-muted tracking-[.04em]">
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block size-1.5 rounded-full ${dot}`} aria-hidden />
        {line.text}
      </span>
    </div>
  )
}
