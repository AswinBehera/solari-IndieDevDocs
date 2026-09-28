import type { MeterId } from "@samsara/core"
import { BudgetGuard, MemoryCounterStore } from "@samsara/kernel"
import { definePrompt, fakeChatClient, LlmClient, type LlmConfig } from "@samsara/llm"
import { beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import {
  type CreatorEntity,
  type CreatorMention,
  creatorPack,
  creatorRepo,
} from "./__fixtures__/creator.js"
import { type DedupEntity, dedup } from "./dedup.js"
import { ENVELOPE_INSTRUCTIONS, extract, ITEMS_VARIABLE } from "./extract.js"
import {
  type MemoryClaim,
  MemoryEntityLinks,
  MemoryEvidence,
  MemoryMentionSink,
  MemoryResolutionCache,
} from "./memory.js"
import { type DomainPack, PackRegistry } from "./pack.js"
import type { ExtractItem, PendingMention } from "./ports.js"
import { resolve } from "./resolve.js"
import { type ScoreEntity, score } from "./score.js"

/**
 * P2.8's seam proof, or the half of it that can exist yet.
 *
 * The acceptance ADR-0009 actually asks for is a number, not a feeling: running a
 * second, non-travel pack through the pipeline must require **zero edits under
 * `packages/samsara/` other than adding the fixture**. Anything above zero means
 * the contract is shaped around the first vertical and should be revised now,
 * while there is one consumer, rather than in Phase 3 when there are three.
 *
 * This file is written to grow: P2.3, P2.4 and P2.5 each add a stage, and each
 * adds its assertions below rather than repeating this setup. That is deliberate
 * — P2.8 as a one-time run would prove the seam on the day it was run and never
 * again, which is the property a convention has and a check does not.
 *
 * Result for the extract stage: **zero edits.** The fixture compiled and ran
 * against the engine as it stood. See STATUS for the one bug the *first* pack
 * found, which is the counter-example that makes this result worth stating.
 *
 * Result for the resolve stage: **zero edits**, plus one addition to the fixture
 * (`creatorPack.resolve`), which is the thing P2.8 says is allowed. Worth
 * recording *what* was at risk, because it was not nothing: the resolve contract
 * was designed while looking straight at ADR-0017's tiers, and travel's tiers end
 * in a pair of coordinates. A `geo` field on `Resolution`, a lat/lng on the cache
 * row, a required `LookupPort` — each would have compiled, each would have been
 * an invisible assumption that every vertical resolves *places*. A creator
 * resolves to a channel URL, pays nobody, and has no Tier 2 at all. It runs.
 */

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

const llm = (chat: ReturnType<typeof fakeChatClient>) =>
  new LlmClient({
    chat,
    config,
    budget: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: CEILINGS }),
    sleep: async () => {},
  })

/** Refs are the engine's to mint, so the fake answers whatever it was handed. */
const refsIn = (user: string) => [...user.matchAll(/ref:\s*(\S+)/g)].map((m) => m[1] as string)

const creatorAnswer = (user: string) =>
  JSON.stringify({
    items: refsIn(user).map((ref) => ({
      ref,
      mentions: [
        {
          confidence: 0.8,
          mention: {
            handle: "@chi_hai_food",
            platform: "youtube",
            channelUrl: "https://example.invalid/c/chi-hai",
            postsPerWeek: 3,
            quote: "kênh này review rất thật",
          },
        },
      ],
    })),
  })

/** Two sources, so a `batchBy` on `sourceId` has something to separate. */
function corpus(): ExtractItem[] {
  return [
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `a${i}`,
      sourceId: "fake.search",
      url: `https://example.invalid/a/${i}`,
      title: `bài ${i}`,
      text: "Xem kênh này đi, review rất thật.",
      languageGuess: "vi",
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      id: `b${i}`,
      sourceId: "fake.forum",
      url: `https://example.invalid/b/${i}`,
      title: `chủ đề ${i}`,
      text: "Mình theo dõi kênh đó lâu rồi.",
      languageGuess: "vi",
    })),
  ]
}

