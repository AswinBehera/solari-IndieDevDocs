import { MemoryProbeTargetStore } from "@samsara/probe"
import { describe, expect, it } from "vitest"
import type { JobContext } from "./handlers.js"
import { createProbeSweepHandler } from "./probe-sweep.js"

describe("probe.sweep", () => {
  it("queues one probe per watched target per day, capped, and only watched ones", async () => {
    const targets = new MemoryProbeTargetStore()
    for (const n of [1, 2, 3]) {
      const t = await targets.upsert({
        ownerId: "o",
        sourceId: "price.stay",
        url: `https://x.invalid/${n}`,
        parsed: {},
      })
      if (n !== 3) await targets.setWatch("o", t.id, true)
    }
    const seen = new Set<string>()
    const enq: { key: string | null | undefined; payload: unknown }[] = []
    const queue = {
      async enqueue(i: { idempotencyKey?: string | null; payload?: unknown }) {
        const dup = i.idempotencyKey ? seen.has(i.idempotencyKey) : false
        if (i.idempotencyKey) seen.add(i.idempotencyKey)
        enq.push({ key: i.idempotencyKey, payload: i.payload })
        return { id: "j", deduped: dup }
      },
    }
    const notes: string[] = []
    const h = createProbeSweepHandler({
      targets,
      queue,
      maxTargets: 1,
      clock: () => new Date("2026-09-29T00:00:00Z"),
    })
    const ctx = {
      job: { payload: {} },
      async heartbeat(n?: string) {
        if (n) notes.push(n)
      },
    } as unknown as JobContext
    await h(ctx)
    expect(enq).toHaveLength(1)
    expect(enq[0]?.key).toMatch(/^probe\.run:target-1:2026-09-29$/)
    await h(ctx)
    expect(notes.at(-1)).toContain("0 probe(s) queued")
  })
})
