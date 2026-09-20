import type { PromptRef } from "@samsara/llm"
import type { z } from "zod"
import type { ExtractItem } from "./ports.js"

/**
 * The `DomainPack` contract — the identity half, and now the extract half.
 *
 * Section 2.5 specifies the whole thing — `extract`, `entity`, `resolve`,
 * `dedupKeys`, `score`, `sources`, `queries` — and P2.2 to P2.5 build the
 * pipeline that consumes it. **P2.2 widens only as far as it has a consumer.**
 * The reason is the one the identity-only version already gave and which has
 * survived being tested: writing `resolve` and `score` now means inventing
 * `ResolveCtx`, `EntityRepo` and `ScoreSet` against no caller, and a contract
 * shaped by guesses is exactly what P2.8 exists to catch — after it is expensive
 * to change. `extract` is written here because `extract.ts` in this package calls
 * every member of it.
 *
 * What P0.5 needed was narrower still: a registry that is typed, that
 * `apps/worker` holds at boot, and that has **zero packs in it**. An empty
 * registry is not a placeholder — it is the assertion that the runner has no
 * vertical compiled into it.
 */
export interface DomainPackIdentity {
  /** `"travel"`. Stamped on every Mention, Evidence, Session and Job row. */
  id: string
  /**
   * Bumped when prompts or weights change; stored with each Mention and Evidence
   * row, and part of the key the extract stage skips already-done work on. A
   * pack that edits its prompt without bumping this will read its old answers as
   * if the new prompt had produced them.
   */
  version: string
}

/**
 * How a pack wants its raw items turned into mentions.
 *
 * The engine owns the batching, the call, the retry and the accounting. The pack
 * owns what a mention *is* and what to ask for — and it owns them as data, not as
 * a callback, so that the same pack can be handed to a comparison harness or to
 * a golden-set test without a pipeline underneath it.
 */
export interface ExtractSpec<TMention> {
  /** What one mention must look like. Validated per mention, not per batch — see `extract.ts`. */
  mentionSchema: z.ZodType<TMention>
  /**
   * The pack's prompt. It must declare an `items` variable, which the engine
   * fills with the rendered batch; declaring anything else is a `config` failure
   * at call time, because `PromptRef.render` refuses a variable nobody supplied.
   */
  prompt: PromptRef
  /**
   * The grouping key for a call, e.g. the detected language.
   *
   * Items sharing a key are asked for together. This is a knob with teeth: §8
   * says to batch roughly twenty items per call because the prompt is identical
   * every time and sending it per item is pure waste, and grouping by language
   * is what keeps one call from being a request to read Thai, English and
   * Vietnamese in a single breath.
   */
  batchBy: (item: ExtractItem) => string
  /**
   * Items per call. Defaults to `DEFAULT_BATCH_SIZE` (§8's "roughly 20").
   *
   * A pack whose items are long may want fewer, and the failure mode of getting
   * this wrong is a truncated answer, which P2.1 classifies as `config` and
   * refuses to retry — deliberately, because it names this number.
   */
  batchSize?: number
  /**
   * Per-item character cap on the text sent, defaulting to `DEFAULT_ITEM_CHARS`.
   *
   * A forum thread can be tens of kilobytes and a batch of twenty of them is a
   * request nobody priced. Truncation is marked in the rendered item so the model
   * is not silently asked to summarise something it was only shown the start of.
   */
  maxItemChars?: number
}

/**
 * One hosted lookup, and the only way a pack is allowed to make one.
 *
 * ADR-0017's Tier 2 is a free-tier hosted service, and §8 puts a ceiling of 800
 * calls a day on it. That ceiling is decorative the moment a pack can reach
 * `fetch` itself, so the engine hands the capability down instead: whatever is
 * behind this has already been wrapped in the budget guard.
 *
 * It is optional on the context on purpose. A pack that finds it absent has not
 * been granted the tier — it must not reach around it, and it must not report
 * the mention as `unresolvable` *on the strength of a tier it never ran*.
 */
export interface LookupPort {
  /**
   * `query` is the pack's text and `near` an optional bias. Both are opaque to
   * the engine, which counts the call and forwards it.
   */
  lookup(query: string, near?: { lat: number; lng: number }): Promise<LookupResult>
}

export interface LookupHit {
  lat: number
  lng: number
  /** The provider's own id for this result, for `externalRef`. */
  ref: string
  confidence: number
}

