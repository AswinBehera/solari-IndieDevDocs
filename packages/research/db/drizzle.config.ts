import { existsSync } from "node:fs"
import { defineConfig } from "drizzle-kit"

/**
 * The single migration history for the whole database, engine tables included.
 * drizzle-kit reads no `.env` of its own, so the root one is loaded here; an
 * already-set `DATABASE_URL` still wins.
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
