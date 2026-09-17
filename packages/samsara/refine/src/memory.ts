import type { MentionRow, MentionSink } from "./ports.js"

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
