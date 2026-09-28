import type { MeterId } from "@samsara/core"
import {
  BudgetGuard,
  type EnqueueInput,
  type EnqueueResult,
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
  ITEMS_VARIABLE,
  MemoryEntityLinks,
  MemoryEntityRepo,
  PackRegistry,
} from "@samsara/refine"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { Queue } from "./chain.js"
import { createDedupHandler, dedupJobKey } from "./dedup.js"
import type { JobContext } from "./handlers.js"
import { scoreJobKey } from "./score.js"

/**
 * What this handler owns is the walk: paging, the set of ids it has passed, the
 * cap, cancellation, and the link to the score job. Which rows are duplicates
 * and which way a merge goes are the stage's, and are tested where it lives —
 * except for the one place the two meet, which is the first describe below.
 *
 * **Against a made-up pack**, for the reason `resolve.test.ts` gives.
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

/** One key, the name: two entities with one name are one entity. */
const NAME = "name"
const sameName = () =>
  new MemoryEntityRepo<Entity>({
    matches: (key, entity) => key.kind === NAME && entity.canonicalName === key.value,
  })

class FakeQueue implements Queue {
  readonly enqueued: EnqueueInput[] = []
  constructor(private readonly fail = false) {}
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    if (this.fail) throw new TypeError("connection refused")
    this.enqueued.push(input)
    return { id: `job-${this.enqueued.length}`, deduped: false }
  }
}

/** A repo that never runs out, for the one test about the page cap. */
class EndlessRepo extends MemoryEntityRepo<Entity> {
  pages = 0
  override async page(_after: string | null, limit: number): Promise<EntityPage<Entity>> {
    this.pages++
    return {
      entities: Array.from({ length: limit }, (_, i) => ({
        id: `e${this.pages}-${i}`,
        entity: { canonicalName: `Quán ${this.pages}-${i}` },
      })),
      cursor: `page-${this.pages}`,
    }
  }
}

