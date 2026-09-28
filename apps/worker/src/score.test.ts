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
  type EntityPage,
  type EvidenceRecord,
  type EvidenceStore,
  ITEMS_VARIABLE,
  MemoryEntityRepo,
  PackRegistry,
} from "@samsara/refine"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { JobContext } from "./handlers.js"
import { createScoreHandler, scoreJobKey } from "./score.js"

/**
 * What this handler owns is the *paging*, and nothing else.
 *
 * `score()` decides what a weighted mean of abstaining factors is, and it is
 * tested where it lives. What is only testable here is the loop around it: that
 * the cursor is carried rather than restarted, that a page of entities and its
 * evidence are asked for once each, that the cap is reported rather than thrown,
 * and that a factor which never measured anything is named in the log. Every one
 * of those is a decision about a GitHub Actions job rather than about scoring.
 *
 * **Against a made-up pack**, for the reason `resolve.test.ts` gives: the one
 * line that knows a domain exists is `ctx.packs.require`, and running this
 * through the travel pack would make a domain-agnostic handler depend on the
 * vertical being compiled in.
 */

const mentionSchema = z.object({ name: z.string().min(1) })
type Mention = z.infer<typeof mentionSchema>

const entitySchema = z.object({ canonicalName: z.string().min(1), size: z.number() })
type Entity = z.infer<typeof entitySchema>

const CEILINGS: Record<MeterId, number> = {
  "solari.minutes": 4_000,
  "llm.input.tokens": 1_000_000,
  "llm.output.tokens": 200_000,
  "geocode.calls": 800,
}

const record = (entityId: string, i = 0): EvidenceRecord => ({
  id: `ev-${entityId}-${i}`,
  entityId,
  rawItemId: `r${i}`,
  sourceId: "fake.search",
  sourceUrl: `https://example.invalid/i/${i}`,
  language: "vi",
  capturedAt: new Date("2026-01-01T00:00:00Z"),
  extract: { name: `Quán ${i}` },
  engagement: { views: 100, likes: 10, comments: 1 },
})

/**
 * An evidence store that has a receipt for everything, and counts the asking.
 *
 * The count is the assertion: the stage promises one read per page and the
 * handler's only job is not to turn that into one read per entity.
 */
class FakeEvidence implements EvidenceStore {
  readonly asked: string[][] = []
  constructor(private readonly withEvidence: (id: string) => boolean = () => true) {}
  async forEntities(_domainId: string, entityIds: readonly string[]) {
    this.asked.push([...entityIds])
    const out = new Map<string, EvidenceRecord[]>()
    // Absent rather than empty for an entity with nothing, which is what the
    // port says and what makes `unevidenced` mean anything.
    for (const id of entityIds) if (this.withEvidence(id)) out.set(id, [record(id)])
    return out
  }
}

/** A repo that never runs out, for the one test about the page cap. */
class EndlessRepo extends MemoryEntityRepo<Entity> {
  pages = 0
  // Overridden because the base class refuses to score a row it never stored,
  // and this one mints its pages rather than holding them.
  override async writeScores(): Promise<void> {}
  override async page(_after: string | null, limit: number): Promise<EntityPage<Entity>> {
    this.pages++
    return {
      entities: Array.from({ length: limit }, (_, i) => ({
        id: `e${this.pages}-${i}`,
        entity: { canonicalName: `Quán ${i}`, size: 3 },
      })),
      cursor: `page-${this.pages}`,
    }
  }
}

