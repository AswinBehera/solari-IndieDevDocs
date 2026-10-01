import { describe, expect, it } from "vitest"
import { MemoryLogger } from "./log.js"
import { type SessionRecord, SessionRegistry } from "./registry.js"
import { MemorySessionStore } from "./stores/memory.js"

const row = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  purpose: "probe",
  ownerId: null,
  domainId: null,
  country: "sg",
  locale: "vi-VN",
  timezoneId: "Asia/Ho_Chi_Minh",
  startedAt: new Date("2026-09-11T09:00:00.000Z"),
  endedAt: null,
  minutes: 0,
  outcome: "running",
  recordingRef: null,
  ...over,
})

describe("session registry", () => {
  it("writes a row on open and closes it with measured minutes", async () => {
    const store = new MemorySessionStore()
    let t = 0
    const registry = new SessionRegistry(store, new MemoryLogger(), () => new Date(t))

    await registry.open(row(), async () => {})
    expect(registry.openCount).toBe(1)

    t = 90_000
    const minutes = await registry.close(row().id, "ok")

    expect(minutes).toBe(1.5)
    expect(registry.openCount).toBe(0)
    expect(store.rows.get(row().id)?.outcome).toBe("ok")
    expect(store.rows.get(row().id)?.minutes).toBe(1.5)
  })

  it("marks rows the last process abandoned as orphaned", async () => {
    // The case this is really about: a scheduled runner cancelled mid-flight
    // (ADR-0014). The handle died with the process, so nothing can recover the
    // session — but the row must stop claiming to be running, and the minutes it
    // burned before dying still have to reach the meter.
    const store = new MemorySessionStore()
    await store.open(row({ id: "aaaaaaaa-1111-4111-8111-111111111111" }))
    await store.open(row({ id: "bbbbbbbb-1111-4111-8111-111111111111" }))

    const logger = new MemoryLogger()
    const registry = new SessionRegistry(store, logger, () => new Date("2026-09-11T09:05:00.000Z"))

    const orphans = await registry.reconcile()

    expect(orphans).toHaveLength(2)
    expect([...store.rows.values()].every((r) => r.outcome === "orphaned")).toBe(true)
    expect([...store.rows.values()].every((r) => r.minutes === 5)).toBe(true)
    expect(logger.events.filter((e) => e.event === "session.orphaned")).toHaveLength(2)
  })

  it("leaves a session this process is holding alone", async () => {
    const store = new MemorySessionStore()
    const registry = new SessionRegistry(store, new MemoryLogger())
    await registry.open(row(), async () => {})

    expect(await registry.reconcile()).toHaveLength(0)
    expect(store.rows.get(row().id)?.outcome).toBe("running")
  })

  it("releases every handle on shutdown, even if one refuses to close", async () => {
    const store = new MemorySessionStore()
    const registry = new SessionRegistry(store, new MemoryLogger())
    const released: string[] = []

    await registry.open(row({ id: "aaaaaaaa-1111-4111-8111-111111111111" }), async () => {
      throw new Error("this handle is wedged")
    })
    await registry.open(row({ id: "bbbbbbbb-1111-4111-8111-111111111111" }), async () => {
      released.push("b")
    })

    await registry.shutdown()

    // One handle throwing must not strand the other: the whole point of shutdown
    // is that nothing is left billing after SIGTERM.
    expect(released).toEqual(["b"])
    expect(registry.openCount).toBe(0)
    expect([...store.rows.values()].every((r) => r.outcome === "orphaned")).toBe(true)
  })
})

describe("structured logs", () => {
  it("emits open and close events with the fields the log contract asks for", async () => {
    const store = new MemorySessionStore()
    const logger = new MemoryLogger()
    const registry = new SessionRegistry(store, logger, () => new Date(0))

    await registry.open(row(), async () => {})
    await registry.close(row().id, "ok", 4096)

    const open = logger.events.find((e) => e.event === "session.open")
    const close = logger.events.find((e) => e.event === "session.close")
    expect(open).toMatchObject({ purpose: "probe", country: "sg", locale: "vi-VN" })
    expect(close).toMatchObject({ outcome: "ok", bytes: 4096 })
  })

  it("has nowhere to put a secret", async () => {
    // Not a redaction test — a shape test. The repository is public, so the
    // Actions log is public (ADR-0014). The defence is that no event type has a
    // free-form field, so logging a request body or an env value would not
    // typecheck. If a `payload`-shaped field is ever added, this fails.
    const store = new MemorySessionStore()
    const logger = new MemoryLogger()
    const registry = new SessionRegistry(store, logger, () => new Date(0))
    await registry.open(row(), async () => {})
    await registry.close(row().id, "ok")

    const allowed = new Set([
      "at",
      "event",
      "sessionId",
      "purpose",
      "country",
      "domainId",
      "recording",
      "outcome",
      "durationMs",
      "minutes",
      "bytes",
      // Both halves of the viewpoint. Neither can carry a secret: a BCP 47 tag and
      // an IANA zone are drawn from fixed public vocabularies.
      "locale",
      "timezoneId",
      "ageMs",
      "meter",
      "window",
      "ceiling",
      "used",
      "requested",
      "amount",
      "attempt",
      "of",
      "delayMs",
      "because",
      "kind",
      "message",
      "attempts",
      "jobId",
      "type",
      "outcome",
      "willRetry",
      "runId",
      "claimed",
      "succeeded",
      "failed",
      "reclaimed",
    ])
    for (const event of logger.events) {
      for (const key of Object.keys(event)) expect(allowed).toContain(key)
    }
  })
})
