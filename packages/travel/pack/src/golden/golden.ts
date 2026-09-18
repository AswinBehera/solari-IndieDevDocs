import type { PlaceMention } from "../mention.js"
import corpus from "./corpus.json" with { type: "json" }
import labels from "./labels.json" with { type: "json" }

/**
 * The golden set the extraction prompt is measured against.
 *
 * Fifty real Thai items, harvested from Pantip on 2026-09-17 through one Solari
 * session, and fifty labels written by hand against them. It exists because P2.1
 * left a debt — `LLM_MODEL_EXTRACT` has no value, and it cannot get one from an
 * argument about which model is better. `compare()` needs a number, and a number
 * needs an answer key.
 *
 * **Why the corpus is derived rather than the captures.** The harvest produced
 * 2.6MB of page state. That is not checked in: P1.2's adapter fixtures already
 * cover parsing, and this set needs the text, not the bytes it arrived in. What
 * is checked in is the parser's own output, capped at the engine's `maxItemChars`
 * so that the text a label was written against is exactly the text the extractor
 * is shown. Labelling the full item and grading against a truncated one would
 * score a model down for a place it was never given.
 *
 * **Why two thirds of it is negatives.** 19 items name a place and 31 name none.
 * That is not a sampling accident — it is the ratio a food board actually has,
 * and the failure this prompt is written against is invention, not omission. An
 * extractor that returns something for every item scores well on recall and is
 * useless, because P2.3 then geocodes the noise. The negatives include the cases
 * that are hard rather than empty: a 2.5k-character news article about how Google
 * Maps computes busy times, which is fluent, on-topic and names no restaurant; a
 * shop the writer ate at for years and is now asking where it went; and a full
 * five-dish review whose author elides the shop name as `ร้าน ดี....` on purpose,
 * winking at readers who already know it. That last one is the best negative in
 * the set, because everything except the name is there.
 *
 * **Who wrote the key, and who checked it.** I wrote both the key and the prompt
 * it grades, so the set could only ever be as honest as that loop allows. Ten of
 * the fifty are flagged `audit` and all ten were put to a human one at a time:
 * eight judgement calls I knew I had made, and two drawn at random so the audit
 * was not only the questions I already knew to ask. Their notes say which way
 * each went and why, and `golden.test.ts` asserts that every one of them records
 * a resolution, so reverting a ruling fails a test instead of only changing a
 * JSON file nobody rereads.
 *
 * Four of the ten moved. The prompt used to disqualify a place the writer had
 * not been to; that was struck, because `sentiment` and `creatorReads` already
 * carry it and striking it cost no information. The mirror case survived for
 * exactly that reason: nothing in the schema can say a place is *gone*, so a
 * closed shop would be emitted looking like somewhere you can walk into tonight.
 * A generic noun now counts where the item names the locality and the locality
 * has only one of the thing — a town's walking street does, `ร้านเก่าแก่` in
 * Bangsaen does not. And a place named to describe something else, as in "nature
 * spots such as X", is not a mention of X.
 *
 * The audit also found two names the key was grading too narrowly, neither by
 * any test: a shop the item spells two ways, and one whose title uses a short
 * form. Both were found while writing the questions, which is an argument for
 * the audit over and above the answers it produced.
 *
 * The labels follow the prompt's definition of a place rather than a general
 * one, which is the only fair way to grade it: lodging is out because the prompt
 * puts it out, so a farmstay is absent — but a farmstay the writer drives to for
 * coffee is in.
 */

export type GoldenItem = {
  readonly id: string
  readonly sourceId: string
  readonly url: string
  readonly title: string | null
  readonly text: string
  readonly languageGuess: string | null
}

export type GoldenLabel = {
  /**
   * The places the item names, each as the spellings that should count as
   * naming it.
   *
   * A group rather than a string because one item gives one temple three names
   * — `วัดสิรินธรวรารามภูพร้าว`, `วัดภูพร้าว` and `วัดเรืองแสง` — and the prompt
   * says the same place mentioned twice in one item is one mention. Grading
   * against whichever of the three I happened to write down would fail a model
   * for agreeing with the item. The same mechanism carries the one case where
   * the source is simply wrong: it spells the Sirindhorn dam `เขื่อนสิรินธน`,
   * and both that and the real spelling are accepted, because a model that
   * silently fixes the typo has done the resolve stage a favour rather than an
   * injury. The first spelling in each group is the canonical one for display;
   * every other one but a deliberate correction also appears in the item.
   */
  readonly places: readonly (readonly string[])[]
  /** Flagged for the human spot-check. See the note for what is being asked. */
  readonly audit?: boolean
  /** The id of the item this one is a verbatim copy of, where there is one. */
  readonly duplicate?: string
  /** Why the label is what it is, and in particular what was left out of it. */
  readonly note: string
}

