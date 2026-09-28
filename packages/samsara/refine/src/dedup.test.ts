import { definePrompt } from "@samsara/llm"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { type DedupEntity, dedup } from "./dedup.js"
import { ENVELOPE_INSTRUCTIONS, ITEMS_VARIABLE } from "./extract.js"
import { MemoryEntityLinks, MemoryEntityRepo, MemoryResolutionCache } from "./memory.js"
import type { DedupKey, DedupMatch, DomainPack, EntityRepo } from "./pack.js"

/**
 * The dedup stage, over a pack that is not travel and is not the creator fixture
 * either.
 *
 * A third shape on purpose. The creator pack belongs to `seam.test.ts`, whose
 * question is "does a second vertical run unchanged"; this file's question is
 * "does the stage keep its own promises", and answering it needs a repo that can
 * be made to misbehave — one that returns a match the port forbids, one that
 * tombstones instead of deleting, one that hands back a cycle. None of those are
 * things a pack fixture should be able to do.
 *
 * Entities here are boxes with a colour and a serial number, because the moment
 * the fixture has names and coordinates a reader starts checking the *dedup
 * decisions* rather than the *stage's* behaviour, and the stage is the thing with
 * no opinion about either.
 */

interface Box {
  colour: string
  serial: string | null
}

const box = z.object({ colour: z.string(), serial: z.string().nullable() })

const SERIAL = "serial"
const COLOUR = "colour"

/** Serial first: it identifies one box. Colour second: it groups many. */
const boxKeys = (entity: Box): DedupKey[] => {
  const keys: DedupKey[] = []
  if (entity.serial !== null) keys.push({ kind: SERIAL, value: entity.serial })
  keys.push({ kind: COLOUR, value: entity.colour })
  return keys
}

const boxRepo = () =>
  new MemoryEntityRepo<Box>({
    matches: (key, entity) =>
      key.kind === SERIAL ? entity.serial === key.value : entity.colour === key.value,
    fold: (into, from) => ({ ...into, serial: into.serial ?? from.serial }),
  })

const packOf = (repo: EntityRepo<Box>): DomainPack<{ name: string }, Box> => ({
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
    entitySchema: box,
    repo,
    key: (m) => m.name,
    resolve: async () => ({ outcome: "unresolvable", tier: 3 }),
  },
  dedupKeys: boxKeys,
})

/** Write entities through the repo and hand back what the stage is given. */
const stored = async (repo: MemoryEntityRepo<Box>, ...boxes: Box[]) => {
  const out: DedupEntity<Box>[] = []
  for (const entity of boxes) out.push({ id: await repo.upsert(entity), entity })
  return out
}

