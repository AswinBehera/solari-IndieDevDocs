import { definePrompt } from "@samsara/llm"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { ENVELOPE_INSTRUCTIONS, ITEMS_VARIABLE } from "./extract.js"
import { MemoryEntityRepo, MemoryEvidence } from "./memory.js"
import type { DomainPack, ScoreFactor } from "./pack.js"
import type { EvidenceRecord } from "./ports.js"
import { type ScoreEntity, score } from "./score.js"

/**
 * The score stage, over a pack that is neither travel nor the creator fixture.
 *
 * Boxes again, for the reason `dedup.test.ts` gives: the moment the fixture has
 * a localness score a reader starts checking whether the *judgement* is right,
 * and the stage has no judgement. What it has is arithmetic, a refusal, and two
 * counters, and those are what is tested here.
 *
 * The factors are therefore deliberately trivial — a constant, a share of a
 * list, a thing that always abstains — because every interesting property of
 * this stage is a property of what it does *with* a reading, not of the reading.
 */

interface Box {
  colour: string
}

const boxRepo = () => new MemoryEntityRepo<Box>()

/** A factor returning a fixed number, so weights can be checked by hand. */
const fixed = (name: string, weight: number, value: number, ids: string[] = []): ScoreFactor<Box> =>
  ({ name, weight, measure: () => ({ value, evidenceIds: ids }) }) satisfies ScoreFactor<Box>

const abstains = (name: string, weight = 1): ScoreFactor<Box> => ({
  name,
  weight,
  measure: () => null,
})

const packOf = (
  repo: MemoryEntityRepo<Box>,
  scores: Record<string, readonly ScoreFactor<Box>[]>,
): DomainPack<{ name: string }, Box> => ({
  id: "boxes",
  version: "1",
  extract: {
    mentionSchema: z.object({ name: z.string() }),
    prompt: definePrompt({
      id: "boxes/extract.mentions",
      version: "1",
      system: ENVELOPE_INSTRUCTIONS,
      template: `List boxes.\n\n{{${ITEMS_VARIABLE}}}`,
    }),
    batchBy: () => "all",
  },
  resolve: {
    entitySchema: z.object({ colour: z.string() }),
    repo,
    key: (m) => m.name,
    resolve: async () => ({ outcome: "unresolvable", tier: 3 }),
  },
  score: { scores },
})

