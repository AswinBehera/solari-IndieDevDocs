import { randomUUID } from "node:crypto"
import { samsaraSchema, sessions } from "@samsara/db"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { SESSION_SCAN_DEPTH } from "./health.js"
import { PostgresPersonaStore } from "./postgres.js"
import type { PersonaRecord } from "./store.js"

/**
 * The persona store against a real Postgres.
 *
 * Two properties live here because `MemoryPersonaStore` is structurally unable to
 * hold them. The first is concurrent accounting: `recordSession` is `column + 1`
 * in one statement precisely so that two runners draining at once cannot lose an
 * update, and a fake that runs one statement at a time cannot fail that test,
 * which means it cannot pass it either. The second is `recentOutcomes`, which is
 * SQL — ordering, the `endedAt` filter and the limit are the whole contract, and
 * a Map re-implementing them proves only that the Map agrees with itself.
 *
 * Runs whenever `DATABASE_URL` is set, and **fails loudly when it is not** unless
 * `SAMSARA_NO_DB=1` says the omission is deliberate. See `jobs.pg.test.ts` for why
 * that bargain, and not a silent skip: a green run that tested nothing is worse
 * than a red one, because a red one gets investigated.
 */

const url = process.env.DATABASE_URL
const hasDb = typeof url === "string" && url.length > 0
const optedOut = process.env.SAMSARA_NO_DB === "1"

if (!hasDb && !optedOut) {
  describe("personas, against Postgres", () => {
    it("has a database to run against", () => {
      expect.fail(
        "DATABASE_URL is not set, so the concurrency and SQL tests would have " +
          "skipped and this run would have reported green while testing nothing. " +
          "Run `pnpm db:up` and retry, or set SAMSARA_NO_DB=1 to skip on purpose.",
      )
    })
  })
}

// `max: 8` is the concurrency test's whole point — it needs eight real connections
// to race on. `onnotice` silences the "truncate cascades to ..." chorus, which is
// expected here and long enough to push a real failure off the screen.
const client = hasDb ? postgres(url as string, { max: 8, onnotice: () => {} }) : null
const db = client ? drizzle(client, { schema: samsaraSchema }) : null

// Held for the whole file: these suites truncate shared tables, and Turbo runs
// the packages that do so at the same time. See `@samsara/db/testing`.
let lock: DatabaseLock | null = null

beforeAll(async () => {
  if (hasDb) lock = await lockDatabase(url as string)
})

afterAll(async () => {
  await client?.end({ timeout: 5 })
  await lock?.release()
})

const row = (over: Partial<PersonaRecord> = {}): PersonaRecord => ({
  id: randomUUID(),
  name: "regular",
  locality: "District 1",
  country: "sg",
  locale: "vi-VN",
  timezoneId: "Asia/Ho_Chi_Minh",
  tier: "anon",
  solariProfileId: null,
  proxySession: "0123456789abcdef",
  health: "healthy",
  seedPlanId: null,
  lastAliveAt: null,
  stats: { sessions: 0, minutes: 0, blocks: 0 },
  traits: null,
  ...over,
})