describe("dedup", () => {
  it("merges the newcomer into the row that was already there", async () => {
    const repo = boxRepo()
    const links = new MemoryEntityLinks()
    const entities = await stored(
      repo,
      { colour: "red", serial: "A1" },
      { colour: "red", serial: "A1" },
    )
    const [first, second] = entities as [DedupEntity<Box>, DedupEntity<Box>]

    const report = await dedup({ pack: packOf(repo), entities, links })

    expect(report).toMatchObject({ entities: 2, examined: 1, merged: 1, skipped: 1 })
    // The direction, not just the count. The survivor is the older row because
    // it is the one other things have had time to point at.
    expect(repo.merges).toEqual([{ into: first.id, from: second.id }])
    expect(repo.entities.map((row) => row.id)).toEqual([first.id])
  })

  it("moves every engine pointer before the pack's table loses the row", async () => {
    // The stage's central promise, and the one that cannot be recovered from if
    // it is broken: evidence is the only thing in the pipeline that was paid for
    // with a browser session, and the engine's reference into a pack's table is
    // opaque, so nothing would ever notice it dangling.
    const repo = boxRepo()
    const cache = new MemoryResolutionCache()
    const links = new MemoryEntityLinks(cache)
    const entities = await stored(
      repo,
      { colour: "red", serial: "A1" },
      { colour: "red", serial: "A1" },
    )
    const [first, second] = entities as [DedupEntity<Box>, DedupEntity<Box>]

    links.addEvidence("boxes", second.id)
    links.addEvidence("boxes", second.id)
    links.addEvidence("boxes", first.id)
    await cache.commit({
      domainId: "boxes",
      key: "a-one",
      mentionIds: ["m1", "m2"],
      state: "resolved",
      entityId: second.id,
      tier: 1,
      confidence: 0.8,
      deferred: false,
    })

    const report = await dedup({ pack: packOf(repo), entities, links })

    expect(report).toMatchObject({ merged: 1, evidence: 2, mentions: 2, resolutions: 1 })
    // Nothing points at the deleted row, and nothing was dropped on the way.
    expect(links.evidence.every((row) => row.entityId === first.id)).toBe(true)
    expect(links.evidence).toHaveLength(3)
    expect(cache.rows.get("boxes")?.get("a-one")?.entityId).toBe(first.id)
  })

  it("asks the strongest key first and reports which one answered", async () => {
    // Two boxes that agree on colour and on serial. Both keys would match, and
    // the report has to say the strong one did — this is the number the stage is
    // read for, and a run where the weak key does the work is a run to look at.
    const repo = boxRepo()
    const links = new MemoryEntityLinks()
    const entities = await stored(
      repo,
      { colour: "red", serial: "A1" },
      { colour: "red", serial: "A1" },
    )

    const report = await dedup({ pack: packOf(repo), entities, links })

    expect(report.keys).toEqual([{ kind: SERIAL, count: 1 }])
  })

  it("falls through to the weaker key when the stronger one has nothing to say", async () => {
    const repo = boxRepo()
    const links = new MemoryEntityLinks()
    const entities = await stored(
      repo,
      { colour: "red", serial: null },
      { colour: "red", serial: null },
    )

    const report = await dedup({ pack: packOf(repo), entities, links })

    expect(report.keys).toEqual([{ kind: COLOUR, count: 1 }])
    expect(report.merged).toBe(1)
  })

  it("does not report an entity as a duplicate of itself", async () => {
    // Every entity is already in the table when this stage runs — that is what
    // makes `exclude` part of the port rather than a convenience. One entity, one
    // row, no merge.
    const repo = boxRepo()
    const links = new MemoryEntityLinks()
    const entities = await stored(repo, { colour: "red", serial: "A1" })

    const report = await dedup({ pack: packOf(repo), entities, links })

    expect(report).toMatchObject({ examined: 1, merged: 0 })
    expect(repo.merges).toEqual([])
  })

  it("counts an entity with no keys apart from one that was looked for and missed", async () => {
    const repo = new MemoryEntityRepo<Box>({ matches: () => true })
    const links = new MemoryEntityLinks()
    const pack = packOf(repo)
    pack.dedupKeys = () => []
    const entities = await stored(
      repo,
      { colour: "red", serial: "A1" },
      { colour: "blue", serial: null },
    )

    const report = await dedup({ pack, entities, links })

    // `matches` returns true for everything, so a single key would have merged
    // these. Nothing was asked, because there was nothing to ask with.
    expect(report).toMatchObject({ examined: 2, keyless: 2, merged: 0 })
  })

  it("skips an entity a previous merge in the same run already took", async () => {
    // Three of one thing. The second merges into the first; the third then finds
    // the first, not the second — and the second is never examined on its own,
    // because it no longer exists.
    const repo = boxRepo()
    const links = new MemoryEntityLinks()
    const entities = await stored(
      repo,
      { colour: "red", serial: "A1" },
      { colour: "red", serial: "A1" },
      { colour: "red", serial: "A1" },
    )
    const [first] = entities as [DedupEntity<Box>]

    const report = await dedup({ pack: packOf(repo), entities, links })

    // Two merges and one skip: the first entity absorbs the second on sight, so
    // the second is never examined on its own — it no longer exists to examine.
    expect(report).toMatchObject({ entities: 3, examined: 2, merged: 2, skipped: 1 })
    expect(repo.merges.every((m) => m.into === first.id)).toBe(true)
    expect(repo.entities.map((row) => row.id)).toEqual([first.id])
  })

  it("follows a merge already made rather than making it twice", async () => {
    // A repo that tombstones instead of deleting, which the port permits and the
    // one real implementation does not do. B merges into A and stays visible; C
    // then matches B, and the stage has to notice that B is now A.
    const tombstoned = new Set<string>()
    const rows: { id: string; entity: Box }[] = []
    const merges: { into: string; from: string }[] = []
    const repo: EntityRepo<Box> = {
      async upsert(entity) {
        const id = `row-${rows.length + 1}`
        rows.push({ id, entity })
        return id
      },
      async findByKeys(keys, exclude): Promise<DedupMatch | null> {
        for (const key of keys) {
          for (const row of rows) {
            if (row.id === exclude) continue
            const hit =
              key.kind === SERIAL
                ? row.entity.serial === key.value
                : row.entity.colour === key.value
            if (hit) return { id: row.id, kind: key.kind }
          }
        }
        return null
      },
      async merge(into, from) {
        merges.push({ into, from })
        tombstoned.add(from)
      },
      // P2.5's member. This repo exists to tombstone rather than delete; scoring
      // never comes near it, and throwing is more honest than a no-op that would
      // let a future test believe it had written something.
      async writeScores() {
        throw new Error("this repo does not score")
      },
      // Likewise: the stage is handed its page, never reads one.
      async page() {
        throw new Error("this repo does not page")
      },
    }
    const links = new MemoryEntityLinks()
    const entities: DedupEntity<Box>[] = []
    for (const entity of [
      { colour: "red", serial: "A1" },
      { colour: "red", serial: "A1" },
      { colour: "red", serial: "A1" },
    ] satisfies Box[]) {
      entities.push({ id: await repo.upsert(entity), entity })
    }

    const report = await dedup({ pack: packOf(repo), entities, links })

    expect(report).toMatchObject({ merged: 2, skipped: 1 })
    // Both merges land on the first row. Without the chain the third would have
    // been folded into a row that no longer holds anything.
    expect(merges).toEqual([
      { into: "row-1", from: "row-2" },
      { into: "row-1", from: "row-3" },
    ])
    expect(tombstoned).toEqual(new Set(["row-2", "row-3"]))
  })

  it("stops where it is when the signal fires, and says so", async () => {
    const repo = boxRepo()
    const links = new MemoryEntityLinks()
    const entities = await stored(
      repo,
      { colour: "red", serial: "A1" },
      { colour: "red", serial: "A1" },
      { colour: "red", serial: "A1" },
    )
    const controller = new AbortController()
    controller.abort()

    const report = await dedup({ pack: packOf(repo), entities, links, signal: controller.signal })

    expect(report).toMatchObject({ entities: 3, examined: 0, merged: 0, cancelled: true })
    // Nothing half-done: the page is simply still there for the next run.
    expect(repo.entities).toHaveLength(3)
  })

  it("refuses by name when the pack has no resolver or no keys", async () => {
    const repo = boxRepo()
    const links = new MemoryEntityLinks()

    // `delete` rather than assigning undefined: under `exactOptionalPropertyTypes`
    // an absent member and one holding undefined are different things, and absent
    // is what a pack that never declared it looks like.
    const keyless = packOf(repo)
    delete keyless.dedupKeys
    await expect(dedup({ pack: keyless, entities: [], links })).rejects.toThrow(/has no dedupKeys/)

    const resolverless = packOf(repo)
    delete resolverless.resolve
    await expect(dedup({ pack: resolverless, entities: [], links })).rejects.toThrow(
      /has no resolve spec/,
    )
  })

  it("folds what the pack said to fold and leaves the rest", async () => {
    const repo = boxRepo()
    const links = new MemoryEntityLinks()
    const entities = await stored(
      repo,
      { colour: "red", serial: null },
      { colour: "red", serial: "A1" },
    )
    const [first] = entities as [DedupEntity<Box>]

    await dedup({ pack: packOf(repo), entities, links })

    // The survivor had no serial and the duplicate did. What the engine did was
    // call `merge`; what a serial means is entirely the repo's.
    expect(repo.entities).toEqual([{ id: first.id, entity: { colour: "red", serial: "A1" } }])
  })

  it("is idempotent: a second run over what is left finds nothing to do", async () => {
    const repo = boxRepo()
    const cache = new MemoryResolutionCache()
    const links = new MemoryEntityLinks(cache)
    const entities = await stored(
      repo,
      { colour: "red", serial: "A1" },
      { colour: "red", serial: "A1" },
    )
    links.addEvidence("boxes", entities[1]?.id ?? "")

    const first = await dedup({ pack: packOf(repo), entities, links })
    const again = await dedup({
      pack: packOf(repo),
      entities: repo.entities.map((row) => ({ ...row })),
      links,
    })

    expect(first.merged).toBe(1)
    expect(again).toMatchObject({ merged: 0, evidence: 0 })
    expect(links.evidence).toHaveLength(1)
  })
})

