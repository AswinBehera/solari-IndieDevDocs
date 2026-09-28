import type { EvidenceRecord, ScoreFactor, ScoreSpec } from "@samsara/refine"
import type { PlaceEntity } from "./entity.js"
import { placeMention } from "./mention.js"

/**
 * The travel pack's two scores, as factors the engine weighs (P2.5).
 *
 * Section 2.5 names them and says what each is built from: `scores.local` from
 * the evidence mix — native-language share, creator-local share, source
 * diversity, engagement ratio — and `scores.tourist` from a keyword and source
 * list. Every one of those is a travel judgement and none of them is in the
 * engine: `score.ts` multiplies numbers by weights and divides by their sum, and
 * could not name a single thing in this file.
 *
 * Three properties hold across all of them.
 *
 * **They read the mention payload, and they validate it first.** `extract` is
 * `unknown` on the way in — that is the seam working, not a gap — and the
 * payload in a row written weeks ago was validated against whatever version of
 * `placeMention` was current then. So every row is parsed, and a row that no
 * longer fits is dropped from the factor's sample rather than crashing the
 * stage. A pack that widened its schema should lose a little history, not a run.
 *
 * **They abstain rather than returning zero.** A factor here returns `null` when
 * the corpus does not carry what it measures — no language recorded anywhere, no
 * view count, every item's `creatorReads` an honest `unknown`. `FactorReading`
 * explains why this matters more than it looks: zero is a measurement and would
 * quietly punish a place for the shape of the surfaces it was found on.
 *
 * **`evidenceIds` is the receipts, not the sample.** Each reading carries the
 * rows that pushed it *up* — the Thai-language items, the local-sounding
 * creators, the listicles — rather than everything it divided by. That is what a
 * card can render under "because": a reader following the link wants to see the
 * items the number is claiming, and a list that also contained every row arguing
 * the other way would make the link useless.
 *
 * **The fifth factor in section 2.5's list is not here, and it is the same kind
 * of finding P2.4 recorded about the embedding key.** "Creator-local share" is
 * here, because `placeMention.creatorReads` carries it. What is *not* here is
 * any factor about the creator as a person — how often they post, whether they
 * have named this neighbourhood before, whether their other places cluster. The
 * repository has no creator entity: mentions point at places, and the only
 * identity attached to an artifact is the persona that harvested it, which is
 * *ours*. A factor weighing a persona would be scoring our own sampling. When a
 * creator vertical exists, that factor is an addition to this file and nothing
 * else.
 */

/**
 * The language a place's own neighbourhood writes in.
 *
 * Singular and hard-coded, which is a real limitation and worth naming: this
 * pack is Thailand-only today — `City` is a Thai enum, the OSM extract is a Thai
 * bbox — and a second country makes this a property of the place rather than a
 * constant. Until then, a configurable field would be configuration nobody sets,
 * pointing at the one value it could have.
 */
const NATIVE_LANGUAGE = "th"

/**
 * How many distinct sources count as a fully diverse corpus.
 *
 * Four, which is every adapter we have — YouTube, TikTok, Pantip, Maps. The
 * number is a ceiling rather than a target: a place found on all four is as
 * corroborated as this corpus can make it, and the factor saturates there rather
 * than continuing to reward a fifth source we do not harvest.
 */
const SOURCE_DIVERSITY_FULL = 4

/**
 * The engagement ratio at which the factor saturates.
 *
 * Ten percent of viewers reacting is a lot. The shape being measured is not
 * popularity — a listicle farms views — but whether the audience did anything,
 * and a threshold well below the viral ceiling is what keeps a modest Pantip
 * thread from reading as indistinguishable from an ignored one.
 */
const ENGAGEMENT_FULL = 0.1

/**
 * How many receipts one reading carries.
 *
 * `scores` is a jsonb column read on every card render, and eight factors each
 * naming two hundred uuids would be thirty kilobytes of ids per place to support
 * a UI that shows a handful. Twenty is more than anything renders and small
 * enough to stop the column growing with the corpus. The rows are taken in the
 * order evidence came back, which `PostgresEvidenceStore` makes newest-first.
 */
const MAX_RECEIPTS = 20

/** Parsed evidence: the engine's row beside the pack's own payload. */
interface Claim {
  row: EvidenceRecord
  mention: ReturnType<typeof placeMention.parse>
}

const claims = (evidence: readonly EvidenceRecord[]): Claim[] => {
  const out: Claim[] = []
  for (const row of evidence) {
    const parsed = placeMention.safeParse(row.extract)
    // Dropped, not thrown. See the header: a row written against an older
    // version of the schema costs this factor one sample, not the run.
    if (parsed.success) out.push({ row, mention: parsed.data })
  }
  return out
}

const receipts = (rows: readonly EvidenceRecord[]): string[] =>
  rows.slice(0, MAX_RECEIPTS).map((row) => row.id)

