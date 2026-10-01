import { err, type Failure, failure, ok, type Result } from "./result.js"

/**
 * The hard deadline.
 *
 * This exists because the provider's `timeoutMs` is a **rolling idle window**, not
 * a deadline: it resets on every use. A page that keeps doing something — an
 * infinite scroll, a redirect loop, a slow feed — never goes idle and so never
 * times out, while the minutes meter runs the whole time. The kernel's own clock is
 * the only thing that can stop that.
 */

/** Per-purpose defaults. */
export const DEFAULT_DEADLINE_MS: Record<string, number> = {
  probe: 90_000,
  agent: 4 * 60_000,
}

export const deadlineFor = (purpose: string, override?: number): number =>
  override ?? DEFAULT_DEADLINE_MS[purpose] ?? 2 * 60_000

/**
 * Race `fn` against the clock.
 *
 * `onTimeout` is where the force-close goes. It is awaited but its own failure is
 * swallowed: we are already on the failure path, and a browser that will not close
 * must not mask the timeout that is the actual news. The orphan reconciler
 * (`SessionRegistry.reconcile`) is the backstop for the session that leaks.
 *
 * Note the settled callback keeps running after a timeout — JavaScript has no way
 * to cancel a promise. `onTimeout` closing the underlying handle is what actually
 * stops the work; the timeout alone only stops the *waiting*.
 */
export async function withDeadline<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  onTimeout?: () => Promise<void> | void,
): Promise<Result<T, Failure>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false

  const ticking = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new DeadlineExceeded(ms))
    }, ms)
    // Do not hold the event loop open on our own timer.
    timer.unref?.()
  })

  try {
    const value = await Promise.race([fn(controller.signal), ticking])
    return ok(value)
  } catch (thrown) {
    if (timedOut || thrown instanceof DeadlineExceeded) {
      if (onTimeout) {
        try {
          await onTimeout()
        } catch {
          // Deliberately ignored — see above.
        }
      }
      return err(failure("timeout", `deadline of ${ms}ms exceeded`, { deadlineMs: ms }))
    }
    throw thrown
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class DeadlineExceeded extends Error {
  constructor(readonly ms: number) {
    super(`deadline of ${ms}ms exceeded`)
    this.name = "DeadlineExceeded"
  }
}