/**
 * The stage run the way the job runs it: one page at a time, oldest first.
 *
 * Every test above hands the stage the whole table in one page, and in that
 * shape "a match outside the page is older" is true by construction — there is
 * no outside except rows from a previous run. A job that pages the table breaks
 * the premise, and it breaks it in the common case rather than an edge: two
 * duplicates written weeks apart sit on different pages, the older one is
 * reached first, and the newer one is *outside the page and newer*. Without
 * being told what the walk has already passed, the stage cannot tell a row on
 * an earlier page from a row on a later one, and it merges the older row away.
 */
describe("dedup, walked a page at a time", () => {
  const walk = async (
    repo: MemoryEntityRepo<Box>,
    links: MemoryEntityLinks,
    opts: { size: number; tell: boolean },
  ) => {
    const earlier = new Set<string>()
    let cursor: string | null = null
    for (;;) {
      const page: Awaited<ReturnType<typeof repo.page>> = await repo.page(cursor, opts.size)
      if (page.entities.length === 0) break
      await dedup({
        pack: packOf(repo),
        entities: page.entities,
        links,
        ...(opts.tell ? { earlier } : {}),
      })
      for (const row of page.entities) earlier.add(row.id)
      cursor = page.cursor
      if (cursor === null) break
    }
  }

  it("keeps the older row when its duplicate is on a page not read yet", async () => {
    const repo = boxRepo()
    const links = new MemoryEntityLinks()
    const [first, second] = (await stored(
      repo,
      { colour: "red", serial: "A1" },
      { colour: "blue", serial: null },
      { colour: "red", serial: "A1" },
    )) as [DedupEntity<Box>, DedupEntity<Box>, DedupEntity<Box>]

    await walk(repo, links, { size: 2, tell: true })

    expect(repo.merges).toHaveLength(1)
    expect(repo.merges[0]?.into).toBe(first.id)
    expect(repo.entities.map((row) => row.id)).toEqual([first.id, second.id])
  })

  it("keeps the older row when the newer one finds it from a later page", async () => {
    // The asymmetric version: only the newer row can see the older one, so the
    // merge is decided on page two, and a row the walk already passed is older.
    // A serial here finds any red box, and a colour finds nothing — so the red
    // box without a serial has no key that answers, and the one with it does.
    const repo = new MemoryEntityRepo<Box>({
      matches: (key, entity) => key.kind === SERIAL && entity.colour === "red",
    })
    const [first, , third] = (await stored(
      repo,
      { colour: "red", serial: null },
      { colour: "blue", serial: null },
      { colour: "red", serial: "A1" },
    )) as [DedupEntity<Box>, DedupEntity<Box>, DedupEntity<Box>]

    await walk(repo, new MemoryEntityLinks(), { size: 2, tell: true })

    expect(repo.merges).toEqual([{ into: first.id, from: third.id }])
  })

  it("merges the older row away when the walk does not say what it passed", async () => {
    // The failure the option exists for, pinned so that it stays visible: the
    // stage's default is the single-page premise, and a paging caller that
    // forgets to pass `earlier` gets exactly the inversion P2.4 fixed within a
    // page, back again across pages.
    const repo = boxRepo()
    const links = new MemoryEntityLinks()
    const [first, , third] = (await stored(
      repo,
      { colour: "red", serial: "A1" },
      { colour: "blue", serial: null },
      { colour: "red", serial: "A1" },
    )) as [DedupEntity<Box>, DedupEntity<Box>, DedupEntity<Box>]

    await walk(repo, links, { size: 2, tell: false })

    expect(repo.merges).toEqual([{ into: third.id, from: first.id }])
  })

  it("moves the newer row's evidence onto the older one across pages", async () => {
    const repo = boxRepo()
    const links = new MemoryEntityLinks()
    const [first, , third] = (await stored(
      repo,
      { colour: "red", serial: "A1" },
      { colour: "blue", serial: null },
      { colour: "red", serial: "A1" },
    )) as [DedupEntity<Box>, DedupEntity<Box>, DedupEntity<Box>]
    links.addEvidence("boxes", third.id)
    links.addEvidence("boxes", first.id)

    await walk(repo, links, { size: 1, tell: true })

    expect(links.evidence.map((row) => row.entityId)).toEqual([first.id, first.id])
  })
})

