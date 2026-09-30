/**
 * Queue a spread of `harvest.run` jobs so Bangkok has a corpus worth searching.
 *
 * The hosted database held 18 scored places, all from one query ("Bangkok street
 * food") run fourteen times as a drift experiment. That proves the pipeline and
 * nothing else: a traveller who types "Wat Pho" or "rooftop bar" finds nothing.
 * This tool queues one harvest per query below, in English and Thai, across the
 * categories the place card knows about and the neighbourhoods people ask for.
 * Each harvest chains into extract → resolve → dedup → score on its own (see
 * `apps/worker/src/chain.ts`), so queueing is the only step.
 *
 * **Re-running it is safe.** The idempotency key is the query itself, so a second
 * run collides with the first. Add queries to grow the corpus; do not rename them.
 *
 * **It queues spend rather than spending**, like `backfill-refine.ts`: `--commit`
 * is required, and the estimate prints first. Each harvest is one Solari session
 * (~0.2 browser-minutes observed) plus one extraction of ~20 items.
 *
 * **It uses the database's own personas**, alternating across the healthy ones so
 * none carries the whole batch. A fresh clone has none, so on `--commit` it
 * creates one `anon` Bangkok persona: `anon` needs no Solari profile, only the
 * `SOLARI_API_KEY` the harvest itself spends.
 *
 * Usage:
 *   npx tsx --env-file=.env tools/harvest-corpus.ts [--limit N] [--commit]
 *   ./tools/with-hosted-env.sh npx tsx tools/harvest-corpus.ts [--commit]
 *
 * `--limit 5` takes the first five queries, which is the way to try the pipeline
 * for a few cents. Locally `pnpm dev`'s worker drains the queue; on hosted,
 * `gh workflow run worker.yml -f budgetMinutes=40 -f shards=6`.
 */

import { randomUUID } from "node:crypto"
import { PostgresJobStore } from "../packages/samsara/kernel/src/stores/postgres.js"
import { PostgresPersonaStore } from "../packages/samsara/personas/src/postgres.js"
import { createDb } from "../packages/travel/db/src/index.js"

const SOURCE_ID = "youtube.search"
const DOMAIN_ID = "travel"
/** The dev owner `pnpm db:seed` creates, and the one the hosted jobs carry. */
const OWNER_ID = "00000000-0000-4000-8000-000000000001"

/** Observed on the fourteen hosted runs of 28–29 September 2026. */
const MINUTES_PER_HARVEST = 0.2
const DOLLARS_PER_MINUTE = 0.002
const DOLLARS_PER_EXTRACTION = (0.0092 / 50) * 20

export const QUERIES: readonly string[] = [
  // Food, by dish and by kind of place.
  "best pad thai Bangkok",
  "Bangkok boat noodles Victory Monument",
  "khao man gai Bangkok famous",
  "Jay Fai crab omelette Bangkok",
  "Bangkok michelin street food",
  "Bangkok som tam isaan restaurant",
  "khao soi Bangkok",
  "Bangkok mango sticky rice best",
  "Bangkok hainanese chicken rice Pratunam",
  "Bangkok moo ping breakfast",
  "Bangkok tom yum goong restaurant",
  "Bangkok jok rice porridge",
  "Bangkok seafood restaurant local",
  "Bangkok thai fine dining",
  "Bangkok vegetarian restaurant",
  "Bangkok halal food",
  "Bangkok hidden gem restaurant",
  "Bangkok food tour locals",
  "Bangkok shophouse restaurant old town",
  "Bangkok noodle soup legendary",
  "ผัดไทย อร่อย กรุงเทพ",
  "ก๋วยเตี๋ยวเรือ อนุสาวรีย์",
  "ข้าวมันไก่ ประตูน้ำ",
  "ร้านอาหาร เยาวราช",
  "ส้มตำ อร่อย กรุงเทพ",
  "ร้านลับ กรุงเทพ",
  "ร้านเด็ด บางรัก",
  "ข้าวต้ม โต้รุ่ง",
  "ร้านอาหาร มิชลิน สตรีทฟู้ด",
  "ก๋วยจั๊บ เยาวราช",
  // Neighbourhoods.
  "Yaowarat Chinatown night food",
  "Bangrak street food",
  "Ari Bangkok cafes food",
  "Thonglor restaurants",
  "Ekkamai bars restaurants",
  "Silom food guide",
  "Sukhumvit soi 38 food",
  "Banglamphu food Khao San",
  "Talad Noi walk",
  "Charoen Krung art walk",
  "Old town Rattanakosin walk",
  "Thonburi canal food",
  "Samyan Mitrtown food",
  "Bang Kho Laem riverside",
  "Phra Nakhon food guide",
  "เที่ยว อารีย์",
  "เที่ยว ทองหล่อ",
  "เดินเที่ยว ตลาดน้อย",
  "เที่ยว ฝั่งธน",
  "เที่ยว เจริญกรุง",
  // Markets.
  "Chatuchak market food guide",
  "Or Tor Kor market",
  "Jodd Fairs night market",
  "Khlong Toei market",
  "Pak Khlong Talat flower market",
  "Wang Lang market",
  "Talad Rot Fai Srinakarin",
  "Bangkok floating market near city",
  "Khlong Lat Mayom floating market",
  "Sampeng lane market",
  "ตลาดนัด กรุงเทพ",
  "ตลาดน้ำ ใกล้กรุงเทพ",
  "ตลาดคลองเตย",
  "ตลาดวังหลัง",
  "ตลาดนัดกลางคืน",
  // Temples and sights.
  "Wat Pho reclining Buddha",
  "Wat Arun temple of dawn",
  "Grand Palace Wat Phra Kaew",
  "Wat Saket golden mount",
  "Wat Benchamabophit marble temple",
  "Wat Suthat giant swing",
  "Wat Traimit golden Buddha",
  "Wat Paknam Bangkok",
  "Erawan shrine Bangkok",
  "Bangkok temples less crowded",
  "วัดโพธิ์",
  "วัดอรุณ",
  "ภูเขาทอง วัดสระเกศ",
  "วัดปากน้ำ ภาษีเจริญ",
  "ไหว้พระ 9 วัด กรุงเทพ",
  // Cafes and drink.
  "Bangkok specialty coffee",
  "Bangkok cafe hopping",
  "Bangkok rooftop bar",
  "Bangkok speakeasy bar",
  "Bangkok craft beer bar",
  "Bangkok cocktail bar Asia 50 best",
  "Bangkok thai tea",
  "Bangkok dessert cafe",
  "คาเฟ่ กรุงเทพ",
  "คาเฟ่ ริมแม่น้ำ",
  "บาร์ ลับ กรุงเทพ",
  "ร้านกาแฟ อารีย์",
  // Nightlife.
  "Bangkok live music bar",
  "Bangkok jazz bar",
  "Bangkok nightlife guide",
  "Soi Nana Chinatown bars",
  "RCA Bangkok clubs",
  "บาร์ ดนตรีสด",
  // Nature and slower days.
  "Lumpini park Bangkok",
  "Bang Krachao green lung bike",
  "Benjakitti forest park",
  "Chao Phraya river boat",
  "Bangkok canal tour khlong",
  "Koh Kret island",
  "สวนลุมพินี",
  "บางกระเจ้า ปั่นจักรยาน",
  "เกาะเกร็ด",
  // Shopping, museums, the rest.
  "Bangkok museums guide",
  "Jim Thompson house",
  "Bangkok art galleries",
  "ICONSIAM food hall",
  "Bangkok vintage shopping",
  "Bangkok bookstores",
  "Bangkok muay thai stadium",
  "Bangkok thai massage local",
  "Bangkok cooking class",
  "Bangkok day trip Ayutthaya",
  "Bangkok with kids",
  "Bangkok rainy day",
  "Bangkok 3 day itinerary locals",
]

