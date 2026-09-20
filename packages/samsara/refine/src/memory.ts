import type { ResolutionState } from "@samsara/core"
import type { DedupKey, DedupMatch, EntityRepo } from "./pack.js"
import type {
  CachedResolution,
  EntityLinks,
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
  private minted = 0

  constructor(private readonly options: MemoryEntityRepoOptions<TEntity> = {}) {}

  async upsert(entity: TEntity): Promise<string> {
    // Minted from a counter rather than from `entities.length`, which was the
    // first version and is wrong the moment `merge` removes a row: the next
    // upsert would reuse the id of something that had just been merged away, and
    // every engine pointer still on its way to the survivor would land on it.
    this.minted++
    const id = `entity-${this.minted}`
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
    if (!target || index < 0) throw new Error(`cannot merge ${from} into ${into}: no such entity`)
    const duplicate = this.entities[index]
    if (duplicate && this.options.fold)
      target.entity = this.options.fold(target.entity, duplicate.entity)
    this.entities.splice(index, 1)
    this.merges.push({ into, from })
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

  constructor(private readonly cache?: MemoryResolutionCache) {}

  /** Put an evidence row on an entity, since no stage does it yet. */
  addEvidence(
    domainId: string,
    entityId: string,
    id = `evidence-${this.evidence.length + 1}`,
  ): void {
    this.evidence.push({ id, domainId, entityId })
  }

  async repoint(domainId: string, from: string, into: string): Promise<RepointCount> {
    const count: RepointCount = { evidence: 0, mentions: 0, resolutions: 0 }

    for (const row of this.evidence) {
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
