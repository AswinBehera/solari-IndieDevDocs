/**
 * The document's autosave: debounced, one request in flight, and honest about a
 * conflict (P4.1: "persist document JSON on debounce, version column for
 * optimistic concurrency").
 *
 * Plain TypeScript with an injected clock so a test can drive it. The editor calls
 * `change()` on every edit; this decides when a PUT actually happens.
 *
 * Three rules:
 *
 * - **Debounced.** A save fires `delay` after the last edit, not on each keystroke.
 * - **One in flight.** An edit that lands while a save is out is not sent beside
 *   it — two PUTs at the same version would have the second refused as a
 *   conflict with ourselves. It waits, and goes with the next version.
 * - **A conflict stops saving.** When the server says the version moved (another
 *   tab, another device), carrying on would overwrite that edit with this one.
 *   The saver goes to `conflict` and sends nothing more until the page reloads.
 */

export type SaveOutcome = { saved: true; version: number } | { saved: false; version: number }

export type SaverStatus =
  | { kind: "saved"; version: number }
  | { kind: "pending"; version: number }
  | { kind: "saving"; version: number }
  | { kind: "conflict"; version: number; current: number }
  | { kind: "error"; version: number; message: string }

export interface SaverOptions {
  version: number
  save: (content: unknown, version: number) => Promise<SaveOutcome>
  delay?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class DocumentSaver {
  private version: number
  private latest: unknown = undefined
  private dirty = false
  private inFlight = false
  private timer: unknown = null
  private state: SaverStatus
  private readonly listeners = new Set<(s: SaverStatus) => void>()
  private readonly delay: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: SaverOptions) {
    this.version = options.version
    this.state = { kind: "saved", version: this.version }
    this.delay = options.delay ?? 800
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  get status(): SaverStatus {
    return this.state
  }

  subscribe(fn: (s: SaverStatus) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** The editor changed. Remember the newest content and (re)arm the timer. */
  change(content: unknown): void {
    if (this.state.kind === "conflict") return
    this.latest = content
    this.dirty = true
    this.set({ kind: "pending", version: this.version })
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.flush()
    }, this.delay)
  }

  /** Save now, if there is anything to save and nothing already on its way. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    if (!this.dirty || this.inFlight || this.state.kind === "conflict") return
    const content = this.latest
    this.dirty = false
    this.inFlight = true
    this.set({ kind: "saving", version: this.version })
    try {
      const outcome = await this.options.save(content, this.version)
      if (!outcome.saved) {
        this.set({ kind: "conflict", version: this.version, current: outcome.version })
        return
      }
      this.version = outcome.version
      this.set({ kind: this.dirty ? "pending" : "saved", version: this.version })
    } catch (e) {
      // The edit is not lost: it is still the newest content, so the next change
      // or flush sends it again.
      this.dirty = true
      this.set({
        kind: "error",
        version: this.version,
        message: e instanceof Error ? e.message : String(e),
      })
      return
    } finally {
      this.inFlight = false
    }
    // Edits that arrived during the save go out now, at the new version.
    if (this.dirty) await this.flush()
  }

  private set(s: SaverStatus) {
    this.state = s
    for (const fn of this.listeners) fn(s)
  }
}

/**
 * The rail footer's words. No version number: "v41" and "edited" were the
 * saver's state, and all a traveller needs is whether their writing is safe.
 */
export function statusLine(s: SaverStatus): string {
  switch (s.kind) {
    case "saved":
      return "Saved"
    case "pending":
    case "saving":
      return "Saving…"
    case "conflict":
      return "Changed in another tab · Reload"
    case "error":
      return "Not saved · keeps trying as you type"
  }
}
