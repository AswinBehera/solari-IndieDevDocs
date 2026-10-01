import { createDb } from "@rd/db"
import { PostgresJobStore } from "@samsara/kernel/postgres"

const [blockId, cascade] = process.argv.slice(2)
const { db, sql } = createDb(process.env.DATABASE_URL!)
const owner = process.env.DEV_OWNER_ID ?? "00000000-0000-4000-8000-000000000001"
console.log(
  await new PostgresJobStore(db).enqueue({
    type: "block.run",
    ownerId: owner,
    payload: { blockId, cascade: cascade === "cascade" },
  }),
)
await sql.end()
