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

async function main() {
  const { db, sql: client } = createDb(connectionString, { max: 1 })
  const found = await db.execute(
    sql`select o.target_id as id, t.url from observations o join probe_targets t on t.id = o.target_id
        group by o.target_id, t.url having count(distinct o.country) >= 6
        order by max(o.captured_at) desc limit 1`,
  )
  const target = (found as unknown as { id: string; url: string }[])[0]
  if (!target) {
    console.error("no probe target with 6 observations yet: run one price check first")
    await client.end()
    process.exit(1)
  }

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
