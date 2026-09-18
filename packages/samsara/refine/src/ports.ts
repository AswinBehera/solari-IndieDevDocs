import type { ResolutionState } from "@samsara/core"

/**
 * The refine ports, and nothing that implements them.
 *
 * Same division as `@samsara/harvest/ports`: a caller may want the types without
 * the module. Nothing here imports a value, and if something in this file ever
 * needs to, it belongs in a sibling instead.
 */

/**
 * What the extract stage reads out of a RawItem, and deliberately not the row.
 *
 * `@samsara/core`'s `RawItem` carries `rawRef`, `mediaRefs`, `engagement`, `rank`
 * and the timestamps. None of them are things an extractor should see: `rank` is
 * the surface's opinion and would leak a ranking signal into an entity's
 * description, `rawRef` is a storage key, and `engagement` belongs to scoring,
 * where it can be weighed against evidence from other sources rather than quietly
 * flattering whichever item happened to go viral.
 *
 * A narrow input type is also what makes `batchBy` honest. A pack grouping by
 * `languageGuess` is grouping by something the engine can explain; a pack that
 * could reach `engagement` would eventually group by it, and the reason would
 * live in the pack where the engine could not see it.
 *
 * `RawItemRow` from `@samsara/harvest/ports` satisfies this structurally, so the
 * worker passes its rows straight through.
 */
export interface ExtractItem {
  id: string
  sourceId: string
  url: string
  title: string | null
  text: string
  /** What the source or a cheap detector claimed. Not authoritative — see the column. */
  languageGuess: string | null
}

/**
 * A Mention as the engine writes it: the pack's payload, and the four columns
 * around it that the engine owns.
 *
 * `payload` is `unknown` here on purpose. It has already been validated against
 * the pack's `mentionSchema` by the time it reaches a sink, and re-typing it
 * would give the storage layer an opinion about a shape that is none of its
 * business — the seam that section 3 states as "an engine table never holds a
 * foreign key to a travel table" is the same seam in the type system.
 */
export interface MentionRow {
  id: string
  rawItemId: string
  domainId: string
  packVersion: string
  payload: unknown
  /** Null until the resolve stage (P2.3) says otherwise. */
  entityId: null
  resolution: ResolutionState
  confidence: number
}

export interface MentionSink {
  /**
   * One call for the whole batch, not one per row, for the same reason
   * `RawItemStore.insertMany` says so: twenty round trips inside a runner that
   * may be cancelled at any moment is twenty chances to be cancelled holding
   * half a batch.
   */
  insertMany(rows: readonly MentionRow[]): Promise<void>

  /**
   * Which of these raw items already have mentions for this pack version.
   *
   * The stage is re-run constantly — §8's "refine runs cost zero Solari minutes"
   * is an invitation to re-run it — and the whole point of storing RawItems
   * verbatim is that re-extraction never reopens a browser. What it *does* spend
   * is tokens, on the one meter Phase 2 can actually exhaust. So the stage asks
   * first, and an item already extracted at this pack version is skipped rather
   * than paid for twice.
   *
   * Keyed on `(rawItemId, domainId, packVersion)` because a version bump is
   * exactly the case where re-extraction is wanted: new prompt, new answer.
   */
  extractedIds(
    rawItemIds: readonly string[],
    domainId: string,
    packVersion: string,
  ): Promise<Set<string>>
}

/**
 * The bound on a mention list read.
 *
 * A hundred, like `ITEM_LIST_LIMIT`, and for the same reason: this is read by a
 * lab screen a person scrolls, and the honest failure of an unbounded list is not
 * a slow query but a page that renders eleven thousand rows and stops responding.
 */
export const MENTION_LIST_LIMIT = 100

export interface MentionFilter {
  domainId?: string
  packVersion?: string
  resolution?: ResolutionState
  /** One item's mentions, for the "why did it say that" view. */
  rawItemId?: string
  limit?: number
}

/**
 * A mention as a reader gets it back: the stored row, plus the item it came from.
 *
 * The join is not a convenience. A mention on its own is a name and a confidence
 * with no way to check either — the whole question a reviewer asks is "is that
 * really what the post said", and answering it needs the source, the URL and the
 * language the item was written in. Returning them together is what makes one
 * request enough to render a row, rather than one request plus N.
 *
 * `payload` stays `unknown` here exactly as it is in `MentionRow`. The engine
 * stores what the pack validated and hands it back unread; giving this type a
 * travel shape is the seam breaking in the place it is least likely to be noticed.
 */
export interface MentionRecord {
  id: string
  rawItemId: string
  domainId: string
  packVersion: string
  payload: unknown
  /** Set once the resolve stage (P2.3) has pointed it at an entity. */
  entityId: string | null
  resolution: ResolutionState
  confidence: number
  createdAt: Date
  item: {
    sourceId: string
    url: string
    title: string | null
    languageGuess: string | null
  }
}

/**
 * The read side, separate from the sink because the callers are.
 *
 * The worker writes and never reads back; the API reads and must never write.
 * Two interfaces rather than one is what lets the API hold an implementation
 * that has no `insertMany` on it at all.
 */
export interface MentionStore {
  list(filter: MentionFilter): Promise<MentionRecord[]>
}
