import type { MeterId, PersonaHealth, SessionPurpose } from "@samsara/core"
import { budgetCounters, personas, sessions } from "@samsara/db"
import type { TablesRelationalConfig } from "drizzle-orm"
import { and, desc, eq, gte, sql } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>

/** What the ops dashboard (P5.5) shows, before ceilings are laid over it. */
export interface OpsSnapshot {
  open: { id: string; purpose: SessionPurpose; country: string; startedAt: string }[]
  minutesToday: { purpose: SessionPurpose; minutes: number }[]
  /** Global-day counters, one per meter that has a row today. */
  used: Partial<Record<MeterId, number>>
  /** Sessions in the last 24 hours per adapter (`domain_id`), with how many were blocked. */
  adapters: { domainId: string; total: number; blocked: number }[]
  personas: {
    id: string
    name: string
    country: string
    health: PersonaHealth
    lastAliveAt: string | null
    sessions: number
    blocks: number
  }[]
}

/**
 * The read side of the kernel's own tables, for one screen.
 *
 * Five aggregate queries and no row-per-session read, because the API answers it
 * inside a 10 ms CPU budget (ADR-0014). Ceilings are not joined here: they are
 * constants, not rows, so the caller lays them over `used`.
 */
export class PostgresOpsReader {
  constructor(private readonly db: Db) {}

  async snapshot(now: Date = new Date()): Promise<OpsSnapshot> {
    const day = now.toISOString().slice(0, 10)
    const startOfDay = new Date(`${day}T00:00:00.000Z`)
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    const [open, minutes, counters, adapters, board] = await Promise.all([
      this.db
        .select({
          id: sessions.id,
          purpose: sessions.purpose,
          country: sessions.country,
          startedAt: sessions.startedAt,
        })
        .from(sessions)
        .where(eq(sessions.outcome, "running"))
        .orderBy(desc(sessions.startedAt))
        .limit(50),
      this.db
        .select({
          purpose: sessions.purpose,
          minutes: sql<number>`coalesce(sum(${sessions.minutes}), 0)::float8`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, startOfDay))
        .groupBy(sessions.purpose),
      this.db
        .select({ meter: budgetCounters.meter, amount: budgetCounters.amount })
        .from(budgetCounters)
        .where(and(eq(budgetCounters.window, "global.day"), eq(budgetCounters.windowKey, day))),
      this.db
        .select({
          domainId: sql<string>`coalesce(${sessions.domainId}, 'unknown')`,
          total: sql<number>`count(*)::int`,
          blocked: sql<number>`count(*) filter (where ${sessions.outcome} = 'blocked')::int`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, since))
        .groupBy(sql`coalesce(${sessions.domainId}, 'unknown')`),
      this.db
        .select({
          id: personas.id,
          name: personas.name,
          country: personas.country,
          health: personas.health,
          lastAliveAt: personas.lastAliveAt,
          sessions: personas.statSessions,
          blocks: personas.statBlocks,
        })
        .from(personas)
        .orderBy(personas.name),
    ])

    return {
      open: open.map((r) => ({ ...r, startedAt: r.startedAt.toISOString() })),
      minutesToday: minutes,
      used: Object.fromEntries(counters.map((c) => [c.meter, c.amount])),
      adapters,
      personas: board.map((p) => ({ ...p, lastAliveAt: p.lastAliveAt?.toISOString() ?? null })),
    }
  }
}
