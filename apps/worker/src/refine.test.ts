import type { MeterId } from "@samsara/core"
import {
  type HarvestRunStart,
  MemoryHarvestRunStore,
  MemoryRawItemStore,
  type RawItemRow,
} from "@samsara/harvest"
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
import {
  definePrompt,
  type FakeReply,
  fakeChatClient,
  LlmClient,
  type LlmConfig,
} from "@samsara/llm"
import {
  type DomainPack,
  ENVELOPE_INSTRUCTIONS,
  ITEMS_VARIABLE,
  MemoryEntityRepo,
  MemoryMentionSink,
  PackRegistry,
} from "@samsara/refine"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { JobContext } from "./handlers.js"
import { createRefineHandler } from "./refine.js"
import { resolveJobKey } from "./resolve.js"

/**
 * What this handler owns, which is again smaller than it looks: validate a
 * payload anything with the connection string can write, refuse the four
 * situations in which spending on a model would produce a run that lies about
 * itself, and hand the rest to `extract()`. The extraction is tested where it
 * lives; every test below is one of the refusals, or the one path through.
 *
 * **Against a made-up pack, not the travel one.** The handler is the generic
 * half — `ctx.packs.require(payload.domainId)` is the only thing that knows a
 * domain exists — so testing it through `travelPack` would assert the travel
 * pack's prompt on the way past and quietly make a domain-agnostic handler
 * depend on the vertical being present. `atlas` is the engine's fixture domain
 * for exactly this, and its items are Vietnamese: not the language the first
 * vertical is about, so a test that passes for the wrong reason cannot hide.
 */

const mentionSchema = z.object({
  name: z.string().min(1),
  quote: z.string().min(1),
})

const pack: DomainPack<z.infer<typeof mentionSchema>> = {
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
}

/** The same pack, able to resolve: the only kind the extract job hands on. */
const resolvable: DomainPack<z.infer<typeof mentionSchema>, { canonicalName: string }> = {
  ...pack,
  resolve: {
    entitySchema: z.object({ canonicalName: z.string() }),
    repo: new MemoryEntityRepo(),
    key: (m) => m.name,
    resolve: async () => ({ outcome: "unresolvable", tier: 3 }),
  },
}

class FakeJobs {
  readonly enqueued: EnqueueInput[] = []
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    this.enqueued.push(input)
    return { id: `job-${this.enqueued.length}`, deduped: false }
  }
}

const CEILINGS: Record<MeterId, number> = {
  "solari.minutes": 4_000,
  "llm.input.tokens": 1_000_000,
  "llm.output.tokens": 200_000,
  "geocode.calls": 800,
}

const config: LlmConfig = {
  apiKey: "test-key",
  baseUrl: "https://example.invalid/v1",
  models: { extract: "vendor/cheap" },
  format: "schema",
}

/** One envelope entry per ref, each with one mention. The shape the engine asks for. */
const answers = (refs: readonly string[]) =>
  JSON.stringify({
    items: refs.map((ref) => ({
      ref,
      mentions: [{ confidence: 0.9, mention: { name: "Quán Bà Tư", quote: "ngon lắm, giá rẻ" } }],
    })),
  })

const RUN_ID = "run-1"

function run(over: Partial<HarvestRunStart & { itemCount: number }> = {}) {
  return {
    id: RUN_ID,
    domainId: "atlas",
    personaId: "p1",
    sourceId: "fake.search",
    query: "xin chào thế giới",
    sessionId: "s1",
    startedAt: new Date("2026-09-12T00:00:00Z"),
    experiment: null,
    ...over,
  }
}

function item(rank: number): RawItemRow {
  return {
    id: `r${rank}`,
    harvestRunId: RUN_ID,
    sourceId: "fake.search",
    rank,
    url: `https://example.invalid/i/${rank}`,
    title: `bài ${rank}`,
    text: "Hôm qua đi ăn ở District 1, ngon lắm.",
    languageGuess: "vi",
    mediaRefs: [],
    engagement: null,
    capturedAt: new Date("2026-09-12T00:00:00Z"),
    rawRef: `captures/${RUN_ID}/${rank}.json`,
  }
}

