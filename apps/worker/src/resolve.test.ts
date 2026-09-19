import type { MeterId } from "@samsara/core"
import {
  BudgetGuard,
  Kernel,
  type Logger,
  MemoryCounterStore,
  MemoryLogger,
  MemorySessionStore,
  SessionRegistry,
} from "@samsara/kernel"
import { definePrompt } from "@samsara/llm"
import {
  type DomainPack,
  ENVELOPE_INSTRUCTIONS,
  ITEMS_VARIABLE,
  MENTION_LIST_LIMIT,
  MemoryEntityRepo,
  MemoryResolutionCache,
  PackRegistry,
  type PendingMention,
  type PendingMentionReader,
  type Resolution,
} from "@samsara/refine"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { JobContext } from "./handlers.js"
import { createResolveHandler, resolveJobKey } from "./resolve.js"

/**
 * What this handler owns is the *loop*, and nothing else.
 *
 * `resolve()` decides tiers, caches keys and writes entities, and it is tested
 * where it lives. What is only testable here is how many pages one job will
 * drain, when it stops, and what it does with a report that says nothing moved —
 * because every one of those is a decision about a GitHub Actions job's wall
 * clock rather than about resolution.
 *
 * **Against a made-up pack, not the travel one**, for the reason `refine.test.ts`
 * gives: `ctx.packs.require(payload.domainId)` is the only line that knows a
 * domain exists, so running this through `travelPack` would make a
 * domain-agnostic handler depend on the vertical being compiled in. `atlas` is
 * the engine's fixture domain and its strings are Vietnamese, so a test that
 * passes for the wrong reason cannot hide behind the language the first vertical
 * is actually about.
 */

const mentionSchema = z.object({ name: z.string().min(1) })
type Mention = z.infer<typeof mentionSchema>

const entitySchema = z.object({ canonicalName: z.string().min(1) })
type Entity = z.infer<typeof entitySchema>

const CEILINGS: Record<MeterId, number> = {
  "solari.minutes": 4_000,
  "llm.input.tokens": 1_000_000,
  "llm.output.tokens": 200_000,
  "geocode.calls": 800,
}

/** One page of pending mentions, all distinct keys so none is answered from cache. */
const page = (from: number, count: number): PendingMention[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${from + i}`,
    rawItemId: `r${from + i}`,
    domainId: "atlas",
    packVersion: "3",
    payload: { name: `Quán ${from + i}` },
    item: {
      id: `r${from + i}`,
      sourceId: "fake.search",
      url: `https://example.invalid/i/${from + i}`,
      title: null,
      text: "Hôm qua đi ăn ở District 1, ngon lắm.",
      languageGuess: "vi",
    },
  }))

/**
 * A queue that hands out the pages it was given and then runs dry.
 *
 * Deliberately *not* modelling "a resolved mention leaves the pending set": the
 * handler's loop must not depend on that, and a fake that enforced it would hide
 * the case this file most needs — a page that comes back unchanged because every
 * key on it deferred.
 */
class FakeQueue implements PendingMentionReader {
  calls = 0
  constructor(private readonly pages: PendingMention[][]) {}
  async pending(_domainId: string, _limit?: number): Promise<PendingMention[]> {
    return this.pages[this.calls++] ?? []
  }
}

function harness(
  behaviour: {
    pages?: PendingMention[][]
    resolution?: (m: Mention) => Resolution<Entity>
    registerPack?: boolean
    aborted?: boolean
  } = {},
) {
  const repo = new MemoryEntityRepo<Entity>()
  const asked: string[] = []

  const pack: DomainPack<Mention, Entity> = {
    id: "atlas",
    version: "3",
    extract: {
      mentionSchema,
      prompt: definePrompt({
        id: "atlas/extract.test",
        version: "3",
        system: ENVELOPE_INSTRUCTIONS,
        template: `Read these.\n\n{{${ITEMS_VARIABLE}}}`,
      }),
      batchBy: (item) => item.languageGuess ?? "unknown",
    },
    resolve: {
      entitySchema,
      repo,
      key: (m) => m.name,
      resolve: async (m) => {
        asked.push(m.name)
        return (
          behaviour.resolution?.(m) ?? {
            outcome: "resolved",
            entity: { canonicalName: m.name },
            tier: 0,
            confidence: 0.9,
          }
        )
      },
    },
  }

  const queue = new FakeQueue(behaviour.pages ?? [page(0, 3)])
  const handler = createResolveHandler({ pending: queue, cache: new MemoryResolutionCache() })

  const packs = new PackRegistry()
  if (behaviour.registerPack !== false) packs.register(pack)

  const logger: Logger = new MemoryLogger()
  const controller = new AbortController()
  if (behaviour.aborted) controller.abort()

  const notes: string[] = []
  const ctx = (payload: unknown): JobContext => ({
    job: { id: "j1", type: "refine.resolve", payload } as JobContext["job"],
    kernel: new Kernel({
      registry: new SessionRegistry(new MemorySessionStore(), logger),
      guard: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS }),
      logger,
    }),
    packs,
    logger,
    signal: controller.signal,
    async heartbeat(note?: string) {
      if (note) notes.push(note)
    },
  })

  return { handler, ctx, queue, repo, asked, notes }
}

const PAYLOAD = { domainId: "atlas" }

