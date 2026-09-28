import type { DomainPack } from "./pack.js"
import type { EntityLinks } from "./ports.js"

/**
 * The dedup stage: entities in, fewer entities out, and the engine's pointers
 * moved so that nothing lost its receipts on the way.
 *
 * Generic to the last line, like `extract()` and `resolve()`. It knows that a
 * pack can describe one of its entities as a short ordered list of questions and
 * that the pack's own table can answer them; it never learns what a question
 * means. The three keys section 2.4 names for the first vertical — a source's
 * own identifier, a normalised name within a radius, a similarity above a
 * threshold — do not appear here and could not be written here.
 *
 * Four decisions carry weight.
 *
 * **1. This runs after resolution, over rows that already exist.** It is
 * tempting to put dedup *before* the write, as a check inside `upsert`, and that
 * version is both cheaper and wrong. The duplicates worth collapsing are not two
 * mentions in one batch — the resolve stage already folds those together by key,
 * one answer per key. They are two entities written weeks apart, by two spellings
 * that normalise differently, that turn out to carry the same identifier. Nothing
 * inside a single run can see that pair, so the stage that does has to be able to
 * look at what is already stored.
 *
 * **2. The older row survives, and the page order is how the stage knows which
 * one that is.** It has to be one or the other, and the argument for the older
 * one is that it is what other things have had time to point at — a reader's
 * link, a card on a trip, a score computed last week. Keeping the newcomer would
 * move the most references for the least reason.
 *
 * The engine has no clock over a table it cannot see, so it uses the only
 * ordering it is given: the page arrives oldest first, and a match that sits
 * *later* in that page is merged into the entity being examined rather than the
 * other way round. Everything else — a match earlier in the page, or a match
 * already in the table from a previous run — is older, and the entity being
 * examined is merged into it. A caller walking the table page by page says which
 * rows it has already passed (`earlier`), and then a match on a page it has not
 * reached yet counts as later too; see that option for the bug it closes.
 *
 * The first version of this had no such rule and merged into the match every
 * time, which reads as the same thing and is not: two duplicates in one page are
 * found from the older one first, so *every* same-page merge kept the newer row.
 * It also removes any need for a pack's keys to be symmetric. Deciding the
 * direction at the earlier entity and letting the later one be skipped means a
 * key that finds B from A but not A from B still produces the merge — a rule
 * that waited for the later entity to look back would lose it silently.
 *
 * **3. The engine's side moves first, the pack's table second.** `EntityLinks`
 * then `EntityRepo.merge`, never the other way, and it is an ADR-0014 argument
 * rather than an aesthetic one. A runner is killed between two statements often
 * enough to design for it, and the two orders fail very differently. Cut after
 * the repoint: the evidence is on the survivor, a duplicate row sits there
 * referenced by nothing, and the next run finds it by the same keys and finishes
 * the job. Cut after the merge: the duplicate is gone and its evidence points at
 * an id no row answers to — permanently, silently, with no constraint anywhere to
 * notice, because the engine's reference into a pack's table is opaque by design.
 *
 * **4. A merge already made is followed rather than re-made.** Within one page A
 * can merge into B and C can then match A. A repo that deleted A cannot return
 * it, so this is defence against the repo that tombstones instead — and against
 * the fakes, which are the implementations most likely to keep a merged row
 * visible. The chain is walked with a bound, because a repo that returned a cycle
 * would otherwise hang the runner rather than fail it.
 */

/**
 * An entity as the stage is handed it: the pack's shape, and the id the pack's
 * own repo gave it.
 *
 * Handed in rather than fetched, exactly as `extract()` takes its items and
 * `resolve()` takes its mentions, and for the reason both of them state: paging
 * and its bounded-read refusal belong to the job handler, where "there is more
 * than one page of this" can be acted on. It is also why `EntityRepo` gained no
 * read method in this task — the stage has no use for one, and a port widened
 * for a caller that does not exist yet is a shape guessed at rather than needed.
 */
export interface DedupEntity<TEntity> {
  id: string
  entity: TEntity
}

export interface DedupOptions<TMention, TEntity> {
  pack: DomainPack<TMention, TEntity>
  /** One page, oldest first. See `DedupEntity` for why the caller reads it. */
  entities: readonly DedupEntity<TEntity>[]
  links: EntityLinks
  /**
   * Every id on an earlier page of the same oldest-first walk, when the caller
   * is walking the table a page at a time.
   *
   * Decision 2 needs to know whether a match is older or newer than the entity
   * that found it, and inside the page the position answers that. Outside it,
   * the stage used to assume "older", which is true only when the page is the
   * whole table. A job that pages from the oldest row breaks that in the common
   * case: two duplicates written weeks apart sit on different pages, the older
   * is reached first, and what it finds is outside the page *and newer* — so it
   * was merged away into the newcomer, the exact inversion decision 2 exists to
   * prevent, and no test with a single page could see it.
   *
   * Given this set, a match in neither the page nor the set is on a page not yet
   * read, and so newer. Absent, the single-page premise stands. The engine
   * cannot read the repo's cursor to work this out for itself, because the
   * cursor is opaque by design; the set of ids a caller has already been handed
   * is the one ordering fact both sides can see.
   */
  earlier?: ReadonlySet<string>
  signal?: AbortSignal
}

