import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { schema } from "./schema.js"

export type Db = ReturnType<typeof createDb>["db"]

/**
 * One pool per process. `max` is small on purpose: the worker is bound by browser
 * minutes long before it is bound by database concurrency, and the API opens one
 * connection per request (Hyperdrive does the pooling).
 */
export function createDb(connectionString: string, options?: { max?: number }) {
  const sql = postgres(connectionString, { max: options?.max ?? 5 })
  return { db: drizzle(sql, { schema }), sql }
}
