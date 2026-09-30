import { describe, expect, it } from "vitest"
import { DocumentSaver, type SaveOutcome, statusLine } from "./saver"

/** A hand-cranked clock: timers fire only when the test says so. */
function clock() {
  let next = 0
  const timers = new Map<number, () => void>()
  return {
    setTimer: (fn: () => void) => {
      next++
      timers.set(next, fn)
      return next
    },
    clearTimer: (h: unknown) => timers.delete(h as number),
    fire: () => {
      const fns = [...timers.values()]
      timers.clear()
      for (const fn of fns) fn()
    },
    pending: () => timers.size,
  }
}

function saver(respond: (content: unknown, version: number) => Promise<SaveOutcome>) {
  const c = clock()
  const calls: { content: unknown; version: number }[] = []
  const s = new DocumentSaver({
    version: 1,
    save: (content, version) => {
      calls.push({ content, version })
      return respond(content, version)
    },
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  })
  return { s, c, calls }
}

const ok = async (_c: unknown, v: number): Promise<SaveOutcome> => ({ saved: true, version: v + 1 })

describe("DocumentSaver", () => {
  it("sends one save for a burst of edits, with the last content", async () => {
    const { s, c, calls } = saver(ok)
    s.change("a")
    s.change("ab")
    s.change("abc")
    expect(c.pending()).toBe(1)
    c.fire()
    await s.flush()
    expect(calls).toEqual([{ content: "abc", version: 1 }])
    expect(s.status).toEqual({ kind: "saved", version: 2 })
  })

  it("holds an edit made mid-save and sends it after, at the new version", async () => {
    let release: (o: SaveOutcome) => void = () => {}
    const first = new Promise<SaveOutcome>((r) => {
      release = r
    })
    let n = 0
    const { s, calls } = saver((_c, v) => (n++ === 0 ? first : ok(_c, v)))
    s.change("a")
    const inFlight = s.flush()
    s.change("ab")
    await s.flush() // refused: one already out
    expect(calls).toHaveLength(1)
    release({ saved: true, version: 2 })
    await inFlight
    expect(calls).toEqual([
      { content: "a", version: 1 },
      { content: "ab", version: 2 },
    ])
    expect(s.status).toEqual({ kind: "saved", version: 3 })
  })

  it("stops saving on a conflict rather than overwriting the other edit", async () => {
    const { s, calls } = saver(async () => ({ saved: false, version: 5 }))
    s.change("a")
    await s.flush()
    expect(s.status).toEqual({ kind: "conflict", version: 1, current: 5 })
    s.change("ab")
    await s.flush()
    expect(calls).toHaveLength(1)
    expect(statusLine(s.status)).toBe("Changed in another tab · Reload")
  })

  it("keeps an edit that failed to send, and sends it on the next flush", async () => {
    let fail = true
    const { s, calls } = saver(async (c, v) => {
      if (fail) throw new Error("offline")
      return ok(c, v)
    })
    s.change("a")
    await s.flush()
    expect(s.status.kind).toBe("error")
    fail = false
    await s.flush()
    expect(calls.map((c) => c.content)).toEqual(["a", "a"])
    expect(s.status).toEqual({ kind: "saved", version: 2 })
  })

  it("does nothing when nothing changed", async () => {
    const { s, calls } = saver(ok)
    await s.flush()
    expect(calls).toHaveLength(0)
    expect(statusLine(s.status)).toBe("Saved")
  })
})