async function harness(
  behaviour: {
    script?: readonly FakeReply[] | ((...args: never[]) => never)
    items?: number
    /** What the run *claims*, when the test wants it to disagree with the store. */
    itemCount?: number
    runDomainId?: string
    withoutLlm?: boolean
    registerPack?: boolean
    resolvable?: boolean
    jobs?: FakeJobs
  } = {},
) {
  const logger: Logger = new MemoryLogger()
  const chat = fakeChatClient(
    (behaviour.script ?? ((_req, _call) => answers(["1"]))) as Parameters<typeof fakeChatClient>[0],
  )

  const runs = new MemoryHarvestRunStore()
  const items = new MemoryRawItemStore()
  const sink = new MemoryMentionSink()

  const count = behaviour.items ?? 0
  await runs.start(run(behaviour.runDomainId ? { domainId: behaviour.runDomainId } : {}))
  await runs.finish(RUN_ID, "ok", behaviour.itemCount ?? count, new Date("2026-09-12T00:01:00Z"))
  if (count > 0) {
    await items.insertMany(Array.from({ length: count }, (_, i) => item(i)))
  }

  const llm = new LlmClient({
    chat,
    config,
    budget: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS }),
    // Retries are policy tested in `@samsara/llm`. Here they must not cost wall clock.
    sleep: async () => {},
  })

  const handler = createRefineHandler({
    runs,
    items,
    sink,
    ...(behaviour.withoutLlm ? {} : { llm }),
    ...(behaviour.jobs ? { queue: behaviour.jobs } : {}),
  })

  const packs = new PackRegistry()
  if (behaviour.registerPack !== false) packs.register(behaviour.resolvable ? resolvable : pack)

  const notes: string[] = []
  const ctx = (payload: unknown): JobContext => ({
    job: { id: "j1", type: "refine.extract", payload } as JobContext["job"],
    kernel: new Kernel({
      registry: new SessionRegistry(new MemorySessionStore(), logger),
      guard: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS }),
      logger,
    }),
    packs,
    logger,
    signal: new AbortController().signal,
    async heartbeat(note?: string) {
      if (note) notes.push(note)
    },
  })

  return { handler, ctx, runs, items, sink, chat, notes }
}

const PAYLOAD = { domainId: "atlas", harvestRunId: RUN_ID }

describe("the payload, which anything holding the connection string can write", () => {
  it.each([
    ["no payload", undefined, "domainId"],
    ["an empty object", {}, "domainId"],
    ["a blank domain", { ...PAYLOAD, domainId: "  " }, "domainId"],
    ["a missing run id", { domainId: "atlas" }, "harvestRunId"],
    ["a run id that is a number", { ...PAYLOAD, harvestRunId: 7 }, "harvestRunId"],
  ])("refuses %s by naming the field", async (_case, payload, field) => {
    const h = await harness({ items: 1 })
    await expect(h.handler(h.ctx(payload))).rejects.toThrow(field)
    // The point of validating first: nothing was asked of a paid provider.
    expect(h.chat.calls).toBe(0)
  })
})

describe("the four refusals", () => {
  it("fails by name without a key, rather than not claiming the job", async () => {
    const h = await harness({ items: 1, withoutLlm: true })
    await expect(h.handler(h.ctx(PAYLOAD))).rejects.toThrow(/OPENROUTER_API_KEY/)
  })

  it("names the registered packs when the runner shipped without the one asked for", async () => {
    const h = await harness({ items: 1, registerPack: false })
    await expect(h.handler(h.ctx(PAYLOAD))).rejects.toThrow(/no domain pack registered/)
  })

  it("refuses a run that does not exist", async () => {
    const h = await harness({ items: 1 })
    await expect(h.handler(h.ctx({ ...PAYLOAD, harvestRunId: "run-nope" }))).rejects.toThrow(
      /no such harvest run/,
    )
    expect(h.chat.calls).toBe(0)
  })

  it("refuses a run belonging to another domain, and says which", async () => {
    // Extracting under the wrong pack writes rows that look extracted: the skip is
    // keyed on (domain, version), so re-running would report them as already done
    // and the mistake would be uncorrectable by the obvious remedy.
    const h = await harness({ items: 1, runDomainId: "orbit" })
    await expect(h.handler(h.ctx(PAYLOAD))).rejects.toThrow(/belongs to domain orbit, not atlas/)
    expect(h.chat.calls).toBe(0)
    expect(h.sink.rows).toHaveLength(0)
  })

  it("refuses a run larger than the read bound instead of extracting the first hundred", async () => {
    // The dangerous half is not the truncation, it is that the truncation looks
    // like success afterwards. Refusing is what leaves the remainder reachable.
    const h = await harness({ items: 2, itemCount: 140 })
    await expect(h.handler(h.ctx(PAYLOAD))).rejects.toThrow(/cannot cover this run/)
    expect(h.chat.calls).toBe(0)
  })
})

describe("a run with nothing in it", () => {
  it("returns without spending a call to discover it is empty", async () => {
    // A blocked harvest, which is an ordinary outcome and not this job's failure.
    const h = await harness({ items: 0 })
    await expect(h.handler(h.ctx(PAYLOAD))).resolves.toBeUndefined()
    expect(h.chat.calls).toBe(0)
    expect(h.notes.join(" ")).toContain("no items to extract")
  })
})