/**
 * Found nothing, or could not look. Two different things, and this type is the
 * reason a pack can tell them apart.
 *
 * The first draft returned `Promise<LookupHit[]>` and said a refusal would
 * "arrive as a thrown `budget` failure". Building the first real consumer showed
 * that for what it was: an empty array is what a geocoder returns when it has
 * never heard of a place, and it is also what a wrapper returns when the daily
 * quota is spent, and a pack cannot distinguish them without catching an
 * exception and inspecting its shape. Getting that wrong is not a small bug —
 * `unresolvable` is terminal, so the day the quota runs out would be the day
 * every remaining mention is permanently recorded as having no answer.
 *
 * So the refusal is in the return type, and its reasons are spelled exactly like
 * `Resolution`'s deferral reasons, so a pack forwards one rather than
 * translating it and inventing a difference on the way.
 */
export type LookupResult =
  | { ok: true; hits: LookupHit[] }
  | { ok: false; reason: "budget" | "provider" | "cancelled" }

/** What the engine gives a pack's resolver, and nothing more. */
export interface ResolveCtx {
  /**
   * The artifact this mention was found in.
   *
   * Plan section 2.5 writes the signature as `resolve(m, ctx)` and it would be
   * easy to read that as "the mention is all a resolver gets". It cannot be:
   * ADR-0017's Tier 0 — the free, exact, primary path — reads coordinates that
   * are *already in the harvested artifact*, in map links and captions that no
   * mention schema quotes. A resolver without the item has no Tier 0, and a
   * resolver without Tier 0 fails P2.3's acceptance by construction.
   *
   * It is `ExtractItem` rather than the row, for the reasons that type already
   * gives: `rank` is the surface's opinion and `engagement` belongs to scoring,
   * and a resolver able to reach either would eventually weigh one.
   */
  item: ExtractItem
  /** Absent unless the caller granted the metered tier. See `LookupPort`. */
  lookup?: LookupPort
  /** The runner's. A resolver doing network work should pass it on. */
  signal?: AbortSignal
}

/**
 * What one attempt at resolution concluded. Three outcomes, not two.
 *
 * The split between `unresolvable` and `deferred` is the load-bearing part, and
 * it exists because `unresolvable` is terminal. "I looked through every tier and
 * there is nothing" and "I could not look" are the same event from the outside
 * and opposite events in a week's time: the first is a fact about a name, the
 * second is a fact about a Tuesday. Collapsing them means the day a free tier's
 * daily quota runs out is the day every name still in the queue is permanently
 * marked as having no answer — and nothing afterwards would ever ask again.
 */
export type Resolution<TEntity> =
  | {
      outcome: "resolved"
      entity: TEntity
      /** Which tier answered, lowest first, as ADR-0017 orders them. */
      tier: number
      confidence: number
    }
  | {
      outcome: "unresolvable"
      /**
       * Optional, and the reason P2.3's plan entry says unresolved mentions
       * "still produce an entity, flagged": a name nobody can put on a map is
       * still a name worth carrying, and dropping it here would make the gap
       * invisible to the screen whose job is to show it.
       */
      entity?: TEntity
      tier: number
    }
  | {
      outcome: "deferred"
      /**
       * A class, never a message. These strings reach a lab screen served out of
       * a public repository, and a provider's error text can quote a URL or a
       * key. Same rule as the kernel's closed log union (ADR-0014).
       */
      reason: "budget" | "provider" | "cancelled"
    }

/**
 * One way of asking "is this the same thing as something already stored".
 *
 * `kind` is the pack's own name for the question — the engine prints it in the
 * report and never interprets it. `value` is whatever the pack's repo needs to
 * ask it, and is `unknown` for the reason `MentionRow.payload` is: the two ends
 * of this are the pack's `dedupKeys` and the pack's own repo, and a type in
 * between would be the engine having an opinion about a table it cannot see.
 *
 * A key is deliberately not a string. The first draft made it one, on the
 * reasoning that a normalised name *is* a string and two equal strings are a
 * duplicate — and that draft could express only the strongest of the three keys
 * section 2.4 names. A radius around a coordinate and a similarity above a
 * threshold are both questions with no exact answer to hash, and a contract that
 * could not ask them would have quietly limited dedup to exact matching while
 * appearing to be general.
 */
export interface DedupKey {
  /** The pack's name for this kind of question. Counted in the report, never read. */
  kind: string
  /** Opaque. Built by `dedupKeys`, consumed by the same pack's repo. */
  value: unknown
}

