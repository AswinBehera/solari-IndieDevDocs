import { samsaraSchema } from "@samsara/db"
import * as researchTables from "./tables.js"

/**
 * The whole database in one module. The star re-exports are what drizzle-kit
 * reads — the `schema` object alone would generate an empty migration.
 */
export * from "@samsara/db"
export * from "./tables.js"

export const schema = { ...samsaraSchema, ...researchTables } as const
export type Schema = typeof schema
