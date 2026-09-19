import type { DomainPack, ResolveCtx, ResolveSpec } from "./pack.js"
import type { PendingMention, ResolutionCache, ResolutionCommit } from "./ports.js"

/**
 * The resolve stage: pending Mentions in, entities out, and a cache in between
 * that is the only reason the arithmetic works.
 *
 * Generic to the last line, like `extract()`. It knows a pack can normalise a
 * name into a key and can turn a mention into an entity; it never learns what
 * either means. The tiers live in the pack — ADR-0017 numbers them and
 * `@dt/travel-pack` implements them — and this file could not name one if it
 * wanted to.
 *
 * Four decisions carry the weight.
 *
 * **1. Work is done per key, not per mention.** A week of harvests names the
 * same handful of entities repeatedly: that is what a corpus of opinions about
 * one city *is*. Resolving each mention separately would multiply every tier's
 * cost by however often a name happens to be popular, and the tier that gets
 * multiplied is the metered one. So mentions are grouped by `spec.key(mention)`
 * first, `resolve` is called once per distinct key, and every mention sharing
 * that key is pointed at the same answer. The report says both numbers, because
 * the ratio between them is the thing worth watching.
 *
 * **2. `unresolvable` and `deferred` are different events.** The sharp one, and
 * the reason `Resolution` has three variants where two would have compiled.
 * `unresolvable` is terminal — it is written to the cache and no later run asks
 * again. "I could not look" must therefore never take that branch, or the day a
 * free tier's daily quota runs out is the day every name still in the queue is
 * permanently marked as having no answer, and nothing afterwards would ever
 * revisit it. A `deferred` attempt increments a counter and leaves the key
 * pending; only after `maxAttempts` of them does the stage give up, and when it
 * does, it says so in the report rather than in the same bucket as a real miss.
 *
 * **3. The attempt counter lives on the key.** Consequence of 1 and 2 together.
 * Twelve mentions of one name that cannot be looked up cost N attempts between
 * them, not twelve times N. Had the column been on `mentions` — which is where
 * it would naturally go, since that is the row with a state — the budget this
 * stage exists to protect would be multiplied by exactly the popularity that
 * made the name worth resolving.
 *
 * **4. A stored payload is re-validated before the pack sees it.** `payload` is
 * `unknown` because it came back out of a jsonb column, and a pack that has
 * since changed its `mentionSchema` will have rows that no longer parse. Those
 * are counted as `invalid` and skipped rather than handed to a resolver that
 * would read fields that are not there. The same goes the other way: what a
 * resolver returns is checked against `entitySchema` before the repo is asked
 * to write it, because the repo is the pack's own table and the engine is the
 * one holding the pen.
 */

/**
 * How many `deferred` attempts a key gets before the stage writes it off.
 *
 * Three, matching `jobs.max_attempts`, and for the same reason: the failures
 * this counts are transient by definition — a spent quota, a provider having a
 * bad minute — and something transient that has survived three separate runner
 * invocations is not transient. It is deliberately not larger. Under ADR-0014
 * each attempt is a different scheduled run on a different day, so three
 * attempts is already the better part of a week of asking.
 */
export const DEFAULT_RESOLVE_ATTEMPTS = 3

export interface ResolveOptions<TMention, TEntity> {
  pack: DomainPack<TMention, TEntity>
  /**
   * The page to work through, handed in rather than read.
   *
   * Same shape as `extract()`, and the same reason: paging and its bounded-read
   * refusal belong to the job handler, which is where the decision "there is
   * more than one page of this" can be acted on. A stage that fetched its own
   * work would have to decide what to do when it filled its bound, and the
   * honest answer to that is not available from in here.
   */
  mentions: readonly PendingMention[]
  cache: ResolutionCache
  /** Granted by the caller, not built here. See `LookupPort` for why it is optional. */
  lookup?: ResolveCtx["lookup"]
  signal?: AbortSignal
}

