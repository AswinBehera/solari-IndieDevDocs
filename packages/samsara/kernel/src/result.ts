/**
 * The kernel returns failures; it does not throw them. Everything above it has to
 * branch on *why* something failed — a blocked page is the adapter's cue to try its
 * next strategy, an exhausted meter is a hard stop, and an upstream outage is
 * neither — so the reason has to survive in the type rather than in a message.
 */

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

/**
 * Why a kernel operation did not produce a value.
 *
 * The split that earns its keep is `upstream` versus `internal`. When the provider
 * is down — a maintenance window, a 5xx, DNS failing to resolve — that is not our
 * bug, and a run that reports it as one sends somebody debugging their own code for
 * an afternoon. Every failure the kernel raises must land in exactly one of these,
 * and `internal` is the only one that means "we broke it".
 */
export type FailureKind =
  /** A meter is exhausted. Named, with the numbers, so the message is actionable. */
  | "budget"
  /** The page refused us: captcha, bot wall, login gate. Never retried. */
  | "blocked"
  /** Our own hard deadline fired and the session was force-closed. */
  | "timeout"
  /** The provider failed: 5xx, connection refused, DNS, malformed response. Not our bug. */
  | "upstream"
  /** The caller asked for something impossible, e.g. a proxy without stealth. */
  | "config"
  /** Everything else. This one is ours. */
  | "internal"

export interface Failure {
  kind: FailureKind
  /** Safe for a public log: no secrets, no request bodies, no page text. */
  message: string
  /** Present on `budget`. Which meter refused, and the arithmetic behind it. */
  meter?: string
  ceiling?: number
  used?: number
  requested?: number
  /** Present on `upstream` when the provider gave us a status code. */
  status?: number
  /** Present on `timeout`. */
  deadlineMs?: number
  /** Only ever an Error's name and message — never its stack, which can carry paths. */
  cause?: string
}

export const failure = (
  kind: FailureKind,
  message: string,
  extra: Partial<Failure> = {},
): Failure => ({
  kind,
  message,
  ...extra,
})

/**
 * Classify a thrown value. Conservative on purpose: anything we cannot positively
 * identify as the provider's fault is called `internal`, because a kernel that
 * blames upstream by default is a kernel that never gets debugged.
 */
/**
 * Thrown by a caller's callback when the *page* refused it.
 *
 * `classify` can only read what an exception says, and a surface refusing a
 * session usually does not throw at all — Playwright's `goto` returns a response
 * with a 403 on it and carries on. So the word-matching below catches a provider
 * error that happens to mention a captcha and misses the actual case, which then
 * classifies as `internal` and gets **retried** — spending a second session to be
 * refused again and teaching the surface that this identity retries, which is the
 * one thing the retry policy exists to prevent.
 *
 * An adapter that has read a status code knows the answer. This is how it says so
 * without encoding it in a string and hoping the regex still matches.
 */
export class Blocked extends Error {
  constructor(readonly detail: string) {
    super(`page refused the session: ${detail}`)
    this.name = "Blocked"
  }
}

export function classify(thrown: unknown): Failure {
  if (thrown instanceof Blocked) {
    return failure("blocked", "page refused the session", { cause: thrown.detail })
  }
  const e = thrown instanceof Error ? thrown : new Error(String(thrown))
  const cause = `${e.name}: ${e.message}`
  // Structural rather than `NodeJS.ErrnoException`. `classify` is on the path the
  // API takes, and the API compiles against the Workers runtime where the `NodeJS`
  // namespace does not exist — a type-only import of it would make this whole file
  // unusable above the seam for no benefit, since all we want is one string.
  const code = (e as { code?: string }).code
  const status =
    (e as { status?: number; statusCode?: number }).status ??
    (e as { statusCode?: number }).statusCode

  // Transport-level: the provider was not reachable at all.
  if (code && TRANSPORT_CODES.has(code)) {
    return failure("upstream", `provider unreachable (${code})`, { cause })
  }
  // HTTP-level: we reached them. 429 counts as upstream — it is their capacity
  // decision, not our defect — and so does anything 5xx.
  if (typeof status === "number" && (status >= 500 || status === 429)) {
    return failure("upstream", `provider returned ${status}`, { status, cause })
  }
  // A 4xx means they understood us and we were wrong: an unsupported option, a
  // bad key, a malformed request. That is `config`, which is not retried —
  // learned the hard way from a 400 for an unsupported proxy country that the
  // kernel first called `internal` and then dutifully retried.
  if (typeof status === "number" && status >= 400 && status < 500) {
    return failure("config", `provider rejected the request (${status})`, { status, cause })
  }
  if (/\b(captcha|blocked|forbidden by bot|access denied)\b/i.test(e.message)) {
    return failure("blocked", "page refused the session", { cause })
  }
  return failure("internal", "unhandled kernel error", { cause })
}

const TRANSPORT_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
])
