import { describe, expect, it } from "vitest"
import type { PlaceMention } from "../mention.js"
import {
  type GoldenItem,
  goldenCorpus,
  goldenLabels,
  normaliseName,
  scoreGolden,
} from "./golden.js"

/**
 * These tests are not about the scorer's arithmetic so much as about the key.
 *
 * A golden set is a measuring instrument, and an instrument nobody checks drifts
 * silently — a name typed from memory instead of copied, a label left behind when
 * the corpus was regenerated, an id appearing twice and quietly counting double.
 * None of that fails loudly on its own; it just moves every score by a percent
 * or two forever. So the invariants are asserted here, where they run on every
 * `pnpm check`, rather than trusted because they were true the day they were
 * written.
 */

const mention = (localName: string): PlaceMention => ({
  localName,
  romanName: null,
  dish: null,
  category: "food",
  priceHint: null,
  quote: "…",
  sentiment: "positive",
  creatorReads: "unknown",
})

const bare = (name: string) => name.replace(/\s+/gu, "").toLowerCase()

describe("the corpus", () => {
  it("has a label for every item and no label without one", () => {
    const ids = goldenCorpus.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.keys(goldenLabels).sort()).toEqual([...ids].sort())
  })

  it("is 50 items, 19 of which name somewhere", () => {
    // Stated as a number so that regenerating the corpus without revisiting the
    // labels fails here instead of silently changing what every score means.
    expect(goldenCorpus).toHaveLength(50)
    const bearing = Object.values(goldenLabels).filter((l) => l.places.length > 0)
    expect(bearing).toHaveLength(19)
    expect(bearing.reduce((n, l) => n + l.places.length, 0)).toBe(74)
  })

  it("holds Thai text long enough to extract from", () => {
    for (const item of goldenCorpus) {
      expect(item.sourceId).toBe("pantip.topic")
      expect(item.languageGuess).toBe("th")
      expect(item.text.length).toBeGreaterThanOrEqual(100)
      // The cap is the engine's `maxItemChars`, so the labelled text and the
      // rendered text are the same text.
      expect(item.text.length).toBeLessThanOrEqual(4_000)
    }
  })

  it("flags ten items for the human spot-check", () => {
    // I wrote the prompt and the key both. Ten is the audit that breaks that
    // loop, and the count is asserted so it cannot quietly become nine.
    const flagged = Object.entries(goldenLabels).filter(([, l]) => l.audit)
    expect(flagged).toHaveLength(10)
    for (const [, label] of flagged) {
      expect(label.note.length).toBeGreaterThan(40)
      // All ten were put to a human one at a time and answered. The note records
      // which way, so that a later edit quietly reverting a ruling shows up here
      // rather than only in the diff of a JSON file nobody rereads.
      expect(label.note).toContain("resolved")
    }
  })
})

describe("every label", () => {
  const byId = new Map<string, GoldenItem>(goldenCorpus.map((i) => [i.id, i]))

  it("names something the item actually says", () => {
    // The one invariant that catches a name written from memory. At least one
    // spelling per group has to be in the item; the others may be corrections,
    // which is how `เขื่อนสิรินธน` and the real spelling both count.
    for (const [id, label] of Object.entries(goldenLabels)) {
      const item = byId.get(id)
      expect(item).toBeDefined()
      const hay = bare(`${item?.text ?? ""} ${item?.title ?? ""}`)
      for (const group of label.places) {
        expect(group.length).toBeGreaterThan(0)
        expect(group.some((name) => hay.includes(bare(name)))).toBe(true)
      }
    }
  })

  it("says why, and does not name the same place twice", () => {
    for (const label of Object.values(goldenLabels)) {
      expect(label.note.length).toBeGreaterThan(10)
      const canonical = label.places.map((g) => normaliseName(g[0] ?? ""))
      expect(new Set(canonical).size).toBe(canonical.length)
    }
  })
})

describe("normaliseName", () => {
  it("folds the spacing Thai does not fix", () => {
    expect(normaliseName("ตลาดบ้านฟ้า เลอ มาร์เช่")).toBe(normaliseName("ตลาดบ้านฟ้าเลอมาร์เช่"))
  })

  it("treats the noun ร้าน as optional but ตลาด as part of the name", () => {
    expect(normaliseName("ร้านหอมดิน")).toBe(normaliseName("หอมดิน"))
    expect(normaliseName("ตลาดบ้านฟ้า")).not.toBe(normaliseName("บ้านฟ้า"))
  })
})

describe("scoreGolden", () => {
  it("gives a perfect run 1 and 1", () => {
    const perfect = new Map(
      Object.entries(goldenLabels).map(([id, l]) => [id, l.places.map((g) => mention(g[0] ?? ""))]),
    )
    const score = scoreGolden(perfect)
    expect(score.matched).toBe(74)
    expect(score.recall).toBe(1)
    expect(score.precision).toBe(1)
    expect(score.inventedOnNegatives).toBe(0)
    expect(score.items.flatMap((i) => i.missed)).toEqual([])
  })

  it("scores silence as 0 recall rather than perfect precision", () => {
    const score = scoreGolden(new Map())
    expect(score.matched).toBe(0)
    expect(score.recall).toBe(0)
    // The degenerate case that would otherwise let an empty run win a bake-off.
    expect(score.precision).toBe(0)
  })

  it("counts a place returned twice as one match and one spurious row", () => {
    const score = scoreGolden(
      new Map([["pt-44225687-0", [mention("ต้าเจียห่าว"), mention("ต้าเจียห่าว")]]]),
    )
    const item = score.items.find((i) => i.id === "pt-44225687-0")
    expect(item?.matched).toBe(1)
    expect(item?.spurious).toEqual(["ต้าเจียห่าว"])
  })

  it("counts a generic noun on a negative as invention", () => {
    // The exact failure the prompt's generic-noun rule was written against: the
    // item is a news article about how Google Maps measures how busy shops are.
    const score = scoreGolden(new Map([["pt-44227552-0", [mention("ร้านกาแฟ"), mention("คาเฟ่")]]]))
    expect(score.inventedOnNegatives).toBe(2)
    expect(score.matched).toBe(0)
    expect(score.precision).toBe(0)
  })

  it("accepts every spelling the key lists, not only the canonical one", () => {
    // The audit turned up two names the key was grading too narrowly — `ต้าเจียฮ่าว`,
    // which the item switches to halfway through, and bare `KUSA`, which is the
    // title. Neither is something `normaliseName` folds: one is a substitution and
    // the other a truncation, and a sweep for either finds mostly `ร้าน` and `ตลาด`,
    // the generic nouns the prompt exists to reject. So the aliases are written out
    // by hand, and this asserts each one actually earns the match it was added for.
    for (const [id, label] of Object.entries(goldenLabels)) {
      for (const group of label.places) {
        for (const spelling of group) {
          expect(scoreGolden(new Map([[id, [mention(spelling)]]])).matched).toBe(1)
        }
      }
    }
  })

  it("accepts either spelling where the source misspells the name", () => {
    const wanted = goldenLabels["pt-43933591-4"]?.places[0] ?? []
    expect(wanted.length).toBeGreaterThan(1)
    for (const spelling of wanted) {
      const score = scoreGolden(new Map([["pt-43933591-4", [mention(spelling)]]]))
      expect(score.matched).toBe(1)
    }
  })
})