describe("a second pack, over the same engine", () => {
  it("runs the extract stage with no engine change at all", async () => {
    const chat = fakeChatClient((req) => creatorAnswer(req.user))
    const sink = new MemoryMentionSink()

    const report = await extract({
      pack: creatorPack,
      llm: llm(chat),
      items: corpus(),
      sink,
      scope: { purpose: "refine" },
    })

    expect(report.invalid).toBe(0)
    expect(report.mentions).toBe(5)
    expect(sink.rows.every((row) => row.domainId === "creator")).toBe(true)
    // A numeric field and an enum survived the round trip. Travel's mentions are
    // all strings and nullable strings, so "the payload is strings" was exactly
    // the kind of assumption one pack could not have caught.
    expect(sink.rows[0]?.payload).toMatchObject({ platform: "youtube", postsPerWeek: 3 })
  })

  it("groups by whatever the pack said, which here is the source and not the language", async () => {
    // The sharp one. Section 8 motivates batching with "do not ask a model to read
    // Thai, English and Vietnamese in one breath", and a reader could conclude the
    // engine groups by language. It groups by `batchBy`. Every item here shares a
    // language and differs by source, so a language-grouping engine would send one
    // call and this pack would be silently mis-batched forever.
    const chat = fakeChatClient((req) => creatorAnswer(req.user))

    await extract({
      pack: creatorPack,
      llm: llm(chat),
      items: corpus(),
      sink: new MemoryMentionSink(),
      scope: { purpose: "refine" },
    })

    // Two calls is itself the proof: all five items share a language and the batch
    // size is 5, so an engine grouping by language would have sent exactly one.
    expect(chat.calls).toBe(2)

    // And the split is along the source, not merely into two of something. Refs
    // are engine-minted indices and carry no source, so this reads the `source:`
    // line `renderItem` writes into each item — which is also the reminder that
    // the item's URL is never sent to a provider at all.
    const from = (needle: string) =>
      chat.requests.filter((req) => req.user.includes(`source: ${needle}`))
    expect(from("fake.search")).toHaveLength(1)
    expect(from("fake.forum")).toHaveLength(1)
    expect(
      chat.requests.filter(
        (req) =>
          req.user.includes("source: fake.search") && req.user.includes("source: fake.forum"),
      ),
    ).toHaveLength(0)
    // Nothing rendered carries a URL, which is why the check above cannot use one.
    expect(chat.requests.every((req) => !req.user.includes("example.invalid"))).toBe(true)
  })

  it("keeps its own skip key, so two packs can read one corpus without hiding it from each other", async () => {
    // The property that only a second pack can demonstrate. `extractedIds` is
    // keyed on `(domainId, packVersion, rawItemId)`, so a corpus already read by
    // travel must still be unread as far as creator is concerned. Had the skip
    // been keyed on the item alone, the second vertical would have silently
    // extracted nothing and looked like a model that found no mentions.
    const sink = new MemoryMentionSink()
    const items = corpus()

    const first = await extract({
      pack: creatorPack,
      llm: llm(fakeChatClient((req) => creatorAnswer(req.user))),
      items,
      sink,
      scope: { purpose: "refine" },
    })
    expect(first.skipped).toBe(0)

    // Same items, same sink, a pack that differs only in id.
    const other: DomainPack<z.infer<typeof creatorPack.extract.mentionSchema>> = {
      ...creatorPack,
      id: "creator-two",
    }
    const second = await extract({
      pack: other,
      llm: llm(fakeChatClient((req) => creatorAnswer(req.user))),
      items,
      sink,
      scope: { purpose: "refine" },
    })

    expect(second.skipped).toBe(0)
    expect(second.mentions).toBe(5)

    // And the same pack twice *does* skip, which is what makes the above a
    // statement about the domain rather than about the skip being broken.
    const third = await extract({
      pack: creatorPack,
      llm: llm(fakeChatClient(() => "{}")),
      items,
      sink,
      scope: { purpose: "refine" },
    })
    expect(third.skipped).toBe(5)
    expect(third.sent).toBe(0)
  })
})

describe("the registry, holding two mention types at once", () => {
  it("takes packs whose mentions have nothing in common", () => {
    // `register` took a `DomainPack<never>` until the first real pack was
    // registered and could not be. This is the assertion that would have caught
    // it on the day it was written: two packs, two unrelated mention types, one
    // registry, no cast at either call site.
    const other: DomainPack<{ isbn: string }> = {
      id: "library",
      version: "1",
      extract: {
        mentionSchema: z.object({ isbn: z.string().min(1) }),
        prompt: definePrompt({
          id: "library/extract.mentions",
          version: "1",
          system: ENVELOPE_INSTRUCTIONS,
          template: `List the books.\n\n{{${ITEMS_VARIABLE}}}`,
        }),
        batchBy: () => "all",
      },
    }

    const registry = new PackRegistry()
    registry.register(creatorPack)
    registry.register(other)

    expect(registry.size).toBe(2)
    expect(registry.require("creator").version).toBe("1")
    expect(registry.require("library").extract.batchBy({} as ExtractItem)).toBe("all")
  })
})

