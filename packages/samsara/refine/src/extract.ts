import type { FailureKind, SpendScope } from "@samsara/kernel"
import type { LlmClient, LlmTask, Sensitivity } from "@samsara/llm"
import { z } from "zod"
import type { DomainPack } from "./pack.js"
import type { ExtractItem, MentionRow, MentionSink } from "./ports.js"

/**
 * The extract stage: RawItems in, Mention rows out, and the accounting in between.
 *
 * Generic to the last line. It knows that a pack has a schema, a prompt and an
 * opinion about grouping; it never learns what a mention means. The travel words
 * live in `@dt/travel-pack`, and P2.8 will try to break that claim by running a
 * second pack through this same function.
 *
 * Four decisions here are load-bearing, and three of them are consequences of
 * P2.1 rather than of anything in this file.
 *
 * **1. Batches carry refs, and the refs are checked.** §8 requires roughly twenty
 * items per call, which means twenty answers come back in one object and each has
 * to be attributed to exactly one item — `mentions.raw_item_id` is NOT NULL, and
 * a mention filed against the wrong item is worse than a mention lost, because
 * nothing downstream can tell. So each item is rendered with a ref and the model
 * echoes it back. A ref nobody asked for is dropped and counted; an item the
 * model never answered for is counted too, and gets no rows. Both counts are in
 * the report, because the interesting number is not whether this happens but how
 * often, and for which model — and P2.1's `compare()` is the thing that will
 * eventually be asked.
 *
 * **2. A batch is validated twice, at two different strictnesses.** The provider
 * is handed the full schema, mention shape included, because that is the only
 * part worth constraining. What comes back is validated loosely first — an
 * envelope of refs and opaque mentions — and then each mention is checked against
 * the pack's schema on its own. One malformed mention therefore costs one
 * mention. The alternative, validating the whole batch at once, makes a single
 * bad field discard nineteen good answers *and* retry the call, and P2.1 meters
 * every attempt: that retry re-sends twenty items' text, which at Thai's roughly
 * one token per character is the most expensive mistake available here.
 *
 * **3. A batch that fails structurally splits instead of retrying.** Same
 * arithmetic from the other side. `complete()` retries a schema failure three
 * times by default and each attempt re-sends the whole batch, so a batch of
 * twenty with one poisonous item costs sixty items' worth of input to fail. A
 * multi-item batch is therefore sent with `attempts: 1` and halved on failure,
 * down to single items which get the normal retry policy. The bad item ends up
 * alone, having cost about `2n` items of input instead of `3n` — and, more
 * usefully, the nineteen good ones get extracted.
 *
 * **4. Already-extracted items are skipped, not re-paid for.** §8 calls re-running
 * refine free because it opens no browsers. It is free on the meter that is
 * loose and not on the meter that is tight, and the stage is going to be re-run
 * constantly during P2.2's own prompt iteration. The skip is keyed on the pack
 * version, so bumping the version is how a pack asks for its items back.
 */

/** §8: "Batch roughly 20 RawItems per LLM call." */
export const DEFAULT_BATCH_SIZE = 20

/**
 * The per-item text cap.
 *
 * A pantip topic runs to tens of kilobytes; twenty of them is a request nobody
 * priced and an answer that hits `maxOutputTokens` and fails as `config`. Four
 * thousand characters of Thai is roughly four thousand tokens, so a full batch
 * sits near 80k input — inside a modern context and nowhere near comfortable,
 * which is why a pack with long items is expected to lower `batchSize`.
 */
export const DEFAULT_ITEM_CHARS = 4_000

/** The variable a pack's prompt must declare. The engine fills it; the pack words it. */
export const ITEMS_VARIABLE = "items"

/**
 * The envelope, in prose, for the model that has to produce it.
 *
 * This is the engine's text and not the pack's, because the envelope is the
 * engine's invention: the refs exist so that twenty answers can be attributed to
 * twenty items, and `confidence` is an engine column. A pack writing its own
 * version of this paragraph would be writing the one part of the prompt whose
 * correctness the pack cannot check — and would drift from it the first time
 * this file changed.
 *
 * It is a constant a pack must include verbatim rather than something the engine
 * splices in, because splicing means deciding where: before the pack's
 * instructions, after them, in the system message or the user one. Those are
 * prompt-engineering decisions with measurable consequences, and they belong to
 * whoever is iterating on the prompt, which is the pack. `extract()` refuses a
 * prompt that left it out, before spending anything.
 */
