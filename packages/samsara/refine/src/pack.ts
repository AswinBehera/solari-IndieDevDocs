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
 * Widened as far as P2.2 has a caller. `resolve`, `dedupKeys`, `score`, `entity`,
 * `sources` and `queries` arrive in P2.3 to P2.5, each with the stage that calls
 * it. Callers should already type against this name so that the widening is a
 * change in one file rather than in every consumer.
 */
export interface DomainPack<TMention = unknown> extends DomainPackIdentity {
  extract: ExtractSpec<TMention>
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
  register<TMention>(pack: DomainPack<TMention>): void {
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