/**
 * Mentions as the resolve stage reads them, built from what extract just wrote.
 *
 * A real run reads these back out of Postgres through `PendingMentionReader`;
 * here the two stages are wired directly, which is the point — the seam claim is
 * about the contract between pack and engine, not about the store.
 */
const pendingFrom = (sink: MemoryMentionSink, items: ExtractItem[]): PendingMention[] =>
  sink.rows.map((row) => {
    const item = items.find((candidate) => candidate.id === row.rawItemId)
    if (!item) throw new Error(`no item for mention ${row.id}`)
    return {
      id: row.id,
      rawItemId: row.rawItemId,
      domainId: row.domainId,
      packVersion: row.packVersion,
      payload: row.payload,
      item,
    }
  })

/** One mention, spelled however the caller likes, with no round trip through a model. */
const handled = (
  id: string,
  mention: Record<string, unknown>,
  item: ExtractItem,
): PendingMention => ({
  id,
  rawItemId: item.id,
  domainId: creatorPack.id,
  packVersion: creatorPack.version,
  payload: { quote: "kênh này review rất thật", ...mention },
  item,
})

describe("a second pack, resolving over the same engine", () => {
  beforeEach(() => {
    // The fixture's repo is a module singleton, so that a test can read back what
    // the stage wrote without the fixture having to hand one out per call.
    creatorRepo.entities.length = 0
  })

  it("runs the resolve stage with no engine change at all", async () => {
    const items = corpus()
    const sink = new MemoryMentionSink()
    await extract({
      pack: creatorPack,
      llm: llm(fakeChatClient((req) => creatorAnswer(req.user))),
      items,
      sink,
      scope: { purpose: "refine" },
    })

    const cache = new MemoryResolutionCache()
    const report = await resolve({ pack: creatorPack, mentions: pendingFrom(sink, items), cache })

    // Five mentions of one handle: the cache's arithmetic is not a travel fact.
    expect(report).toMatchObject({ mentions: 5, keys: 1, asked: 1, resolved: 1, entities: 1 })
    expect(report.tiers).toEqual([{ tier: 0, count: 1 }])
    expect(creatorRepo.entities[0]?.entity).toMatchObject({
      canonicalHandle: "chi_hai_food",
      channelUrl: "https://example.invalid/c/chi-hai",
    })
    // All five mentions point at the one entity, which is the saving.
    const pointed = new Set([...cache.mentions.values()].map((m) => m.entityId))
    expect(cache.mentions.size).toBe(5)
    expect(pointed).toEqual(new Set([creatorRepo.entities[0]?.id]))
  })

  it("completes without a LookupPort, because not every vertical buys its answers", async () => {
    // The sharp one for this stage. Travel's Tier 2 calls a metered geocoder, and
    // `LookupPort` exists so that meter cannot be bypassed — it would have been
    // natural to make it a required member of `ResolveCtx`. A creator pack has
    // nothing to buy. If `lookup` were required, every future vertical would have
    // had to invent a lookup service it does not use in order to resolve at all.
    const item = corpus()[0] as ExtractItem
    const cache = new MemoryResolutionCache()

    const report = await resolve({
      pack: creatorPack,
      mentions: [
        handled(
          "m1",
          { handle: "@bep_nha_minh", platform: "youtube", channelUrl: null, postsPerWeek: 2 },
          item,
        ),
      ],
      cache,
      // No `lookup`, deliberately.
    })

    expect(report).toMatchObject({ resolved: 1, deferred: 0 })
    expect(report.tiers).toEqual([{ tier: 1, count: 1 }])
  })

  it("keys on what the pack said, which here is a handle and a platform", async () => {
    // Four spellings and two platforms. A pack chooses its own normalisation, and
    // the engine has no opinion about what a key looks like — it compares strings.
    // The platform is part of creator's key because one handle on two platforms is
    // two creators; travel's key has no such component. Had the engine normalised
    // anything itself, that difference would be unrepresentable.
    const item = corpus()[0] as ExtractItem
    const cache = new MemoryResolutionCache()
    const spelling = (id: string, handle: string, platform: string) =>
      handled(id, { handle, platform, channelUrl: null, postsPerWeek: null }, item)

    const report = await resolve({
      pack: creatorPack,
      mentions: [
        spelling("m1", "@chi_hai_food", "youtube"),
        spelling("m2", "chi_hai_food", "youtube"),
        spelling("m3", "  @Chi_Hai_Food  ", "youtube"),
        spelling("m4", "@chi_hai_food", "tiktok"),
      ],
      cache,
    })

    expect(report).toMatchObject({ mentions: 4, keys: 2, asked: 2 })
    // And the two keys got genuinely different answers, so this is a statement
    // about the key and not about the resolver ignoring its input.
    expect(report.tiers).toEqual([
      { tier: 1, count: 1 },
      { tier: 3, count: 1 },
    ])
    expect(cache.mentions.get("m3")?.state).toBe("resolved")
    expect(cache.mentions.get("m4")?.state).toBe("unresolvable")
  })

  it("carries the pack's own tier numbers without interpreting them", async () => {
    // ADR-0017 numbers travel's tiers 0 to 3 and gives each a meaning. Creator's
    // tier 3 also means "we could not place this", but on a platform rather than a
    // map, and its tier 1 is a string template rather than a trigram search over an
    // OSM extract. `ResolveReport.tiers` is P2.3's acceptance criterion, so this
    // asserts the criterion is computed from what the pack returned — not from
    // anything the engine knows about geocoding, which it must not.
    const item = corpus()[0] as ExtractItem
    const cache = new MemoryResolutionCache()

    const report = await resolve({
      pack: creatorPack,
      mentions: [
        handled(
          "m1",
          {
            handle: "a",
            platform: "youtube",
            channelUrl: "https://example.invalid/c/a",
            postsPerWeek: null,
          },
          item,
        ),
        handled(
          "m2",
          { handle: "b", platform: "youtube", channelUrl: null, postsPerWeek: null },
          item,
        ),
        handled(
          "m3",
          { handle: "c", platform: "forum", channelUrl: null, postsPerWeek: null },
          item,
        ),
      ],
      cache,
    })

    expect(report.tiers).toEqual([
      { tier: 0, count: 1 },
      { tier: 1, count: 1 },
      { tier: 3, count: 1 },
    ])
    // The unresolvable one still got an entity written, per P2.3: a handle nobody
    // can place is visible, and absent is indistinguishable from never extracted.
    expect(report.unresolvable).toBe(1)
    expect(creatorRepo.entities).toHaveLength(3)
    expect(creatorRepo.entities[2]?.entity.channelUrl).toBeNull()
  })
})

