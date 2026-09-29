import { existsSync, readFileSync } from "node:fs"
import { sql } from "drizzle-orm"
import { createDb } from "./client.js"
import { documents, trips, users } from "./tables.js"
import { PostgresTripStore } from "./trips.js"

/**
 * The demo trip: a Bangkok document with a hotel Price card that already holds a
 * real seven-country probe, so the price table is on screen the moment the trip
 * opens and the demo cannot fail on a slow site or a blocked session.
 *
 * It reads the newest probe target that has at least six observations, so it needs
 * one real run first (`POST /probes` with the worker draining, or
 * `tools/probe-live.ts`); with none it says so and stops rather than inventing one.
 * Idempotent: the trip has a fixed id and is rebuilt each time.
 */

const USER_ID = "00000000-0000-4000-8000-000000000001"
const TRIP_ID = "00000000-0000-4000-8000-0000000000d1"
const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/doen_thang"

type Db = ReturnType<typeof createDb>["db"]

const FIXTURE = "../../../apps/web/public/demo/probe.json"

/**
 * A probe target with six or more countries: the newest real one in the database,
 * else the committed fixture of a real run (`demo/probe.json`, screenshots beside
 * it), loaded under fresh session rows. The card links a shot at `/shots/<ref>`,
 * so a fixture ref is prefixed `../demo/shots/` to land on the committed copy. The fixture exists because `pnpm test`
 * truncates the tables the live probe lives in.
 */
async function ensureDemoProbe(db: Db): Promise<{ id: string; url: string }> {
  const found = await db.execute(
    sql`select o.target_id as id, t.url from observations o join probe_targets t on t.id = o.target_id
        group by o.target_id, t.url having count(distinct o.country) >= 6
        order by max(o.captured_at) desc limit 1`,
  )
  const live = (found as unknown as { id: string; url: string }[])[0]
  if (live) return live
  if (!existsSync(FIXTURE)) {
    console.error("no probe with 6 countries and no demo fixture: run one price check first")
    process.exit(1)
  }
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    url: string
    parsed: unknown
    observations: {
      country: string
      capturedAt: string
      payload: unknown
      screenshotRef: string
      notes: string | null
    }[]
  }
  const [t] = (await db.execute(
    sql`insert into probe_targets (owner_id, source_id, url, parsed)
        values (${USER_ID}, 'price.stay', ${fx.url}, ${JSON.stringify(fx.parsed)}::jsonb) returning id`,
  )) as unknown as { id: string }[]
  if (!t) throw new Error("could not insert the demo probe target")
  for (const o of fx.observations) {
    const [s] = (await db.execute(
      sql`insert into sessions (purpose, country, outcome, started_at, ended_at)
          values ('probe', ${o.country}, 'ok', ${o.capturedAt}, ${o.capturedAt}) returning id`,
    )) as unknown as { id: string }[]
    await db.execute(
      sql`insert into observations (target_id, country, captured_at, payload, screenshot_ref, session_id, notes)
          values (${t.id}, ${o.country}, ${o.capturedAt}, ${JSON.stringify(o.payload)}::jsonb,
                  ${`../demo/shots/${o.screenshotRef}`}, ${s?.id}, ${o.notes})`,
    )
  }
  return { id: t.id, url: fx.url }
}

async function main() {
  const { db, sql: client } = createDb(connectionString, { max: 1 })
  const target = await ensureDemoProbe(db)

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

  const store = new PostgresTripStore(db)
  const price = await store.addPostcard(USER_ID, TRIP_ID, {
    kind: "price",
    placeId: null,
    payload: { url: target.url, probeId: target.id },
    geo: null,
    time: null,
    sourceRefs: [],
  })
  if (!price) throw new Error("could not add the price card")
  const text = (t: string) => ({ type: "paragraph", content: [{ type: "text", text: t }] })
  const content = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Bangkok, 29 October" }],
      },
      text(
        "Street food, night markets, and one good hotel. Same room, different countries: what does each one see?",
      ),
      { type: "postcard", attrs: { postcardId: price.id } },
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
