import { describe, expect, it } from "vitest"
import type { JobContext } from "./handlers.js"
import { createPersonaSweepHandler, keepaliveAfterMs } from "./persona-sweep.js"

const NOW = new Date("2026-09-29T00:00:00Z")
const H = 3_600_000

describe("keepaliveAfterMs", () => {
  it("is 36 to 72 hours and stable per persona", () => {
    for (const id of ["a", "b", "0f3c-77", "the local"]) {
      const ms = keepaliveAfterMs(id)
      expect(ms).toBeGreaterThanOrEqual(36 * H)
      expect(ms).toBeLessThanOrEqual(72 * H)
      expect(keepaliveAfterMs(id)).toBe(ms)
    }
  })
})

describe("persona.sweep", () => {
  it("queues a keepalive only for personas idle past their own window", async () => {
    const window = keepaliveAfterMs("stale")
    const personas = [
      { id: "stale", lastAliveAt: new Date(NOW.getTime() - window - H) },
      { id: "fresh", lastAliveAt: new Date(NOW.getTime() - H) },
      { id: "never", lastAliveAt: null },
    ]
    const keys: string[] = []
    const queue = {
      async enqueue(i: { idempotencyKey?: string | null }) {
        keys.push(i.idempotencyKey ?? "")
        return { id: "j", deduped: false }
      },
    }
    const h = createPersonaSweepHandler({
      personas: { list: async () => personas as never },
      queue,
      clock: () => NOW,
    })
    await h({ job: { payload: {} }, async heartbeat() {} } as unknown as JobContext)
    expect(keys).toEqual([
      "persona.keepalive:stale:2026-09-29",
      "persona.keepalive:never:2026-09-29",
    ])
  })
})