function harness(
  behaviour: {
    repo?: MemoryEntityRepo<Entity>
    registerPack?: boolean
    dropResolve?: boolean
    dropKeys?: boolean
    dropScore?: boolean
    aborted?: boolean
    queue?: Queue | null
  } = {},
) {
  const repo = behaviour.repo ?? sameName()

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
            resolve: async () => ({ outcome: "unresolvable" as const, tier: 3 }),
          },
        }),
    ...(behaviour.dropKeys
      ? {}
      : { dedupKeys: (e: Entity) => [{ kind: NAME, value: e.canonicalName }] }),
    ...(behaviour.dropScore ? {} : { score: { scores: { busy: [] } } }),
  }

  const links = new MemoryEntityLinks()
  const queue = behaviour.queue === null ? undefined : (behaviour.queue ?? new FakeQueue())
  const handler = createDedupHandler({ links, ...(queue ? { queue } : {}) })

  const packs = new PackRegistry()
  if (behaviour.registerPack !== false) packs.register(pack)

  const logger: Logger = new MemoryLogger()
  const controller = new AbortController()
  if (behaviour.aborted) controller.abort()

  const notes: string[] = []
  const ctx = (payload: unknown): JobContext => ({
    job: { id: "j7", type: "refine.dedup", payload } as JobContext["job"],
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

  /** Names in mint order, so ids are `entity-1` … `entity-n`. */
  const fill = async (names: string[]) => {
    for (const canonicalName of names) await repo.upsert({ canonicalName })
  }

  return { handler, ctx, repo, links, queue, notes, fill }
}

const PAYLOAD = { domainId: "atlas" }
/**
 * `n` names, none a prefix of another, so a matcher that compares prefixes
 * cannot find a duplicate among them that nobody planted.
 */
const distinct = (n: number) =>
  Array.from({ length: n }, (_, i) => `Quán ${String(i).padStart(3, "0")}`)

describe("the payload, which anything holding the connection string can write", () => {
  it.each([
    ["no payload", undefined],
    ["an empty object", {}],
    ["a blank domain", { domainId: "   " }],
    ["a domain that is a number", { domainId: 7 }],
  ])("refuses %s before anything is read", async (_label, payload) => {
    const { handler, ctx, repo } = harness()
    await expect(handler(ctx(payload))).rejects.toThrow(/domainId/)
    expect(repo.merges).toHaveLength(0)
  })
})

describe("the dedup handler, over a registry it does not control", () => {
  it("refuses a domain nobody registered, naming it", async () => {
    const { handler, ctx } = harness({ registerPack: false })
    await expect(handler(ctx(PAYLOAD))).rejects.toThrow(/atlas/)
  })

  it("refuses a pack with no entity table, before reading a page", async () => {
    const repo = new EndlessRepo()
    const { handler, ctx } = harness({ repo, dropResolve: true })
    await expect(handler(ctx(PAYLOAD))).rejects.toThrow(/resolve spec/)
    expect(repo.pages).toBe(0)
  })

  it("refuses a pack with no keys, before reading a page", async () => {
    const repo = new EndlessRepo()
    const { handler, ctx } = harness({ repo, dropKeys: true })
    await expect(handler(ctx(PAYLOAD))).rejects.toThrow(/dedupKeys/)
    expect(repo.pages).toBe(0)
  })
})

describe("the dedup handler, walking a table longer than a page", () => {
  it("keeps the older row when its duplicate is two pages later", async () => {
    // The case this handler had to pass `earlier` for. Row 1 and row 250 share
    // a name; page one reaches row 1 first, and the only thing that stops the
    // stage treating row 250 as older is being told it has not been walked yet.
    const { handler, ctx, repo, fill } = harness()
    await fill(["Quán Ốc", ...distinct(248), "Quán Ốc"])

    await handler(ctx(PAYLOAD))

    expect(repo.merges).toEqual([{ into: "entity-1", from: "entity-250" }])
  })

  it("keeps the older row when the newer one is the one that asks", async () => {
    // Entity 1 carries no key here, so only entity 150 can find it — and the
    // row it finds is one the walk has already passed, which makes it older.
    const repo = new MemoryEntityRepo<Entity>({
      matches: (key, entity) =>
        key.kind === NAME && entity.canonicalName.startsWith(`${key.value}`),
    })
    const { handler, ctx, fill } = harness({ repo })
    await fill(["Quán Ốc Oanh", ...distinct(148), "Quán Ốc"])

    await handler(ctx(PAYLOAD))

    expect(repo.merges).toEqual([{ into: "entity-1", from: "entity-150" }])
  })

  it("examines every row once and reports the merge in counts", async () => {
    const { handler, ctx, notes, fill } = harness()
    await fill([...distinct(150), "Quán 003"])

    await handler(ctx(PAYLOAD))

    const log = notes.join("\n")
    // 151 rows, one merged away before its own page came: 150 walked.
    expect(log).toContain("atlas: 1 merged of 150")
    expect(log).toContain("2 pages")
    expect(log).toContain(`[${NAME}×1]`)
  })

  it("does nothing at all against an empty table, and still hands on", async () => {
    const { handler, ctx, notes, queue } = harness()
    await handler(ctx(PAYLOAD))
    expect(notes.join("\n")).toContain("0 merged of 0")
    expect((queue as FakeQueue).enqueued).toHaveLength(1)
  })

  it("reports the page cap rather than throwing, because a retry would hit it too", async () => {
    const repo = new EndlessRepo()
    const { handler, ctx, notes } = harness({ repo })
    await handler(ctx(PAYLOAD))
    expect(repo.pages).toBe(100)
    expect(notes.join("\n")).toContain("stopped at 100 pages")
  })
})

describe("the dedup handler, cut off by the runner", () => {
  it("throws rather than returning, so the runner releases it instead of marking it done", async () => {
    const { handler, ctx, repo, queue, fill } = harness({ aborted: true })
    await fill(["Quán Ốc", "Quán Ốc"])

    await expect(handler(ctx(PAYLOAD))).rejects.toThrow(/cancelled/)

    expect(repo.merges).toHaveLength(0)
    // And the score is not queued behind a walk that did not finish.
    expect((queue as FakeQueue).enqueued).toHaveLength(0)
  })
})

describe("the dedup handler, handing the table to the score stage", () => {
  it("queues refine.score keyed on its own job id", async () => {
    const { handler, ctx, queue, fill } = harness()
    await fill(distinct(3))
    await handler(ctx(PAYLOAD))
    expect((queue as FakeQueue).enqueued).toEqual([
      {
        type: "refine.score",
        domainId: "atlas",
        idempotencyKey: scoreJobKey("atlas", "j7"),
        payload: { domainId: "atlas" },
      },
    ])
  })

  it("queues nothing for a pack that declares no score", async () => {
    const { handler, ctx, queue, fill } = harness({ dropScore: true })
    await fill(distinct(3))
    await handler(ctx(PAYLOAD))
    expect((queue as FakeQueue).enqueued).toHaveLength(0)
  })

  it("runs without a queue, which is how a test or a one-off tool calls it", async () => {
    const { handler, ctx, repo, fill } = harness({ queue: null })
    await fill(["Quán Ốc", "Quán Ốc"])
    await handler(ctx(PAYLOAD))
    expect(repo.merges).toHaveLength(1)
  })

  it("does not fail the job when the queue refuses, and says so by class", async () => {
    const { handler, ctx, notes, repo, fill } = harness({ queue: new FakeQueue(true) })
    await fill(["Quán Ốc", "Quán Ốc"])

    await expect(handler(ctx(PAYLOAD))).resolves.toBeUndefined()

    expect(repo.merges).toHaveLength(1)
    const log = notes.join("\n")
    expect(log).toContain("could not queue refine.score (TypeError)")
    expect(log).not.toContain("connection refused")
  })
})

describe("the idempotency key", () => {
  it("windows the domain, so two upstream jobs are two dedup jobs", () => {
    expect(dedupJobKey("atlas", "j1")).not.toBe(dedupJobKey("atlas", "j2"))
  })

  it("is stable for one domain and window, so a retried upstream job queues one", () => {
    expect(dedupJobKey("atlas", "j1")).toBe(dedupJobKey("atlas", "j1"))
  })
})