export interface ResolveReport {
  /** Mentions handed in. */
  mentions: number
  /** Distinct keys among them. `mentions / keys` is the saving the cache exists for. */
  keys: number
  /** Keys answered from the cache without calling the pack at all. */
  cached: number
  /** Keys the pack was asked about. */
  asked: number
  /** Keys that came back resolved. */
  resolved: number
  /** Keys the pack looked for and could not find. */
  unresolvable: number
  /** Keys that ran out of attempts and were written off. Counted inside `unresolvable` too. */
  exhausted: number
  /** Keys left pending because an attempt could not look. */
  deferred: number
  /** Mentions whose stored payload no longer matches the pack's schema. Skipped. */
  invalid: number
  /** Entities written through the pack's repo. */
  entities: number
  /**
   * Which tier answered, and how often. **This is P2.3's acceptance criterion**,
   * which is why it is a field and not a log line: if tier 2 carries more than a
   * fifth of these, tiers 0 and 1 are underbuilt and that is the bug.
   */
  tiers: { tier: number; count: number }[]
  /** Why the deferred attempts deferred. Empty on a clean run. */
  deferrals: { reason: string; count: number }[]
}

/** Written once so the two places that end a key agree on what a commit looks like. */
const commitOf = (
  domainId: string,
  key: string,
  mentionIds: readonly string[],
  over: Partial<ResolutionCommit>,
): ResolutionCommit => ({
  domainId,
  key,
  mentionIds,
  state: "pending",
  entityId: null,
  tier: null,
  confidence: null,
  deferred: false,
  ...over,
})