/**
 * A share of a population, with the supporting rows attached.
 *
 * The one helper every share-shaped factor is built from, so that "abstain when
 * the population is empty" is written once. An empty population is exactly the
 * case abstention exists for: no rows recorded a language, or every creator read
 * as `unknown`, and a zero there is a claim about the place rather than about
 * the corpus.
 */
const share = (
  population: readonly Claim[],
  supporting: readonly Claim[],
): { value: number; evidenceIds: string[] } | null => {
  if (population.length === 0) return null
  return {
    value: supporting.length / population.length,
    evidenceIds: receipts(supporting.map((c) => c.row)),
  }
}

/** BCP 47 arrives as `th`, `th-TH`, `en-GB`. Compare the primary subtag only. */
const primary = (language: string | null): string | null =>
  language === null ? null : (language.split("-")[0]?.toLowerCase() ?? null)

/**
 * Phrases that mean "this is a list someone will work through", in both
 * languages the corpus arrives in.
 *
 * Matched against the verbatim quote rather than a title, because the quote is
 * the one span of source text evidence carries and it is the span the extractor
 * chose as the reason this place was named. A place whose *reasons* are all "one
 * of the 10 best" is being recommended by rank rather than by anything about it.
 *
 * Kept deliberately short. Every entry is a phrase that would be strange in a
 * neighbourhood recommendation, and the way this list fails is by growing until
 * it matches ordinary enthusiasm — "ต้องลอง" (worth trying) belongs to both
 * kinds of writing and is not here.
 */
const LISTICLE_PHRASES = [
  "top 10",
  "top10",
  "top 5",
  "best places",
  "must-visit",
  "must visit",
  "must-try",
  "must try",
  "bucket list",
  "hidden gem",
  "10 อันดับ",
  "ห้ามพลาด",
  "ที่เที่ยวห้ามพลาด",
]

/**
 * Hosts that publish for people who do not live there.
 *
 * Deliberately a list of *aggregators and guidebooks*, not of foreign sites. A
 * Thai-language blog is not touristy because it is a blog, and an English-
 * language Bangkok resident's newsletter is not touristy because it is English —
 * that is what the language factor is for, weighed separately, so that neither
 * signal has to carry the other's mistakes.
 *
 * Matched on host suffix so that `www.` and country subdomains are covered
 * without a regex per entry. This list will be wrong and will need adding to;
 * being a constant in the pack rather than a column means adding to it is a
 * commit someone reviews.
 */
const LISTICLE_HOSTS = [
  "tripadvisor.com",
  "timeout.com",
  "lonelyplanet.com",
  "culturetrip.com",
  "thecrazytourist.com",
  "migrationology.com",
  "expedia.com",
  "agoda.com",
  "klook.com",
  "getyourguide.com",
]

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    // `source_url` is `NOT NULL` but nothing constrains it to parse, and a
    // malformed URL is not a reason to fail a score. It simply matches nothing.
    return null
  }
}

const isListicleHost = (url: string): boolean => {
  const host = hostOf(url)
  if (host === null) return false
  return LISTICLE_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))
}

const hasListiclePhrase = (quote: string): boolean => {
  const haystack = quote.toLowerCase()
  return LISTICLE_PHRASES.some((phrase) => haystack.includes(phrase))
}

/** Everything that recorded a language at all. The population both share factors divide by. */
const languaged = (rows: readonly Claim[]): Claim[] =>
  rows.filter((c) => primary(c.row.language) !== null)

/** Everything whose creator was placed either way. `unknown` is not a vote. */
const placed = (rows: readonly Claim[]): Claim[] =>
  rows.filter((c) => c.mention.creatorReads !== "unknown")

const nativeLanguageShare: ScoreFactor<PlaceEntity> = {
  name: "nativeLanguageShare",
  weight: 3,
  measure(_entity, evidence) {
    const rows = languaged(claims(evidence))
    return share(
      rows,
      rows.filter((c) => primary(c.row.language) === NATIVE_LANGUAGE),
    )
  },
}

const creatorLocalShare: ScoreFactor<PlaceEntity> = {
  name: "creatorLocalShare",
  weight: 3,
  measure(_entity, evidence) {
    const rows = placed(claims(evidence))
    return share(
      rows,
      rows.filter((c) => c.mention.creatorReads === "local"),
    )
  },
}

/**
 * How many different adapters found this place, as a share of all of them.
 *
 * A corroboration term rather than a localness term, and it earns its place
 * under `local` for a specific reason: the failure mode this score exists to
 * catch is a place that is famous on exactly one surface. One viral TikTok
 * produces a dozen Thai-language items from Thai creators, and every other
 * factor here reads that as maximally local. A second source disagreeing —
 * or, more often, simply never having heard of it — is the only thing in the
 * corpus that can tell a neighbourhood fixture from a trend.
 *
 * It never abstains. `source_id` is `NOT NULL` on every evidence row, so there
 * is always something to count, and one source is a real reading of 0 rather
 * than an absence.
 */
