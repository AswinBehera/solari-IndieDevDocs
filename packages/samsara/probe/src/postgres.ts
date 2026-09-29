import { observations, probeTargets } from "@samsara/db"
import type { TablesRelationalConfig } from "drizzle-orm"
import { and, desc, eq, sql } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type {
  NewObservation,
  NewProbeTarget,
  ObservationRecord,
  ObservationStore,
  ProbeTargetRecord,
  ProbeTargetStore,
} from "./adapter.js"

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>

const toTarget = (r: typeof probeTargets.$inferSelect): ProbeTargetRecord => ({
  id: r.id,
  ownerId: r.ownerId,
  sourceId: r.sourceId,
  url: r.url,
  parsed: r.parsed,
  watch: r.watch,
  cadence: r.cadence,
  createdAt: r.createdAt,
})

const toObservation = (r: typeof observations.$inferSelect): ObservationRecord => ({
  id: r.id,
  targetId: r.targetId,
  country: r.country,
  personaId: r.personaId,
  capturedAt: r.capturedAt,
  payload: r.payload,
  screenshotRef: r.screenshotRef,
  sessionId: r.sessionId,
  notes: r.notes,
})

export class PostgresProbeTargetStore implements ProbeTargetStore {
  constructor(private readonly db: Db) {}

  async upsert(input: NewProbeTarget): Promise<ProbeTargetRecord> {
    const owner =
      input.ownerId === null
        ? sql`${probeTargets.ownerId} is null`
        : eq(probeTargets.ownerId, input.ownerId)
    const [existing] = await this.db
      .select()
      .from(probeTargets)
      .where(and(owner, eq(probeTargets.url, input.url)))
      .limit(1)
    if (existing) return toTarget(existing)
    const [row] = await this.db
      .insert(probeTargets)
      .values({
        ownerId: input.ownerId,
        sourceId: input.sourceId,
        url: input.url,
        parsed: input.parsed,
        watch: input.watch ?? false,
        cadence: input.cadence ?? null,
      })
      .returning()
    if (!row) throw new Error("probe target insert returned no row")
    return toTarget(row)
  }

  async get(id: string) {
    const [row] = await this.db.select().from(probeTargets).where(eq(probeTargets.id, id)).limit(1)
    return row ? toTarget(row) : null
  }

  async getOwned(ownerId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(probeTargets)
      .where(and(eq(probeTargets.id, id), eq(probeTargets.ownerId, ownerId)))
      .limit(1)
    return row ? toTarget(row) : null
  }

  async listWatched() {
    const rows = await this.db.select().from(probeTargets).where(eq(probeTargets.watch, true))
    return rows.map(toTarget)
  }
}

export class PostgresObservationStore implements ObservationStore {
  constructor(private readonly db: Db) {}

  async insert(o: NewObservation): Promise<string> {
    const [row] = await this.db.insert(observations).values(o).returning({ id: observations.id })
    if (!row) throw new Error("observation insert returned no row")
    return row.id
  }

  async listByTarget(targetId: string, limit = 200) {
    const rows = await this.db
      .select()
      .from(observations)
      .where(eq(observations.targetId, targetId))
      .orderBy(desc(observations.capturedAt))
      .limit(limit)
    return rows.map(toObservation)
  }

  async latestByCountry(targetId: string) {
    const rows = await this.db
      .selectDistinctOn([observations.country])
      .from(observations)
      .where(eq(observations.targetId, targetId))
      .orderBy(observations.country, desc(observations.capturedAt))
    return rows.map(toObservation)
  }
}
