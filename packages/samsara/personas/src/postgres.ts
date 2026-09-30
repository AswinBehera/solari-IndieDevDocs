import { type PersonaHealth, personaTraits, type SessionOutcome } from "@samsara/core"
import { personas, sessions } from "@samsara/db"
import type { TablesRelationalConfig } from "drizzle-orm"
import { and, desc, eq, isNotNull, sql } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type {
  PersonaEdit,
  PersonaFilter,
  PersonaRecord,
  PersonaStore,
  SessionOutturn,
} from "./store.js"

/**
 * The real persona store.
 *
 * Typed against `PgDatabase` rather than a concrete client, like the kernel's, so
 * a caller may pass a database composed with its own vertical's tables while this
 * file still touches only engine ones.
 */
type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>

type Row = typeof personas.$inferSelect

const toRecord = (row: Row): PersonaRecord => ({
  id: row.id,
  name: row.name,
  locality: row.locality,
  country: row.country,
  locale: row.locale,
  timezoneId: row.timezoneId,
  tier: row.tier,
  solariProfileId: row.solariProfileId,
  proxySession: row.proxySession,
  health: row.health,
  seedPlanId: row.seedPlanId,
  lastAliveAt: row.lastAliveAt,
  stats: { sessions: row.statSessions, minutes: row.statMinutes, blocks: row.statBlocks },
  // Parsed on the way out: jsonb takes anything, and a row edited by hand should
  // read as no traits rather than as a shape the caller trusts.
  traits: row.traits == null ? null : (personaTraits.safeParse(row.traits).data ?? null),
})

export class PostgresPersonaStore implements PersonaStore {
  constructor(private readonly db: Db) {}

  async insert(row: PersonaRecord): Promise<void> {
    await this.db.insert(personas).values({
      id: row.id,
      name: row.name,
      locality: row.locality,
      country: row.country,
      locale: row.locale,
      timezoneId: row.timezoneId,
      tier: row.tier,
      solariProfileId: row.solariProfileId,
      proxySession: row.proxySession,
      health: row.health,
      seedPlanId: row.seedPlanId,
      lastAliveAt: row.lastAliveAt,
      statSessions: row.stats.sessions,
      statMinutes: row.stats.minutes,
      statBlocks: row.stats.blocks,
      traits: row.traits ?? null,
    })
  }

  async byId(id: string): Promise<PersonaRecord | null> {
    const [row] = await this.db.select().from(personas).where(eq(personas.id, id)).limit(1)
    return row ? toRecord(row) : null
  }

  async list(filter: PersonaFilter = {}): Promise<PersonaRecord[]> {
    const clauses = [
      ...(filter.country ? [eq(personas.country, filter.country)] : []),
      ...(filter.health ? [eq(personas.health, filter.health)] : []),
    ]
    const rows = await this.db
      .select()
      .from(personas)
      // The `(country, health)` index exists for exactly this listing — picking a
      // usable identity in a country is the query the harvester runs constantly.
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(personas.lastAliveAt))
    return rows.map(toRecord)
  }

  async setHealth(id: string, health: PersonaHealth): Promise<void> {
    await this.db.update(personas).set({ health, updatedAt: new Date() }).where(eq(personas.id, id))
  }

  async edit(id: string, patch: PersonaEdit): Promise<PersonaRecord | null> {
    const [row] = await this.db
      .update(personas)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(personas.id, id))
      .returning()
    return row ? toRecord(row) : null
  }

  async setProfile(id: string, solariProfileId: string | null): Promise<void> {
    await this.db
      .update(personas)
      .set({ solariProfileId, updatedAt: new Date() })
      .where(eq(personas.id, id))
  }

  async setProxySession(id: string, proxySession: string): Promise<void> {
    await this.db
      .update(personas)
      .set({ proxySession, updatedAt: new Date() })
      .where(eq(personas.id, id))
  }

  /**
   * One statement, and every counter expressed as `column + literal`.
   *
   * Never read-modify-write. Two runners draining at once is the normal case under
   * ADR-0014, and a read-then-write loses one of the two updates silently and
   * always in the direction of under-counting — which, for a minutes column under
   * a hard ceiling, is the direction that costs money.
   */
  async recordSession(id: string, outturn: SessionOutturn): Promise<void> {
    await this.db
      .update(personas)
      .set({
        statSessions: sql`${personas.statSessions} + 1`,
        statMinutes: sql`${personas.statMinutes} + ${outturn.minutes}`,
        statBlocks: sql`${personas.statBlocks} + ${outturn.outcome === "blocked" ? 1 : 0}`,
        // Only a session that worked proves the identity is still alive. A blocked
        // or timed-out session that moved this forward would make a dying persona
        // look freshly exercised.
        ...(outturn.outcome === "ok" ? { lastAliveAt: outturn.at } : {}),
        updatedAt: new Date(),
      })
      .where(eq(personas.id, id))
  }

  /**
   * The evidence health is derived from, newest first — the order `assess`
   * requires. `endedAt is not null` drops sessions still running, which have no
   * verdict yet and would otherwise pad the window with `running` rows and push
   * real evidence out of it.
   */
  async recentOutcomes(id: string, limit: number): Promise<SessionOutcome[]> {
    const rows = await this.db
      .select({ outcome: sessions.outcome })
      .from(sessions)
      .where(and(eq(sessions.personaId, id), isNotNull(sessions.endedAt)))
      .orderBy(desc(sessions.startedAt))
      .limit(limit)
    return rows.map((r) => r.outcome)
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(personas).where(eq(personas.id, id))
  }
}
