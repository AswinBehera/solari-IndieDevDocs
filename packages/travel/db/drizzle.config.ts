import { existsSync } from "node:fs"
import { defineConfig } from "drizzle-kit"

/**
 * @dt/db owns the single migration history for the whole database, engine tables
 * included — which is why `schema` points at the composed object rather than at this
 * package's own tables.
 *
 * drizzle-kit reads no `.env` of its own, so without this line `pnpm db:migrate`
 * silently migrated the fallback URL below while `db:seed:demo` (which does read
 * `.env`) seeded `DATABASE_URL` — a fresh clone with its own URL got a seed error
 * about a table the migration had created somewhere else. `loadEnvFile` never
 * overrides a variable already set, so `with-hosted-env.sh` still wins.
 */
const ROOT_ENV = "../../../.env"
if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV)

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/research_docs",
  },
  strict: true,
  verbose: true,
})
