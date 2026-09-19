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
  /**
   * Always null, and typed as the literal rather than `string | null`.
   *
   * This is the shape the *extract* stage inserts, and extraction cannot know
   * an entity id — the resolve stage does not write `MentionRow`s, it updates
   * mentions through `ResolutionCache.commit`. P2.3 widened the read side
   * (`MentionRecord.entityId`) and deliberately left this alone: a write type
   * that can only express what the writer is allowed to say is worth more than
   * one that matches the column.
   */
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

/**
 * A mention the resolve stage has been handed, with the artifact it came from.
 *
 * The item is here rather than fetched by the pack because `ResolveCtx` needs
 * it for Tier 0 and because the join is one query for a page of mentions and N
 * queries if each resolver does it. It is the same narrow `ExtractItem` the
 * extractor saw — narrow for the same reasons, which do not stop applying
 * because a different stage is asking.
 */
export interface PendingMention {
  id: string
  rawItemId: string
  domainId: string
  packVersion: string
  /** Opaque, exactly as stored. The stage re-validates it against the pack's schema. */
  payload: unknown
  item: ExtractItem
}

/**
 * The resolve stage's read side: mentions nobody has worked out yet.
 *
 * Separate from `MentionStore` even though both read mentions, because they are
 * read by different callers for different reasons. `MentionStore.list` serves a
 * lab screen and returns what a person needs to judge a row — the source, the
 * URL, the title. This returns what a *resolver* needs, which is the item's full
 * text, because that is where ADR-0017's Tier 0 finds its coordinates. Merging
 * them would mean the API's reader pulling whole forum threads it never renders.
 */
export interface PendingMentionReader {
  /**
   * Oldest first, always bounded by `MENTION_LIST_LIMIT`.
   *
   * Oldest rather than newest, unlike every other list in the codebase, and the
   * inversion is deliberate: this is a work queue rather than a view. Newest
   * first would re-read the same page every run while the backlog behind it
   * aged, which is starvation dressed as progress.
   */
  pending(domainId: string, limit?: number): Promise<PendingMention[]>
}

/** What the cache knows about one key. */
export interface CachedResolution {
  state: ResolutionState
  entityId: string | null
  tier: number | null
  confidence: number | null
  /** Deferred attempts so far. See `entityResolution` in `@samsara/core`. */
  attempts: number
}

/**
 * One key's outcome, and the mentions that were waiting on it.
 *
 * Written as a single call rather than "update the cache, then update the
 * mentions" because the two halves must not be separable. A runner under
 * ADR-0014 can be killed between any two statements, and the order that
 * survives being cut in half is the one where a cache row never claims an
 * entity that no mention points at, or the reverse. An implementation backed by
 * a database is expected to do both in one transaction; the in-memory one does
 * both before it returns.
 */
export interface ResolutionCommit {
  domainId: string
  key: string
  /** Every pending mention that shares this key. Often more than one — that is the point. */
  mentionIds: readonly string[]
  state: ResolutionState
  entityId: string | null
  tier: number | null
  confidence: number | null
  /**
   * Whether this attempt could not look, as opposed to having looked and found
   * nothing. Only the former is counted, and the store increments rather than
   * being told a total, so two runners racing the same key cannot both write 1.
   */
  deferred: boolean
}

/**
 * The resolve stage's one port: what has been worked out about a key, and where
 * to put what gets worked out next.
 *
 * A sink that also reads, like `MentionSink` and for the same reason — the read
 * exists so the stage does not pay twice for work it has already done, which is
 * not the API's read side and has no business being reachable from it.
 */
export interface ResolutionCache {
  /**
   * What is known about these keys. Keys with no row are absent from the map
   * rather than present with a `pending` value: "never asked" and "asked and
   * still pending" differ by an attempt count that the caller must not have to
   * reconstruct from a default.
   */
  read(domainId: string, keys: readonly string[]): Promise<Map<string, CachedResolution>>
  commit(entry: ResolutionCommit): Promise<void>
}
