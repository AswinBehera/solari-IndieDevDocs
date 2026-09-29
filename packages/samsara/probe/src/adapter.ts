import type { ProbeCadence, SourceId } from "@samsara/core"

/**
 * What a probe source is (P3.1/P3.2): a URL it understands, and one look at it.
 *
 * Same split as `SourceAdapter` in `@samsara/sources`, for the same reason: what
 * the adapter *stores* is its own business and the engine carries it without
 * reading it. The engine never opens `parsed` or `payload`.
 *
 * `page` is `unknown` for the reason `CaptureContext.page` is: its real type is
 * Playwright's, and this package must stay loadable where Playwright is not.
 */
export type ParsedUrl<P> = { ok: true; parsed: P } | { ok: false; reason: string }

export interface ProbeContext {
  page: unknown
  country: string
  signal: AbortSignal
}

export interface ProbeCapture<Payload> {
  /** Whatever the adapter saw, including an explicit "blocked" or "no price". */
  payload: Payload
  /** PNG bytes. Required even for a refusal: the picture is the proof. */
  screenshot: Uint8Array
  notes?: string
}

/** Units of USD per one unit of the currency, keyed by upper-case ISO 4217 code. */
export type FxRates = Readonly<Record<string, number>>

export interface ProbeAdapter<Parsed = unknown, Payload = unknown> {
  id: SourceId
  /** Pure. A URL the adapter does not understand is refused here, never at probe time. */
  parseUrl(url: string): ParsedUrl<Parsed>
  /** The half that spends. */
  probe(ctx: ProbeContext, target: { url: string; parsed: Parsed }): Promise<ProbeCapture<Payload>>
  /**
   * Declared by the adapter, run by the engine after every probe (P3.3): the raw
   * payload in, the same payload with normalised figures alongside it out. The
   * raw figure is never replaced.
   */
  normalise?(payload: Payload, rates: FxRates): Payload
}

export interface ProbeTargetRecord {
  id: string
  ownerId: string | null
  sourceId: string
  url: string
  parsed: unknown
  watch: boolean
  cadence: ProbeCadence
  createdAt: Date
}

export interface NewProbeTarget {
  ownerId: string | null
  sourceId: string
  url: string
  parsed: unknown
  watch?: boolean
  cadence?: ProbeCadence
}

export interface ProbeTargetStore {
  /** Returns the existing target for the same owner and URL rather than a duplicate. */
  upsert(input: NewProbeTarget): Promise<ProbeTargetRecord>
  get(id: string): Promise<ProbeTargetRecord | null>
  /** The owner's own targets only: a target id alone must not read anyone's. */
  getOwned(ownerId: string, id: string): Promise<ProbeTargetRecord | null>
  listWatched(): Promise<ProbeTargetRecord[]>
}

export interface ObservationRecord {
  id: string
  targetId: string
  country: string
  personaId: string | null
  capturedAt: Date
  payload: unknown
  screenshotRef: string
  sessionId: string
  notes: string | null
}

export type NewObservation = Omit<ObservationRecord, "id">

export interface ObservationStore {
  insert(o: NewObservation): Promise<string>
  listByTarget(targetId: string, limit?: number): Promise<ObservationRecord[]>
  /** The newest observation per country, for the table a Price card draws. */
  latestByCountry(targetId: string): Promise<ObservationRecord[]>
}

export interface ScreenshotArchive {
  put(targetId: string, country: string, at: Date, png: Uint8Array): Promise<string>
}
