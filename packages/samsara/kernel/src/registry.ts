import type { SessionOutcome, SessionPurpose } from "@samsara/core"
import { type Logger, now, silentLogger } from "./log.js"

/**
 * Session registry. An in-memory map plus a row per
 * session, and a reconcile pass on boot.
 *
 * The reconcile pass is not bookkeeping. A session row marked `running` with no
 * live handle is a session nobody is paying attention to but everybody is paying
 * for, and under ADR-0014 the runner exits between drains — so that state is not
 * exceptional, it is what a cancelled workflow leaves behind every time. Marking
 * them `orphaned` on the next boot is how the minutes meter stays honest.
 */

export interface SessionRecord {
  id: string
  purpose: SessionPurpose
  ownerId: string | null
  domainId: string | null
  country: string
  /** What the browser claimed to be. Null means the provider's default: nobody. */
  locale: string | null
  timezoneId: string | null
  startedAt: Date
  endedAt: Date | null
  minutes: number
  outcome: SessionOutcome
  recordingRef: string | null
}

export interface SessionStore {
  open(row: SessionRecord): Promise<void>
  close(id: string, patch: Partial<SessionRecord>): Promise<void>
  /** Rows still marked `running`. */
  findOpen(): Promise<SessionRecord[]>
}

interface LiveHandle {
  record: SessionRecord
  startedAtMs: number
  /** Force-close. Called by the deadline and by shutdown. */
  release: () => Promise<void>
}

export class SessionRegistry {
  private readonly live = new Map<string, LiveHandle>()

  constructor(
    private readonly store: SessionStore,
    private readonly logger: Logger = silentLogger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get openCount(): number {
    return this.live.size
  }

  async open(record: SessionRecord, release: () => Promise<void>): Promise<void> {
    this.live.set(record.id, { record, startedAtMs: this.clock().getTime(), release })
    await this.store.open(record)
    this.logger.emit({
      at: now(),
      event: "session.open",
      sessionId: record.id,
      purpose: record.purpose,
      country: record.country,
      locale: record.locale,
      timezoneId: record.timezoneId,
      domainId: record.domainId,
      recording: record.recordingRef !== null,
    })
  }

  /** Returns the minutes the session consumed, so the caller can meter them. */
  async close(id: string, outcome: SessionOutcome, bytes: number | null = null): Promise<number> {
    const handle = this.live.get(id)
    if (!handle) return 0
    this.live.delete(id)

    const endedAt = this.clock()
    const durationMs = endedAt.getTime() - handle.startedAtMs
    const minutes = durationMs / 60_000

    await this.store.close(id, { endedAt, minutes, outcome })
    this.logger.emit({
      at: now(),
      event: "session.close",
      sessionId: id,
      purpose: handle.record.purpose,
      country: handle.record.country,
      outcome,
      durationMs,
      minutes,
      bytes,
    })
    return minutes
  }

  /**
   * On boot: every row the database still thinks is running, with no live handle
   * here, was abandoned by a previous process. Nothing can recover them — the
   * handle died with that process — so they are closed as `orphaned`, which is a
   * distinct outcome precisely so the `/kernel` screen can show how often the
   * runner is being cancelled mid-flight.
   */
  async reconcile(): Promise<SessionRecord[]> {
    const open = await this.store.findOpen()
    const orphans = open.filter((row) => !this.live.has(row.id))
    const at = this.clock()
    for (const row of orphans) {
      const ageMs = at.getTime() - row.startedAt.getTime()
      await this.store.close(row.id, {
        endedAt: at,
        outcome: "orphaned",
        minutes: ageMs / 60_000,
      })
      this.logger.emit({
        at: now(),
        event: "session.orphaned",
        sessionId: row.id,
        purpose: row.purpose,
        ageMs,
      })
    }
    return orphans
  }

  /**
   * SIGTERM path. A scheduled runner gets a cancellation signal and a short grace
   * period; every live session must be released inside it or it bills until the
   * provider's own idle timeout. Releases run in parallel and individually: one
   * handle that refuses to close must not strand the others.
   */
  async shutdown(): Promise<void> {
    const handles = [...this.live.values()]
    await Promise.allSettled(
      handles.map(async (h) => {
        try {
          await h.release()
        } finally {
          await this.close(h.record.id, "orphaned")
        }
      }),
    )
    this.live.clear()
  }
}