export const goldenCorpus: readonly GoldenItem[] = corpus
export const goldenLabels: Readonly<Record<string, GoldenLabel>> = labels

/**
 * Fold a place name to the form two spellings of one place share.
 *
 * Thai does not put spaces between words, so where a space falls inside a name
 * is a typesetting choice and not part of it: one item writes the same market
 * `ตลาดบ้านฟ้า เลอ มาร์เช่` and another writes it `ตลาดบ้านฟ้าเลอมาร์เช่`.
 * Dropping whitespace entirely makes those one string, and costs nothing in the
 * Latin-script names because those are compared against themselves.
 *
 * The leading `ร้าน` comes off for a narrower reason: it is the common noun
 * "shop", the items attach it to names freely, and a model that returns `หอมดิน`
 * for `ร้านหอมดิน` has named the right restaurant. This is deliberately not done
 * for `ตลาด` or `วัด`, which look like the same case and are not — strip `ตลาด`
 * from `ตลาดบ้านฟ้า` and what is left is a housing estate.
 */
export const normaliseName = (name: string): string => {
  const flat = name.replace(/\s+/gu, "").toLowerCase()
  return flat.startsWith("ร้าน") ? flat.slice("ร้าน".length) : flat
}

export type ItemScore = {
  readonly id: string
  /** Canonical names in the label that no mention matched. */
  readonly missed: readonly string[]
  /** `localName`s returned that no label accounts for. */
  readonly spurious: readonly string[]
  readonly matched: number
}

export type GoldenScore = {
  readonly items: readonly ItemScore[]
  readonly expected: number
  readonly predicted: number
  readonly matched: number
  /** Matched over expected. How much of what is there the model finds. */
  readonly recall: number
  /** Matched over predicted. How much of what it returns is real. */
  readonly precision: number
  /**
   * Mentions returned for items labelled as naming nowhere.
   *
   * Tracked on its own rather than left inside precision because it is the
   * number this prompt was written against, and because the two move
   * independently: a model can be precise on the items that do name somewhere
   * and still answer every negative with `คาเฟ่`.
   */
  readonly inventedOnNegatives: number
}

/**
 * Grade one run of the extractor against the key.
 *
 * Matching is greedy and one-to-one: a label group is satisfied by at most one
 * mention and a mention satisfies at most one group, so returning the same shop
 * three times earns one match and two spurious rows. That is the prompt's own
 * rule — the same place mentioned twice in one item is one mention — enforced
 * where it can be counted instead of only asked for.
 *
 * Items the caller has no predictions for are scored as having returned nothing,
 * which is the honest reading: a call that failed or was never made found no
 * places. A failed call and a model that found none are different events, and
 * distinguishing them is the runner's job, not the scorer's.
 */
export const scoreGolden = (
  predictions: ReadonlyMap<string, readonly PlaceMention[]>,
): GoldenScore => {
  const items: ItemScore[] = []
  let expected = 0
  let predicted = 0
  let matched = 0
  let inventedOnNegatives = 0

  for (const item of goldenCorpus) {
    const label = goldenLabels[item.id]
    if (!label) continue
    const mentions = predictions.get(item.id) ?? []
    const taken = new Set<number>()
    const missed: string[] = []
    let hits = 0

    for (const group of label.places) {
      const wanted = group.map(normaliseName)
      const at = mentions.findIndex(
        (m, i) => !taken.has(i) && wanted.includes(normaliseName(m.localName)),
      )
      if (at === -1) missed.push(group[0] ?? "")
      else {
        taken.add(at)
        hits += 1
      }
    }

    const spurious = mentions.filter((_, i) => !taken.has(i)).map((m) => m.localName)
    if (label.places.length === 0) inventedOnNegatives += mentions.length
    expected += label.places.length
    predicted += mentions.length
    matched += hits
    items.push({ id: item.id, missed, spurious, matched: hits })
  }

  return {
    items,
    expected,
    predicted,
    matched,
    // A model that returns nothing is not precise, it is silent; and one graded
    // on a corpus with nothing to find has no recall to report. Both degenerate
    // cases report 0 rather than 1, so that a broken run cannot top a table.
    recall: expected === 0 ? 0 : matched / expected,
    precision: predicted === 0 ? 0 : matched / predicted,
    inventedOnNegatives,
  }
}
