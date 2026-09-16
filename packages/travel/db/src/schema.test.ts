import { getTableName, is } from "drizzle-orm"
import { PgTable } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { schema } from "./schema.js"

const tables = Object.values(schema).filter((v) => is(v, PgTable))
const names = tables.map((t) => getTableName(t)).sort()

const ENGINE = [
  "budget_counters",
  "drift_experiments",
  "evidence",
  "harvest_runs",
  "job_events",
  "jobs",
  "mentions",
  "observations",
  "personas",
  "probe_targets",
  "raw_items",
  "seed_plans",
  "sessions",
]
const TRAVEL = ["documents", "places", "postcards", "trips", "users"]

describe("the composed schema", () => {
  it("is one database: every engine table plus every travel table, declared once", () => {
    expect(names).toEqual([...ENGINE, ...TRAVEL].sort())
  })

  it("has no duplicate table declared on both sides", () => {
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("the seam, as the database sees it", () => {
  it("has no foreign key from an engine table into a travel table", () => {
    // The rule from plan section 3: engine rows point at a vertical's entity through
    // an opaque (domain_id, entity_id) pair, never a constraint. Verified structurally
    // here so CI catches it without needing a live Postgres.
    const travel = new Set(TRAVEL)
    const offenders: string[] = []

    for (const table of tables) {
      const name = getTableName(table)
      if (!ENGINE.includes(name)) continue
      const config = (table as unknown as { [k: symbol]: unknown })[
        Symbol.for("drizzle:PgInlineForeignKeys")
      ] as Array<{ reference: () => { foreignTable: PgTable } }> | undefined

      for (const fk of config ?? []) {
        const target = getTableName(fk.reference().foreignTable)
        if (travel.has(target)) offenders.push(`${name} -> ${target}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
