import { mkdirSync, writeFileSync } from "node:fs"
import { sql } from "drizzle-orm"
import { createDb } from "./client.js"

/**
 * Freezes the newest real probe (six or more countries) into `demo/probe.json`, so
 * the demo trip survives `pnpm test`, which truncates every table it touches.
 * Screenshots are copied separately (see `seed-demo.ts`). Run after a real price
 * check: `pnpm --filter @dt/db exec tsx src/export-demo-probe.ts`.
 */
const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/doen_thang"

const { db, sql: client } = createDb(connectionString, { max: 1 })
const rows = (await db.execute(sql`
  select t.url, t.parsed, o.country, o.captured_at, o.payload, o.screenshot_ref, o.notes
  from observations o join probe_targets t on t.id = o.target_id
  where o.target_id = (
    select target_id from observations group by target_id
    having count(distinct country) >= 6 order by max(captured_at) desc limit 1)
  order by o.country`)) as unknown as {
  url: string
  parsed: unknown
  country: string
  captured_at: Date
  payload: unknown
  screenshot_ref: string
  notes: string | null
}[]
if (rows.length === 0) throw new Error("no probe with six countries to export")
mkdirSync("../../../apps/web/public/demo", { recursive: true })
writeFileSync(
  "../../../apps/web/public/demo/probe.json",
  `${JSON.stringify(
    {
      url: rows[0]?.url,
      parsed: rows[0]?.parsed,
      observations: rows.map((r) => ({
        country: r.country,
        capturedAt: r.captured_at,
        payload: r.payload,
        screenshotRef: r.screenshot_ref,
        notes: r.notes,
      })),
    },
    null,
    2,
  )}\n`,
)
console.log(`exported ${rows.length} observations`)
await client.end()