describe("the path through", () => {
  it("writes the run's items as mentions, stamped with the pack that read them", async () => {
    const h = await harness({
      items: 2,
      script: ((req: { user: string }) => {
        // Refs are the engine's, so the fake answers whatever it was handed rather
        // than a list this test computed — see `fake.ts` on why that is the rule.
        const refs = [...req.user.matchAll(/ref:\s*(\S+)/g)].map((m) => m[1] as string)
        return answers(refs)
      }) as never,
    })

    await h.handler(h.ctx(PAYLOAD))

    expect(h.sink.rows).toHaveLength(2)
    expect(h.sink.rows.every((row) => row.domainId === "atlas")).toBe(true)
    expect(h.sink.rows.every((row) => row.packVersion === "3")).toBe(true)
    expect(h.sink.rows.map((row) => row.rawItemId).sort()).toEqual(["r0", "r1"])
    expect(h.sink.rows[0]?.payload).toMatchObject({ name: "Quán Bà Tư" })
  })

  it("reports counts and nothing that was read, because the log is public", async () => {
    const h = await harness({
      items: 2,
      script: ((req: { user: string }) =>
        answers([...req.user.matchAll(/ref:\s*(\S+)/g)].map((m) => m[1] as string))) as never,
    })

    await h.handler(h.ctx(PAYLOAD))

    const note = h.notes.at(-1) ?? ""
    expect(note).toContain("2 mentions from 2 items")
    // ADR-0014: the quote is in the database, never in the Actions log.
    expect(note).not.toContain("ngon lắm")
    expect(note).not.toContain("Quán Bà Tư")
  })

  it("costs nothing the second time, because the sink already holds the answers", async () => {
    const script = ((req: { user: string }) =>
      answers([...req.user.matchAll(/ref:\s*(\S+)/g)].map((m) => m[1] as string))) as never
    const h = await harness({ items: 2, script })

    await h.handler(h.ctx(PAYLOAD))
    const first = h.chat.calls
    await h.handler(h.ctx(PAYLOAD))

    expect(h.chat.calls).toBe(first)
    expect(h.sink.rows).toHaveLength(2)
    expect(h.notes.at(-1)).toContain("2 already done")
  })
})

describe("what the job hands on", () => {
  const echo = ((req: { user: string }) =>
    answers([...req.user.matchAll(/ref:\s*(\S+)/g)].map((m) => m[1] as string))) as never

  it("queues the domain's resolve, keyed on its own job id", async () => {
    const jobs = new FakeJobs()
    const h = await harness({ items: 2, script: echo, resolvable: true, jobs })
    await h.handler(h.ctx(PAYLOAD))
    expect(jobs.enqueued).toEqual([
      {
        type: "refine.resolve",
        domainId: "atlas",
        idempotencyKey: resolveJobKey("atlas", "j1"),
        payload: { domainId: "atlas" },
      },
    ])
  })

  it("queues nothing for a pack that cannot resolve", async () => {
    const jobs = new FakeJobs()
    const h = await harness({ items: 2, script: echo, jobs })
    await h.handler(h.ctx(PAYLOAD))
    expect(jobs.enqueued).toHaveLength(0)
  })

  it("queues nothing for an empty run", async () => {
    const jobs = new FakeJobs()
    const h = await harness({ items: 0, resolvable: true, jobs })
    await h.handler(h.ctx(PAYLOAD))
    expect(jobs.enqueued).toHaveLength(0)
  })

  it("queues nothing when the extraction was partial, so the retry goes first", async () => {
    const jobs = new FakeJobs()
    const h = await harness({
      items: 1,
      resolvable: true,
      jobs,
      script: (() => ({ throws: new Error("provider fell over") })) as never,
    })
    await expect(h.handler(h.ctx(PAYLOAD))).rejects.toThrow(/unextracted/)
    expect(jobs.enqueued).toHaveLength(0)
  })
})

describe("a partial extraction", () => {
  it("fails the job rather than leaving the run looking finished", async () => {
    // `extract()` returns an ordinary-looking report when calls fail; the bake-off
    // lost a measurement to exactly that. Throwing is what puts the items back in
    // reach of a retry.
    const h = await harness({
      items: 1,
      script: (() => ({ throws: new Error("provider fell over") })) as never,
    })

    await expect(h.handler(h.ctx(PAYLOAD))).rejects.toThrow(/left 1 items unextracted/)
    expect(h.sink.rows).toHaveLength(0)
  })
})
