import type { SessionPurpose } from "@samsara/core"
import { type Logger, now } from "./log.js"
import { err, type Failure, type Result } from "./result.js"

/**
 * Retry policy. Up to two retries, with jitter.
 *
 * What must *not* be retried is the interesting half:
 *
 * - `blocked` — the page refused us. Retrying spends minutes to be refused again,
 *   and worse, it teaches the target that this browser is a bot. The adapter's next
 *   strategy is the correct response, which is why `blocked` is surfaced rather
 *   than swallowed.
 * - `budget` — the meter is exhausted. Retrying is the one thing a budget guard
 *   exists to stop.
 * - `config` — a proxy without stealth will be invalid the third time too.
 * - `timeout` — our deadline already fired. Retrying doubles the spend on work that
 *   was too slow, and the caller can choose to re-queue with a longer deadline if
 *   that is actually what it wants.
 *
 * Which leaves `upstream` (the provider failed — worth another go, they may be
 * mid-deploy) and `internal` (which is worth exactly one retry, because a genuine
 * bug will reproduce and the log should say so rather than looping).
 */

const RETRYABLE = new Set(["upstream", "internal"])

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  logger?: Logger
  purpose?: SessionPurpose
  /** Injectable for tests; real callers get the default. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function withRetry<T>(
  fn: (attempt: number) => Promise<Result<T, Failure>>,
  opts: RetryOptions = {},
): Promise<Result<T, Failure>> {
  const attempts = opts.attempts ?? 3 // one try plus two retries
  const base = opts.baseDelayMs ?? 500
  const max = opts.maxDelayMs ?? 8_000
  const sleep = opts.sleep ?? defaultSleep
  const random = opts.random ?? Math.random
  const purpose = opts.purpose ?? "agent"

  let last: Failure = {
    kind: "internal",
    message: "retry ran zero attempts",
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await fn(attempt)
    if (result.ok) return result
    last = result.error

    const isLast = attempt === attempts
    if (isLast || !RETRYABLE.has(last.kind)) break

    // Full jitter: exponential ceiling, uniform draw beneath it. Two runners that
    // fail at the same moment must not retry at the same moment.
    const ceiling = Math.min(max, base * 2 ** (attempt - 1))
    const delayMs = Math.round(random() * ceiling)
    opts.logger?.emit({
      at: now(),
      event: "attempt.retry",
      purpose,
      attempt,
      of: attempts,
      delayMs,
      because: last.kind,
    })
    await sleep(delayMs)
  }

  opts.logger?.emit({
    at: now(),
    event: "attempt.failed",
    purpose,
    kind: last.kind,
    message: last.message,
    attempts,
  })
  return err(last)
}

export const isRetryable = (kind: Failure["kind"]): boolean => RETRYABLE.has(kind)
