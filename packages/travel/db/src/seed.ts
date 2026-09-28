import { createDb } from "./client.js"
import { documents, trips, users } from "./tables.js"
import { EMPTY_DOCUMENT } from "./trips.js"

/**
 * Local development seed: one user, one trip. Idempotent, so `pnpm db:seed` twice is
 * not an error — the fixed ids exist precisely so re-running is boring.
 *
 * The user id is a UUID because in production it is the Supabase Auth `sub`
 * (ADR-0013). There is no auth schema locally, so this one is simply made up.
 */

const DEV_USER_ID = "00000000-0000-4000-8000-000000000001"
const DEV_TRIP_ID = "00000000-0000-4000-8000-000000000002"

const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/doen_thang"

async function main() {
  const { db, sql } = createDb(connectionString, { max: 1 })

  await db
    .insert(users)
    .values({
      id: DEV_USER_ID,
      email: "dev@localhost",
      plan: "pro",
      locale: "en-IN",
      budgetSolariMinutesPerDay: null,
      budgetGeocodeCallsPerDay: null,
    })
    .onConflictDoNothing()

  await db
    .insert(trips)
    .values({
      id: DEV_TRIP_ID,
      userId: DEV_USER_ID,
      title: "Bangkok, November",
      destinationCity: "Bangkok",
      startDate: new Date("2026-11-02T00:00:00.000Z"),
      endDate: new Date("2026-11-09T00:00:00.000Z"),
      status: "planning",
    })
    .onConflictDoNothing()

  // Every trip has its document; `TripStore.create` writes both, so the seed does too.
  await db
    .insert(documents)
    .values({ tripId: DEV_TRIP_ID, content: EMPTY_DOCUMENT })
    .onConflictDoNothing()

  const allUsers = await db.select().from(users)
  const allTrips = await db.select().from(trips)

  console.log(`seeded: ${allUsers.length} user(s), ${allTrips.length} trip(s)`)
  await sql.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