const evidenceFor = (entityId: string, count: number): EvidenceRecord[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${entityId}-e${i + 1}`,
    entityId,
    rawItemId: `raw-${i + 1}`,
    sourceId: "fake.search",
    sourceUrl: "https://example.invalid/1",
    language: null,
    capturedAt: new Date("2026-01-01T00:00:00Z"),
    extract: {},
    engagement: { views: null, likes: null, comments: null },
  }))

/**
 * An `EvidenceStore` built straight from a map, so a test can say what an entity
 * has without going through the writer. The writer has its own tests.
 */
const storeOf = (byEntity: Record<string, EvidenceRecord[]>) => ({
  asked: [] as string[][],
  async forEntities(_domainId: string, entityIds: readonly string[]) {
    this.asked.push([...entityIds])
    const out = new Map<string, EvidenceRecord[]>()
    for (const id of entityIds) {
      const rows = byEntity[id]
      if (rows && rows.length > 0) out.set(id, rows)
    }
    return out
  },
})

const stored = async (repo: MemoryEntityRepo<Box>, ...boxes: Box[]) => {
  const out: ScoreEntity<Box>[] = []
  for (const entity of boxes) out.push({ id: await repo.upsert(entity), entity })
  return out
}

describe("score", () => {
  it("is the weighted mean of the factors, and the contributions sum to it", async () => {
    const repo = boxRepo()
    const [entity] = await stored(repo, { colour: "red" })
    const id = entity?.id as string
    const pack = packOf(repo, {
      // 3·1 + 1·0 over 4 is 0.75.
      quality: [fixed("always", 3, 1), fixed("never", 1, 0)],
    })

    const report = await score({
      pack,
      entities: [entity as ScoreEntity<Box>],
      evidence: storeOf({ [id]: evidenceFor(id, 2) }),
    })

    expect(report).toMatchObject({ entities: 1, scored: 1, unevidenced: 0, unmeasurable: 0 })
    const written = repo.scores.get(id)
    expect(written?.quality?.value).toBeCloseTo(0.75, 12)
    // The property the whole design rests on: `because` is the calculation, not
    // a description of it.
    const total = written?.quality?.because.reduce((sum, e) => sum + e.contribution, 0)
    expect(total).toBeCloseTo(written?.quality?.value as number, 12)
    expect(written?.quality?.because.map((e) => e.factor)).toEqual(["always", "never"])
  })

  it("leaves an abstaining factor out of the denominator rather than scoring it zero", async () => {
    const repo = boxRepo()
    const [entity] = await stored(repo, { colour: "red" })
    const id = entity?.id as string
    const pack = packOf(repo, {
      // Were the abstention counted as a zero over weight 9, this would be 0.1.
      quality: [fixed("measured", 1, 1), abstains("silent", 9)],
    })

    const report = await score({
      pack,
      entities: [entity as ScoreEntity<Box>],
      evidence: storeOf({ [id]: evidenceFor(id, 1) }),
    })

    expect(repo.scores.get(id)?.quality?.value).toBe(1)
    // And it is not in the explanation either: a factor that read nothing has
    // nothing to say about why the score came out as it did.
    expect(repo.scores.get(id)?.quality?.because.map((e) => e.factor)).toEqual(["measured"])
    expect(report.scores[0]?.factors).toEqual([
      { name: "measured", measured: 1, abstained: 0 },
      { name: "silent", measured: 0, abstained: 1 },
    ])
  })

  it("omits a score no factor could measure rather than writing a zero", async () => {
    const repo = boxRepo()
    const [entity] = await stored(repo, { colour: "red" })
    const id = entity?.id as string
    const pack = packOf(repo, {
      measurable: [fixed("always", 1, 0.5)],
      unmeasurable: [abstains("one"), abstains("two")],
    })

    await score({
      pack,
      entities: [entity as ScoreEntity<Box>],
      evidence: storeOf({ [id]: evidenceFor(id, 1) }),
    })

    const written = repo.scores.get(id)
    expect(Object.keys(written ?? {})).toEqual(["measurable"])
  })

  it("does not write anything for an entity with no evidence", async () => {
    const repo = boxRepo()
    const [with_, without] = await stored(repo, { colour: "red" }, { colour: "blue" })
    const pack = packOf(repo, { quality: [fixed("always", 1, 1)] })

    const report = await score({
      pack,
      entities: [with_ as ScoreEntity<Box>, without as ScoreEntity<Box>],
      evidence: storeOf({ [with_?.id as string]: evidenceFor(with_?.id as string, 1) }),
    })

    expect(report).toMatchObject({ entities: 2, scored: 1, unevidenced: 1 })
    // The point of decision 3: a zero with an empty `because` is indistinguishable
    // from a place that was measured and scored badly, so nothing is written.
    expect(repo.scores.has(without?.id as string)).toBe(false)
  })

  it("counts an entity that had evidence and still could not be measured", async () => {
    const repo = boxRepo()
    const [entity] = await stored(repo, { colour: "red" })
    const id = entity?.id as string
    const pack = packOf(repo, { quality: [abstains("silent")] })

    const report = await score({
      pack,
      entities: [entity as ScoreEntity<Box>],
      evidence: storeOf({ [id]: evidenceFor(id, 3) }),
    })

    // Separate from `unevidenced`, because they are fixed by different work: one
    // is a corpus with nothing in it, the other a corpus that does not carry
    // what this pack measures.
    expect(report).toMatchObject({ scored: 0, unevidenced: 0, unmeasurable: 1 })
    expect(repo.scores.size).toBe(0)
  })

  it("reads the whole page's evidence in one call", async () => {
    const repo = boxRepo()
    const entities = await stored(repo, { colour: "a" }, { colour: "b" }, { colour: "c" })
    const store = storeOf({})
    await score({ pack: packOf(repo, { quality: [fixed("f", 1, 1)] }), entities, evidence: store })

    expect(store.asked).toHaveLength(1)
    expect(store.asked[0]).toEqual(entities.map((e) => e.id))
  })

  it("carries the factor's evidence ids into the explanation, copied", async () => {
    const repo = boxRepo()
    const [entity] = await stored(repo, { colour: "red" })
    const id = entity?.id as string
    const ids = [`${id}-e1`]
    const pack = packOf(repo, { quality: [fixed("f", 1, 1, ids)] })

    await score({
      pack,
      entities: [entity as ScoreEntity<Box>],
      evidence: storeOf({ [id]: evidenceFor(id, 1) }),
    })

    const carried = repo.scores.get(id)?.quality?.because[0]?.evidenceIds
    expect(carried).toEqual(ids)
    // Copied rather than aliased: a pack handing back an array it still holds
    // must not be able to edit what was stored.
    expect(carried).not.toBe(ids)
  })

  it("refuses a factor whose value is outside [0,1], by name", async () => {
    const repo = boxRepo()
    const [entity] = await stored(repo, { colour: "red" })
    const id = entity?.id as string
    const pack = packOf(repo, { quality: [fixed("overconfident", 1, 1.4)] })

    // Refused rather than clamped. Clamping would keep the value in range while
    // making `because` lie — the contributions would no longer sum to it.
    await expect(
      score({
        pack,
        entities: [entity as ScoreEntity<Box>],
        evidence: storeOf({ [id]: evidenceFor(id, 1) }),
      }),
    ).rejects.toThrow(/overconfident/)
  })

  it("refuses a factor with a weight of zero, before reading anything", async () => {
    const repo = boxRepo()
    const store = storeOf({})
    await expect(
      score({
        pack: packOf(repo, { quality: [fixed("weightless", 0, 1)] }),
        entities: [],
        evidence: store,
      }),
    ).rejects.toThrow(/weightless/)
    // Before, not after: a spec that cannot produce a score should fail on the
    // spec rather than after a query against the largest table we have.
    expect(store.asked).toHaveLength(0)
  })

  it("refuses a pack with no score spec, by name", async () => {
    const repo = boxRepo()
    const pack = packOf(repo, { quality: [fixed("f", 1, 1)] })
    delete pack.score

    await expect(score({ pack, entities: [], evidence: storeOf({}) })).rejects.toThrow(
      /"boxes" has no score spec/,
    )
  })

  it("refuses a pack with no resolve spec, since there would be nothing to score", async () => {
    const repo = boxRepo()
    const pack = packOf(repo, { quality: [fixed("f", 1, 1)] })
    delete pack.resolve

    await expect(score({ pack, entities: [], evidence: storeOf({}) })).rejects.toThrow(
      /"boxes" has no resolve spec/,
    )
  })

  it("stops on an aborted signal and says the page is unfinished", async () => {
    const repo = boxRepo()
    const entities = await stored(repo, { colour: "a" }, { colour: "b" })
    const controller = new AbortController()
    controller.abort()

    const report = await score({
      pack: packOf(repo, { quality: [fixed("f", 1, 1)] }),
      entities,
      evidence: storeOf(Object.fromEntries(entities.map((e) => [e.id, evidenceFor(e.id, 1)]))),
      signal: controller.signal,
    })

    expect(report).toMatchObject({ entities: 2, scored: 0, cancelled: true })
    expect(repo.scores.size).toBe(0)
  })

  it("is idempotent over a page: a second run replaces rather than accumulates", async () => {
    const repo = boxRepo()
    const [entity] = await stored(repo, { colour: "red" })
    const id = entity?.id as string
    const evidence = storeOf({ [id]: evidenceFor(id, 1) })

    await score({
      pack: packOf(repo, { a: [fixed("f", 1, 1)] }),
      entities: [entity as ScoreEntity<Box>],
      evidence,
    })
    await score({
      pack: packOf(repo, { b: [fixed("g", 1, 0.5)] }),
      entities: [entity as ScoreEntity<Box>],
      evidence,
    })

    // The key the pack stopped computing is gone, rather than sitting beside the
    // new one at whatever it last was. See `EntityRepo.writeScores`.
    expect(Object.keys(repo.scores.get(id) ?? {})).toEqual(["b"])
  })

  it("scores over the evidence a writer actually materialised", async () => {
    // Not a fake map: the two P2.5 ports end to end, so that a change to the
    // writer's skip rules is visible here rather than only in Postgres.
    const repo = boxRepo()
    const [entity] = await stored(repo, { colour: "red" })
    const id = entity?.id as string

    const evidence = new MemoryEvidence(undefined)
    // With no cache the writer can see no entity for any mention, so nothing is
    // written — which is the rule, and leaves the entity unevidenced.
    evidence.add({
      mentionId: "m1",
      domainId: "boxes",
      rawItemId: "raw-1",
      sourceId: "fake.search",
      sourceUrl: "https://example.invalid/1",
      language: "th",
      capturedAt: new Date("2026-01-01T00:00:00Z"),
      extract: {},
      engagement: { views: null, likes: null, comments: null },
    })
    expect(await evidence.record("boxes", ["m1"])).toBe(0)

    const report = await score({
      pack: packOf(repo, { quality: [fixed("f", 1, 1)] }),
      entities: [entity as ScoreEntity<Box>],
      evidence,
    })

    expect(report).toMatchObject({ unevidenced: 1, scored: 0 })
    expect(id).toBeTruthy()
  })
})
