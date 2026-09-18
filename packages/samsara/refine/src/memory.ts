import type {
  MentionFilter,
  MentionRecord,
  MentionRow,
  MentionSink,
  MentionStore,
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