/** Which stored entity a key found, and which key found it. */
export interface DedupMatch {
  /** The survivor. The entity being examined is merged into this one. */
  id: string
  /** The `kind` of the key that matched. The report counts these; see `DedupReport`. */
  kind: string
}

/**
 * A pack's own table, as the engine is allowed to see it.
 *
 * Ownership is inverted exactly as plan section 2.5 says: the engine calls this,
 * and never imports the table behind it. P2.3 needed one method; P2.4 adds the
 * two the dedup stage calls, which is the same discipline `ExtractSpec` was
 * written under.
 */
export interface EntityRepo<TEntity> {
  /**
   * Write the entity and return its id.
   *
   * No deduplication is expected here. Two resolutions of two spellings of one
   * name legitimately produce two rows at this stage; collapsing them is P2.4's
   * whole job, and a repo that quietly did it early would hide the thing P2.4
   * is measured on.
   */
  upsert(entity: TEntity): Promise<string>

  /**
   * The first of these keys that matches a stored entity other than `exclude`,
   * or null.
   *
   * **The order of `keys` is the engine's and the repo must honour it.** Section
   * 2.4 says strongest first, and the reason is not tidiness: the weakest key is
   * also the most expensive one to ask — a similarity search is a scan where an
   * exact reference is an index lookup — so stopping at the first hit is what
   * keeps dedup affordable, and stopping at the *wrong* first hit is how two
   * different entities get welded together on the flimsiest evidence available.
   *
   * The whole list goes in one call rather than one call per key, and that is
   * the one place this contract asks the repo to do the walking. It is not a
   * concession: an engine looping from outside pays a round trip per key, and an
   * engine that batched to avoid that would have to run every key including the
   * expensive one. Only the repo can have both, and returning the matching
   * `kind` is what keeps it honest — a repo that ignored the order says so in
   * the report, in the column the stage exists to produce.
   *
   * `exclude` is not optional and is not a convenience. The entity being
   * examined is already in this table — the resolve stage wrote it — so every
   * one of its own keys matches itself, and a repo asked without an exclusion
   * would report every entity as a duplicate of itself on the first call.
   */
  findByKeys(keys: readonly DedupKey[], exclude: string): Promise<DedupMatch | null>

  /**
   * Fold `from` into `into`, and leave only `into`.
   *
   * What folding means is the pack's, because only the pack knows which of two
   * rows holds the better answer — the engine cannot tell a coordinate found by
   * a cheap exact method from one found by an expensive approximate one, and
   * that comparison is the whole of it.
   *
   * Called **after** the engine has repointed everything on its own side (see
   * `EntityLinks`), and the order is load-bearing under ADR-0014: a runner cut
   * in half between the two leaves evidence pointing at the survivor and a
   * duplicate row that nothing references, which the next run merges again
   * because the keys still match. The reverse order loses the evidence, and
   * evidence is the one thing in this pipeline that was paid for with a browser
   * session.
   */
  merge(into: string, from: string): Promise<void>
}

/**
 * How a pack turns mentions into entities.
 *
 * The entity schema and the repo live in here rather than in a sibling `entity`
 * member, which is a deliberate deviation from the shape plan section 2.5 lists.
 * They must be present exactly when `resolve` is, and this codebase already has
 * the argument written down one table over: half a pairing key is worse than
 * none, which is why `harvest_runs` carries a check constraint rather than two
 * hopeful nullable columns. Two optional members that must agree is that same
 * mistake in the type system, where nothing would enforce it.
 */
export interface ResolveSpec<TMention, TEntity> {
  /** What a resolved entity must look like. Checked before the repo sees it. */
  entitySchema: z.ZodType<TEntity>
  repo: EntityRepo<TEntity>
  /**
   * The cache key: the pack's normalised form of whatever this mention names.
   *
   * The engine never builds one, because normalising a name is precisely the
   * knowledge that makes a pack a pack — case, script, honorifics, the word for
   * "shop" that half the sources leave off. Two mentions sharing a key are the
   * same thing as far as the pack is concerned, and the stage will resolve them
   * once between them.
   */
  key(mention: TMention): string
  resolve(mention: TMention, ctx: ResolveCtx): Promise<Resolution<TEntity>>
  /**
   * How many `deferred` attempts a key gets before the stage gives up on it and
   * writes `unresolvable`. Defaults to `DEFAULT_RESOLVE_ATTEMPTS`.
   *
   * Counted per key rather than per mention — see `entityResolution` in
   * `@samsara/core` for why that division is the one that protects the budget.
   */
  maxAttempts?: number
}