describe("the payload, which anything holding the connection string can write", () => {
  it.each([
    ["no payload", undefined],
    ["an empty object", {}],
    ["a blank domain", { domainId: "   " }],
    ["a domain that is a number", { domainId: 7 }],
  ])("refuses %s before anything is read", async (_label, payload) => {
    const { handler, ctx, queue } = harness()
    await expect(handler(ctx(payload))).rejects.toThrow(/domainId/)
    // Not merely that it threw: that it threw *first*. A validation error after
    // the queue has been read is a validation error that already cost a query.
    expect(queue.calls).toBe(0)
  })

  it("refuses a domain nobody registered, by name", async () => {
    const { handler, ctx } = harness({ registerPack: false })
    await expect(handler(ctx(PAYLOAD))).rejects.toThrow(/atlas/)
  })
})

describe("how much one job drains", () => {
  it("works through a full page and then a short one", async () => {
    const { handler, ctx, queue, repo } = harness({
      pages: [page(0, MENTION_LIST_LIMIT), page(MENTION_LIST_LIMIT, 4)],
    })
    await handler(ctx(PAYLOAD))

    expect(queue.calls).toBe(2)
    expect(repo.entities).toHaveLength(MENTION_LIST_LIMIT + 4)
  })

  it("stops on a short page without asking for another", async () => {
    // The end of the queue. A further read would be a query whose answer is
    // already known, once per job, forever.
    const { handler, ctx, queue } = harness({ pages: [page(0, 3)] })
    await handler(ctx(PAYLOAD))
    expect(queue.calls).toBe(1)
  })

  it("stops at its page ceiling rather than draining a long backlog in one job", async () => {
    const pages = Array.from({ length: 20 }, (_, i) =>
      page(i * MENTION_LIST_LIMIT, MENTION_LIST_LIMIT),
    )
    const { handler, ctx, queue } = harness({ pages })
    await handler(ctx(PAYLOAD))

    // Five pages, and then it returns cleanly. A backlog longer than one job is
    // an ordinary queue, not a failure — the next run reads a shorter one.
    expect(queue.calls).toBe(5)
  })

  it("stops when a page moved nothing, instead of re-reading it", async () => {
    // **The reason the loop has a second exit condition.** `pending()` is
    // oldest-first and a deferred key stays pending, so a spent geocoder quota
    // returns the same hundred rows every time. Without this the job would spend
    // its whole wall clock discovering one refusal five times over.
    const pages = Array.from({ length: 5 }, () => page(0, MENTION_LIST_LIMIT))
    const { handler, ctx, queue, asked } = harness({
      pages,
      resolution: () => ({ outcome: "deferred", reason: "budget" }),
    })
    await handler(ctx(PAYLOAD))

    expect(queue.calls).toBe(1)
    expect(asked).toHaveLength(MENTION_LIST_LIMIT)
  })

  it("reads nothing at all once the signal is aborted", async () => {
    const { handler, ctx, queue } = harness({ aborted: true })
    await handler(ctx(PAYLOAD))
    expect(queue.calls).toBe(0)
  })
})

describe("what it does with the report", () => {
  it("succeeds on a page that deferred, rather than failing the job", async () => {
    // The opposite of `refine.extract`, and the difference is what `deferred`
    // means. A deferred key is already recorded as pending with its attempts
    // incremented, so the next run picks it up whether this job passed or
    // failed. Throwing would retry a page to re-learn a refusal already written
    // down, and turn a spent monthly quota into a red build until it reset.
    const { handler, ctx, notes } = harness({
      resolution: () => ({ outcome: "deferred", reason: "budget" }),
    })
    await expect(handler(ctx(PAYLOAD))).resolves.toBeUndefined()
    expect(notes.join(" ")).toContain("budget")
  })

  it("reports which tier answered, because that is P2.3's acceptance criterion", async () => {
    const { handler, ctx, notes } = harness({
      pages: [page(0, 2)],
      resolution: (m) => ({
        outcome: "resolved",
        entity: { canonicalName: m.name },
        tier: m.name.endsWith("0") ? 0 : 2,
        confidence: 0.9,
      }),
    })
    await handler(ctx(PAYLOAD))

    const summary = notes.join(" ")
    expect(summary).toContain("t0×1")
    expect(summary).toContain("t2×1")
  })

  it("logs counts and no harvested text, because the Actions log is public", async () => {
    const { handler, ctx, notes } = harness({ pages: [page(0, 2)] })
    await handler(ctx(PAYLOAD))

    // ADR-0014. The item text and the mention names are both in the fixture; a
    // log line carrying either is a log line that could carry anything.
    for (const note of notes) {
      expect(note).not.toContain("District 1")
      expect(note).not.toContain("Quán")
    }
  })
})

describe("the idempotency key", () => {
  it("takes a window, because a permanent unique index collides against successes", () => {
    // `refine.resolve:atlas` alone would mean a domain can be resolved exactly
    // once ever, which for a job that exists to drain a refilling queue is the
    // wrong shape entirely.
    expect(resolveJobKey("atlas", "2026-W38")).not.toBe(resolveJobKey("atlas", "2026-W39"))
    expect(resolveJobKey("atlas", "2026-W38")).toBe(resolveJobKey("atlas", "2026-W38"))
  })
})