function harness(
  behaviour: {
    entities?: number
    repo?: MemoryEntityRepo<Entity>
    withEvidence?: (id: string) => boolean
    registerPack?: boolean
    dropResolve?: boolean
    aborted?: boolean
  } = {},
) {
  const repo = behaviour.repo ?? new MemoryEntityRepo<Entity>()

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
      batchBy: () => "vi",
    },
    ...(behaviour.dropResolve
      ? {}
      : {
          resolve: {
            entitySchema,
            repo,
            key: (m: Mention) => m.name,
            // Never called: this handler reads the table, it does not fill it.
            resolve: async () => ({ outcome: "unresolvable" as const, tier: 3 }),
          },
        }),
    score: {
      scores: {
        // Measures whenever there is a row to read.
        busy: [
          {
            name: "size",
            weight: 2,
            measure: (entity: Entity, evidence: readonly EvidenceRecord[]) =>
              evidence.length === 0
                ? null
                : { value: Math.min(1, entity.size / 10), evidenceIds: evidence.map((e) => e.id) },
          },
        ],
        // Never measures anything, which is the line the log has to surface.
        quiet: [{ name: "noise", weight: 1, measure: () => null }],
      },
    },
  }

  const evidence = new FakeEvidence(behaviour.withEvidence)
  const handler = createScoreHandler({ evidence })

  const packs = new PackRegistry()
  if (behaviour.registerPack !== false) packs.register(pack)

  const logger: Logger = new MemoryLogger()
  const controller = new AbortController()
  if (behaviour.aborted) controller.abort()

  const notes: string[] = []
  const ctx = (payload: unknown): JobContext => ({
    job: { id: "j1", type: "refine.score", payload } as JobContext["job"],
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

  const fill = async (n: number) => {
    for (let i = 0; i < n; i++) await repo.upsert({ canonicalName: `Quán ${i}`, size: i % 10 })
  }

  return { handler, ctx, repo, evidence, notes, fill }
}

const PAYLOAD = { domainId: "atlas" }

describe("the payload, which anything holding the connection string can write", () => {
  it.each([
    ["no payload", undefined],
    ["an empty object", {}],
    ["a blank domain", { domainId: "   " }],
    ["a domain that is a number", { domainId: 7 }],
  ])("refuses %s before anything is read", async (_label, payload) => {
    const { handler, ctx, evidence } = harness()
    await expect(handler(ctx(payload))).rejects.toThrow(/domainId/)
    expect(evidence.asked).toHaveLength(0)
  })
})

describe("the score handler, over a registry it does not control", () => {
  it("refuses a domain nobody registered, naming it", async () => {
    const { handler, ctx } = harness({ registerPack: false })
    await expect(handler(ctx(PAYLOAD))).rejects.toThrow(/atlas/)
  })

  it("refuses a pack with no entity table to page, before reading evidence", async () => {
    const { handler, ctx, evidence } = harness({ dropResolve: true })
    await expect(handler(ctx(PAYLOAD))).rejects.toThrow(/resolve spec/)
    expect(evidence.asked).toHaveLength(0)
  })
})

describe("the score handler, paging a table that outlives one page", () => {
  it("carries the cursor forward instead of re-reading the first page", async () => {
    const { handler, ctx, repo, fill } = harness()
    await fill(120)
    await handler(ctx(PAYLOAD))
    // Every entity scored exactly once, which is only true if the cursor moved.
    expect(repo.scores.size).toBe(120)
  })

  it("reads each page's evidence in one call, not one per entity", async () => {
    const { handler, ctx, evidence, fill } = harness()
    await fill(120)
    await handler(ctx(PAYLOAD))
    // 50 + 50 + 20, and the short page ends it.
    expect(evidence.asked.map((ids) => ids.length)).toEqual([50, 50, 20])
  })

  it("stops on a short page without asking for another one", async () => {
    const { handler, ctx, evidence, fill } = harness()
    await fill(10)
    await handler(ctx(PAYLOAD))
    expect(evidence.asked).toHaveLength(1)
  })

  it("does nothing at all against an empty table", async () => {
    const { handler, ctx, evidence, notes } = harness()
    await handler(ctx(PAYLOAD))
    expect(evidence.asked).toHaveLength(0)
    expect(notes.join("\n")).toContain("0 scored of 0")
  })

  it("reads nothing when the signal is already aborted", async () => {
    const { handler, ctx, evidence, fill } = harness({ aborted: true })
    await fill(10)
    await handler(ctx(PAYLOAD))
    expect(evidence.asked).toHaveLength(0)
  })
})

describe("the score handler, reporting what a nightly run should show", () => {
  it("counts entities with no receipts apart from entities it scored", async () => {
    const { handler, ctx, repo, notes, fill } = harness({
      // Half the table has nothing to read.
      withEvidence: (id) => Number(id.split("-")[1]) % 2 === 0,
    })
    await fill(10)
    await handler(ctx(PAYLOAD))
    expect(repo.scores.size).toBe(5)
    expect(notes.join("\n")).toContain("5 scored of 10")
    expect(notes.join("\n")).toContain("5 unevidenced")
  })

  it("names each score and how many rows it was written to", async () => {
    const { handler, ctx, notes, fill } = harness()
    await fill(3)
    await handler(ctx(PAYLOAD))
    // `busy` measured on all three; `quiet` abstained everywhere, so it was
    // written to none — and a named zero beside a named three is the difference
    // between a score nobody computes and a score nobody asked for.
    expect(notes.join("\n")).toContain("busy×3")
    expect(notes.join("\n")).toContain("quiet×0")
  })

  it("names a factor that never measured anything, scoped to its score", async () => {
    const { handler, ctx, notes, fill } = harness()
    await fill(3)
    await handler(ctx(PAYLOAD))
    expect(notes.join("\n")).toContain("never measured quiet.noise×3")
  })

  it("does not call a factor silent when it measured somewhere", async () => {
    const { handler, ctx, notes, fill } = harness()
    await fill(3)
    await handler(ctx(PAYLOAD))
    expect(notes.join("\n")).not.toContain("busy.size")
  })

  it("reports the page cap rather than throwing, because a retry would hit it too", async () => {
    const repo = new EndlessRepo()
    const { handler, ctx, notes } = harness({ repo })
    await handler(ctx(PAYLOAD))
    expect(repo.pages).toBe(200)
    expect(notes.join("\n")).toContain("stopped at 200 pages")
  })
})

describe("the idempotency key", () => {
  it("windows the domain, so two nights are two jobs", () => {
    expect(scoreJobKey("atlas", "2026-09-20")).not.toBe(scoreJobKey("atlas", "2026-09-21"))
  })

  it("is stable for one domain and window, so a double enqueue is one job", () => {
    expect(scoreJobKey("atlas", "2026-09-20")).toBe(scoreJobKey("atlas", "2026-09-20"))
  })
})
