import { Link, Outlet } from "@tanstack/react-router"
import { useHealth } from "./health"

/**
 * The frame every page sits in: the brand, a strip that appears only when the API
 * cannot be reached, and the footer that says what does the reading.
 */
export function Shell() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface font-body text-ink">
      <header className="sticky top-0 z-20 flex min-h-13 items-center gap-x-5 border-rule border-b bg-surface px-4 py-2 sm:px-7">
        <Link to="/" className="flex flex-none items-baseline gap-2 whitespace-nowrap">
          <span className="font-display text-[24px] tracking-tight">
            indieDevDocs<span className="text-marker">.</span>
          </span>
          <span className="font-mono text-[10px] text-ink-faint tracking-[.08em]">STEAM RESEARCH</span>
        </Link>
        <nav className="ml-auto flex items-center gap-1 text-sm">
          <Link to="/" className="px-2 py-1 text-ink-muted hover:text-ink">
            Documents
          </Link>
        </nav>
      </header>
      <StatusStrip />
      <Outlet />
      <footer className="mt-auto bg-night text-surface">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-end gap-x-10 gap-y-4 px-4 py-6 sm:px-12">
          <div className="min-w-0 flex-1 basis-72">
            <p className="font-mono text-[11px] text-marker tracking-[.12em]">BUILT ON SOLARI</p>
            <p className="mt-1.5 max-w-2xl text-sm text-surface/85 leading-relaxed">
              Store pages are read in{" "}
              <a
                href="https://getsolari.com"
                className="underline decoration-surface/40 underline-offset-2 hover:decoration-surface"
              >
                Solari
              </a>{" "}
              cloud browsers, one session per page, and kept as HTML plus a screenshot with the cited region
              marked. Numbers from Steam's public API keep the raw response. Receipts stay on the machine that
              ran the block: they are Steam's content, not ours to republish.
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}

/** Only when something is wrong: the API is not answering, so nothing will save. */
function StatusStrip() {
  const health = useHealth()
  if (!health.isError) return null
  return (
    <div className="flex items-center gap-2 border-rule border-b bg-surface-raised px-7 py-1 font-mono text-[10px] text-ink-muted">
      <span className="inline-block size-1.5 rounded-full bg-signal-red" aria-hidden />
      Can't reach the API. Changes won't save until it's back.
    </div>
  )
}