export const ENVELOPE_INSTRUCTIONS = `Return JSON: {"items":[{"ref":"<the ref>","mentions":[{"confidence":<0-1>,"mention":{...}}]}]}
- One entry per item you were given. Its "ref" is the value on that item's "ref:" line, copied exactly, and nothing else from the header. Do not invent refs.
- An item with nothing worth extracting gets an entry with an empty "mentions" list. Do not omit it.
- "confidence" is how sure you are of that one mention, not of the item.`

export interface ExtractOptions<TMention> {
  pack: DomainPack<TMention>
  llm: LlmClient
  items: readonly ExtractItem[]
  sink: MentionSink
  /** Which configured model to route to. Defaults to `extract`, which is what this is. */
  task?: LlmTask
  scope?: SpendScope
  /**
   * Defaults to `private`, like everything else routed through `complete()`.
   *
   * Harvested public forum posts are the case ADR-0012 explicitly allows a
   * `:free` route for, so the caller extracting them says `public` and gets one.
   * The default stays the careful one because the day this stage is pointed at a
   * user's own text, nobody will remember to change it back.
   */
  sensitivity?: Sensitivity
  maxOutputTokens?: number
  /** Injectable for tests. Real callers get `crypto.randomUUID`. */
  newId?: () => string
}

export interface ExtractReport {
  /** Items handed in. */
  items: number
  /** Items skipped because this pack version had already seen them. */
  skipped: number
  /** Items sent to a model. */
  sent: number
  /** Items the model returned an entry for, valid or not. */
  answered: number
  /** Mention rows written. */
  mentions: number
  /** Mentions dropped because they did not match the pack's schema. */
  invalid: number
  /** Answers filed against a ref that was not in the batch. Dropped. */
  unknownRefs: number
  /** Refs answered more than once in one batch. The extra entries are kept; the count is not silent. */
  duplicateRefs: number
  /** Calls attempted, splits included. Compare against `batches` to see the reliability tax. */
  calls: number
  /** Batches formed, before any splitting. */
  batches: number
  /** Why the failed calls failed. Empty on a clean run. */
  failures: { kind: FailureKind; count: number }[]
}

/**
 * The envelope, at the two strictnesses point 2 above describes.
 *
 * `ref` accepts a number as well as a string because a model handed `"1"` will
 * sometimes return `1`, and refusing that would discard a batch over a JSON type
 * the prompt never cared about. It is normalised to a string immediately.
 */
const looseMention = z.object({
  confidence: z.number().min(0).max(1),
  mention: z.unknown(),
})

const looseEnvelope = z.object({
  items: z.array(
    z.object({
      ref: z.union([z.string(), z.number()]),
      mentions: z.array(looseMention),
    }),
  ),
})

const strictEnvelope = (mentionSchema: z.ZodType<unknown>) =>
  z.object({
    items: z.array(
      z.object({
        ref: z.string(),
        mentions: z.array(
          z.object({
            confidence: z.number().min(0).max(1),
            mention: mentionSchema,
          }),
        ),
      }),
    ),
  })

/**
 * One item as the model sees it.
 *
 * The item's own URL is deliberately absent. It costs tokens on every item of
 * every batch and an extractor has no use for it: the coordinates and map links
 * that P2.3's Tier 0 reads live in the *text*, which is here in full, and a
 * canonical URL is something the engine already knows and would only be asking
 * the model to copy back.
 *
 * The ref gets its own labelled line, which costs a few tokens per item and buys
 * back the batch. The first version packed ref, source and language onto one
 * header line — `--- 1 maps.reviews th` — and the first real model to see it
 * answered with `"ref": "maps.reviews th"` on all five items: it read the header
 * as one field and dropped the leading number. Every answer was unattributable,
 * the report said `unknownRefs: 5`, and nothing failed, because from the engine's
 * side a wrong ref and an invented one are the same event. No fake client can
 * find that bug — the fake echoes whatever the test tells it to.
 */
