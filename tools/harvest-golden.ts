/**
 * Rebuilds the travel pack's golden corpus from Pantip, in one Solari session.
 *
 * The corpus in `packages/travel/pack/src/golden/corpus.json` is checked in and the
 * 2.9MB of page state it was derived from is not. This script is why that is a
 * defensible trade rather than a loss: the provenance of those fifty items is a
 * program you can read and run, not a sentence in a commit message.
 *
 * **It is not meant to be run casually, and it will not be run by CI.** It opens a
 * real browser session against a real site and bills real minutes against the 4,000
 * in §8. More to the point, the labels in `labels.json` are keyed by item id and
 * written by hand against specific text — so a second harvest does not refresh the
 * golden set, it invalidates the key. Pantip's front page moves hourly; run this
 * tomorrow and you get fifty different items under fifty familiar-looking ids. The
 * assertions in `golden.test.ts` are the tripwire for exactly that, and they are
 * there because a silently re-harvested corpus is a measuring instrument that has
 * stopped measuring anything.
 *
 * So the output path is an argument with no default. Writing over the committed
 * corpus is a thing you have to ask for by name, for the same reason `.env.example`
 * leaves `LLM_MODEL_EXTRACT` empty rather than guessing.
 *
 * **Why two stages.** Pantip's `tag` and `forum` surfaces are title-only by design —
 * a listing page carries headlines and nothing else — and `pantip/index.ts` says the
 * chaining into topics is the caller's. The first attempt at this corpus skipped
 * that step and harvested a fine set of zero prose items.
 *
 * Usage:
 *   npx tsx tools/harvest-golden.ts <out.json>
 */
import { writeFileSync } from "node:fs"
import {
  createSolariBrowserLauncher,
  solariCredentials,
} from "../packages/samsara/kernel/src/solari.js"
import type { CaptureContext, ItemDraft } from "../packages/samsara/sources/src/adapter.js"
import { harvest } from "../packages/samsara/sources/src/adapter.js"
import { createPantipAdapter } from "../packages/samsara/sources/src/pantip/index.js"

const out = process.argv[2]
if (!out) {
  console.error("usage: npx tsx tools/harvest-golden.ts <out.json>")
  console.error("refusing to guess an output path: see the note about invalidating the key")
  process.exit(1)
}

/**
 * The listings to walk, chosen so that a place-bearing answer is the *normal*
 * answer. P1.2's pantip fixture was captured against the recipe board, which is why
 * it made a good parser fixture and no corpus at all: a thread about how to cook
 * something names dishes, not restaurants.
 */
const LISTINGS = [
  { surface: "tag", query: "ร้านอาหาร" },
  { surface: "forum", query: "food" },
] as const

/**
 * `[CR]` and `[SR]` are Pantip's own consumer-review and sponsored-review markers,
 * so two of these seven are the site's classification rather than my guess at one.
 * The rest are the words a Thai thread uses when it is about going somewhere.
 */
const REVIEWISH = /\[CR\]|\[SR\]|ร้าน|คาเฟ่|ตลาด|เที่ยว|ชี้เป้า|พาไปกิน/

const TOPICS = 12
const PER_TOPIC = 8
/** Below this a reply is an emoji and a thank-you, which labels as a negative but teaches nothing. */
const MIN_CHARS = 100
/** The refine engine's own `maxItemChars`. See the note on `text` below. */
const MAX_CHARS = 4_000

const persona = { id: "golden-harvest", country: "th", locale: "th-TH", timezoneId: "Asia/Bangkok" }

/**
 * `sg`, not `th`. Solari has no Thai egress — the API answers a `th` request with
 * `Unsupported proxy country` and a list that does not include it. The viewpoint
 * stays `th-TH`, which is the half that decides what language the page comes back
 * in, and the P1 fixtures were captured the same way.
 */
const proxy = { country: "sg", tier: "residential" } as const

const launcher = createSolariBrowserLauncher(solariCredentials())
const startedAt = Date.now()
const rows: unknown[] = []
let browser: Awaited<ReturnType<typeof launcher.launch>> | undefined

/** The logger a one-off script wants: the counts go to stdout below, in prose. */
const quiet = { log: () => {} } as unknown as CaptureContext["logger"]

try {
  browser = await launcher.launch({
    stealth: true,
    proxy,
    viewpoint: { locale: "th-TH", timezoneId: "Asia/Bangkok" },
  })

  const withPage = async <T>(run: (ctx: CaptureContext) => Promise<T>): Promise<T> => {
    const page = await browser!.newPage()
    try {
      return await run({ page, persona, logger: quiet, signal: AbortSignal.timeout(90_000) })
    } finally {
      await (page as { close(): Promise<void> }).close().catch(() => {})
    }
  }

  // Stage one: the listings, for their topic ids.
  const seen = new Set<string>()
  const picked: string[] = []
  for (const { surface, query } of LISTINGS) {
    const adapter = createPantipAdapter(surface)
    const { capture, items } = await withPage((ctx) => harvest(adapter, ctx, query))
    console.log(
      `${adapter.id} "${query}" → ${items.length}${capture.refusedBy ? ` REFUSED(${capture.refusedBy})` : ""}`,
    )
    for (const item of items) {
      const id = item.url.match(/topic\/(\d+)/)?.[1]
      if (!id || seen.has(id) || !REVIEWISH.test(item.title ?? "")) continue
      seen.add(id)
      picked.push(id)
    }
  }

  // Stage two: the topics, for their prose.
  const topic = createPantipAdapter("topic")
  for (const id of picked.slice(0, TOPICS)) {
    const { capture, items } = await withPage((ctx) => harvest(topic, ctx, id))
    if (capture.refusedBy) {
      console.log(`topic ${id} REFUSED(${capture.refusedBy})`)
      continue
    }

    // Pantip renders "related topics" teasers into a topic page, and the parser
    // returns them as items — correctly, in that they are items with their own
    // urls, but they belong to other threads and carry tag-list boilerplate where
    // the prose should be. The topic id in the url is the discriminator, and
    // without this filter over a third of the corpus was other people's sidebars.
    const own = items.filter((i: ItemDraft) => i.url.includes(`/topic/${id}`))
    // The opening post first, because that is the review where there is one, then
    // the longest replies, because that is where a recommendation gets argued over.
    const ordered = [own[0], ...own.slice(1).sort((a, b) => b.text.length - a.text.length)]

    let taken = 0
    for (const item of ordered) {
      if (!item || taken >= PER_TOPIC) continue
      const text = item.text.trim()
      if (text.length < MIN_CHARS) continue
      rows.push({
        id: `pt-${id}-${taken}`,
        sourceId: topic.id,
        url: item.url,
        title: item.title,
        // Capped at the engine's own `maxItemChars`, so the text a label is written
        // against is exactly the text the extractor is shown. Labelling the full
        // item and grading against a truncated one scores a model down for a place
        // it was never given.
        text: text.slice(0, MAX_CHARS),
        languageGuess: item.languageGuess,
      })
      taken += 1
    }
    console.log(`topic ${id} → ${taken} items`)
  }
} finally {
  await browser?.close().catch(() => {})
  await launcher.dispose().catch(() => {})
}

writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`)
console.log(`\n${rows.length} items → ${out}`)
console.log(`${((Date.now() - startedAt) / 60_000).toFixed(2)} solari minutes`)
