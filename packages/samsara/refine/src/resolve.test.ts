import { definePrompt } from "@samsara/llm"
import { beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { ENVELOPE_INSTRUCTIONS } from "./extract.js"
import { MemoryEntityRepo, MemoryEvidence, MemoryResolutionCache } from "./memory.js"
import type { DomainPack, Resolution, ResolveCtx } from "./pack.js"
import type { PendingMention } from "./ports.js"
import { DEFAULT_RESOLVE_ATTEMPTS, resolve } from "./resolve.js"

/**
 * The resolve stage (P2.3), against the in-memory cache and repo.
 *
 * The fixture is deliberately not about the first vertical — `atlas`, a pack
 * that finds Vietnamese street names — for the reason every engine test here is
 * written that way: a stage tested only against the pack it was written for
 * will grow that pack's assumptions and nobody will see it happen.
 *
 * What these tests can prove is the policy: what a key costs, what an attempt
 * costs, and which of the three outcomes is terminal. What they cannot prove is
 * that `commit` is atomic, because nothing here can be interrupted between two
 * statements — that is `refine.pg.test.ts` against a real database, and the
 * split is the same one `runner.test.ts` makes about `SKIP LOCKED`.
 */

const mentionSchema = z.object({ name: z.string().min(1), ward: z.string().min(1).nullable() })
type Mention = z.infer<typeof mentionSchema>

const entitySchema = z.object({
  canonical: z.string().min(1),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
})
type Entity = z.infer<typeof entitySchema>

const prompt = definePrompt({
  id: "atlas/extract",
  version: "1",
  system: `find things\n\n${ENVELOPE_INSTRUCTIONS}`,
  template: "read these:\n\n{{items}}",
})

let repo: MemoryEntityRepo<Entity>
let cache: MemoryResolutionCache
/** Every `resolve` call the pack saw, so a test can assert it was asked once. */
let asked: { mention: Mention; ctx: ResolveCtx }[]

beforeEach(() => {
  repo = new MemoryEntityRepo<Entity>()
  cache = new MemoryResolutionCache()
  asked = []
  seq = 0
})

/**
 * A pack whose resolver is whatever the test says.
 *
 * `key` lowercases and trims, which is the smallest thing that is recognisably
 * normalisation rather than identity — two mentions differing only in case must
 * collapse, or the grouping assertions below would pass on a stage that did not
 * group at all.
 */
const pack = (
  answer: (m: Mention, ctx: ResolveCtx) => Resolution<Entity> | Promise<Resolution<Entity>>,
  over: Partial<NonNullable<DomainPack<Mention, Entity>["resolve"]>> = {},
): DomainPack<Mention, Entity> => ({
  id: "atlas",
  version: "1",
  extract: { mentionSchema, prompt, batchBy: () => "all" },
  resolve: {
    entitySchema,
    repo,
    key: (m) => m.name.trim().toLowerCase(),
    resolve: async (m, ctx) => {
      asked.push({ mention: m, ctx })
      return answer(m, ctx)
    },
    ...over,
  },
})

let seq = 0
const mention = (name: string, over: Partial<PendingMention> = {}): PendingMention => {
  seq += 1
  return {
    id: `m${seq}`,
    rawItemId: `r${seq}`,
    domainId: "atlas",
    packVersion: "1",
    payload: { name, ward: null },
    item: {
      id: `r${seq}`,
      sourceId: "fake.search",
      url: `https://example.invalid/${seq}`,
      title: `bài ${seq}`,
      text: `Quán này ở ${name}.`,
      languageGuess: "vi",
    },
    ...over,
  }
}

const found = (canonical: string, tier = 0): Resolution<Entity> => ({
  outcome: "resolved",
  entity: { canonical, lat: 10.77, lng: 106.7 },
  tier,
  confidence: 0.9,
})

describe("the resolve stage", () => {
  it("resolves a mention, writes the entity, and points the mention at it", async () => {
    const report = await resolve({
      pack: pack((m) => found(m.name)),
      mentions: [mention("Chợ Bến Thành")],
      cache,
    })

    expect(report).toMatchObject({ mentions: 1, keys: 1, asked: 1, resolved: 1, entities: 1 })
    expect(repo.entities).toHaveLength(1)
    expect(cache.mentions.get("m1")).toMatchObject({
      state: "resolved",
      entityId: repo.entities[0]?.id,
    })
  })

  it("asks once for a name that appears many times, and points every mention at the one answer", async () => {
    // The arithmetic the cache exists for, and the reason the stage groups before
    // it asks. Six mentions, one name, one call — a stage that worked per mention
    // would multiply every tier's cost by how popular a name happens to be, and
    // the tier that would get multiplied is the metered one.
    const mentions = [
      mention("Chợ Bến Thành"),
      mention("chợ bến thành"),
      mention("  Chợ Bến Thành  "),
      mention("Chợ Bến Thành"),
      mention("chợ Bến Thành"),
      mention("CHỢ BẾN THÀNH"),
    ]

    const report = await resolve({ pack: pack((m) => found(m.name)), mentions, cache })

    expect(report.mentions).toBe(6)
    expect(report.keys).toBe(1)
    expect(report.asked).toBe(1)
    expect(asked).toHaveLength(1)
    // One entity, not six. Dedup is P2.4's job, but six rows for one *key* would
    // not be a dedup problem — it would be this stage failing to group.
    expect(repo.entities).toHaveLength(1)
    for (const m of mentions) {
      expect(cache.mentions.get(m.id)?.state).toBe("resolved")
    }
  })

  it("hands the resolver the artifact, because Tier 0 lives in it and not in the mention", async () => {
    // ADR-0017's primary path reads coordinates already present in the harvested
    // artifact — map links, captions — none of which any mention schema quotes.
    // A `ResolveCtx` without the item would leave a pack with no Tier 0 at all,
    // and P2.3's acceptance is a statement about how much Tier 0 carries.
    const m = mention("Bún Chả Hương Liên")
    await resolve({ pack: pack(() => found("x")), mentions: [m], cache })

    expect(asked[0]?.ctx.item.text).toBe(m.item.text)
    expect(asked[0]?.ctx.item.sourceId).toBe("fake.search")
  })

  it("does not ask again about a key it has already settled", async () => {
    const first = await resolve({
      pack: pack((m) => found(m.name)),
      mentions: [mention("Chợ Bến Thành")],
      cache,
    })
    expect(first.asked).toBe(1)

    // A later run, a new mention of the same name. The answer is already known.
    const later = mention("chợ bến thành")
    const second = await resolve({
      pack: pack(() => {
        throw new Error("the stage asked about a key it had already resolved")
      }),
      mentions: [later],
      cache,
    })

    expect(second.asked).toBe(0)
    expect(second.cached).toBe(1)
    // Still committed, because the mention itself is new and nothing had pointed
    // it anywhere. A cache hit that left the mention pending would be re-read by
    // every run forever.
    expect(cache.mentions.get(later.id)).toMatchObject({
      state: "resolved",
      entityId: repo.entities[0]?.id,
    })
    // And it cost no second entity.
    expect(repo.entities).toHaveLength(1)
  })

  it("records which tier answered, which is what the acceptance criterion reads", async () => {
    const tierOf: Record<string, number> = { a: 0, b: 0, c: 1, d: 2 }
    const report = await resolve({
      pack: pack((m) => found(m.name, tierOf[m.name] ?? 3)),
      mentions: [mention("a"), mention("b"), mention("c"), mention("d")],
      cache,
    })

    expect(report.tiers).toEqual([
      { tier: 0, count: 2 },
      { tier: 1, count: 1 },
      { tier: 2, count: 1 },
    ])
  })
})

describe("the three outcomes, and which of them is terminal", () => {
  it("writes an entity for an unresolvable mention, so the gap is visible", async () => {
    // P2.3's plan entry asks for this explicitly: an unresolved mention still
    // produces an entity, flagged. Absent is indistinguishable from never
    // extracted, and the screen whose job is to show what the resolver misses
    // would show nothing at all.
    const unplaceable = mention("quán không rõ")
    const report = await resolve({
      pack: pack(() => ({
        outcome: "unresolvable",
        entity: { canonical: "quán không rõ", lat: null, lng: null },
        tier: 3,
      })),
      mentions: [unplaceable],
      cache,
    })

    expect(report).toMatchObject({ unresolvable: 1, resolved: 0, entities: 1 })
    expect(repo.entities[0]?.entity.lat).toBeNull()
    expect(cache.mentions.get(unplaceable.id)?.state).toBe("unresolvable")
  })

  it("never asks again about an unresolvable key", async () => {
    await resolve({
      pack: pack(() => ({ outcome: "unresolvable", tier: 3 })),
      mentions: [mention("nowhere")],
      cache,
    })

    const second = await resolve({
      pack: pack(() => {
        throw new Error("the stage asked about a key it had written off")
      }),
      mentions: [mention("nowhere")],
      cache,
    })
    expect(second.cached).toBe(1)
    expect(second.asked).toBe(0)
  })

  it("leaves a deferred key pending and spends one attempt, not a verdict", async () => {
    // The sharp one, and the reason `Resolution` has three variants where two
    // would have compiled. A spent quota is a fact about a Tuesday, not about a
    // name. Taking the `unresolvable` branch here would mean the day a free
    // tier's daily quota runs out is the day every name still in the queue is
    // permanently written off — and `unresolvable` is terminal, so nothing would
    // ever ask again.
    const waiting = mention("Chợ Bến Thành")
    const report = await resolve({
      pack: pack(() => ({ outcome: "deferred", reason: "budget" })),
      mentions: [waiting],
      cache,
    })

    expect(report).toMatchObject({ deferred: 1, unresolvable: 0, resolved: 0, entities: 0 })
    expect(report.deferrals).toEqual([{ reason: "budget", count: 1 }])
    expect(cache.mentions.get(waiting.id)?.state).toBe("pending")

    // The cache row exists even though nothing was learned, which is what makes
    // the attempt count survive to the next run. Without it the key would be
    // attempted forever, one fresh row at a time.
    const row = (await cache.read("atlas", ["chợ bến thành"])).get("chợ bến thành")
    expect(row).toMatchObject({ state: "pending", attempts: 1 })
  })

  it("gives up after maxAttempts deferrals, and says it gave up rather than that it looked", async () => {
    const deferring = pack(() => ({ outcome: "deferred", reason: "provider" }))
    for (let i = 0; i < DEFAULT_RESOLVE_ATTEMPTS; i++) {
      const report = await resolve({ pack: deferring, mentions: [mention("flaky")], cache })
      expect(report.deferred).toBe(1)
      expect(report.exhausted).toBe(0)
    }

    // The attempt after the last one is not made at all.
    const lastTry = mention("flaky")
    const final = await resolve({
      pack: pack(() => {
        throw new Error("the stage asked after its attempts were spent")
      }),
      mentions: [lastTry],
      cache,
    })

    expect(final).toMatchObject({ asked: 0, exhausted: 1, unresolvable: 1 })
    expect(cache.mentions.get(lastTry.id)?.state).toBe("unresolvable")
    // Null tier, which is how a reader tells "we stopped trying" apart from a
    // tier-3 miss meaning "every tier was tried and none knew". Both stop the
    // work; only one is a statement about the entity.
    expect(final.tiers).toEqual([])
  })

  it("counts attempts once per key, not once per mention of it", async () => {
    // The whole reason the counter is on the key. Twelve mentions of one
    // unlookup-able name cost one attempt between them; on the mention this
    // would have burned the budget twelve times as fast, and it would have done
    // so in exact proportion to how popular the unlucky name was.
    const mentions = Array.from({ length: 12 }, () => mention("Chợ Bến Thành"))
    await resolve({
      pack: pack(() => ({ outcome: "deferred", reason: "budget" })),
      mentions,
      cache,
    })

    const row = (await cache.read("atlas", ["chợ bến thành"])).get("chợ bến thành")
    expect(row?.attempts).toBe(1)
    expect(asked).toHaveLength(1)
  })
})

describe("what the stage refuses to pass along", () => {
  it("skips a stored payload that no longer matches the pack's schema", async () => {
    // `payload` came back out of a jsonb column and a pack that has since
    // changed its `mentionSchema` has rows that no longer parse. Handing one to
    // a resolver means reading fields that are not there.
    const report = await resolve({
      pack: pack((m) => found(m.name)),
      mentions: [mention("ok"), mention("bad", { payload: { ward: 7 } })],
      cache,
    })

    expect(report.invalid).toBe(1)
    expect(report.keys).toBe(1)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.mention.name).toBe("ok")
  })

  it("refuses an entity that fails the pack's own schema, and leaves the key retryable", async () => {
    // The engine holds the pen on the pack's table, so it checks before writing.
    // Left pending rather than written off: a fixed resolver should get the key
    // back, not find it already given up on.
    const rejected = mention("Chợ Bến Thành")
    const report = await resolve({
      pack: pack(() => ({
        outcome: "resolved",
        entity: { canonical: "" } as Entity,
        tier: 1,
        confidence: 0.9,
      })),
      mentions: [rejected],
      cache,
    })

    expect(report).toMatchObject({ invalid: 1, resolved: 0, entities: 0, deferred: 1 })
    expect(repo.entities).toHaveLength(0)
    expect(cache.mentions.get(rejected.id)?.state).toBe("pending")
  })

  it("names the pack when it has no resolver at all", async () => {
    const { resolve: _dropped, ...withoutResolver } = pack(() => found("x"))
    await expect(
      resolve({ pack: withoutResolver, mentions: [mention("x")], cache }),
    ).rejects.toThrow(/"atlas" has no resolve spec/)
  })

  it("keeps two domains' answers apart under the same key", async () => {
    // `(domainId, key)` is a pair for a reason. Two packs may normalise to the
    // same string — "chợ bến thành" is a market to one vertical and a filming
    // location to another — and one answering for the other is the seam leaking
    // through a cache.
    await resolve({
      pack: pack(() => found("first")),
      mentions: [mention("Chợ Bến Thành")],
      cache,
    })

    const other = { ...pack(() => found("second")), id: "cartography" }
    const report = await resolve({
      pack: other,
      mentions: [mention("Chợ Bến Thành", { domainId: "cartography" })],
      cache,
    })

    expect(report.cached).toBe(0)
    expect(report.asked).toBe(1)
    expect(repo.entities.map((e) => e.entity.canonical)).toEqual(["first", "second"])
  })
})

