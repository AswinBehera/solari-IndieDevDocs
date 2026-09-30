import type { PersonaHealth, PersonaTier, PersonaTraits, SessionOutcome } from "@samsara/core"

/**
 * The persona row as this package needs it, and the port that holds it.
 *
 * `recentOutcomes` looks like it belongs to a session store rather than a persona
 * store, and it is here on purpose: health is derived from session history
 * (`health.ts`), so the one query that makes a persona's state computable travels
 * with the persona. Splitting it into a second port would be one interface per
 * query, which is how a port stops describing a role and starts describing SQL.
 */

export interface PersonaRecord {
  id: string
  name: string
  /** Free text: where this identity reads as being from. Not where it egresses. */
  locality: string
  /** Lowercase ISO 3166-1 alpha-2 — the form the proxy layer takes. */
  country: string
  locale: string
  timezoneId: string
  tier: PersonaTier
  solariProfileId: string | null
  proxySession: string | null
  health: PersonaHealth
  seedPlanId: string | null
  lastAliveAt: Date | null
  stats: { sessions: number; minutes: number; blocks: number }
  /** Optional so every record written before traits existed still is one. */
  traits?: PersonaTraits | null
}

/**
 * What may change about an identity after it exists.
 *
 * Never its counters, health or profile: those are history, written by the
 * sessions that made it. The where-and-how fields are here for an identity that
 * has not run yet; the caller decides whether to allow them later.
 */
export type PersonaEdit = Partial<
  Pick<PersonaRecord, "name" | "locality" | "country" | "locale" | "timezoneId" | "tier">
> & { traits?: PersonaTraits | null }

export interface PersonaFilter {
  country?: string
  health?: PersonaHealth
}

/** What one finished session did to a persona's books. */
export interface SessionOutturn {
  minutes: number
  outcome: SessionOutcome
  at: Date
}

export interface PersonaStore {
  insert(row: PersonaRecord): Promise<void>
  byId(id: string): Promise<PersonaRecord | null>
  list(filter?: PersonaFilter): Promise<PersonaRecord[]>
  setHealth(id: string, health: PersonaHealth): Promise<void>
  /** Returns the edited record, or null when there is no such persona. */
  edit(id: string, patch: PersonaEdit): Promise<PersonaRecord | null>
  setProfile(id: string, solariProfileId: string | null): Promise<void>
  /** Rotation: the same identity behind a different address. See `rotateProxySession`. */
  setProxySession(id: string, proxySession: string): Promise<void>
  /**
   * Adds to the counters and moves `lastAliveAt`. Additive rather than a write of
   * a computed total, because two runners may be draining at once and a read-then-
   * write loses one of them — silently, and in the direction of under-counting.
   */
  recordSession(id: string, outturn: SessionOutturn): Promise<void>
  /** Newest first. The order `assess` requires; see its parameter docs. */
  recentOutcomes(id: string, limit: number): Promise<SessionOutcome[]>
  delete(id: string): Promise<void>
}

/**
 * Personas without Postgres, for unit tests and dry runs.
 *
 * It cannot reproduce the one thing the real store has to get right — two runners
 * adding minutes to the same row concurrently — which is why `personas.pg.test.ts`
 * exists and runs against a real database. Same division as the job queue's.
 */
export class MemoryPersonaStore implements PersonaStore {
  readonly rows = new Map<string, PersonaRecord>()
  /** Session outcomes, oldest first, keyed by persona. Written by tests. */
  readonly outcomes = new Map<string, SessionOutcome[]>()

  async insert(row: PersonaRecord): Promise<void> {
    if (this.rows.has(row.id)) throw new Error(`persona already exists: ${row.id}`)
    this.rows.set(row.id, { ...row, stats: { ...row.stats } })
  }

  async byId(id: string): Promise<PersonaRecord | null> {
    const row = this.rows.get(id)
    return row ? { ...row, stats: { ...row.stats } } : null
  }

  async list(filter: PersonaFilter = {}): Promise<PersonaRecord[]> {
    return [...this.rows.values()]
      .filter((r) => (filter.country ? r.country === filter.country : true))
      .filter((r) => (filter.health ? r.health === filter.health : true))
      .map((r) => ({ ...r, stats: { ...r.stats } }))
  }

  async setHealth(id: string, health: PersonaHealth): Promise<void> {
    const row = this.rows.get(id)
    if (row) row.health = health
  }

  async edit(id: string, patch: PersonaEdit): Promise<PersonaRecord | null> {
    const row = this.rows.get(id)
    if (!row) return null
    Object.assign(row, patch)
    return this.byId(id)
  }

  async setProfile(id: string, solariProfileId: string | null): Promise<void> {
    const row = this.rows.get(id)
    if (row) row.solariProfileId = solariProfileId
  }

  async setProxySession(id: string, proxySession: string): Promise<void> {
    const row = this.rows.get(id)
    if (row) row.proxySession = proxySession
  }

  async recordSession(id: string, outturn: SessionOutturn): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return
    row.stats.sessions += 1
    row.stats.minutes += outturn.minutes
    if (outturn.outcome === "blocked") row.stats.blocks += 1
    // Only a session that actually worked proves the identity is still alive.
    if (outturn.outcome === "ok") row.lastAliveAt = outturn.at
    const list = this.outcomes.get(id) ?? []
    list.push(outturn.outcome)
    this.outcomes.set(id, list)
  }

  async recentOutcomes(id: string, limit: number): Promise<SessionOutcome[]> {
    return [...(this.outcomes.get(id) ?? [])].reverse().slice(0, limit)
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id)
    this.outcomes.delete(id)
  }
}
