/**
 * Build the Samsara demo's results from real captures: `pnpm db:seed:demo` seeds
 * the characters, and this is what they are shown to have found.
 *
 * Usage: npx tsx tools/build-samsara-demo.ts
 *
 * **Nothing here is written by hand.** Each run is a capture a real browser took
 * (the committed, scrubbed `__fixtures__`, plus two local YouTube captures from
 * the 16 September comparison), put through the same parser the worker uses, and
 * cut to the top items. The query and the capture time are the capture's own; the
 * only editorial act is which character each capture is filed under, and each
 * entry says why in `why`.
 *
 * The two YouTube captures are the pair the Lab's split screen was built on: the
 * same English question, eleven seconds apart, one from a Thai-locale browser (the
 * page came back in Thai) and one from an English one. Filed under Auntie Noi and
 * Sam, they are the demo's comparison. `.captures/` is gitignored, so this tool
 * is only re-runnable on the machine that has them; the output is committed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import type { Capture, ItemDraft } from "../packages/samsara/sources/src/adapter.js"
import { parseMaps } from "../packages/samsara/sources/src/maps/parse.js"
import { parsePantip } from "../packages/samsara/sources/src/pantip/parse.js"
import { parseYouTube } from "../packages/samsara/sources/src/youtube/parse.js"

const OUT = "packages/travel/pack/fixtures/samsara-demo.json"
const TOP = 10
const SRC = "packages/samsara/sources/src"
const LOCAL = "apps/worker/.captures/captures/youtube.search"

interface Plan {
  archetype: string
  file: string
  sourceId: string
  why: string
}

const PLANS: Plan[] = [
  {
    archetype: "Street-food auntie",
    file: `${LOCAL}/9098964e-f266-4fad-811d-3a378f67057e/ae7a5b38-8bd1-4986-9b7f-487e5335a3a4.json`,
    sourceId: "youtube.search",
    why: "Thai-locale browser; YouTube answered in Thai. Half of the 16 Sep comparison pair.",
  },
  {
    archetype: "First-time tourist",
    file: `${LOCAL}/8cd3b212-ba8c-46ab-838a-de242d15a26a/c8673ddf-ca1c-4d10-9fa3-bdd82e523fbb.json`,
    sourceId: "youtube.search",
    why: "English-locale browser, same question 11 s later. The other half of the pair.",
  },
  {
    archetype: "Street-food auntie",
    file: `${SRC}/pantip/__fixtures__/pantip-forum-th-TH-2026-09-13.capture.json`,
    sourceId: "pantip.forum",
    why: "th-TH browser reading Pantip's food forum.",
  },
  {
    archetype: "Office worker in Ari",
    file: `${SRC}/maps/__fixtures__/maps-search-cafes-th-TH-2026-09-13.capture.json`,
    sourceId: "maps.search",
    why: "th-TH browser searching Maps for cafés in Ari, in Thai.",
  },
]

type Parser = (c: Capture<never>) => readonly ItemDraft[]
const PARSERS: Record<string, Parser> = {
  "youtube.search": parseYouTube as Parser,
  "pantip.forum": parsePantip as Parser,
  "maps.search": parseMaps as Parser,
}

const runs = PLANS.map((plan) => {
  if (!existsSync(plan.file)) throw new Error(`missing capture: ${plan.file}`)
  const raw = JSON.parse(readFileSync(plan.file, "utf8")) as Capture<never> & {
    capturedAt: string
  }
  const capture = { ...raw, sourceId: plan.sourceId, capturedAt: new Date(raw.capturedAt) }
  const parse = PARSERS[plan.sourceId]
  if (!parse) throw new Error(`no parser for ${plan.sourceId}`)
  const items = parse(capture as Capture<never>).slice(0, TOP)
  console.log(`${plan.archetype} · ${plan.sourceId} · "${raw.query}" → ${items.length} items`)
  return {
    archetype: plan.archetype,
    sourceId: plan.sourceId,
    query: raw.query,
    capturedAt: raw.capturedAt,
    why: plan.why,
    items: items.map((item, i) => ({
      rank: i + 1,
      url: item.url,
      title: item.title,
      text: item.text.slice(0, 400),
      languageGuess: item.languageGuess,
      engagement: item.engagement,
    })),
  }
})

writeFileSync(OUT, `${JSON.stringify({ runs }, null, 2)}\n`)
console.log(`wrote ${OUT}`)