/**
 * Widened as far as P2.4 has a caller. `score`, `sources` and `queries` arrive
 * in P2.5 and Phase 3, each with the stage that calls it. Callers
 * should already type against this name so that the widening is a change in one
 * file rather than in every consumer.
 *
 * `resolve` is optional while `extract` is not, and that is not laziness: a pack
 * part-way through being written is a real state — the creator fixture was one
 * for a day — and the alternative is forcing every pack to carry stubs for
 * stages that do not exist yet, which is how a contract stops describing
 * anything. The stage refuses by name when it is absent, the way `require` does.
 */
export interface DomainPack<TMention = unknown, TEntity = unknown> extends DomainPackIdentity {
  extract: ExtractSpec<TMention>
  resolve?: ResolveSpec<TMention, TEntity>

  /**
   * The ways this pack can recognise one of its entities in another, strongest
   * first (P2.4).
   *
   * A bare member rather than a `DedupSpec` beside `ResolveSpec`, and that is a
   * deliberate departure from the pairing argument two types up. There is
   * nothing here to pair it *with*: the repo the stage writes through is already
   * on `resolve`, because it is the same table, and a second copy of it would be
   * two members that could name two tables. So this stays the one thing dedup
   * adds, under the name section 2.4 gives it.
   *
   * Which also makes the dependency honest. Dedup cannot run on a pack with no
   * resolver, because there is nothing to deduplicate that resolution did not
   * write, and the stage refuses by name rather than reporting a clean run over
   * an empty table.
   *
   * Returning an empty array is a pack saying it has no way to recognise a
   * duplicate — which is a real answer, and different from the member being
   * absent. The stage counts the entity as examined and moves on.
   */
  /**
   * Declared as a method rather than as a property holding a function, which is
   * not a style choice: under `strictFunctionTypes` a function-typed property is
   * checked contravariantly in `TEntity`, so a fully-typed pack would stop being
   * assignable to the `DomainPack<unknown, unknown>` the registry holds — and the
   * registry not caring about the entity type is the seam. Every other member of
   * this contract is already written this way.
   */
  dedupKeys?(entity: TEntity): readonly DedupKey[]
}

/**
 * `Map<string, DomainPack>` from section 2.5, with the invariant the plain Map
 * cannot express: a pack's key is its own `id`, so nothing can be registered under
 * a name it does not answer to, and registering twice is a bug rather than a
 * silent replacement.
 *
 * Unparameterised in the mention type, because a registry holding two packs holds
 * two different mention types and the runner that looks one up by a job's
 * `domainId` cannot know which at compile time. The stage re-narrows at the point
 * it validates, which is where the pack's own schema is in hand anyway.
 */
export class PackRegistry {
  private readonly packs = new Map<string, DomainPack>()

  get size(): number {
    return this.packs.size
  }

  /**
   * Generic in the mention type rather than taking `DomainPack<never>`, which is
   * what this said until the first real pack was registered and could not be:
   * `never` is assignable *to* everything, not *from* it, so the parameter
   * accepted only a pack whose mentions were impossible. The registry genuinely
   * does not care what shape a mention is — that is the point of the seam — so it
   * takes any pack and widens at the map, where `DomainPack<unknown>` is the
   * honest type for a value the runner will look up by a string.
   */
  register<TMention, TEntity>(pack: DomainPack<TMention, TEntity>): void {
    if (this.packs.has(pack.id)) {
      throw new Error(`domain pack already registered: ${pack.id}`)
    }
    this.packs.set(pack.id, pack as DomainPack)
  }

  get(id: string): DomainPack | undefined {
    return this.packs.get(id)
  }

  /**
   * Throws rather than returning undefined, and names the registered ids in the
   * message. A job carrying a `domainId` nobody registered is a deployment
   * mistake — the runner shipped without the pack — and it should say so once,
   * loudly, rather than being handled as an ordinary missing value at every call
   * site downstream.
   */
  require(id: string): DomainPack {
    const pack = this.packs.get(id)
    if (!pack) {
      throw new Error(
        `no domain pack registered for "${id}" (registered: ${[...this.packs.keys()].join(", ") || "none"})`,
      )
    }
    return pack
  }

  ids(): string[] {
    return [...this.packs.keys()]
  }
}
