import type { EvidenceRecord } from "@samsara/refine"
import { describe, expect, it } from "vitest"
import type { PlaceEntity } from "./entity.js"
import type { PlaceMention } from "./mention.js"
import { placeScores } from "./scores.js"

/**
 * The travel pack's score factors (P2.5).
 *
 * These are the judgements — what counts as local, what counts as touristy — so
 * they are tested here and not in the engine, which weighs them without being
 * able to name one. What the engine does with a reading is `score.test.ts` in
 * `@samsara/refine`; what a reading *is* is this file.
 *
 * Every test asks a factor directly rather than going through the stage. A
 * factor's contract is small and exact — a number in [0,1], a list of receipts,
 * or `null` — and running the weighted mean over it would turn every assertion
 * into arithmetic about the other three factors.
 */

const ENTITY: PlaceEntity = {
  canonicalName: "Jay Fai",
  localName: "เจ๊ไฝ",
  city: "Bangkok",
  geo: { lat: 13.7529, lng: 100.5064 },
  externalRef: null,
  resolvedTier: 0,
  category: "food",
  tags: [],
}

const MENTION: PlaceMention = {
  localName: "เจ๊ไฝ",
  romanName: "Jay Fai",
  dish: "ไข่เจียวปู",
  category: "food",
  priceHint: "1000 บาท",
  quote: "ร้านนี้อร่อยมาก ไปกินบ่อย",
  sentiment: "positive",
  creatorReads: "local",
}

let seq = 0
const row = (
  over: Partial<EvidenceRecord> = {},
  mention: Partial<PlaceMention> = {},
): EvidenceRecord => {
  seq += 1
  return {
    id: `e${seq}`,
    entityId: "place-1",
    rawItemId: `r${seq}`,
    sourceId: "pantip",
    sourceUrl: `https://pantip.com/topic/${seq}`,
    language: "th",
    capturedAt: new Date("2026-02-01T00:00:00Z"),
    extract: { ...MENTION, ...mention },
    engagement: { views: null, likes: null, comments: null },
    ...over,
  }
}

const factor = (scoreName: string, factorName: string) => {
  const found = placeScores.scores[scoreName]?.find((f) => f.name === factorName)
  if (!found) throw new Error(`no factor ${scoreName}.${factorName}`)
  return (evidence: readonly EvidenceRecord[]) => found.measure(ENTITY, evidence)
}

describe("the two scores", () => {
  it("are local and tourist, and are not each other's complement", () => {
    expect(Object.keys(placeScores.scores)).toEqual(["local", "tourist"])
    const local = placeScores.scores.local?.map((f) => f.name)
    const tourist = placeScores.scores.tourist?.map((f) => f.name)
    // Two of each side mirror the other; two share nothing. A single slider
    // would force them to be exact opposites, and a temple is both.
    expect(local).toEqual([
      "nativeLanguageShare",
      "creatorLocalShare",
      "sourceDiversity",
      "engagementRatio",
    ])
    expect(tourist).toEqual([
      "nonNativeLanguageShare",
      "visitorCreatorShare",
      "listicleQuotes",
      "listicleSources",
    ])
  })

  it("weighs every factor positively, which is what lets a contribution be a share", () => {
    for (const factors of Object.values(placeScores.scores)) {
      for (const f of factors) expect(f.weight).toBeGreaterThan(0)
    }
  })
})

describe("nativeLanguageShare", () => {
  const measure = factor("local", "nativeLanguageShare")

  it("is the share of language-bearing rows written in Thai", () => {
    const reading = measure([row(), row(), row({ language: "en" }), row({ language: "vi" })])
    expect(reading?.value).toBe(0.5)
    // The receipts are the rows that pushed it up, not everything it divided by.
    expect(reading?.evidenceIds).toHaveLength(2)
  })

  it("reads a regional tag as its primary subtag", () => {
    // `th-TH` and `en-GB` both arrive from real sources.
    expect(measure([row({ language: "th-TH" }), row({ language: "en-GB" })])?.value).toBe(0.5)
  })

  it("abstains when nothing recorded a language, rather than scoring zero", () => {
    // Not 0: a corpus that never says what language it is in says nothing at all
    // about whether this place is local.
    expect(measure([row({ language: null }), row({ language: null })])).toBeNull()
  })

  it("divides by the rows that recorded a language, not by all of them", () => {
    expect(measure([row(), row({ language: null }), row({ language: null })])?.value).toBe(1)
  })
})

