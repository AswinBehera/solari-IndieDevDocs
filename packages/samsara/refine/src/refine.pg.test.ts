import { randomUUID } from "node:crypto"
import {
  entityResolutions,
  evidence,
  harvestRuns,
  mentions,
  personas,
  rawItems,
  samsaraSchema,
  sessions,
} from "@samsara/db"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { EvidenceRecord, MentionRow } from "./ports.js"
import {
  EVIDENCE_PER_ENTITY,
  PostgresEntityLinks,
  PostgresEvidenceStore,
  PostgresEvidenceWriter,
  PostgresMentionSink,
  PostgresMentionStore,
  PostgresPendingMentions,
  PostgresResolutionCache,
} from "./postgres.js"

/**
 * The mention stores against a real Postgres.
 *
 * What needs a real database here is the **cascade**. `mentions.raw_item_id` is
 * `ON DELETE cascade`, which encodes the rule that a mention is a claim *about*
 * an item and cannot outlive it — delete the item and the claim goes with it. An
 * in-memory sink will happily keep an orphan, and an orphaned mention is the
 * worst kind, because it still renders: a name with a quote attributed to a post
 * that is no longer there.
 *
 * The other thing a fake cannot check is that `payload` survives the round trip
 * through `jsonb` **unread**. The engine stores what the pack validated and hands
 * it back without opinion, and a non-Latin script in a JSON column is exactly
 * where a silent re-encoding would show up. The fixtures are Vietnamese for the
 * reason `harvest.pg.test.ts`'s are: the engine must not be developed against the
 * one language its first vertical happens to be about (ADR-0009).
 *
 * Runs whenever `DATABASE_URL` is set, and **fails loudly when it is not** unless
 * `SAMSARA_NO_DB=1` says the omission is deliberate. See `harvest.pg.test.ts`.
 */

const url = process.env.DATABASE_URL
const hasDb = typeof url === "string" && url.length > 0
const optedOut = process.env.SAMSARA_NO_DB === "1"

if (!hasDb && !optedOut) {
  describe("refine, against Postgres", () => {
    it("has a database to run against", () => {
      expect.fail(
        "DATABASE_URL is not set, so the cascade test would have skipped and this " +
          "run would have reported green while testing nothing. Run `pnpm db:up` " +
          "and retry, or set SAMSARA_NO_DB=1 to skip on purpose.",
      )
    })
  })
}

const client = hasDb ? postgres(url as string, { max: 4, onnotice: () => {} }) : null
const db = client ? drizzle(client, { schema: samsaraSchema }) : null

// Held for the whole file: this suite truncates shared tables, and Turbo runs the
// packages that do so at the same time. See `@samsara/db/testing`.
let lock: DatabaseLock | null = null

beforeAll(async () => {
  if (hasDb) lock = await lockDatabase(url as string)
})

afterAll(async () => {
  await client?.end({ timeout: 5 })
  await lock?.release()
})

const capturedAt = new Date("2026-09-18T10:00:00.000Z")

/** A map lookup that fails the test rather than the type, since absent is meaningful. */
const read = (map: Map<string, EvidenceRecord[]>, id: string): EvidenceRecord[] => {
  const rows = map.get(id)
  if (!rows) throw new Error(`no evidence for ${id}`)
  return rows
}

