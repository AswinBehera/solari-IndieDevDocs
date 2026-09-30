import type { ResolutionState, ScoreSet } from "@samsara/core"
import type { DedupKey, DedupMatch, EntityPage, EntityRepo } from "./pack.js"
import type {
  CachedResolution,
  EntityLinks,
  EvidenceRecord,
  EvidenceStore,
  EvidenceWriter,
  MentionFilter,
  MentionRecord,
  MentionRow,
  MentionSink,
  MentionStore,
  RepointCount,
  ResolutionCache,
  ResolutionCommit,
} from "./ports.js"
import { MENTION_LIST_LIMIT } from "./ports.js"

/**
 * A `MentionSink` that keeps its rows in an array.
 *
 * Exported rather than kept in a test file, for the same reason `MemoryLogger`
 * and `MemoryCounterStore` are: the golden-set tests in `@dt/travel-pack` need a
 * sink and have no business importing one from another package's tests, and
 * P2.8's throwaway pack needs to run the whole stage without a Postgres.
 */
export class MemoryMentionSink implements MentionSink {
  readonly rows: MentionRow[] = []

  async insertMany(rows: readonly MentionRow[]): Promise<void> {
    this.rows.push(...rows)
  }

  async extractedIds(
    rawItemIds: readonly string[],
    domainId: string,
    packVersion: string,
  ): Promise<Set<string>> {
    const wanted = new Set(rawItemIds)
    const found = new Set<string>()
    for (const row of this.rows) {
      if (
        row.domainId === domainId &&
        row.packVersion === packVersion &&
        wanted.has(row.rawItemId)
      ) {
        found.add(row.rawItemId)
      }
    }
    return found
  }

  /** Every mention written for one item, in the order it was written. */
  byItem(rawItemId: string): MentionRow[] {
    return this.rows.filter((row) => row.rawItemId === rawItemId)
  }
}

/**
 * A `MentionStore` that keeps its records in an array.
 *
 * Holds `MentionRecord`s rather than wrapping `MemoryMentionSink`, because the
 * read side returns the item each mention came from and the sink never sees one.
 * A fake that invented an item to join against would be asserting something no
 * real store does; one that returned a null item would have a shape the schema
 * forbids. So the caller supplies whole records, which is what a reader reads.
 *
 * The ordering and the limit are copied from `PostgresMentionStore` on purpose:
 * a test that passes here and fails there is worth nothing, and "newest first,
 * always bounded" is the contract rather than an implementation detail of SQL.
 */
export class MemoryMentionStore implements MentionStore {
  readonly records: MentionRecord[] = []

  add(...records: MentionRecord[]): void {
    this.records.push(...records)
  }