/**
 * The same singleton repo the resolve block uses, reset the same way and with
 * its merge log cleared too — a merge count left over from a previous test is
 * the one assertion in this file that would be false in a way nothing else
 * catches.
 */
describe("a second pack, deduplicating over the same engine", () => {
  beforeEach(() => {
    creatorRepo.entities.length = 0
    creatorRepo.merges.length = 0
  })

  /** The stage takes a page of already-written entities; this is what the repo holds. */
  const stored = (): DedupEntity<CreatorEntity>[] =>
    creatorRepo.entities.map((row) => ({ id: row.id, entity: row.entity }))

  const write = async (...entities: CreatorEntity[]): Promise<void> => {
    for (const entity of entities) await creatorRepo.upsert(entity)
  }

  it("collapses duplicates on keys that have no geometry in them", async () => {
    // The sharp one for this stage. Travel's second key is a normalised name
    // inside a 150m radius, and a stage that walked keys strongest-first could
    // very easily have grown an opinion that the weak key is a *spatial* one — a
    // `near` on the key, a radius in the report, a distance in the match. A
    // creator has no coordinate to be near. Both of these keys are exact string
    // comparisons and the ordering between them is about identity, not precision.
    await write(
      {
        canonicalHandle: "chi_hai_food",
        platform: "youtube",
        channelUrl: "https://example.invalid/c/chi-hai",
        postsPerWeek: 3,
      },
      {
        canonicalHandle: "chi_hai_food_official",
        platform: "youtube",
        channelUrl: "https://example.invalid/c/chi-hai",
        postsPerWeek: null,
      },
    )
    const links = new MemoryEntityLinks()

    const report = await dedup({ pack: creatorPack, entities: stored(), links })

    expect(report).toMatchObject({ merged: 1 })
    expect(report.keys).toEqual([{ kind: "channelUrl", count: 1 }])
    expect(creatorRepo.entities).toHaveLength(1)
    // Two different handles collapsed on the channel they both point at, and the
    // survivor took the cadence the duplicate had. The fold is the pack's.
    expect(creatorRepo.entities[0]?.entity).toMatchObject({
      canonicalHandle: "chi_hai_food",
      postsPerWeek: 3,
    })
  })

  it("reports which of the pack's own keys did the work, without knowing what either means", async () => {
    // `DedupReport.keys` is this stage's counterpart of `ResolveReport.tiers`,
    // and the point is the same: it is computed entirely from what the pack
    // returned. These kinds are strings the creator fixture invented. Neither
    // appears anywhere in `@samsara/refine`, and the report still names them.
    await write(
      { canonicalHandle: "bep_nha_minh", platform: "tiktok", channelUrl: null, postsPerWeek: 2 },
      { canonicalHandle: "bep_nha_minh", platform: "tiktok", channelUrl: null, postsPerWeek: null },
    )
    const links = new MemoryEntityLinks()

    const report = await dedup({ pack: creatorPack, entities: stored(), links })

    expect(report.keys).toEqual([{ kind: "handle", count: 1 }])
  })

  it("keeps two packs' entities apart, because a merge is scoped to a domain", async () => {
    // The engine's side of a merge is `(domain_id, entity_id)`, and the domain
    // half is the reason a second vertical can share these tables at all. A
    // repoint that ignored it would move another pack's evidence onto this
    // pack's survivor, and nothing downstream could tell.
    await write(
      {
        canonicalHandle: "chi_hai_food",
        platform: "youtube",
        channelUrl: "https://example.invalid/c/chi-hai",
        postsPerWeek: null,
      },
      {
        canonicalHandle: "chi_hai_food",
        platform: "youtube",
        channelUrl: "https://example.invalid/c/chi-hai",
        postsPerWeek: null,
      },
    )
    const entities = stored()
    const links = new MemoryEntityLinks()
    const duplicate = entities[1]?.id ?? ""
    links.addEvidence("creator", duplicate)
    // Same entity id, different domain. Contrived on purpose: the ids are opaque
    // and nothing stops two packs minting the same one.
    links.addEvidence("library", duplicate)

    const report = await dedup({ pack: creatorPack, entities, links })

    expect(report.evidence).toBe(1)
    expect(links.evidence.find((row) => row.domainId === "library")?.entityId).toBe(duplicate)
  })

  it("does not require a pack to have a way of recognising anything", async () => {
    // `dedupKeys` returning an empty array is a real answer — an entity with
    // nothing to compare — and it has to be distinguishable from a miss, because
    // a rising count of them is a resolver problem surfacing in the wrong
    // stage's report. The creator pack always has a handle, so this asks it to
    // say nothing for one call.
    const keys = creatorPack.dedupKeys
    if (!keys) throw new Error("the fixture lost its dedup keys")
    const silent: DomainPack<CreatorMention, CreatorEntity> = {
      ...(creatorPack as DomainPack<CreatorMention, CreatorEntity>),
      dedupKeys: () => [],
    }
    await write(
      { canonicalHandle: "a", platform: "forum", channelUrl: null, postsPerWeek: null },
      { canonicalHandle: "a", platform: "forum", channelUrl: null, postsPerWeek: null },
    )

    const report = await dedup({ pack: silent, entities: stored(), links: new MemoryEntityLinks() })

    expect(report).toMatchObject({ examined: 2, keyless: 2, merged: 0 })
  })

  it("runs the whole pipeline end to end, and the count that comes out is the count of things", async () => {
    // Extract, resolve, dedup, over one corpus, with the engine untouched. Five
    // items all naming the same channel: five mentions, one resolve key, one
    // entity — and therefore nothing for dedup to do, which is the correct
    // answer and worth asserting. The resolve cache already collapses repeats of
    // one name; dedup exists for the pair that two *different* keys resolved to
    // two rows, which is not a thing one batch can produce.
    const sink = new MemoryMentionSink()
    const items = corpus()
    await extract({
      pack: creatorPack,
      llm: llm(fakeChatClient((req) => creatorAnswer(req.user))),
      items,
      sink,
      scope: { purpose: "refine" },
    })
    const cache = new MemoryResolutionCache()
    const resolved = await resolve({ pack: creatorPack, mentions: pendingFrom(sink, items), cache })
    expect(resolved).toMatchObject({ mentions: 5, keys: 1, entities: 1 })

    const links = new MemoryEntityLinks(cache)
    const report = await dedup({ pack: creatorPack, entities: stored(), links })

    expect(report).toMatchObject({ entities: 1, examined: 1, merged: 0, keyless: 0 })
  })
})

