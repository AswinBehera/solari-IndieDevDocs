import { ageCookieHeader } from "./endpoints.js"

/**
 * Plain HTTP to Steam, paced, with the bytes kept.
 *
 * Kept, because every response is a receipt candidate: the caller hashes and
 * stores exactly what came back, and a parser that later improves re-reads the
 * stored bytes instead of asking Steam again.
 *
 * Paced, because the store API is unofficial and throttles around 200 requests per
 * five minutes. One request per `minIntervalMs` (1.6 s by default, about 190 per
 * five minutes) from one client, and a 429 or 403 backs off rather than retrying
 * straight away. A 403 from the store is how it says "slow down" as often as "no".
 */

export interface Fetched {
  url: string
  status: number
  contentType: string
  body: Uint8Array
  fetchedAt: Date
}

export interface SteamClientOptions {
  fetch?: typeof fetch
  minIntervalMs?: number
  /** Backoffs after a 429/403, in order. Their count is the retry count. */
  backoffMs?: number[]
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  signal?: AbortSignal
  /** Per request, body included. A stalled connection otherwise holds the block for as long as the OS lets it. */
  timeoutMs?: number
}

export class SteamThrottled extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`steam answered ${status} after backing off: ${url}`)
    this.name = "SteamThrottled"
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class SteamClient {
  private next = 0
  private readonly fetchImpl: typeof fetch
  private readonly minIntervalMs: number
  private readonly backoffMs: number[]
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly timeoutMs: number
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: SteamClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.minIntervalMs = options.minIntervalMs ?? 1_600
    this.backoffMs = options.backoffMs ?? [15_000, 60_000]
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  /** Requests made so far. The run records it, so a block's cost is not a guess. */
  requests = 0

  async get(url: string): Promise<Fetched> {
    for (let attempt = 0; ; attempt++) {
      await this.turn()
      this.requests++
      const timeout = AbortSignal.timeout(this.timeoutMs)
      const res = await this.fetchImpl(url, {
        headers: { cookie: ageCookieHeader(), "accept-language": "en-US,en;q=0.9" },
        signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout,
      })
      if (res.status === 429 || res.status === 403) {
        const wait = this.backoffMs[attempt]
        if (wait === undefined) throw new SteamThrottled(url, res.status)
        await this.sleep(wait)
        continue
      }
      return {
        url,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        body: new Uint8Array(await res.arrayBuffer()),
        fetchedAt: new Date(this.now()),
      }
    }
  }

  async json(url: string): Promise<{ fetched: Fetched; json: unknown }> {
    const fetched = await this.get(url)
    return { fetched, json: JSON.parse(new TextDecoder().decode(fetched.body)) }
  }

  /**
   * One slot at a time, in call order. Chained on a promise rather than a
   * timestamp check, so concurrent callers (a fan-out) queue instead of all
   * reading the same "next" and going at once.
   */
  private turn(): Promise<void> {
    const mine = this.queue.then(async () => {
      const wait = this.next - this.now()
      if (wait > 0) await this.sleep(wait)
      this.next = this.now() + this.minIntervalMs
    })
    this.queue = mine.catch(() => {})
    return mine
  }
}