  async list(filter: MentionFilter): Promise<MentionRecord[]> {
    const limit =
      filter.limit === undefined || !Number.isFinite(filter.limit)
        ? MENTION_LIST_LIMIT
        : Math.max(1, Math.min(Math.floor(filter.limit), MENTION_LIST_LIMIT))

    return this.records
      .filter(
        (r) =>
          (filter.domainId === undefined || r.domainId === filter.domainId) &&
          (filter.packVersion === undefined || r.packVersion === filter.packVersion) &&
          (filter.resolution === undefined || r.resolution === filter.resolution) &&
          (filter.rawItemId === undefined || r.rawItemId === filter.rawItemId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
  }
}

/**
 * A `ResolutionCache` that keeps its rows in a Map, and the mention states beside
 * them.
 *
 * It holds the mention half as well as the key half because the port's `commit`
 * promises both move together, and a fake that only moved one would let a test
 * pass over exactly the interleaving the real implementation needs a transaction
 * to prevent.
 *
 * Nested maps rather than a joined string key, because there is no separator
 * that a domain id and a pack's normalised key are both guaranteed not to
 * contain — and a collision here would silently hand one domain's answer to
 * another, which is the one thing the `(domainId, key)` pair exists to prevent.
 */
export class MemoryResolutionCache implements ResolutionCache {
  readonly rows = new Map<string, Map<string, CachedResolution>>()
  /** Mention id to what the last commit said about it. */
  readonly mentions = new Map<
    string,
    { state: ResolutionState; entityId: string | null; key: string }
  >()

  async read(domainId: string, keys: readonly string[]): Promise<Map<string, CachedResolution>> {
    const domain = this.rows.get(domainId)
    const out = new Map<string, CachedResolution>()
    if (!domain) return out
    for (const key of keys) {
      const row = domain.get(key)
      if (row) out.set(key, { ...row })
    }
    return out
  }

  async commit(entry: ResolutionCommit): Promise<void> {
    let domain = this.rows.get(entry.domainId)
    if (!domain) {
      domain = new Map()
      this.rows.set(entry.domainId, domain)
    }
    const before = domain.get(entry.key)
    domain.set(entry.key, {
      state: entry.state,
      entityId: entry.entityId,
      tier: entry.tier,
      confidence: entry.confidence,
      // Incremented rather than assigned, matching the SQL: the caller never
      // says what the total is, because two runners racing one key would have
      // read the same total and would both write it back.
      attempts: (before?.attempts ?? 0) + (entry.deferred ? 1 : 0),
    })
    for (const id of entry.mentionIds) {
      this.mentions.set(id, { state: entry.state, entityId: entry.entityId, key: entry.key })
    }
  }
}

/**
 * What a fake needs to be told before it can deduplicate anything.
 *
 * Both are optional and both default to doing nothing, which is the honest
 * default: `DedupKey.value` is `unknown` by design, so a generic in-memory repo
 * cannot answer a single one of a pack's questions without being handed the
 * answer. A fake left un-configured finds no duplicates and says so, rather than
 * inventing a comparison — `JSON.stringify` equality on the value would have
 * worked for an exact identifier and silently returned nothing for a radius or a
 * threshold, which is the shape of fake that makes a stage's tests pass while the
 * real repo does something else.
 */
export interface MemoryEntityRepoOptions<TEntity> {
  /** Does this stored entity answer to this key? Absent means "never". */
  matches?: (key: DedupKey, entity: TEntity) => boolean
  /**
   * What the survivor looks like after absorbing the duplicate. Absent leaves it
   * untouched, which is a legitimate merge — a pack whose rows carry nothing
   * worth folding still wants the duplicate gone and its evidence moved.
   */
  fold?: (into: TEntity, from: TEntity) => TEntity
}

/**
 * An `EntityRepo` that keeps entities in an array and hands back their index.
 *
 * `upsert` deliberately does no deduplication at all, because the port says it
 * must not: collapsing two spellings of one name is the dedup stage's job, and a
 * fake that did it early would make the resolve stage's tests pass over the exact
 * behaviour dedup is measured on.
 *
 * `merge` **deletes** the duplicate rather than tombstoning it, which is what the
 * one real implementation does, so a chain of merges behaves here the way it
 * behaves there. The stage defends against a tombstoning repo anyway; this fake
 * is not the thing that proves it needs to.
 */
export class MemoryEntityRepo<TEntity> implements EntityRepo<TEntity> {
  readonly entities: { id: string; entity: TEntity }[] = []
  /** Every merge, in order, so a test can assert the direction and not just the count. */
  readonly merges: { into: string; from: string }[] = []
  /**
   * Scores by entity id (P2.5).
   *
   * Beside the entities rather than on them, because `TEntity` is the pack's own
   * shape and this fake has no way to put a field on it. The one real repo does
   * write a column on the row; what both agree on is that the last write wins
   * and a key that stopped being computed stops being stored.
   */
  readonly scores = new Map<string, ScoreSet>()
  /** Mint order by id, so a page survives a merge splicing the array. See `page`. */
  private readonly order = new Map<string, number>()
  private minted = 0

  constructor(private readonly options: MemoryEntityRepoOptions<TEntity> = {}) {}

  async upsert(entity: TEntity): Promise<string> {
    // Minted from a counter rather than from `entities.length`, which was the
    // first version and is wrong the moment `merge` removes a row: the next
    // upsert would reuse the id of something that had just been merged away, and
    // every engine pointer still on its way to the survivor would land on it.
    this.minted++
    const id = `entity-${this.minted}`
    this.order.set(id, this.minted)
    this.entities.push({ id, entity })
    return id
  }

  async findByKeys(keys: readonly DedupKey[], exclude: string): Promise<DedupMatch | null> {
    const matches = this.options.matches
    if (!matches) return null
    // Keys in the order given, entities in insertion order within each key. The
    // outer loop is the one the port makes a promise about — strongest key first,
    // whatever the stored order — so it has to be the outer one.
    for (const key of keys) {
      for (const row of this.entities) {
        if (row.id === exclude) continue
        if (matches(key, row.entity)) return { id: row.id, kind: key.kind }
      }
    }
    return null
  }

  async merge(into: string, from: string): Promise<void> {
    const target = this.entities.find((row) => row.id === into)
    const index = this.entities.findIndex((row) => row.id === from)
    if (!target) throw new Error(`cannot merge ${from} into ${into}: no such entity`)
    // Already folded by a concurrent run: the same no-op the Postgres repo makes.
    if (index < 0) return
    const duplicate = this.entities[index]
    if (duplicate && this.options.fold)
      target.entity = this.options.fold(target.entity, duplicate.entity)
    this.entities.splice(index, 1)
    this.scores.delete(from)
    this.merges.push({ into, from })
  }

  async writeScores(id: string, scores: ScoreSet): Promise<void> {
    if (!this.entities.some((row) => row.id === id))
      throw new Error(`cannot score ${id}: no such entity`)
    this.scores.set(id, scores)
  }

  /**
   * Insertion order, keyset on the mint counter rather than on the array index.
   *
   * The index would be the obvious thing and it breaks on exactly the case these
   * pages exist for: `merge` splices a row out, every row after it shifts down
   * one, and a caller holding a cursor into the middle then skips a row it has
   * never seen. The counter is the same one `upsert` mints from and it is never
   * reused, so a cursor stays valid across a merge that removed the row it names.
   */
  async page(after: string | null, limit: number): Promise<EntityPage<TEntity>> {
    const from = after === null ? 0 : Number(after)
    if (!Number.isFinite(from)) throw new Error(`not a cursor this repo minted: ${after}`)

    const rows = this.entities
      .map((row) => ({ row, seq: this.order.get(row.id) ?? 0 }))
      .filter((r) => r.seq > from)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)

    const last = rows.at(-1)
    return {
      entities: rows.map((r) => ({ id: r.row.id, entity: r.row.entity })),
      // Null on a short page, which for a fake is also the exhausted page: the
      // real repo cannot know that without an extra row, so it says the same
      // thing the same way and callers cannot come to depend on the difference.
      cursor: rows.length < limit || !last ? null : String(last.seq),
    }
  }
}

/**
 * What an artifact said, before anyone knows which entity it said it about.
 *
 * Every field of an evidence row except `id` and `entityId`, which is exactly
 * the split the real implementation has: those two are the only things the
 * writer's `INSERT … SELECT` does not read straight off the joined artifact.
 */
export interface MemoryClaim extends Omit<EvidenceRecord, "id" | "entityId"> {
  mentionId: string
  domainId: string
}

/**
 * The evidence ports, in memory, over a list of claims (P2.5).
 *
 * The one collaborator is a `MemoryResolutionCache`, and it is not there for
 * convenience: `record` has to skip a mention that did not resolve, and the only
 * thing in this file that knows whether one did is the fake the resolve stage
 * commits to. Handing the writer a separate copy of that answer would let a test
 * prove evidence is written for resolved mentions while the thing the stage
 * actually wrote said `unresolvable`.
 *
 * The claims themselves are added by hand, because the real writer composes a
 * row from a join — `mentions ⋈ raw_items ⋈ harvest_runs` — and a fake that
 * invented the artifact half would be asserting something about a table it has
 * no copy of. What it does reproduce is the pair of behaviours the stage depends
 * on and the SQL gets from a `WHERE` and an `ON CONFLICT`: an unresolved mention
 * writes nothing, and a second call over the same mentions writes nothing again.
 */
export class MemoryEvidence implements EvidenceWriter, EvidenceStore {
  readonly rows: (EvidenceRecord & { domainId: string; mentionId: string })[] = []
  readonly claims: MemoryClaim[] = []
  private minted = 0

