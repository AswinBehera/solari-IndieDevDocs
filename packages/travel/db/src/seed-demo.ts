import { existsSync, readFileSync } from "node:fs"
import { sql } from "drizzle-orm"
import { createDb } from "./client.js"
import { documents, trips, users } from "./tables.js"
import { PostgresTripStore } from "./trips.js"

/**
 * The demo trip: a Bangkok document with a hotel Price card that already holds
 * real readings from two booking sites, so the comparison is on screen the moment
 * the trip opens and the demo cannot fail on a slow site or a blocked session.
 *
 * The readings are the committed fixture of a live run (`demo/providers.json`, the
 * two snapshots beside it): the same room on Agoda and Booking.com, read from the
 * US on 30 September 2026. The fixture exists because `pnpm test` truncates the
 * tables a live probe lives in. Idempotent: the trip has a fixed id and is rebuilt
 * each time, and a reading already loaded is reused rather than loaded twice.
 */

const USER_ID = "00000000-0000-4000-8000-000000000001"
const TRIP_ID = "00000000-0000-4000-8000-0000000000d1"
const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/doen_thang"

type Db = ReturnType<typeof createDb>["db"]

const FIXTURE = "../../../apps/web/public/demo/providers.json"

interface Fixture {
  viewpoint: string
  offers: {
    url: string
    parsed: unknown
    observation: {
      country: string
      capturedAt: string
      payload: unknown
      screenshotRef: string
      notes: string | null
    }
  }[]
}

/**
 * One probe target per offer, with its one observation. The card links a shot at
 * `/shots/<ref>`, so a fixture ref is prefixed `../demo/shots/` to land on the
 * committed copy.
 */
async function ensureOffer(db: Db, offer: Fixture["offers"][number]): Promise<string> {
  const o = offer.observation
  const found = (await db.execute(
    sql`select t.id from probe_targets t join observations o on o.target_id = t.id
        where t.owner_id = ${USER_ID} and t.url = ${offer.url} and o.country = ${o.country}
          and o.captured_at = ${o.capturedAt}
        order by o.captured_at desc limit 1`,
  )) as unknown as { id: string }[]
  if (found[0]) return found[0].id
  const [t] = (await db.execute(
    sql`insert into probe_targets (owner_id, source_id, url, parsed)
        values (${USER_ID}, 'price.stay', ${offer.url}, ${JSON.stringify(offer.parsed)}::jsonb) returning id`,
  )) as unknown as { id: string }[]
  if (!t) throw new Error("could not insert a demo probe target")
  const [s] = (await db.execute(
    sql`insert into sessions (purpose, country, outcome, started_at, ended_at)
        values ('probe', ${o.country}, 'ok', ${o.capturedAt}, ${o.capturedAt}) returning id`,
  )) as unknown as { id: string }[]
  await db.execute(
    sql`insert into observations (target_id, country, captured_at, payload, screenshot_ref, session_id, notes)
        values (${t.id}, ${o.country}, ${o.capturedAt}, ${JSON.stringify(o.payload)}::jsonb,
                ${`../demo/shots/${o.screenshotRef}`}, ${s?.id}, ${o.notes})`,
  )
  return t.id
}

async function main() {
  const { db, sql: client } = createDb(connectionString, { max: 1 })
  if (!existsSync(FIXTURE)) {
    console.error(`no demo fixture at ${FIXTURE}`)
    process.exit(1)
  }
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture

  await db
    .insert(users)
    .values({ id: USER_ID, email: "dev@localhost", plan: "pro", locale: "en-IN" })
    .onConflictDoNothing()
  await db.delete(trips).where(sql`${trips.id} = ${TRIP_ID}`)
  await db.insert(trips).values({
    id: TRIP_ID,
    userId: USER_ID,
    title: "Bangkok, late October",
    destinationCity: "Bangkok",
    startDate: new Date("2026-10-29T00:00:00.000Z"),
    endDate: new Date("2026-10-30T00:00:00.000Z"),
    status: "planning",
  })
  await db
    .insert(documents)
    .values({ tripId: TRIP_ID, content: { type: "doc", content: [{ type: "paragraph" }] } })

  const offers = []
  for (const offer of fx.offers)
    offers.push({ url: offer.url, probeId: await ensureOffer(db, offer) })

  const store = new PostgresTripStore(db)
  const price = await store.addPostcard(USER_ID, TRIP_ID, {
    kind: "price",
    placeId: null,
    payload: { offers, viewpoint: fx.viewpoint },
    geo: null,
    time: null,
    sourceRefs: [],
  })
  if (!price) throw new Error("could not add the price card")

  // The rest of the page, so the scrapbook has something besides the price card.
  // The link and the café are real finds from Samsara's demo captures
  // (`@dt/travel-pack/fixtures/samsara-demo.json`), not stand-ins.
  const card = async (kind: "note" | "checklist" | "link", payload: Record<string, unknown>) => {
    const c = await store.addPostcard(USER_ID, TRIP_ID, {
      kind,
      placeId: null,
      payload,
      geo: null,
      time: null,
      sourceRefs: [],
    })
    if (!c) throw new Error(`could not add the ${kind} card`)
    return { type: "postcard", attrs: { postcardId: c.id } }
  }
  const link = await card("link", { url: "https://www.youtube.com/watch?v=3OK61vAyz2w" })
  const note = await card("note", {
    text: "Say อร่อยมาก (aroi mak, really delicious) to the cook.\nลดได้ไหม (lot dai mai) at the market, with a smile.\nCash for the stalls; most take PromptPay, not cards.",
  })
  const packing = await card("checklist", {
    items: [
      { text: "Book the hotel on whichever site is cheaper", done: false },
      { text: "Ask Beam to look for a code again the week before", done: false },
      { text: "Coffee in Ari: Two Eight Squared (the office worker's find)", done: true },
      { text: "Small notes, 20s and 100s, for street food", done: false },
    ],
  })
  const text = (t: string) => ({ type: "paragraph", content: [{ type: "text", text: t }] })
  const h2 = (t: string) => ({
    type: "heading",
    attrs: { level: 2 },
    content: [{ type: "text", text: t }],
  })
  const content = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Bangkok, 29 October" }],
      },
      text(
        "Street food, night markets, and one good hotel. Same room on two booking sites: which is cheaper, and has anyone shared a code?",
      ),
      { type: "postcard", attrs: { postcardId: price.id } },
      h2("Morning"),
      text("The street-food auntie's pick for a market breakfast, found searching in Thai."),
      link,
      h2("Before we go"),
      note,
      packing,
    ],
  }
  const saved = await store.saveDocument(USER_ID, TRIP_ID, content, 1)
  console.log(saved?.saved ? `demo trip ready: /trips/${TRIP_ID}` : "document save conflicted")
  await client.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
