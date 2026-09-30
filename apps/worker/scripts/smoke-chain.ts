// Seeds one doc with comparables → snapshot → slop_share and queues the first
// block with cascade. Run the worker (`main()`) afterwards to drain the chain.
import { createDb, PostgresResearchStore } from "@rd/db"
import { PostgresJobStore } from "@samsara/kernel/postgres"

const owner = process.env.DEV_OWNER_ID ?? "00000000-0000-4000-8000-000000000001"
const limit = Number(process.argv[2] ?? 4)
const { db, sql } = createDb(process.env.DATABASE_URL!)
const store = new PostgresResearchStore(db)
const doc = await store.createDoc(owner, "Smoke: cozy farming sims", { type: "doc", content: [] })
const comp = await store.createBlock(owner, doc.id, "comparables", { tagIds: [492, 87918], limit, exclude: [] })
const snap = await store.createBlock(owner, doc.id, "store_snapshot", { source: comp!.id })
const share = await store.createBlock(owner, doc.id, "slop_share", { source: snap!.id })
await new PostgresJobStore(db).enqueue({ type: "block.run", ownerId: owner, payload: { blockId: comp!.id, cascade: true } })
console.log(JSON.stringify({ doc: doc.id, comp: comp!.id, snap: snap!.id, share: share!.id }))
await sql.end()