  constructor(private readonly cache?: MemoryResolutionCache) {}

  add(...claims: MemoryClaim[]): void {
    this.claims.push(...claims)
  }

  async record(domainId: string, mentionIds: readonly string[]): Promise<number> {
    let written = 0
    for (const mentionId of mentionIds) {
      const claim = this.claims.find((c) => c.mentionId === mentionId && c.domainId === domainId)
      if (!claim) continue
      const entityId = this.cache?.mentions.get(mentionId)?.entityId ?? null
      // The `WHERE mentions.entity_id IS NOT NULL` half. A mention nobody could
      // place has nothing to be evidence *for*, and a row pointing at no entity
      // would be counted by every factor and readable by none.
      if (entityId === null) continue
      // The `ON CONFLICT DO NOTHING` half, on `(domainId, mentionId)`.
      if (this.rows.some((r) => r.domainId === domainId && r.mentionId === mentionId)) continue
      this.minted++
      const { mentionId: _, domainId: __, ...rest } = claim
      this.rows.push({ ...rest, id: `evidence-${this.minted}`, domainId, mentionId, entityId })
      written++
    }
    return written
  }

  async forEntities(
    domainId: string,
    entityIds: readonly string[],
  ): Promise<Map<string, EvidenceRecord[]>> {
    const wanted = new Set(entityIds)
    const out = new Map<string, EvidenceRecord[]>()
    for (const row of this.rows) {
      if (row.domainId !== domainId || !wanted.has(row.entityId)) continue
      const bucket = out.get(row.entityId)
      if (bucket) bucket.push(row)
      else out.set(row.entityId, [row])
    }
    return out
  }
}

/**
 * An `EntityLinks` that moves pointers in memory.
 *
 * It holds the evidence rows itself and borrows the other two from a
 * `MemoryResolutionCache` when it is given one, which is not an asymmetry for
 * its own sake: the cache is already the fake that owns mention state and
 * resolution state, and a second copy of either would let a test assert a merge
 * moved something while the thing the resolve stage actually wrote sat
 * unchanged. Evidence has no fake anywhere else because nothing writes evidence
 * yet — so a test that wants to prove a merge preserves it has to put the rows
 * here by hand, and saying so is better than a zero that looks like a pass.
 */
export class MemoryEntityLinks implements EntityLinks {
  readonly evidence: { id: string; domainId: string; entityId: string }[] = []