describe("creatorLocalShare", () => {
  const measure = factor("local", "creatorLocalShare")

  it("is the share of placed creators who read as local", () => {
    const reading = measure([
      row({}, { creatorReads: "local" }),
      row({}, { creatorReads: "local" }),
      row({}, { creatorReads: "visitor" }),
    ])
    expect(reading?.value).toBeCloseTo(2 / 3, 12)
  })

  it("treats unknown as no vote rather than as a visitor", () => {
    // The schema is three-valued precisely so a model can decline, and folding
    // `unknown` into `visitor` would turn every decline into evidence against.
    expect(
      measure([row({}, { creatorReads: "local" }), row({}, { creatorReads: "unknown" })])?.value,
    ).toBe(1)
  })

  it("abstains when every creator was unknown", () => {
    expect(measure([row({}, { creatorReads: "unknown" })])).toBeNull()
  })

  it("drops a row whose payload no longer fits the pack's schema", () => {
    // A row written against an older mention schema costs this factor one
    // sample, not the run.
    const reading = measure([
      row({ extract: { localName: "เจ๊ไฝ" } }),
      row({}, { creatorReads: "local" }),
    ])
    expect(reading?.value).toBe(1)
    expect(reading?.evidenceIds).toHaveLength(1)
  })
})

describe("sourceDiversity", () => {
  const measure = factor("local", "sourceDiversity")

  it("reads one source as no corroboration at all", () => {
    // 0 rather than 0.25: a place famous on exactly one surface has nothing
    // agreeing with it, and a quarter would say it had something.
    expect(measure([row(), row(), row()])?.value).toBe(0)
  })

  it("rises with distinct sources and saturates at every adapter we have", () => {
    expect(measure([row(), row({ sourceId: "youtube" })])?.value).toBeCloseTo(1 / 3, 12)
    expect(
      measure([
        row(),
        row({ sourceId: "youtube" }),
        row({ sourceId: "tiktok" }),
        row({ sourceId: "maps" }),
        row({ sourceId: "somewhere.else" }),
      ])?.value,
    ).toBe(1)
  })

  it("cites one row per source rather than every row", () => {
    const reading = measure([row(), row(), row({ sourceId: "youtube" })])
    expect(reading?.evidenceIds).toHaveLength(2)
  })

  it("never abstains over any evidence at all, because source_id is never null", () => {
    expect(measure([row()])).not.toBeNull()
    expect(measure([])).toBeNull()
  })
})

describe("engagementRatio", () => {
  const measure = factor("local", "engagementRatio")

  it("pools reactions over views rather than averaging per-item ratios", () => {
    // 1 + 100 reactions over 10 + 10000 views is ~1%, a tenth of the ceiling.
    // Averaging the two ratios would have given (10% + 1%) / 2 and let a video
    // with ten views outweigh one with ten thousand.
    const reading = measure([
      row({ engagement: { views: 10, likes: 1, comments: null } }),
      row({ engagement: { views: 10_000, likes: 100, comments: null } }),
    ])
    expect(reading?.value).toBeCloseTo(101 / 10_010 / 0.1, 6)
  })

  it("saturates rather than exceeding one", () => {
    expect(measure([row({ engagement: { views: 100, likes: 90, comments: 10 } })])?.value).toBe(1)
  })

  it("abstains on a corpus that reports no views", () => {
    // The Pantip case, and the whole reason abstention exists: scoring these
    // zero would make every forum-found place look less local than every
    // video-found one, in the score that is supposed to mean the opposite.
    expect(measure([row(), row()])).toBeNull()
  })

  it("skips a row with views but nothing to count, without abstaining overall", () => {
    const reading = measure([
      row({ engagement: { views: 500, likes: null, comments: null } }),
      row({ engagement: { views: 100, likes: 5, comments: 5 } }),
    ])
    // The first row is not a zero-engagement measurement, it is a surface that
    // reports views and not reactions. Only the second is in the ratio.
    expect(reading?.value).toBeCloseTo(10 / 100 / 0.1, 12)
    expect(reading?.evidenceIds).toHaveLength(1)
  })

  it("ignores a row claiming reactions with no views", () => {
    expect(measure([row({ engagement: { views: 0, likes: 3, comments: null } })])).toBeNull()
  })
})