describe.runIf(hasDb)("refine, against Postgres", () => {
  const d = () => db as NonNullable<typeof db>
  const sink = () => new PostgresMentionSink(d())
  const store = () => new PostgresMentionStore(d())

  let itemId: string
  /** Held because `evidence.persona_id` is `ON DELETE restrict` and needs a real one. */
  let personaId: string

  beforeEach(async () => {
    await d().execute(
      sql`truncate table entity_resolutions, mentions, raw_items, harvest_runs, sessions, personas restart identity cascade`,
    )
    personaId = randomUUID()
    await d().insert(personas).values({
      id: personaId,
      name: "regular",
      locality: "District 1",
      country: "vn",
      locale: "vi-VN",
      timezoneId: "Asia/Ho_Chi_Minh",
      tier: "anon",
    })
    const [session] = await d()
      .insert(sessions)
      .values({ purpose: "harvest", personaId, country: "vn", outcome: "ok", minutes: 0.5 })
      .returning({ id: sessions.id })
    const runId = randomUUID()
    await d()
      .insert(harvestRuns)
      .values({
        id: runId,
        domainId: "atlas",
        personaId,
        sourceId: "fake.search",
        query: "xin chào thế giới",
        sessionId: session?.id as string,
        startedAt: capturedAt,
        outcome: "ok",
        itemCount: 1,
      })
    itemId = randomUUID()
    await d()
      .insert(rawItems)
      .values({
        id: itemId,
        harvestRunId: runId,
        sourceId: "fake.search",
        rank: 0,
        url: "https://example.invalid/topic/44225687",
        title: "xin chào thế giới",
        text: "xin chào",
        languageGuess: "vi",
        mediaRefs: [],
        capturedAt,
        rawRef: `captures/fake.search/${runId}/1.json`,
      })
  })

  const row = (over: Partial<MentionRow> = {}): MentionRow => ({
    id: randomUUID(),
    rawItemId: itemId,
    domainId: "atlas",
    packVersion: "1",
    payload: { localName: "Phở Hòa", romanName: "Pho Hoa", sentiment: "positive" },
    entityId: null,
    resolution: "pending",
    confidence: 0.9,
    ...over,
  })

  it("writes a batch and reads it back with the item it came from", async () => {
    await sink().insertMany([row(), row({ payload: { localName: "Bún Chả" } })])

    const read = await store().list({ domainId: "atlas" })
    expect(read).toHaveLength(2)
    // The join is the point: a name with no way to check it is not reviewable.
    expect(read[0]?.item.url).toBe("https://example.invalid/topic/44225687")
    expect(read[0]?.item.sourceId).toBe("fake.search")
    expect(read[0]?.item.languageGuess).toBe("vi")
  })

  it("hands the payload back exactly as the pack wrote it", async () => {
    await sink().insertMany([row()])
    const [read] = await store().list({ domainId: "atlas" })
    // Diacritics through `jsonb` and back. An engine that "helpfully" normalised
    // this would break the golden scorer's name matching without failing anything
    // else — `Pho Hoa` and `Phở Hòa` are two names to a string comparison.
    expect(read?.payload).toEqual({
      localName: "Phở Hòa",
      romanName: "Pho Hoa",
      sentiment: "positive",
    })
  })

  it("an empty batch is not an error", async () => {
    await sink().insertMany([])
    expect(await store().list({})).toHaveLength(0)
  })

  it("loses its mentions when the item is deleted", async () => {
    await sink().insertMany([row(), row()])
    await d().delete(rawItems).where(sql`${rawItems.id} = ${itemId}`)
    // Not "returns nothing because the join found no item" — the rows are gone.
    const remaining = await d().select({ id: mentions.id }).from(mentions)
    expect(remaining).toHaveLength(0)
  })

  describe("extractedIds", () => {
    it("names the items already extracted at this pack version", async () => {
      await sink().insertMany([row()])
      const seen = await sink().extractedIds([itemId, randomUUID()], "atlas", "1")
      expect(seen).toEqual(new Set([itemId]))
    })

    it("counts an item once however many names it found in it", async () => {
      await sink().insertMany([row(), row(), row()])
      const seen = await sink().extractedIds([itemId], "atlas", "1")
      // `selectDistinct` earning its keep: three mentions, one id.
      expect(seen.size).toBe(1)
    })

    it("does not skip an item when the pack version has moved on", async () => {
      await sink().insertMany([row({ packVersion: "1" })])
      // The version bump is precisely the case where re-extraction is wanted:
      // new prompt, new answer. Reporting it as already done would mean a prompt
      // change silently never reached the corpus it was written for.
      expect(await sink().extractedIds([itemId], "atlas", "2")).toEqual(new Set())
    })

    it("does not confuse one pack's work for another's", async () => {
      await sink().insertMany([row({ domainId: "atlas" })])
      expect(await sink().extractedIds([itemId], "creator", "1")).toEqual(new Set())
    })

    it("asks nothing when given nothing", async () => {
      expect(await sink().extractedIds([], "atlas", "1")).toEqual(new Set())
    })
  })

  describe("list", () => {
    it("filters by resolution, so the lab can show what is still pending", async () => {
      // The resolved row is made by an `update`, not by the sink, and that is not
      // test convenience — `MentionRow.entityId` is typed `null`, so the write
      // path *cannot* express a resolved mention. It is a state P2.3 moves a row
      // into after the fact, and writing this any other way would have needed the
      // type widened, which would let a pack invent an entity id.
      const pending = row()
      const toResolve = row()
      await sink().insertMany([pending, toResolve])
      const entityId = randomUUID()
      await d()
        .update(mentions)
        .set({ resolution: "resolved", entityId })
        .where(sql`${mentions.id} = ${toResolve.id}`)

      expect(await store().list({ resolution: "pending" })).toHaveLength(1)
      const [resolved] = await store().list({ resolution: "resolved" })
      expect(resolved?.id).toBe(toResolve.id)
      expect(resolved?.entityId).toBe(entityId)
    })

    it("filters to one item's mentions", async () => {
      await sink().insertMany([row(), row()])
      expect(await store().list({ rawItemId: itemId })).toHaveLength(2)
      expect(await store().list({ rawItemId: randomUUID() })).toHaveLength(0)
    })

    it("bounds the list even when asked for more", async () => {
      await sink().insertMany(Array.from({ length: 5 }, () => row()))
      expect(await store().list({ limit: 1_000_000 })).toHaveLength(5)
      expect(await store().list({ limit: 2 })).toHaveLength(2)
      // A nonsense limit falls back to the bound rather than throwing: this is a
      // query string, and the caller of a lab screen is a URL bar.
      expect(await store().list({ limit: Number.NaN })).toHaveLength(5)
    })
  })

  /**
   * The resolve stage's cache (P2.3), against a real database.
   *
   * Three things here need one and cannot be faked. The **upsert** is a real
   * conflict on a real unique index, which is what makes two runners working
   * overlapping pages safe. The **attempt increment** is an expression evaluated
   * by Postgres rather than a number the caller computed, which is the whole
   * defence against two readers of the same total writing it back. And `commit`
   * moves the cache row and the mentions **in one transaction**, which an
   * in-memory map cannot fail to do and therefore cannot demonstrate.
   */
  describe("the resolution cache", () => {
    const cache = () => new PostgresResolutionCache(d())

    const commit = (over: Partial<Parameters<ReturnType<typeof cache>["commit"]>[0]> = {}) => ({
      domainId: "atlas",
      key: "chợ bến thành",
      mentionIds: [] as string[],
      state: "pending" as const,
      entityId: null,
      tier: null,
      confidence: null,
      deferred: false,
      ...over,
    })

    it("returns nothing for a key it has never seen, rather than a default", async () => {
      // "Never asked" and "asked and still pending" differ by an attempt count,
      // and a caller that had to tell them apart from a zero-valued default
      // would get it wrong the first time the default changed.
      expect((await cache().read("atlas", ["chợ bến thành"])).size).toBe(0)
    })

    it("upserts on (domain, key) rather than inserting a second row", async () => {
      const entityId = randomUUID()
      await cache().commit(commit({ deferred: true }))
      await cache().commit(commit({ state: "resolved", entityId, tier: 1, confidence: 0.8 }))

      const rows = await d().select().from(entityResolutions)
      expect(rows).toHaveLength(1)
      const read = (await cache().read("atlas", ["chợ bến thành"])).get("chợ bến thành")
      expect(read).toMatchObject({ state: "resolved", entityId, tier: 1, confidence: 0.8 })
    })

    it("increments attempts in the database, and only for a deferral", async () => {
      // Written as `attempts + 1` in SQL rather than as a number the caller read
      // and added to. Two runners that both read 0 would both write 1, and the
      // ceiling the counter protects would never be reached.
      await cache().commit(commit({ deferred: true }))
      await cache().commit(commit({ deferred: true }))
      expect((await cache().read("atlas", ["chợ bến thành"])).get("chợ bến thành")?.attempts).toBe(
        2,
      )

      // A commit that looked and found something does not count as an attempt.
      await cache().commit(commit({ state: "unresolvable", tier: 3 }))
      expect((await cache().read("atlas", ["chợ bến thành"])).get("chợ bến thành")?.attempts).toBe(
        2,
      )
    })

    it("keeps two domains apart under the same key", async () => {
      await cache().commit(commit({ state: "resolved", entityId: randomUUID(), tier: 0 }))
      await cache().commit(commit({ domainId: "cartography", state: "unresolvable", tier: 3 }))

      expect((await cache().read("atlas", ["chợ bến thành"])).get("chợ bến thành")?.state).toBe(
        "resolved",
      )
      expect(
        (await cache().read("cartography", ["chợ bến thành"])).get("chợ bến thành")?.state,
      ).toBe("unresolvable")
    })

    it("moves the mentions with the cache row", async () => {
      const first = row()
      const second = row()
      await sink().insertMany([first, second])
      const entityId = randomUUID()

      await cache().commit(
        commit({
          mentionIds: [first.id, second.id],
          state: "resolved",
          entityId,
          tier: 0,
          confidence: 0.95,
        }),
      )

      const read = await store().list({ domainId: "atlas" })
      expect(read.every((m) => m.resolution === "resolved")).toBe(true)
      expect(read.every((m) => m.entityId === entityId)).toBe(true)
    })

    it("writes no cache row at all when the mention half fails", async () => {
      // The one that actually demonstrates the transaction, rather than
      // demonstrating that both halves ran. The cache row is inserted first and
      // the mentions are updated second, so a malformed mention id fails the
      // *second* statement — and the row from the first must not survive it.
      //
      // It matters because of which way the residue would cut. A cache row
      // claiming `resolved` that no mention points at is not a stale row that a
      // later run repairs: it is a permanent cache hit, so every future mention
      // of that name is silently attached to an entity nothing ever verified,
      // and the stage never asks the pack about it again.
      await expect(
        cache().commit(
          commit({
            mentionIds: ["not-a-uuid"],
            state: "resolved",
            entityId: randomUUID(),
            tier: 0,
            confidence: 0.95,
          }),
        ),
      ).rejects.toThrow()

      expect(await d().select().from(entityResolutions)).toHaveLength(0)
    })
  })

  describe("the pending reader", () => {
    const pending = () => new PostgresPendingMentions(d())

    it("returns the item's full text, which is where Tier 0 looks", async () => {
      // `MentionStore.list` deliberately does not select `text` — it serves a
      // screen. A resolver needs the artifact itself, because ADR-0017's Tier 0
      // reads coordinates out of it. This is the assertion that the two reads
      // are different reads for a reason and not duplication.
      await sink().insertMany([row()])
      const [got] = await pending().pending("atlas")
      expect(got?.item.text).toBe("xin chào")
      expect(got?.item.id).toBe(itemId)
    })

    it("returns only what is still pending, and only this domain", async () => {
      // No `entityId` here, and it is not an oversight: `MentionRow.entityId` is
      // the literal `null`, because the extract stage is the only writer of that
      // type and it has nothing to point at yet. The filter this test is about is
      // on `resolution` anyway — the resolve stage moves both, together, through
      // `ResolutionCache.commit`.
      const done = row({ resolution: "resolved" })
      const elsewhere = row({ domainId: "cartography" })
      await sink().insertMany([row(), done, elsewhere])

      const got = await pending().pending("atlas")
      expect(got).toHaveLength(1)
      expect(got[0]?.domainId).toBe("atlas")
    })

    it("is bounded, and hands back the oldest first", async () => {
      // Oldest first because this is a work queue rather than a view. Newest
      // first would re-read one page every run while the backlog behind it aged,
      // which is starvation that looks exactly like progress.
      //
      // What the last assertion actually pins is the **tiebreak**: these five
      // rows are one INSERT and so share a `created_at` to the microsecond,
      // which is the ordinary case for a batch the extract stage wrote. With the
      // timestamps equal, only `id` separates them, and without it in the ORDER
      // BY two reads of one page could return two different pages — so a runner
      // that took page one, died, and restarted could work the same rows twice
      // and never reach the rest.
      await sink().insertMany(Array.from({ length: 5 }, () => row()))
      expect(await pending().pending("atlas", 2)).toHaveLength(2)
      expect(await pending().pending("atlas", 1_000_000)).toHaveLength(5)

      const all = await pending().pending("atlas")
      const oldest = await d()
        .select({ id: mentions.id })
        .from(mentions)
        .orderBy(mentions.createdAt, mentions.id)
        .limit(1)
      expect(all[0]?.id).toBe(oldest[0]?.id)
    })
  })

  /**
   * `PostgresEntityLinks`, which is the engine's whole share of a merge (P2.4).
   *
   * These three tables hold an opaque `(domain_id, entity_id)` with **no foreign
   * key** into any vertical's table — that absence is ADR-0009's seam, and it is
   * also the reason nothing else in the database would ever notice these rows
   * pointing at an id that a pack has just deleted. A fake can move fields in an
   * array. What needs a real Postgres is that the three updates are one
   * transaction, and that the `domain_id` half is actually in every WHERE.
   */
  describe("repointing what a merge is about to leave behind", () => {
    const links = () => new PostgresEntityLinks(d())

    const evidenceFor = async (domainId: string, entityId: string): Promise<string> => {
      // Its own mention, because `evidence.mention_id` is a real foreign key and
      // `(domain_id, mention_id)` is unique (P2.5). Minting one per row here is
      // also what the writer does — one claim, one mention — so the fixture is
      // not a shape the pipeline cannot produce.
      const claim = row({ domainId })
      await sink().insertMany([claim])
      const [written] = await d()
        .insert(evidence)
        .values({
          domainId,
          entityId,
          mentionId: claim.id,
          rawItemId: itemId,
          sourceId: "fake.search",
          sourceUrl: "https://example.invalid/topic/44225687",
          personaId,
          language: "vi",
          capturedAt,
          extract: { localName: "Phở Hòa" },
          rawRef: "captures/fake.search/1.json",
        })
        .returning({ id: evidence.id })
      return written?.id as string
    }

    const duplicate = randomUUID()
    const survivor = randomUUID()

    it("moves all three kinds of pointer and counts what it moved", async () => {
      const kept = await evidenceFor("atlas", duplicate)
      // Through `commit`, because that is the only way a mention ever acquires an
      // entity id — `MentionRow.entityId` is typed `null` so the extract stage
      // cannot claim one. Setting the column directly here would be testing the
      // repoint against a state nothing in the pipeline can produce.
      const mention = row()
      await sink().insertMany([mention])
      await new PostgresResolutionCache(d()).commit({
        domainId: "atlas",
        key: "phohoa",
        state: "resolved",
        entityId: duplicate,
        tier: 1,
        confidence: 0.8,
        mentionIds: [mention.id],
        deferred: false,
      })

      const moved = await links().repoint("atlas", duplicate, survivor)

      expect(moved).toEqual({ evidence: 1, mentions: 1, resolutions: 1 })
      // Evidence is the one section 2.4 names by name: a merge preserves it, and
      // the row is the same row rather than a copy.
      const [carried] = await d().select().from(evidence).where(eq(evidence.id, kept))
      expect(carried?.entityId).toBe(survivor)
      expect(carried?.extract).toEqual({ localName: "Phở Hòa" })
      const [cached] = await d().select().from(entityResolutions)
      // The cache row is what stops the merge undoing itself: left pointing at a
      // deleted id, the next run would read it back and hand out the duplicate.
      expect(cached?.entityId).toBe(survivor)
    })

    it("leaves another domain's rows exactly where they were", async () => {
      // Same entity id, different domain — contrived, and permitted: the ids are
      // opaque and nothing stops two packs minting the same one. Without the
      // `domain_id` half in the WHERE, this merge would move a vertical's
      // evidence onto another vertical's survivor and nothing would ever say so.
      const mine = await evidenceFor("atlas", duplicate)
      const theirs = await evidenceFor("cartography", duplicate)

      const moved = await links().repoint("atlas", duplicate, survivor)

      expect(moved.evidence).toBe(1)
      const rows = await d().select().from(evidence)
      expect(rows.find((r) => r.id === mine)?.entityId).toBe(survivor)
      expect(rows.find((r) => r.id === theirs)?.entityId).toBe(duplicate)
    })

    it("counts nothing when there is nothing pointing at the duplicate", async () => {
      // A legitimate merge: two rows that were resolved from the same key and
      // never had a mention attributed separately. Zero is an answer, not a miss.
      expect(await links().repoint("atlas", duplicate, survivor)).toEqual({
        evidence: 0,
        mentions: 0,
        resolutions: 0,
      })
    })

    it("refuses to move a row onto itself", async () => {
      // Cheap, but the guard is load-bearing: the stage follows merge chains, and
      // a chain that settles on the entity it started from would otherwise issue
      // an UPDATE whose WHERE and SET say the same thing.
      await evidenceFor("atlas", duplicate)

      expect(await links().repoint("atlas", duplicate, duplicate)).toEqual({
        evidence: 0,
        mentions: 0,
        resolutions: 0,
      })
      const [untouched] = await d().select().from(evidence)
      expect(untouched?.entityId).toBe(duplicate)
    })
  })

  /**
   * Evidence materialisation and the read behind every score (P2.5).
   *
   * What needs a real database here is the whole implementation. The writer is
   * one `INSERT … SELECT` over a three-table join with an `ON CONFLICT`, and the
   * reader is a window function — neither of them is a thing a fake can be wrong
   * about in the same way. `MemoryEvidence` reproduces the two *rules* (an
   * unresolved mention writes nothing, a replay writes nothing again); only this
   * file can show that the join picks up the persona from the harvest run, that
   * the unique index is the one being conflicted on, and that a page of entities
   * costs one query.
   */
  describe("the evidence writer", () => {
    const writer = () => new PostgresEvidenceWriter(d())
    const cache = () => new PostgresResolutionCache(d())

    /** A mention pointed at an entity the only way anything ever points one. */
    const resolved = async (entityId: string, over: Partial<MentionRow> = {}): Promise<string> => {
      const mention = row(over)
      await sink().insertMany([mention])
      await cache().commit({
        domainId: mention.domainId,
        key: `k-${mention.id}`,
        state: "resolved",
        entityId,
        tier: 1,
        confidence: 0.8,
        mentionIds: [mention.id],
        deferred: false,
      })
      return mention.id
    }

    it("composes a row from the mention, the item and the harvest run", async () => {
      const entityId = randomUUID()
      const mentionId = await resolved(entityId)

      expect(await writer().record("atlas", [mentionId])).toBe(1)

      const [written] = await d().select().from(evidence)
      expect(written).toMatchObject({
        domainId: "atlas",
        entityId,
        mentionId,
        rawItemId: itemId,
        sourceId: "fake.search",
        sourceUrl: "https://example.invalid/topic/44225687",
        // From `harvest_runs`, two joins away, and the reason the writer is a
        // join rather than a loop: nothing the caller holds knows this.
        personaId,
        language: "vi",
      })
      expect(written?.capturedAt).toEqual(capturedAt)
      // The pack's payload, carried through jsonb unread — the same seam
      // `mentions.payload` is, with the same non-Latin fixture.
      expect(written?.extract).toEqual({
        localName: "Phở Hòa",
        romanName: "Pho Hoa",
        sentiment: "positive",
      })
    })

    it("skips a mention that never resolved", async () => {
      const mention = row()
      await sink().insertMany([mention])

      // Committed as unresolvable, which is what a caller hands in anyway: it
      // cannot tell, because a cached key comes back through the same commit
      // whether it resolved last week or was written off.
      await cache().commit({
        domainId: "atlas",
        key: "unplaceable",
        state: "unresolvable",
        entityId: null,
        tier: 3,
        confidence: null,
        mentionIds: [mention.id],
        deferred: false,
      })

      expect(await writer().record("atlas", [mention.id])).toBe(0)
      expect(await d().select().from(evidence)).toHaveLength(0)
    })

    it("adds nothing on a replay, and adds nothing when two runners overlap", async () => {
      const entityId = randomUUID()
      const a = await resolved(entityId)
      const b = await resolved(entityId)

      expect(await writer().record("atlas", [a, b])).toBe(2)
      expect(await writer().record("atlas", [a, b])).toBe(0)
      // The overlapping-page case: a second runner handed one mention the first
      // already recorded and one it did not.
      const c = await resolved(entityId)
      expect(await writer().record("atlas", [b, c])).toBe(1)
      expect(await d().select().from(evidence)).toHaveLength(3)
    })

    it("stays idempotent after a merge has repointed what it wrote", async () => {
      // The reason the unique index is on `(domain_id, mention_id)` rather than
      // on `(domain_id, entity_id, raw_item_id)`. Two rows from one item about
      // two entities are distinct before a merge and would collide after it,
      // turning `repoint` into a constraint violation at the worst moment.
      const first = randomUUID()
      const second = randomUUID()
      const a = await resolved(first)
      const b = await resolved(second)
      await writer().record("atlas", [a, b])

      const moved = await new PostgresEntityLinks(d()).repoint("atlas", second, first)

      expect(moved.evidence).toBe(1)
      const rows = await d().select().from(evidence)
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.entityId === first)).toBe(true)
      // And the replay still adds nothing, which it could not if the key were
      // the entity.
      expect(await writer().record("atlas", [a, b])).toBe(0)
    })

    it("leaves another domain's mentions alone", async () => {
      const entityId = randomUUID()
      const mine = await resolved(entityId)
      const theirs = await resolved(entityId, { domainId: "cartography" })

      expect(await writer().record("atlas", [mine, theirs])).toBe(1)
      const [written] = await d().select().from(evidence)
      expect(written?.mentionId).toBe(mine)
    })

    it("writes nothing when handed nothing", async () => {
      expect(await writer().record("atlas", [])).toBe(0)
    })

    it("loses its rows when the item they describe is deleted", async () => {
      // `evidence.raw_item_id` is `ON DELETE cascade`, encoding the same rule
      // `mentions` does: a claim about an item cannot outlive it. An orphan here
      // would be worse than an orphaned mention, because a score would keep
      // counting it.
      await writer().record("atlas", [await resolved(randomUUID())])
      expect(await d().select().from(evidence)).toHaveLength(1)

      await d().delete(rawItems).where(eq(rawItems.id, itemId))

      expect(await d().select().from(evidence)).toHaveLength(0)
    })
  })

  describe("the evidence store", () => {
    const writer = () => new PostgresEvidenceWriter(d())
    const store = () => new PostgresEvidenceStore(d())

    const recorded = async (entityId: string, count: number): Promise<void> => {
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const mention = row()
        await sink().insertMany([mention])
        await new PostgresResolutionCache(d()).commit({
          domainId: "atlas",
          key: `k-${mention.id}`,
          state: "resolved",
          entityId,
          tier: 1,
          confidence: 0.8,
          mentionIds: [mention.id],
          deferred: false,
        })
        ids.push(mention.id)
      }
      await writer().record("atlas", ids)
    }

    it("groups a page's evidence by entity, and leaves an empty entity out", async () => {
      const busy = randomUUID()
      const quiet = randomUUID()
      const nothing = randomUUID()
      await recorded(busy, 3)
      await recorded(quiet, 1)

      const read = await store().forEntities("atlas", [busy, quiet, nothing])

      expect(read.get(busy)).toHaveLength(3)
      expect(read.get(quiet)).toHaveLength(1)
      // Absent rather than present-and-empty, which is what lets the stage's
      // "nothing to score" be one check rather than two.
      expect(read.has(nothing)).toBe(false)
    })

    it("hands back the engagement numbers as three nullable fields", async () => {
      const entityId = randomUUID()
      await recorded(entityId, 1)
      await d().update(evidence).set({ engagementViews: 900, engagementComments: 12 })

      const [record] = read(await store().forEntities("atlas", [entityId]), entityId)

      // Three numbers rather than a nullable object: the surfaces disagree about
      // which exist, and a factor abstains on the one it cannot see rather than
      // on the whole row.
      expect(record?.engagement).toEqual({ views: 900, likes: null, comments: 12 })
    })

    it("caps each entity separately, so a loud entity cannot starve a quiet one", async () => {
      // The whole reason the cap is a window function. A `LIMIT` over the page
      // would give the newest rows across entities to whichever had the most,
      // and report every other entity as `unevidenced`.
      const loud = randomUUID()
      const quiet = randomUUID()
      await recorded(loud, EVIDENCE_PER_ENTITY + 3)
      await recorded(quiet, 2)

      const read = await store().forEntities("atlas", [loud, quiet])

      expect(read.get(loud)).toHaveLength(EVIDENCE_PER_ENTITY)
      expect(read.get(quiet)).toHaveLength(2)
    })

    it("keeps the newest rows when it caps, deterministically", async () => {
      const entityId = randomUUID()
      await recorded(entityId, 3)
      const all = await d().select().from(evidence)
      const oldest = all[0]?.id as string
      await d()
        .update(evidence)
        .set({ capturedAt: new Date("2020-01-01T00:00:00Z") })
        .where(eq(evidence.id, oldest))

      const rows = read(await store().forEntities("atlas", [entityId]), entityId)

      // Newest first, because a score is a claim about what the corpus says now
      // — a place that has become a tour stop should stop reading as local.
      expect(rows.at(-1)?.id).toBe(oldest)
    })

    it("reads nothing for another domain's entity", async () => {
      const entityId = randomUUID()
      await recorded(entityId, 2)

      expect((await store().forEntities("cartography", [entityId])).size).toBe(0)
    })

    it("asks nothing of the database when the page is empty", async () => {
      expect((await store().forEntities("atlas", [])).size).toBe(0)
    })
  })
})