const sourceDiversity: ScoreFactor<PlaceEntity> = {
  name: "sourceDiversity",
  weight: 2,
  measure(_entity, evidence) {
    if (evidence.length === 0) return null
    const seen = new Map<string, EvidenceRecord>()
    for (const row of evidence) if (!seen.has(row.sourceId)) seen.set(row.sourceId, row)
    // One short of the count over one short of the ceiling, so a single source
    // reads as 0 rather than as a quarter. The place found only on TikTok has no
    // corroboration at all, and 0.25 would say it had some.
    const value = Math.min(1, (seen.size - 1) / (SOURCE_DIVERSITY_FULL - 1))
    return { value, evidenceIds: receipts([...seen.values()]) }
  },
}

/**
 * Did anyone react, as a fraction of the people who saw it.
 *
 * The weakest factor here and weighted accordingly. Its argument is that a place
 * carried by ranked lists accumulates views without replies, while a place
 * someone's neighbour posted about gets argued with — but the ratio is also a
 * function of which surface reports what, and it is not a clean signal.
 *
 * It abstains whenever it cannot see a denominator, which on this corpus is
 * most of the time: Pantip reports no views at all. That is exactly the case
 * `FactorReading` was designed around. Scoring those zero would make every
 * forum-found place look worse than every video-found one, in a score that is
 * supposed to mean the opposite.
 */
const engagementRatio: ScoreFactor<PlaceEntity> = {
  name: "engagementRatio",
  weight: 1,
  measure(_entity, evidence) {
    let views = 0
    let reactions = 0
    const counted: EvidenceRecord[] = []
    for (const row of evidence) {
      const { views: v, likes, comments } = row.engagement
      if (v === null || v <= 0) continue
      if (likes === null && comments === null) continue
      views += v
      reactions += (likes ?? 0) + (comments ?? 0)
      counted.push(row)
    }
    if (counted.length === 0) return null
    // Pooled rather than averaged per item: a video with four views and one like
    // is not evidence of a 25% engagement rate, and averaging ratios would let
    // it outweigh a video with a hundred thousand.
    const value = Math.min(1, reactions / views / ENGAGEMENT_FULL)
    return { value, evidenceIds: receipts(counted) }
  },
}

const nonNativeLanguageShare: ScoreFactor<PlaceEntity> = {
  name: "nonNativeLanguageShare",
  weight: 3,
  measure(_entity, evidence) {
    const rows = languaged(claims(evidence))
    return share(
      rows,
      rows.filter((c) => primary(c.row.language) !== NATIVE_LANGUAGE),
    )
  },
}

const visitorCreatorShare: ScoreFactor<PlaceEntity> = {
  name: "visitorCreatorShare",
  weight: 3,
  measure(_entity, evidence) {
    const rows = placed(claims(evidence))
    return share(
      rows,
      rows.filter((c) => c.mention.creatorReads === "visitor"),
    )
  },
}

const listicleQuotes: ScoreFactor<PlaceEntity> = {
  name: "listicleQuotes",
  weight: 2,
  measure(_entity, evidence) {
    const rows = claims(evidence)
    return share(
      rows,
      rows.filter((c) => hasListiclePhrase(c.mention.quote)),
    )
  },
}

/**
 * Never abstains and does not parse the payload, because it only needs the
 * engine's own `source_url`. It is the one factor here that would still work if
 * the pack's mention schema were empty.
 */
const listicleSources: ScoreFactor<PlaceEntity> = {
  name: "listicleSources",
  weight: 2,
  measure(_entity, evidence) {
    if (evidence.length === 0) return null
    const hits = evidence.filter((row) => isListicleHost(row.sourceUrl))
    return { value: hits.length / evidence.length, evidenceIds: receipts(hits) }
  },
}

/**
 * The two scores, and the reason they are two rather than one axis.
 *
 * A single `local ↔ tourist` slider would make them exact complements, and they
 * are not: a temple can be a genuine neighbourhood fixture *and* on every
 * itinerary, and a new café can be neither. The product needs to be able to say
 * "locals go here and so does everyone else", which one number cannot express.
 *
 * They are also built from overlapping but different evidence. The language and
 * creator factors mirror each other, deliberately — they are the same population
 * counted the other way, and their disagreement is informative. The other two on
 * each side share nothing: corroboration and engagement say nothing about
 * tourism, and listicles say nothing about who lives nearby.
 */
export const placeScores: ScoreSpec<PlaceEntity> = {
  scores: {
    local: [nativeLanguageShare, creatorLocalShare, sourceDiversity, engagementRatio],
    tourist: [nonNativeLanguageShare, visitorCreatorShare, listicleQuotes, listicleSources],
  },
}
