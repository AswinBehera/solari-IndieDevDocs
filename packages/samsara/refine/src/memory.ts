import type { ResolutionState } from "@samsara/core"
import type { EntityRepo } from "./pack.js"
import type {
  CachedResolution,
  MentionFilter,
  MentionRecord,
  MentionRow,
  MentionSink,
  MentionStore,
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
 * An `EntityRepo` that keeps entities in an array and hands back their index.
 *
 * Deliberately does no deduplication at all, because `EntityRepo.upsert` says it
 * must not: collapsing two spellings of one name is P2.4's job, and a fake that
 * did it early would make this stage's tests pass over the exact behaviour P2.4
 * is measured on.
 */
export class MemoryEntityRepo<TEntity> implements EntityRepo<TEntity> {
  readonly entities: { id: string; entity: TEntity }[] = []

  async upsert(entity: TEntity): Promise<string> {
    const id = `entity-${this.entities.length + 1}`
    this.entities.push({ id, entity })
    return id
  }
}