describe("nonNativeLanguageShare", () => {
  const measure = factor("tourist", "nonNativeLanguageShare")

  it("counts every language that is not Thai, not only English", () => {
    // Section 2.5 says "English-only". Restricting it to English would read a
    // Vietnamese listicle about Bangkok as though it were a neighbourhood post.
    const reading = measure([row(), row({ language: "en" }), row({ language: "vi" })])
    expect(reading?.value).toBeCloseTo(2 / 3, 12)
  })

  it("abstains on the same corpus its mirror abstains on", () => {
    expect(measure([row({ language: null })])).toBeNull()
  })
})

describe("visitorCreatorShare", () => {
  const measure = factor("tourist", "visitorCreatorShare")

  it("is the mirror of the local share over the same population", () => {
    const evidence = [
      row({}, { creatorReads: "local" }),
      row({}, { creatorReads: "visitor" }),
      row({}, { creatorReads: "unknown" }),
    ]
    const local = factor("local", "creatorLocalShare")(evidence)
    const visitor = measure(evidence)
    // They sum to one here because `unknown` is excluded from both. That is the
    // informative case: the two scores disagree when the population splits.
    expect((local?.value ?? 0) + (visitor?.value ?? 0)).toBe(1)
  })
})

describe("listicleQuotes", () => {
  const measure = factor("tourist", "listicleQuotes")

  it("matches ranked-list phrasing in the verbatim quote, in either language", () => {
    const reading = measure([
      row({}, { quote: "Top 10 street food spots in Bangkok" }),
      row({}, { quote: "10 อันดับ ร้านอร่อย" }),
      row(),
    ])
    expect(reading?.value).toBeCloseTo(2 / 3, 12)
    expect(reading?.evidenceIds).toHaveLength(2)
  })

  it("does not fire on ordinary enthusiasm", () => {
    // The way this list fails is by growing until it matches every recommendation.
    expect(measure([row({}, { quote: "ร้านนี้อร่อยมาก ต้องลอง" })])?.value).toBe(0)
  })

  it("measures zero rather than abstaining when it found nothing", () => {
    // It had a quote to read on every row — that is a measurement of zero, not
    // an absence of anything to measure.
    expect(measure([row()])).toEqual({ value: 0, evidenceIds: [] })
  })
})

describe("listicleSources", () => {
  const measure = factor("tourist", "listicleSources")

  it("matches an aggregator's host, including subdomains", () => {
    const reading = measure([
      row({ sourceUrl: "https://www.tripadvisor.com/Restaurant_Review-x" }),
      row({ sourceUrl: "https://th.timeout.com/bangkok/food" }),
      row(),
    ])
    expect(reading?.value).toBeCloseTo(2 / 3, 12)
  })

  it("does not treat a Thai-language blog as touristy, nor an English one as local", () => {
    // Language is weighed separately, so neither signal has to carry the
    // other's mistakes.
    expect(
      measure([row({ sourceUrl: "https://example.invalid/food", language: "en" })])?.value,
    ).toBe(0)
  })

  it("matches nothing on a URL that does not parse, rather than failing", () => {
    expect(measure([row({ sourceUrl: "not a url" })])?.value).toBe(0)
  })

  it("is the one factor here that needs no mention payload at all", () => {
    // It reads `source_url` off the engine's own row. It would still work if the
    // pack's mention schema were empty.
    expect(measure([row({ extract: {}, sourceUrl: "https://klook.com/x" })])?.value).toBe(1)
  })
})

describe("receipts", () => {
  it("are capped, so the scores column does not grow with the corpus", () => {
    const measure = factor("local", "nativeLanguageShare")
    const reading = measure(Array.from({ length: 50 }, () => row()))
    expect(reading?.value).toBe(1)
    // Twenty is more than any card renders; the alternative is thirty kilobytes
    // of uuids per place to support a UI that shows a handful.
    expect(reading?.evidenceIds).toHaveLength(20)
  })
})