export async function resolve<TMention, TEntity>(
  opts: ResolveOptions<TMention, TEntity>,
): Promise<ResolveReport> {
  const { pack, cache } = opts
  const spec: ResolveSpec<TMention, TEntity> | undefined = pack.resolve
  if (!spec) {
    // By name, like `PackRegistry.require`. A pack reaching this stage without a
    // resolver is a deployment mistake rather than an ordinary missing value,
    // and it should say so once and loudly instead of resolving nothing and
    // reporting a clean run over a corpus it never touched.
    throw new Error(`domain pack "${pack.id}" has no resolve spec`)
  }
  const maxAttempts = Math.max(1, spec.maxAttempts ?? DEFAULT_RESOLVE_ATTEMPTS)

  /**
   * Validate, then hand to the pack's repo. Null when the entity does not parse.
   *
   * A `const` arrow rather than a declaration at the foot of the function, which
   * is where it started: declarations hoist, so TypeScript will not carry the
   * narrowing of `spec` into one and the body reads `spec` as possibly
   * undefined. The arrow closes over the narrowed binding instead.
   */
  const write = async (entity: TEntity): Promise<string | null> => {
    const checked = spec.entitySchema.safeParse(entity)
    if (!checked.success) {
      report.invalid++
      return null
    }
    const id = await spec.repo.upsert(checked.data)
    report.entities++
    return id
  }

  const report: ResolveReport = {
    mentions: opts.mentions.length,
    keys: 0,
    cached: 0,
    asked: 0,
    resolved: 0,
    unresolvable: 0,
    exhausted: 0,
    deferred: 0,
    invalid: 0,
    entities: 0,
    tiers: [],
    deferrals: [],
  }
  const tiers = new Map<number, number>()
  const deferrals = new Map<string, number>()

  /**
   * Grouped before anything is asked, and grouped in insertion order so a run is
   * reproducible from its input — the same property `extract()`'s batching has.
   * The first mention of each key is kept as the one to resolve *from*: the
   * pack's resolver reads the artifact through `ctx.item`, and several artifacts
   * naming one entity would each give a different Tier 0 answer, so picking the
   * first deterministically beats picking whichever the map iterated to.
   */
  const groups = new Map<string, { first: PendingMention; ids: string[] }>()
  for (const mention of opts.mentions) {
    const parsed = pack.extract.mentionSchema.safeParse(mention.payload)
    if (!parsed.success) {
      report.invalid++
      continue
    }
    const key = spec.key(parsed.data)
    const group = groups.get(key)
    if (group) group.ids.push(mention.id)
    else groups.set(key, { first: mention, ids: [mention.id] })
  }
  report.keys = groups.size
  if (groups.size === 0) return report

  const known = await cache.read(pack.id, [...groups.keys()])

  for (const [key, group] of groups) {
    const cached = known.get(key)

    /**
     * A key already settled costs nothing and is not asked again — that is the
     * cache's entire job. Its mentions are still committed, because they are
     * new mentions of an old answer and nothing has pointed them at it yet.
     */
    if (cached && cached.state !== "pending") {
      report.cached++
      if (cached.tier !== null) tiers.set(cached.tier, (tiers.get(cached.tier) ?? 0) + 1)
      await cache.commit(
        commitOf(pack.id, key, group.ids, {
          state: cached.state,
          entityId: cached.entityId,
          tier: cached.tier,
          confidence: cached.confidence,
        }),
      )
      continue
    }

    const attempts = cached?.attempts ?? 0
    if (attempts >= maxAttempts) {
      /**
       * Out of attempts. Written off as `unresolvable` with no tier, which is
       * distinguishable from a tier-3 miss precisely because the tier is null:
       * one means "every tier was tried and none knew", the other means "we
       * stopped trying". Both stop the work; only one is a statement about the
       * entity, and a screen asking what the resolver is missing needs to be
       * able to tell them apart.
       */
      report.exhausted++
      report.unresolvable++
      await cache.commit(commitOf(pack.id, key, group.ids, { state: "unresolvable" }))
      continue
    }

    report.asked++
    const ctx: ResolveCtx = {
      item: group.first.item,
      ...(opts.lookup === undefined ? {} : { lookup: opts.lookup }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    }
    const parsed = pack.extract.mentionSchema.safeParse(group.first.payload)
    // Cannot fail: the payload parsed once already, on the way into `groups`.
    // Re-parsed rather than carried so that `groups` holds the row and not a
    // second half-typed copy of it.
    if (!parsed.success) continue
    const outcome = await spec.resolve(parsed.data, ctx)

    if (outcome.outcome === "deferred") {
      report.deferred++
      deferrals.set(outcome.reason, (deferrals.get(outcome.reason) ?? 0) + 1)
      /**
       * The mentions are committed too, and stay `pending`. That looks like a
       * no-op and is not: it is what creates the cache row the *next* run reads
       * its attempt count from. Without it a key that can never be looked up
       * would be attempted forever, one fresh row at a time.
       */
      await cache.commit(commitOf(pack.id, key, group.ids, { deferred: true }))
      continue
    }

    if (outcome.outcome === "unresolvable") {
      report.unresolvable++
      tiers.set(outcome.tier, (tiers.get(outcome.tier) ?? 0) + 1)
      // An entity is still written when the pack supplied one — P2.3's plan
      // entry asks for exactly this, so that a name nobody can place is visible
      // rather than absent. Absent is indistinguishable from never extracted.
      const entityId = outcome.entity === undefined ? null : await write(outcome.entity)
      await cache.commit(
        commitOf(pack.id, key, group.ids, {
          state: "unresolvable",
          entityId,
          tier: outcome.tier,
        }),
      )
      continue
    }

    const entityId = await write(outcome.entity)
    if (entityId === null) {
      // The entity failed the pack's own schema. Not the pack's fault and not
      // the engine's to paper over: counted as invalid and left pending, so a
      // fixed resolver gets the key back rather than finding it written off.
      await cache.commit(commitOf(pack.id, key, group.ids, { deferred: true }))
      report.deferred++
      deferrals.set("provider", (deferrals.get("provider") ?? 0) + 1)
      continue
    }
    report.resolved++
    tiers.set(outcome.tier, (tiers.get(outcome.tier) ?? 0) + 1)
    await cache.commit(
      commitOf(pack.id, key, group.ids, {
        state: "resolved",
        entityId,
        tier: outcome.tier,
        confidence: outcome.confidence,
      }),
    )
  }

  report.tiers = [...tiers.entries()]
    .map(([tier, count]) => ({ tier, count }))
    .sort((a, b) => a.tier - b.tier)
  report.deferrals = [...deferrals.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
  return report
}