describe.runIf(hasDb)("personas, against Postgres", () => {
  const store = () => new PostgresPersonaStore(db as NonNullable<typeof db>)

  beforeEach(async () => {
    const d = db as NonNullable<typeof db>
    await d.execute(sql`truncate table sessions, personas restart identity cascade`)
  })

  it("stores a persona and reads it back unchanged, timezone included", async () => {
    const s = store()
    const p = row()
    await s.insert(p)
    const read = await s.byId(p.id)
    expect(read).toEqual(p)
  })

  it("keeps a character's traits opaque, and edits them without touching the counters", async () => {
    const s = store()
    const p = row({
      traits: { archetype: "night owl", interests: ["late food"], look: { colour: "#7b8cff" } },
    })
    await s.insert(p)
    expect((await s.byId(p.id))?.traits).toEqual(p.traits)

    await s.recordSession(p.id, { minutes: 1, outcome: "ok", at: new Date() })
    const edited = await s.edit(p.id, { name: "renamed", traits: { interests: ["temples"] } })
    expect(edited?.name).toBe("renamed")
    expect(edited?.traits).toEqual({ interests: ["temples"] })
    expect(edited?.stats.sessions).toBe(1)
    expect(await s.edit(randomUUID(), { name: "nobody" })).toBeNull()
  })

  it("keeps every increment when eight sessions land at once", async () => {
    const s = store()
    const p = row()
    await s.insert(p)
    const at = new Date()

    // The property the fake cannot express. Under ADR-0014 a cron run and a
    // dispatched run can be awake at the same instant by design, and a
    // read-then-write here loses updates silently and always downward — which for
    // a minutes column under a hard ceiling is the direction that costs money.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        s.recordSession(p.id, {
          minutes: 0.25,
          outcome: i % 4 === 0 ? "blocked" : "ok",
          at,
        }),
      ),
    )

    const read = await s.byId(p.id)
    expect(read?.stats.sessions).toBe(8)
    expect(read?.stats.minutes).toBeCloseTo(2, 6)
    expect(read?.stats.blocks).toBe(2)
  })

  it("moves lastAliveAt only for a session that worked", async () => {
    const s = store()
    const p = row()
    await s.insert(p)
    const at = new Date("2026-09-12T10:00:00.000Z")

    await s.recordSession(p.id, { minutes: 0.1, outcome: "blocked", at })
    expect((await s.byId(p.id))?.lastAliveAt).toBeNull()

    await s.recordSession(p.id, { minutes: 0.1, outcome: "ok", at })
    expect((await s.byId(p.id))?.lastAliveAt?.toISOString()).toBe(at.toISOString())
  })

  it("returns session outcomes newest first, which is the order assess requires", async () => {
    const s = store()
    const p = row()
    await s.insert(p)
    const d = db as NonNullable<typeof db>

    // Oldest to newest: ok, ok, blocked. Newest first must therefore lead with the
    // refusal. Reading this backwards is the bug that bans healthy personas.
    const base = Date.parse("2026-09-12T10:00:00.000Z")
    await d.insert(sessions).values(
      (["ok", "ok", "blocked"] as const).map((outcome, i) => ({
        purpose: "persona.keepalive" as const,
        personaId: p.id,
        country: "sg",
        startedAt: new Date(base + i * 60_000),
        endedAt: new Date(base + i * 60_000 + 30_000),
        minutes: 0.5,
        outcome,
      })),
    )

    expect(await s.recentOutcomes(p.id, SESSION_SCAN_DEPTH)).toEqual(["blocked", "ok", "ok"])
  })

  it("ignores sessions that have not ended", async () => {
    const s = store()
    const p = row()
    await s.insert(p)
    const d = db as NonNullable<typeof db>
    await d.insert(sessions).values({
      purpose: "harvest",
      personaId: p.id,
      country: "sg",
      endedAt: null,
      outcome: "running",
    })
    // A running row has no verdict yet. Counted, it would pad the window and push
    // real evidence out of the limit.
    expect(await s.recentOutcomes(p.id, SESSION_SCAN_DEPTH)).toEqual([])
  })

  it("does not attribute one persona's sessions to another", async () => {
    const s = store()
    const mine = row()
    const theirs = row()
    await s.insert(mine)
    await s.insert(theirs)
    const d = db as NonNullable<typeof db>
    await d.insert(sessions).values({
      purpose: "harvest",
      personaId: theirs.id,
      country: "sg",
      endedAt: new Date(),
      minutes: 0.5,
      outcome: "blocked",
    })
    expect(await s.recentOutcomes(mine.id, SESSION_SCAN_DEPTH)).toEqual([])
    expect(await s.recentOutcomes(theirs.id, SESSION_SCAN_DEPTH)).toEqual(["blocked"])
  })

  it("lists by country and health, which is how a harvester picks one", async () => {
    const s = store()
    await s.insert(row({ country: "sg", health: "healthy" }))
    await s.insert(row({ country: "sg", health: "banned" }))
    await s.insert(row({ country: "us", health: "healthy" }))

    expect(await s.list({ country: "sg" })).toHaveLength(2)
    expect(await s.list({ country: "sg", health: "healthy" })).toHaveLength(1)
    expect(await s.list()).toHaveLength(3)
  })

  it("refuses a second persona with the same id rather than overwriting one", async () => {
    const s = store()
    const p = row()
    await s.insert(p)
    await expect(s.insert(row({ id: p.id, name: "impostor" }))).rejects.toThrow()
    expect((await s.byId(p.id))?.name).toBe("regular")
  })
})
