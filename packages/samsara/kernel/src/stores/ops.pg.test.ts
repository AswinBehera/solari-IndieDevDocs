import { samsaraSchema } from "@samsara/db"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PostgresOpsReader } from "./ops.js"

/**
 * The ops dashboard's read (P5.5) against a real Postgres: the aggregates are SQL,
 * so a fake cannot say whether `filter (where ...)` or the day window is right.
 * Skips on the same terms as `jobs.pg.test.ts`; the missing-database failure is
 * that file's to raise, once per package.
 */

const url = process.env.DATABASE_URL
const hasDb = typeof url === "string" && url.length > 0

const client = hasDb ? postgres(url as string, { max: 2 }) : undefined
const db = client ? drizzle(client, { schema: samsaraSchema }) : undefined
let lock: DatabaseLock | null = null

beforeAll(async () => {
  if (hasDb) lock = await lockDatabase(url as string)
})

afterAll(async () => {
  await client?.end({ timeout: 5 })
  await lock?.release()
})

describe.skipIf(!hasDb)("the ops reader, against Postgres", () => {
  it("counts today's minutes, the blocked rate, open sessions and today's counters", async () => {
    await db?.execute(sql`TRUNCATE TABLE sessions, budget_counters CASCADE`)
    const now = new Date("2026-09-29T12:00:00Z")
    await db?.execute(sql`
      INSERT INTO sessions (purpose, country, domain_id, started_at, minutes, outcome) VALUES
        ('harvest', 'th', 'youtube.search', '2026-09-29T10:00:00Z', 1.5, 'ok'),
        ('harvest', 'th', 'youtube.search', '2026-09-29T11:00:00Z', 0.5, 'blocked'),
        ('harvest', 'th', 'youtube.search', '2026-09-27T11:00:00Z', 9, 'ok'),
        ('harvest', 'th', 'maps.search', '2026-09-29T11:30:00Z', 0, 'running')`)
    await db?.execute(sql`
      INSERT INTO budget_counters (meter, "window", window_key, amount) VALUES
        ('solari.minutes', 'global.day', '2026-09-29', 2),
        ('solari.minutes', 'global.day', '2026-09-28', 50)`)

    const snap = await new PostgresOpsReader(db as never).snapshot(now)

    expect(snap.minutesToday).toEqual([{ purpose: "harvest", minutes: 2 }])
    expect(snap.used).toEqual({ "solari.minutes": 2 })
    expect(snap.open.map((s) => s.country)).toEqual(["th"])
    const yt = snap.adapters.find((a) => a.domainId === "youtube.search")
    expect(yt).toEqual({ domainId: "youtube.search", total: 2, blocked: 1 })
  })
})