  constructor(
    private readonly cache?: MemoryResolutionCache,
    /**
     * P2.5's evidence fake, when a test has one. Its rows are repointed beside
     * this class's own, because from a merge's point of view they are the same
     * table — and a test that materialised evidence properly and then watched a
     * merge leave it on the dead entity would be the failure this port exists
     * to prevent.
     */
    private readonly evidenceRows?: MemoryEvidence,
  ) {}

  /** Put an evidence row on an entity, without going through the writer. */
  addEvidence(
    domainId: string,
    entityId: string,
    id = `evidence-${this.evidence.length + 1}`,
  ): void {
    this.evidence.push({ id, domainId, entityId })
  }

  async repoint(domainId: string, from: string, into: string): Promise<RepointCount> {
    const count: RepointCount = { evidence: 0, mentions: 0, resolutions: 0 }

    for (const row of [...this.evidence, ...(this.evidenceRows?.rows ?? [])]) {
      if (row.domainId === domainId && row.entityId === from) {
        row.entityId = into
        count.evidence++
      }
    }

    const cache = this.cache
    if (cache) {
      for (const mention of cache.mentions.values()) {
        if (mention.entityId === from) {
          mention.entityId = into
          count.mentions++
        }
      }
      for (const row of cache.rows.get(domainId)?.values() ?? []) {
        if (row.entityId === from) {
          row.entityId = into
          count.resolutions++
        }
      }
    }

    return count
  }
}
