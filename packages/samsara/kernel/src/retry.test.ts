import { describe, expect, it } from "vitest"
import { withDeadline } from "./deadline.js"
import { MemoryLogger } from "./log.js"
import { err, type Failure, failure, ok } from "./result.js"
import { isRetryable, withRetry } from "./retry.js"

const noSleep = async () => {}
const fixedRandom = () => 0.5

describe("retry policy", () => {
  it("stops as soon as it succeeds", async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        return ok("fine")
      },
      { sleep: noSleep },
    )
    expect(result).toEqual({ ok: true, value: "fine" })
    expect(calls).toBe(1)
  })

  it("gives an upstream failure one try plus two retries, then stops", async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        return err(failure("upstream", "provider returned 503", { status: 503 }))
      },
      { sleep: noSleep, random: fixedRandom },
    )
    expect(calls).toBe(3)
    expect(result.ok).toBe(false)
  })

  for (const kind of ["blocked", "budget", "config", "timeout"] as const) {
    it(`never retries ${kind}`, async () => {
      let calls = 0
      await withRetry(
        async () => {
          calls++
          return err(failure(kind, `${kind} happened`))
        },
        { sleep: noSleep, random: fixedRandom },
      )
      // Retrying a block teaches the target that this browser is automated;
      // retrying an exhausted meter is the thing a budget guard exists to stop.
      expect(calls).toBe(1)
    })
  }

  it("backs off exponentially with jitter beneath the ceiling", async () => {
    const delays: number[] = []
    await withRetry(async () => err(failure("upstream", "down")), {
      sleep: async (ms) => {
        delays.push(ms)
      },
      random: () => 1, // full draw, so the ceiling itself is observable
      baseDelayMs: 100,
      attempts: 4,
    })
    expect(delays).toEqual([100, 200, 400])
  })

  it("draws beneath the ceiling rather than sleeping a fixed time", async () => {
    const delays: number[] = []
    await withRetry(async () => err(failure("upstream", "down")), {
      sleep: async (ms) => {
        delays.push(ms)
      },
      random: () => 0, // two runners failing together must not retry together
      baseDelayMs: 100,
      attempts: 3,
    })
    expect(delays).toEqual([0, 0])
  })

  it("logs the failure class, never the provider's message text", async () => {
    const logger = new MemoryLogger()
    await withRetry(
      async () => err(failure("upstream", "provider returned 503", { cause: "Error: secret-ish" })),
      { sleep: noSleep, random: fixedRandom, logger, purpose: "probe" },
    )
    const retries = logger.events.filter((e) => e.event === "attempt.retry")
    expect(retries).toHaveLength(2)
    expect(retries.every((e) => "because" in e && e.because === "upstream")).toBe(true)
    // `cause` can quote a page or a URL, so it is not in the retry event at all.
    expect(JSON.stringify(retries)).not.toContain("secret-ish")
  })

  it("classifies exactly two kinds as worth retrying", () => {
    const kinds: Failure["kind"][] = [
      "budget",
      "blocked",
      "timeout",
      "upstream",
      "config",
      "internal",
    ]
    expect(kinds.filter(isRetryable)).toEqual(["upstream", "internal"])
  })
})

describe("hard deadline", () => {
  it("returns the value when the work finishes in time", async () => {
    const result = await withDeadline(1_000, async () => "done")
    expect(result).toEqual({ ok: true, value: "done" })
  })

  it("fires when the work does not, and runs the force-close", async () => {
    let closed = false
    const result = await withDeadline(
      20,
      () => new Promise(() => {}),
      () => {
        closed = true
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("timeout")
    expect(closed).toBe(true)
  })

  it("aborts the signal it handed the callback", async () => {
    let aborted = false
    await withDeadline(20, (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true
      })
      return new Promise(() => {})
    })
    expect(aborted).toBe(true)
  })

  it("does not swallow a force-close that itself fails", async () => {
    // A browser that will not close must not mask the timeout, which is the
    // actual news. The orphan reconciler is the backstop for the leaked session.
    const result = await withDeadline(
      20,
      () => new Promise(() => {}),
      () => {
        throw new Error("close failed too")
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("timeout")
  })

  it("lets a real error through rather than calling it a timeout", async () => {
    await expect(
      withDeadline(1_000, async () => {
        throw new Error("selector not found")
      }),
    ).rejects.toThrow("selector not found")
  })
})