/**
 * Evidence materialisation (P2.5), which happens here because here is the only
 * moment a mention has just acquired an entity id.
 *
 * These are about the *stage's* half of the contract — which mentions get handed
 * to the writer, and when — rather than about what a writer does with them. The
 * skip rules and the conflict are `MemoryEvidence`'s and, for real, the
 * `INSERT … SELECT`'s in `refine.pg.test.ts`.
 */
describe("the resolve stage, materialising evidence", () => {
  /** Claims for every mention the test is about to hand in. */
  const claimsFor = (evidence: MemoryEvidence, ...mentions: PendingMention[]): void => {
    for (const m of mentions) {
      evidence.add({
        mentionId: m.id,
        domainId: m.domainId,
        rawItemId: m.rawItemId,
        sourceId: m.item.sourceId,
        sourceUrl: m.item.url,
        language: m.item.languageGuess,
        capturedAt: new Date("2026-01-01T00:00:00Z"),
        extract: m.payload,
        engagement: { views: null, likes: null, comments: null },
      })
    }
  }

  it("writes nothing at all when the caller grants no writer", async () => {
    const report = await resolve({
      pack: pack((m) => found(m.name)),
      mentions: [mention("Chợ Bến Thành")],
      cache,
    })

    // The state the repository was in until P2.5, and the reason the score stage
    // had an empty table to read. Kept as a test because it is the default.
    expect(report.evidence).toBe(0)
  })

  it("records a row for every mention that ended up pointing at an entity", async () => {
    const evidence = new MemoryEvidence(cache)
    const ms = [mention("Chợ Bến Thành"), mention("chợ bến thành "), mention("Bún Chả")]
    claimsFor(evidence, ...ms)

    const report = await resolve({
      pack: pack((m) => found(m.name)),
      mentions: ms,
      cache,
      evidence,
    })

    // Two keys, three mentions, three evidence rows: the grain is a claim, not
    // an artifact and not a resolution.
    expect(report).toMatchObject({ keys: 2, resolved: 2, evidence: 3 })
    expect(evidence.rows.map((r) => r.mentionId).sort()).toEqual(["m1", "m2", "m3"])
  })

  it("records nothing for a mention nobody could resolve", async () => {
    const evidence = new MemoryEvidence(cache)
    const m = mention("Chợ Không Tên")
    claimsFor(evidence, m)

    const report = await resolve({
      pack: pack(() => ({ outcome: "unresolvable", tier: 3 })),
      mentions: [m],
      cache,
      evidence,
    })

    // No entity, so nothing for the row to be evidence *for*. A row pointing at
    // no entity would be counted by every factor and readable by none.
    expect(report).toMatchObject({ unresolvable: 1, evidence: 0 })
    expect(evidence.rows).toHaveLength(0)
  })

  it("records a mention whose key was answered from the cache without resolving", async () => {
    const evidence = new MemoryEvidence(cache)
    const first = mention("Chợ Bến Thành")
    claimsFor(evidence, first)
    await resolve({ pack: pack((m) => found(m.name)), mentions: [first], cache, evidence })

    // A second mention of the same name, weeks later. The pack is never asked —
    // and this mention has had no evidence written for it, so a list built from
    // the run's outcomes rather than from its commits would miss it entirely.
    const second = mention("chợ bến thành")
    claimsFor(evidence, second)
    const report = await resolve({
      pack: pack(() => {
        throw new Error("the pack must not be asked")
      }),
      mentions: [second],
      cache,
      evidence,
    })

    expect(report).toMatchObject({ cached: 1, asked: 0, evidence: 1 })
    expect(evidence.rows).toHaveLength(2)
    expect(evidence.rows[1]?.entityId).toBe(evidence.rows[0]?.entityId)
  })

  it("adds nothing the second time the same page is run", async () => {
    const evidence = new MemoryEvidence(cache)
    const ms = [mention("Chợ Bến Thành"), mention("Bún Chả")]
    claimsFor(evidence, ...ms)
    const opts = { pack: pack((m) => found(m.name)), mentions: ms, cache, evidence }

    const first = await resolve(opts)
    const second = await resolve(opts)

    // The idempotency that lets this be the last thing the stage does. A replay
    // reporting `evidence: 0` is the conflict working, not a failure — and it is
    // what stops a second runner doubling the corpus every score is computed on.
    expect(first.evidence).toBe(2)
    expect(second.evidence).toBe(0)
    expect(evidence.rows).toHaveLength(2)
  })
})