const renderItem = (item: ExtractItem, ref: string, maxChars: number): string => {
  const title = item.title?.trim()
  const text =
    item.text.length > maxChars ? `${item.text.slice(0, maxChars)}…[truncated]` : item.text
  return `--- ref: ${ref}\nsource: ${item.sourceId} (${item.languageGuess ?? "?"})\n${title ? `${title}\n` : ""}${text}`
}

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function extract<TMention>(opts: ExtractOptions<TMention>): Promise<ExtractReport> {
  const { pack, llm, sink } = opts
  const spec = pack.extract
  const newId = opts.newId ?? (() => crypto.randomUUID())
  const batchSize = Math.max(1, spec.batchSize ?? DEFAULT_BATCH_SIZE)
  const maxChars = Math.max(1, spec.maxItemChars ?? DEFAULT_ITEM_CHARS)
  const wireSchema = strictEnvelope(spec.mentionSchema as z.ZodType<unknown>)

  const report: ExtractReport = {
    items: opts.items.length,
    skipped: 0,
    sent: 0,
    answered: 0,
    mentions: 0,
    invalid: 0,
    unknownRefs: 0,
    duplicateRefs: 0,
    calls: 0,
    batches: 0,
    failures: [],
  }
  const failures = new Map<FailureKind, number>()

  // Before the skip query and before anything is spent. A pack that left the
  // envelope instructions out will get answers in whatever shape the model
  // improvises, and every one of them will fail validation — expensively, and
  // with a failure kind that blames the provider.
  if (!`${spec.prompt.system ?? ""}\n${spec.prompt.template}`.includes(ENVELOPE_INSTRUCTIONS)) {
    throw new Error(
      `prompt ${spec.prompt.id} v${spec.prompt.version} does not include ENVELOPE_INSTRUCTIONS verbatim`,
    )
  }

  const done = await sink.extractedIds(
    opts.items.map((item) => item.id),
    pack.id,
    pack.version,
  )
  const pending = opts.items.filter((item) => !done.has(item.id))
  report.skipped = opts.items.length - pending.length
  if (pending.length === 0) return report

  // Grouped before it is chunked, so a batch is homogeneous in whatever the pack
  // said matters. Insertion-ordered, so a run is reproducible from its input.
  const groups = new Map<string, ExtractItem[]>()
  for (const item of pending) {
    const key = spec.batchBy(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }

  const rows: MentionRow[] = []

  const run = async (batch: readonly ExtractItem[]): Promise<void> => {
    report.calls++

    // Refs are positions within *this* batch, which is what makes a split cheap:
    // the halves renumber themselves and no state has to follow them down.
    const refs = new Map<string, ExtractItem>()
    const rendered = batch
      .map((item, index) => {
        const ref = String(index + 1)
        refs.set(ref, item)
        return renderItem(item, ref, maxChars)
      })
      .join("\n\n")

    const result = await llm.complete(spec.prompt, looseEnvelope, {
      task: opts.task ?? "extract",
      vars: { [ITEMS_VARIABLE]: rendered },
      wireSchema,
      domainId: pack.id,
      // Point 3: a multi-item batch gets one shot, then halves. A single item
      // gets the ordinary policy, because there is nothing left to split.
      ...(batch.length > 1 ? { attempts: 1 } : {}),
      ...(opts.scope === undefined ? {} : { scope: opts.scope }),
      ...(opts.sensitivity === undefined ? {} : { sensitivity: opts.sensitivity }),
      ...(opts.maxOutputTokens === undefined ? {} : { maxOutputTokens: opts.maxOutputTokens }),
    })

    if (!result.ok) {
      if (batch.length > 1) {
        const half = Math.ceil(batch.length / 2)
        await run(batch.slice(0, half))
        await run(batch.slice(half))
        return
      }
      failures.set(result.error.kind, (failures.get(result.error.kind) ?? 0) + 1)
      return
    }

    const seen = new Set<string>()
    for (const answer of result.value.value.items) {
      const ref = String(answer.ref)
      const item = refs.get(ref)
      if (!item) {
        report.unknownRefs++
        continue
      }
      if (seen.has(ref)) report.duplicateRefs++
      else {
        seen.add(ref)
        report.answered++
      }

      for (const candidate of answer.mentions) {
        const parsed = spec.mentionSchema.safeParse(candidate.mention)
        if (!parsed.success) {
          report.invalid++
          continue
        }
        rows.push({
          id: newId(),
          rawItemId: item.id,
          domainId: pack.id,
          packVersion: pack.version,
          payload: parsed.data,
          entityId: null,
          resolution: "pending",
          /**
           * Self-reported, and stored rather than acted on. A model's own
           * confidence is weakly calibrated and nothing here has measured
           * whether this one correlates with being right — so the stage does not
           * threshold on it. It is written because the column exists and because
           * the correlation is answerable later, from rows that were kept.
           */
          confidence: candidate.confidence,
        })
      }
    }
  }

  for (const group of groups.values()) {
    for (const batch of chunk(group, batchSize)) {
      report.batches++
      report.sent += batch.length
      await run(batch)
    }
  }

  if (rows.length > 0) await sink.insertMany(rows)
  report.mentions = rows.length
  report.failures = [...failures.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count)
  return report
}
