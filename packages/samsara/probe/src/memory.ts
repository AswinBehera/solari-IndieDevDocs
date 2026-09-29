import type {
  NewObservation,
  NewProbeTarget,
  ObservationRecord,
  ObservationStore,
  ProbeTargetRecord,
  ProbeTargetStore,
  ScreenshotArchive,
} from "./adapter.js"

export class MemoryProbeTargetStore implements ProbeTargetStore {
  readonly rows = new Map<string, ProbeTargetRecord>()
  private n = 0
  async upsert(input: NewProbeTarget): Promise<ProbeTargetRecord> {
    for (const r of this.rows.values()) {
      if (r.ownerId === input.ownerId && r.url === input.url) return r
    }
    const row: ProbeTargetRecord = {
      id: `target-${++this.n}`,
      ownerId: input.ownerId,
      sourceId: input.sourceId,
      url: input.url,
      parsed: input.parsed,
      watch: input.watch ?? false,
      cadence: input.cadence ?? null,
      createdAt: new Date(0),
    }
    this.rows.set(row.id, row)
    return row
  }
  async get(id: string) {
    return this.rows.get(id) ?? null
  }
  async getOwned(ownerId: string, id: string) {
    const r = this.rows.get(id)
    return r && r.ownerId === ownerId ? r : null
  }
  async listWatched() {
    return [...this.rows.values()].filter((r) => r.watch)
  }
}

export class MemoryObservationStore implements ObservationStore {
  readonly rows: ObservationRecord[] = []
  async insert(o: NewObservation) {
    const id = `obs-${this.rows.length + 1}`
    this.rows.push({ id, ...o })
    return id
  }
  async listByTarget(targetId: string, limit = 200) {
    return this.rows
      .filter((r) => r.targetId === targetId)
      .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())
      .slice(0, limit)
  }
  async latestByCountry(targetId: string) {
    const out = new Map<string, ObservationRecord>()
    for (const r of await this.listByTarget(targetId))
      if (!out.has(r.country)) out.set(r.country, r)
    return [...out.values()]
  }
}

export class MemoryScreenshotArchive implements ScreenshotArchive {
  readonly puts: { targetId: string; country: string }[] = []
  async put(targetId: string, country: string, at: Date) {
    this.puts.push({ targetId, country })
    return `probe/${targetId}/${country}/${at.toISOString()}.png`
  }
}