function usage(message: string): never {
  console.error(`harvest-corpus: ${message}`)
  console.error("usage: tools/harvest-corpus.ts [--limit N] [--commit]")
  process.exit(1)
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit")
  const url = process.env.DATABASE_URL
  if (!url) usage("DATABASE_URL is not set")

  const unique = new Set(QUERIES)
  if (unique.size !== QUERIES.length) usage("QUERIES has duplicates; the key is the query")

  const at = process.argv.indexOf("--limit")
  const limit = at === -1 ? QUERIES.length : Number(process.argv[at + 1])
  if (!Number.isInteger(limit) || limit < 1) usage("--limit takes a whole number above zero")
  const queries = QUERIES.slice(0, limit)

  const minutes = queries.length * MINUTES_PER_HARVEST
  const dollars = minutes * DOLLARS_PER_MINUTE + queries.length * DOLLARS_PER_EXTRACTION
  console.log(
    `${queries.length} harvest(s) via ${SOURCE_ID}, ~${minutes.toFixed(1)} browser-minutes`,
  )
  console.log(`estimated ~$${dollars.toFixed(2)} including extraction`)

  if (!commit) {
    console.log("\n--commit not given, so nothing was queued.")
    return
  }

  const database = createDb(url)
  try {
    const jobs = new PostgresJobStore(database.db)
    const personas = await personasFor(new PostgresPersonaStore(database.db))
    let queued = 0
    let deduped = 0
    for (const [i, query] of queries.entries()) {
      const personaId = personas[i % personas.length] as string
      const result = await jobs.enqueue({
        type: "harvest.run",
        domainId: DOMAIN_ID,
        ownerId: OWNER_ID,
        idempotencyKey: `corpus:${DOMAIN_ID}:${SOURCE_ID}:${query}`,
        payload: { personaId, sourceId: SOURCE_ID, query, domainId: DOMAIN_ID },
      })
      if (result.deduped) deduped += 1
      else queued += 1
    }
    console.log(`\nqueued ${queued}, already queued ${deduped}`)
  } finally {
    await database.sql.end({ timeout: 5 })
  }
}

/** The healthy personas' ids, creating a Bangkok `anon` one when there are none. */
async function personasFor(store: PostgresPersonaStore): Promise<string[]> {
  const healthy = await store.list({ health: "healthy" })
  if (healthy.length > 0) return healthy.map((p) => p.id)
  const id = randomUUID()
  await store.insert({
    id,
    name: "bangkok-anon",
    locality: "Bangkok",
    country: "th",
    locale: "th-TH",
    timezoneId: "Asia/Bangkok",
    tier: "anon",
    solariProfileId: null,
    proxySession: null,
    health: "healthy",
    seedPlanId: null,
    lastAliveAt: null,
    stats: { sessions: 0, minutes: 0, blocks: 0 },
  })
  console.log(`no healthy persona, so created ${id} (anon, Bangkok)`)
  return [id]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