export interface DedupReport {
  /** Entities handed in. */
  entities: number
  /** Entities whose keys were asked for. */
  examined: number
  /**
   * Entities the pack could offer no key for at all.
   *
   * Counted separately from "examined and not matched", because they are not the
   * same claim. One is the pack looking and finding nothing; the other is the
   * pack having nothing to look with — a row with no identifier, no coordinate
   * and nothing to compare. A rising number here is a resolver problem showing up
   * in the wrong stage's report, and collapsing it into a miss would hide that.
   */
  keyless: number
  /** Entities merged into another. */
  merged: number
  /**
   * Evidence rows moved onto a survivor. Section 2.4's "merge preserves all
   * Evidence", as a number rather than an intention.
   */
  evidence: number
  /** Mention rows repointed. */
  mentions: number
  /** Resolution cache rows repointed. Without these the next run undoes the merge. */
  resolutions: number
  /** Entities skipped because an earlier merge in this same run took them. */
  skipped: number
  /**
   * Which kind of key did the merging, and how often.
   *
   * The counterpart of `ResolveReport.tiers`, and the number this stage is read
   * for. Section 2.4 orders the keys by how much identity each one carries, so a
   * run where the weakest key does most of the work is a run to look at before
   * trusting: it is either finding real duplicates the strong keys cannot see, or
   * welding different entities together on a similarity score. The report cannot
   * tell those apart, which is exactly why it has to show the split rather than a
   * total.
   */
  keys: { kind: string; count: number }[]
  /** True when the signal fired and the page was left part-finished. */
  cancelled: boolean
}

/**
 * How far a chain of merges is followed before the stage gives up on it.
 *
 * A page is bounded by the reader, so a legitimate chain cannot be longer than
 * one page — this bound is not about depth, it is about a repo that hands back a
 * cycle. Failing loudly at a fixed depth turns "the runner hung" into "this repo
 * returned a loop", and only one of those is diagnosable at three in the morning.
 */
const MAX_MERGE_CHAIN = 64

export async function dedup<TMention, TEntity>(
  opts: DedupOptions<TMention, TEntity>,
): Promise<DedupReport> {
  const { pack, links } = opts
  const spec = pack.resolve
  if (!spec) {
    // By name, like `PackRegistry.require` and like the resolve stage. There is
    // nothing to deduplicate that resolution did not write, so a pack arriving
    // here without a resolver is a deployment mistake rather than an empty run.
    throw new Error(`domain pack "${pack.id}" has no resolve spec`)
  }
  const dedupKeys = pack.dedupKeys
  if (!dedupKeys) {
    throw new Error(`domain pack "${pack.id}" has no dedupKeys`)
  }

  const report: DedupReport = {
    entities: opts.entities.length,
    examined: 0,
    keyless: 0,
    merged: 0,
    evidence: 0,
    mentions: 0,
    resolutions: 0,
    skipped: 0,
    keys: [],
    cancelled: false,
  }
  const kinds = new Map<string, number>()
  /** Duplicate id to the id it was merged into, for decision 4. */
  const mergedAway = new Map<string, string>()

  /** Where an id ended up, after however many merges this run has already made. */
  const survivorOf = (id: string): string => {
    let current = id
    for (let hop = 0; hop < MAX_MERGE_CHAIN; hop++) {
      const next = mergedAway.get(current)
      if (next === undefined) return current
      current = next
    }
    throw new Error(`merge chain from "${id}" did not settle in ${MAX_MERGE_CHAIN} hops`)
  }

  /**
   * Where each entity sits in the page, for decision 2. Built up front rather
   * than searched, because the alternative is an `indexOf` per match and this is
   * the one thing the stage knows that the repo does not.
   */
  const position = new Map(opts.entities.map((row, index) => [row.id, index]))

  for (const [index, { id, entity }] of opts.entities.entries()) {
    if (opts.signal?.aborted) {
      // Stop where we are rather than finishing the page. Every merge so far is
      // already committed on its own, and the entities not reached are simply
      // still there — this stage is idempotent, so the next run does them.
      report.cancelled = true
      break
    }

    if (mergedAway.has(id)) {
      report.skipped++
      continue
    }

    const keys = dedupKeys(entity)
    report.examined++
    if (keys.length === 0) {
      report.keyless++
      continue
    }

    const match = await spec.repo.findByKeys(keys, id)
    if (!match) continue

    const target = survivorOf(match.id)
    // A repo that tombstones rather than deletes can hand back a row this run
    // already folded into the entity now being examined. Merging it back is a
    // cycle of two, so the match is dropped: on the next run only one of the
    // pair still exists and the question does not arise.
    if (target === id) continue

    // A match that is still itself and sits later in the page — or, for a caller
    // walking page by page, on a page it has not read yet — is the newer row
    // (decision 2). A match that has already been merged is not a candidate for
    // this at all — whatever absorbed it was examined earlier, and is therefore
    // older than the entity in hand.
    const matchPosition = position.get(match.id)
    const later =
      matchPosition !== undefined
        ? matchPosition > index
        : opts.earlier !== undefined && !opts.earlier.has(match.id)
    const newer = target === match.id && later
    const survivor = newer ? id : target
    const duplicate = newer ? target : id

    const moved = await links.repoint(pack.id, duplicate, survivor)
    await spec.repo.merge(survivor, duplicate)

    mergedAway.set(duplicate, survivor)
    report.merged++
    report.evidence += moved.evidence
    report.mentions += moved.mentions
    report.resolutions += moved.resolutions
    kinds.set(match.kind, (kinds.get(match.kind) ?? 0) + 1)
  }

  report.keys = [...kinds.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1))
  return report
}