/**
 * P2.5, and the result is **zero edits under `packages/samsara/`** other than
 * the fixture gaining `creatorPack.score` — which is the addition P2.8 permits.
 *
 * Worth recording what was at risk, because the plan's own section 3 sketches
 * this member as `score(e, ev): ScoreSet`, one method per pack. Had it been
 * built that way, this file could assert almost nothing: every claim about
 * weighting, abstention and explanation would be a claim about code inside the
 * pack, and a second pack would prove only that a second pack can also return a
 * map. Because the engine owns the arithmetic, the two packs are demonstrably
 * running the *same* scorer.
 *
 * Three engine assumptions travel could have hidden, and this fixture does not:
 *
 * - **A factor that reads the entity and ignores the evidence.** All eight of
 *   travel's read the evidence. `postingCadence` reads `postsPerWeek` off the
 *   entity, so `measure`'s first argument is used by somebody.
 * - **A reading with no receipts.** That same factor has no particular row to
 *   point at, and an engine that required a non-empty `evidenceIds` — or that
 *   helpfully filled one in — would be attaching a reason to a row that did not
 *   supply it.
 * - **One score rather than two.** The first vertical names two, and a report or
 *   a writer shaped around a pair would look perfectly healthy against it.
 */
describe("a second pack, scoring over the same engine", () => {
  beforeEach(() => {
    creatorRepo.entities.length = 0
    creatorRepo.merges.length = 0
    creatorRepo.scores.clear()
  })

  const payload = (platform: CreatorMention["platform"] = "youtube"): CreatorMention => ({
    handle: "@chi_hai_food",
    platform,
    channelUrl: "https://example.invalid/c/chi-hai",
    postsPerWeek: 3,
    quote: "kênh này review rất thật",
  })

  const claim = (mentionId: string, over: Partial<MemoryClaim> = {}): MemoryClaim => ({
    mentionId,
    domainId: "creator",
    rawItemId: `r-${mentionId}`,
    sourceId: "fake.search",
    sourceUrl: `https://example.invalid/${mentionId}`,
    language: "vi",
    capturedAt: new Date("2026-02-01T00:00:00Z"),
    extract: payload(),
    engagement: { views: null, likes: null, comments: null },
    ...over,
  })

  /** Write an entity, attach evidence to it, and hand back the page. */
  const withEvidence = async (
    entity: CreatorEntity,
    claims: MemoryClaim[],
  ): Promise<{ id: string; page: ScoreEntity<CreatorEntity>[]; evidence: MemoryEvidence }> => {
    const cache = new MemoryResolutionCache()
    const id = await creatorRepo.upsert(entity)
    const evidence = new MemoryEvidence(cache)
    evidence.add(...claims)
    await cache.commit({
      domainId: "creator",
      key: entity.canonicalHandle,
      state: "resolved",
      entityId: id,
      tier: 0,
      confidence: 0.9,
      mentionIds: claims.map((c) => c.mentionId),
      deferred: false,
    })
    await evidence.record(
      "creator",
      claims.map((c) => c.mentionId),
    )
    return { id, page: [{ id, entity }], evidence }
  }

  it("weighs a pack's own factors without knowing what any of them mean", async () => {
    const { id, page, evidence } = await withEvidence(
      {
        canonicalHandle: "chi_hai_food",
        platform: "youtube",
        channelUrl: "https://example.invalid/c/chi-hai",
        // 3.5 of 7 is exactly half, so the arithmetic below is checkable by eye.
        postsPerWeek: 3.5,
      },
      [claim("m1"), claim("m2", { extract: payload("forum") })],
    )

    const report = await score({ pack: creatorPack, entities: page, evidence })

    expect(report).toMatchObject({ entities: 1, scored: 1, unevidenced: 0 })
    // 2·0.5 + 1·0.5 over 3. The engine did this, from numbers the pack supplied,
    // and the same code did travel's.
    expect(creatorRepo.scores.get(id)?.influence?.value).toBeCloseTo(0.5, 12)
    expect(Object.keys(creatorRepo.scores.get(id) ?? {})).toEqual(["influence"])
  })

  it("accepts a reading that points at no evidence at all", async () => {
    const { id, page, evidence } = await withEvidence(
      {
        canonicalHandle: "chi_hai_food",
        platform: "youtube",
        channelUrl: "https://example.invalid/c/chi-hai",
        postsPerWeek: 7,
      },
      [claim("m1")],
    )

    await score({ pack: creatorPack, entities: page, evidence })

    const because = creatorRepo.scores.get(id)?.influence?.because ?? []
    const cadence = because.find((e) => e.factor === "postingCadence")
    // Empty, and left empty. A factor reading the entity has no row to cite and
    // the engine must not invent one.
    expect(cadence?.evidenceIds).toEqual([])
    expect(cadence?.contribution).toBeGreaterThan(0)
  })

  it("drops a factor the pack could not measure, without punishing the entity", async () => {
    const { id, page, evidence } = await withEvidence(
      {
        canonicalHandle: "quan_com_tam",
        platform: "forum",
        channelUrl: null,
        // The common case: the source never said how often they post.
        postsPerWeek: null,
      },
      [claim("m1")],
    )

    const report = await score({ pack: creatorPack, entities: page, evidence })

    // `videoShare` alone, at full weight. Counting the abstention as a zero over
    // weight 2 would have made this 1/3 instead.
    expect(creatorRepo.scores.get(id)?.influence?.value).toBe(1)
    expect(report.scores[0]?.factors).toEqual([
      { name: "postingCadence", measured: 0, abstained: 1 },
      { name: "videoShare", measured: 1, abstained: 0 },
    ])
  })

  it("leaves an entity with no evidence unwritten", async () => {
    const id = await creatorRepo.upsert({
      canonicalHandle: "nobody",
      platform: "forum",
      channelUrl: null,
      postsPerWeek: 4,
    })

    const report = await score({
      pack: creatorPack,
      entities: [
        {
          id,
          entity: {
            canonicalHandle: "nobody",
            platform: "forum",
            channelUrl: null,
            postsPerWeek: 4,
          },
        },
      ],
      evidence: new MemoryEvidence(),
    })

    // `postingCadence` could have answered from the entity alone, and the stage
    // still writes nothing. Decision 3: a score over no corpus is not a score.
    expect(report).toMatchObject({ scored: 0, unevidenced: 1 })
    expect(creatorRepo.scores.has(id)).toBe(false)
  })

  it("runs all four stages end to end, and the score at the end has receipts", async () => {
    const sink = new MemoryMentionSink()
    const items = corpus()
    await extract({
      pack: creatorPack,
      llm: llm(fakeChatClient((req) => creatorAnswer(req.user))),
      items,
      sink,
      scope: { purpose: "refine" },
    })

    const cache = new MemoryResolutionCache()
    const mentions = pendingFrom(sink, items)
    const evidence = new MemoryEvidence(cache)
    for (const m of mentions) {
      evidence.add({
        mentionId: m.id,
        domainId: m.domainId,
        rawItemId: m.rawItemId,
        sourceId: m.item.sourceId,
        sourceUrl: m.item.url,
        language: m.item.languageGuess,
        capturedAt: new Date("2026-02-01T00:00:00Z"),
        extract: m.payload,
        engagement: { views: null, likes: null, comments: null },
      })
    }

    const resolved = await resolve({ pack: creatorPack, mentions, cache, evidence })
    expect(resolved).toMatchObject({ mentions: 5, keys: 1, entities: 1, evidence: 5 })

    const links = new MemoryEntityLinks(cache, evidence)
    const page = creatorRepo.entities.map((row) => ({ id: row.id, entity: row.entity }))
    await dedup({ pack: creatorPack, entities: page, links })
    const report = await score({ pack: creatorPack, entities: page, evidence })

    expect(report).toMatchObject({ entities: 1, scored: 1, unmeasurable: 0 })
    const written = creatorRepo.scores.get(page[0]?.id as string)
    // Five items, one channel, one score — and the reasons name the rows the
    // corpus actually produced rather than anything this test invented.
    expect(written?.influence?.because.find((e) => e.factor === "videoShare")?.evidenceIds).toEqual(
      evidence.rows.map((r) => r.id),
    )
  })
})