/**
 * The page the stage is handed, which is the caller's to read.
 *
 * Here rather than beside the score stage, because the failure this contract is
 * shaped against is a *merge*: dedup removes rows from under a caller that is
 * paging the same table, and an offset — or an index, which is what the fake
 * would naturally use — skips whatever moved down into the gap.
 */
describe("EntityRepo.page, which both entity-shaped stages read their work from", () => {
  const boxes = async (n: number) => {
    const repo = new MemoryEntityRepo<Box>()
    for (let i = 0; i < n; i++) await repo.upsert({ colour: `c${i}`, serial: `S${i}` })
    return repo
  }

  it("walks the whole table in order, one page at a time", async () => {
    const repo = await boxes(7)
    const seen: string[] = []
    let cursor: string | null = null
    for (;;) {
      const page: Awaited<ReturnType<typeof repo.page>> = await repo.page(cursor, 3)
      seen.push(...page.entities.map((row) => row.id))
      cursor = page.cursor
      if (cursor === null) break
    }
    expect(seen).toEqual(repo.entities.map((row) => row.id))
  })

  it("ends on a short page, so a caller stops without a final empty read", async () => {
    const repo = await boxes(2)
    await expect(repo.page(null, 3)).resolves.toMatchObject({ cursor: null })
  })

  it("skips nothing when a merge removes a row the caller has already passed", async () => {
    const repo = await boxes(6)
    const first = await repo.page(null, 3)
    // The stage's own effect, mid-walk: entity 1 folded into entity 2 and gone.
    await repo.merge(first.entities[1]?.id ?? "", first.entities[0]?.id ?? "")

    const second = await repo.page(first.cursor, 3)
    // The three rows after the cursor, none of them pulled forward into the gap
    // the merge left behind.
    expect(second.entities.map((row) => row.id)).toEqual(["entity-4", "entity-5", "entity-6"])
  })

  it("refuses a cursor it did not mint rather than returning an empty page", async () => {
    const repo = await boxes(2)
    await expect(repo.page("somewhere", 3)).rejects.toThrow(/cursor/)
  })
})
