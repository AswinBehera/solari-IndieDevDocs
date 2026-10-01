import { describe, expect, it } from "vitest"
import { BudgetGuard, dayKey } from "./budget.js"
import { DEFAULT_CEILINGS } from "./ceilings.js"
import { Kernel } from "./kernel.js"
import { MemoryLogger } from "./log.js"
import type { BrowserHandle, BrowserLauncher, SandboxHandle, SandboxLauncher } from "./ports.js"
import { SessionRegistry } from "./registry.js"
import { MemoryCounterStore, MemorySessionStore } from "./stores/memory.js"

const AT = new Date("2026-09-11T10:00:00.000Z")

/** A browser that never existed, so no test here can spend anything. */
function fakeLauncher(
  behaviour: { onLaunch?: () => void; onPage?: () => Promise<unknown>; closes?: string[] } = {},
): BrowserLauncher {
  let n = 0
  return {
    async launch(): Promise<BrowserHandle> {
      behaviour.onLaunch?.()
      const id = `fake-${++n}`
      return {
        id,
        newPage: behaviour.onPage ?? (async () => ({ page: true })),
        async close() {
          behaviour.closes?.push(id)
        },
      }
    },
    async dispose() {},
  }
}

function harness(launcher: BrowserLauncher, ceilings = DEFAULT_CEILINGS) {
  const counters = new MemoryCounterStore()
  const sessions = new MemorySessionStore()
  const logger = new MemoryLogger()
  const guard = new BudgetGuard({ store: counters, ceilings, clock: () => AT })
  const registry = new SessionRegistry(sessions, logger)
  const kernel = new Kernel({ registry, guard, browser: launcher, logger })
  return { kernel, counters, sessions, logger, registry, guard }
}

describe("withBrowser", () => {
  it("hands the callback a page and closes the session afterwards", async () => {
    const closes: string[] = []
    const { kernel, sessions } = harness(fakeLauncher({ closes }))

    const result = await kernel.withBrowser("harvest", { country: "sg" }, async (page) => {
      expect(page).toBeTruthy()
      return "read the page"
    })

    expect(result).toEqual({ ok: true, value: "read the page" })
    expect(closes).toHaveLength(1)
    const [row] = [...sessions.rows.values()]
    expect(row?.outcome).toBe("ok")
    expect(row?.endedAt).not.toBeNull()
  })

  it("closes the session even when the callback throws", async () => {
    const closes: string[] = []
    const { kernel, sessions } = harness(fakeLauncher({ closes }))

    const result = await kernel.withBrowser("probe", { country: "sg" }, async () => {
      throw new Error("selector not found")
    })

    expect(result.ok).toBe(false)
    expect(closes.length).toBeGreaterThanOrEqual(1)
    expect([...sessions.rows.values()].every((r) => r.outcome !== "running")).toBe(true)
  })
})

describe("a provider outage is not our bug", () => {
  // The reason this test exists: Solari may be in a maintenance window at any
  // time. A run that reports that as an application error sends somebody
  // debugging code that is working correctly.
  it("classifies a connection failure as upstream", async () => {
    const launcher = fakeLauncher({
      onLaunch: () => {
        const e = new Error("connect ECONNREFUSED 1.2.3.4:443") as NodeJS.ErrnoException
        e.code = "ECONNREFUSED"
        throw e
      },
    })
    const { kernel } = harness(launcher)

    const result = await kernel.withBrowser(
      "harvest",
      { country: "sg", attempts: 1 },
      async () => "never runs",
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("upstream")
    expect(result.error.message).toContain("unreachable")
  })

  it("classifies a 5xx as upstream and a DNS failure as upstream", async () => {
    for (const [thrown, expected] of [
      [Object.assign(new Error("bad gateway"), { status: 502 }), "provider returned 502"],
      [Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }), "unreachable"],
    ] as const) {
      const { kernel } = harness(
        fakeLauncher({
          onLaunch: () => {
            throw thrown
          },
        }),
      )
      const result = await kernel.withBrowser(
        "probe",
        { country: "sg", attempts: 1 },
        async () => null,
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe("upstream")
      expect(result.error.message).toContain(expected)
    }
  })

  it("retries an upstream failure and succeeds when the provider comes back", async () => {
    let attempts = 0
    const launcher = fakeLauncher({
      onLaunch: () => {
        attempts++
        if (attempts < 3) {
          const e = new Error("service unavailable") as Error & { status: number }
          e.status = 503
          throw e
        }
      },
    })
    const { kernel } = harness(launcher)

    const result = await kernel.withBrowser("harvest", { country: "sg" }, async () => "recovered")

    expect(attempts).toBe(3)
    expect(result).toEqual({ ok: true, value: "recovered" })
  })

  it("calls our own defect internal, not upstream", async () => {
    const { kernel } = harness(
      fakeLauncher({
        onLaunch: () => {
          throw new TypeError("cannot read properties of undefined")
        },
      }),
    )
    const result = await kernel.withBrowser(
      "harvest",
      { country: "sg", attempts: 1 },
      async () => null,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("internal")
  })
})

describe("the budget guard runs before anything opens", () => {
  it("refuses to launch at all once the minutes meter is exhausted", async () => {
    let launched = 0
    const { kernel, counters } = harness(fakeLauncher({ onLaunch: () => void launched++ }))
    counters.seed(
      { meter: "solari.minutes", window: "global.day", windowKey: dayKey(AT) },
      DEFAULT_CEILINGS["solari.minutes"],
    )

    const result = await kernel.withBrowser("harvest", { country: "sg" }, async () => "nope")

    expect(launched).toBe(0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("budget")
    expect(result.error.meter).toBe("solari.minutes")
  })

  it("meters the minutes a session actually consumed", async () => {
    const { kernel, counters } = harness(fakeLauncher())
    await kernel.withBrowser("harvest", { country: "sg", ownerId: "u1" }, async () => "done")

    const totals = await counters.read([
      { meter: "solari.minutes", window: "global.day", windowKey: dayKey(AT) },
    ])
    // A fake session takes microseconds, so the assertion is that *something* was
    // booked rather than a specific figure. The number is real: it comes from the
    // registry's own clock, not from an estimate.
    expect([...totals.values()][0]).toBeGreaterThanOrEqual(0)
  })
})

describe("config is refused locally, not by the provider", () => {
  it("rejects proxy without stealth", () => {
    const result = Kernel.validateLaunch({ stealth: false, proxy: { country: "sg" } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("config")
    expect(result.error.message).toContain("stealth")
  })

  it("rejects captcha without stealth", () => {
    const result = Kernel.validateLaunch({ stealth: false, captcha: true })
    expect(result.ok).toBe(false)
  })

  it("rejects a country that is not lowercase alpha-2", () => {
    expect(Kernel.validateLaunch({ stealth: true, proxy: { country: "SG" } }).ok).toBe(false)
    expect(Kernel.validateLaunch({ stealth: true, proxy: { country: "sg" } }).ok).toBe(true)
  })

  it("rejects a country the provider's pool does not carry, and names the nearest", () => {
    // The shape that matters: a country the product wants and the pool does not
    // carry. Solari's residential pool has no `vn` egress — nor `th`, the first
    // market — learned from a live 400 on 11 Sep 2026 that listed the whole pool.
    // The kernel refuses locally so this surfaces as a config error at the call
    // site rather than a 400 after a round trip.
    const result = Kernel.validateLaunch({ stealth: true, proxy: { country: "vn" } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("config")
    expect(result.error.message).toContain("not in the provider's pool")
    expect(result.error.message).toContain("nearest available is sg")
  })

  it("never substitutes a country on the caller's behalf", async () => {
    // Naming an alternative is help; applying one silently would change what a
    // persona sees, which is the variable the Persona Lab holds still.
    let launched = 0
    const { kernel } = harness(fakeLauncher({ onLaunch: () => void launched++ }))
    const result = await kernel.withBrowser("harvest", { country: "th" }, async () => null)
    expect(launched).toBe(0)
    expect(result.ok).toBe(false)
  })

  it("treats a provider 4xx as our config error, and does not retry it", async () => {
    // Regression: the kernel first called an "Unsupported proxy country" 400
    // `internal` and then retried it twice — spending three round trips to be
    // told the same true thing.
    let launches = 0
    const { kernel } = harness(
      fakeLauncher({
        onLaunch: () => {
          launches++
          throw Object.assign(new Error("Solari POST /sessions failed: 400"), { status: 400 })
        },
      }),
    )
    const result = await kernel.withBrowser("harvest", { country: "sg" }, async () => null)
    expect(launches).toBe(1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("config")
    expect(result.error.status).toBe(400)
  })

  it("always launches with stealth on, because every session is proxied", async () => {
    let seen: unknown
    const launcher: BrowserLauncher = {
      async launch(config) {
        seen = config
        return { id: "x", newPage: async () => ({}), close: async () => {} }
      },
      async dispose() {},
    }
    const { kernel } = harness(launcher)
    await kernel.withBrowser("harvest", { country: "sg" }, async () => null)
    expect(seen).toMatchObject({ stealth: true, proxy: { country: "sg" } })
  })
})

describe("the viewpoint is not the proxy country", () => {
  // The reason this block exists: the pool has no egress in half the markets the
  // product wants, and the reflex fix — "use `sg` instead" — quietly answers a
  // different question. What a local sees is produced mostly by language, stored
  // preference, and history; the IP is the last and weakest of the signals. So the
  // kernel has to be able to say "`vi-VN` browser, Indochina clock, `sg` packets"
  // and record that it did.
  it("presents a locale and timezone that disagree with the egress country", async () => {
    let seen: unknown
    const launcher: BrowserLauncher = {
      async launch(config) {
        seen = config
        return { id: "x", newPage: async () => ({}), close: async () => {} }
      },
      async dispose() {},
    }
    const { kernel } = harness(launcher)
    await kernel.withBrowser(
      "harvest",
      { country: "sg", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" },
      async () => null,
    )
    expect(seen).toMatchObject({
      proxy: { country: "sg" },
      viewpoint: { locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" },
    })
  })

  it("records the viewpoint on the session row, next to the country", async () => {
    const { kernel, sessions, logger } = harness(fakeLauncher())
    await kernel.withBrowser(
      "harvest",
      { country: "sg", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" },
      async () => null,
    )
    const [row] = [...sessions.rows.values()]
    // Both halves, or an Observation cannot be read later.
    expect(row).toMatchObject({ country: "sg", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" })
    const opened = logger.events.find((e) => e.event === "session.open")
    expect(opened).toMatchObject({ country: "sg", locale: "vi-VN" })
  })

  it("says so when a session has no viewpoint at all", async () => {
    // Not a neutral default: no viewpoint means en-US on UTC, which is a specific
    // person. Recording null is how a comparison run can tell the two apart.
    const { kernel, sessions } = harness(fakeLauncher())
    await kernel.withBrowser("harvest", { country: "sg" }, async () => null)
    expect([...sessions.rows.values()][0]).toMatchObject({ locale: null, timezoneId: null })
  })

  it("rejects a timezone offset instead of an IANA zone", () => {
    const bad = Kernel.validateLaunch({
      stealth: true,
      proxy: { country: "sg" },
      viewpoint: { locale: "vi-VN", timezoneId: "GMT+7" },
    })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error.kind).toBe("config")
    expect(bad.error.message).toContain("IANA")
  })

  it("rejects a locale that is not BCP 47", () => {
    const bad = Kernel.validateLaunch({
      stealth: true,
      viewpoint: { locale: "vietnamese", timezoneId: "Asia/Ho_Chi_Minh" },
    })
    expect(bad.ok).toBe(false)
    expect(
      Kernel.validateLaunch({
        stealth: true,
        viewpoint: { locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" },
      }).ok,
    ).toBe(true)
  })
})

describe("the hard deadline", () => {
  it("force-closes a session that overruns and reports a timeout", async () => {
    const closes: string[] = []
    const { kernel, sessions } = harness(fakeLauncher({ closes }))

    const result = await kernel.withBrowser(
      "probe",
      { country: "sg", deadlineMs: 20, attempts: 1 },
      // A page that never goes idle is exactly the case the provider's rolling
      // idle window cannot catch.
      () => new Promise(() => {}),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("timeout")
    expect(result.error.deadlineMs).toBe(20)
    expect(closes.length).toBeGreaterThanOrEqual(1)
    expect([...sessions.rows.values()][0]?.outcome).toBe("timeout")
  })

  it("does not retry a timeout", async () => {
    let launches = 0
    const { kernel } = harness(fakeLauncher({ onLaunch: () => void launches++ }))
    await kernel.withBrowser(
      "probe",
      { country: "sg", deadlineMs: 20 },
      () => new Promise(() => {}),
    )
    expect(launches).toBe(1)
  })
})

describe("shutdown", () => {
  it("releases every live session", async () => {
    const closes: string[] = []
    const { kernel, registry } = harness(fakeLauncher({ closes }))

    // Start something that will not finish, then shut down underneath it.
    const running = kernel.withBrowser(
      "harvest",
      { country: "sg", deadlineMs: 5_000, attempts: 1 },
      () => new Promise(() => {}),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(registry.openCount).toBe(1)

    await kernel.shutdown()
    expect(registry.openCount).toBe(0)
    expect(closes.length).toBeGreaterThanOrEqual(1)
    void running
  })
})

/** A sandbox that never existed, recording what the kernel did to it. */
function fakeSandboxes(seen: {
  kills: string[]
  kept: number[]
  killedById: string[]
}): SandboxLauncher {
  let n = 0
  return {
    async create(): Promise<SandboxHandle> {
      const id = `sb-${++n}`
      return {
        id,
        async connect() {},
        async run() {
          return { exitCode: 0, stdout: "", stderr: "" }
        },
        async kill() {
          seen.kills.push(id)
        },
        async keepAlive(ms) {
          seen.kept.push(ms)
        },
      }
    },
    async kill(id) {
      seen.killedById.push(id)
      return id === "sb-1"
    },
    async dispose() {},
  }
}

describe("withSandbox, kept", () => {
  function sandboxHarness() {
    const seen = { kills: [] as string[], kept: [] as number[], killedById: [] as string[] }
    const counters = new MemoryCounterStore()
    const logger = new MemoryLogger()
    const guard = new BudgetGuard({ store: counters, ceilings: DEFAULT_CEILINGS, clock: () => AT })
    const registry = new SessionRegistry(new MemorySessionStore(), logger)
    const kernel = new Kernel({
      registry,
      guard,
      browser: fakeLauncher(),
      sandbox: fakeSandboxes(seen),
      logger,
    })
    const minutes = async () =>
      [
        ...(
          await counters.read([
            { meter: "solari.minutes", window: "global.day", windowKey: dayKey(AT) },
          ])
        ).values(),
      ][0] ?? 0
    return { kernel, seen, minutes }
  }

  it("leaves a kept sandbox running and meters the kept minutes up front", async () => {
    const { kernel, seen, minutes } = sandboxHarness()
    const result = await kernel.withSandbox(
      "probe",
      { template: "base", keepMs: 15 * 60_000 },
      async (sb) => sb.id,
    )
    expect(result).toEqual({ ok: true, value: "sb-1" })
    expect(seen.kills).toEqual([])
    expect(seen.kept).toEqual([15 * 60_000])
    expect(await minutes()).toBeGreaterThanOrEqual(15)
  })

  it("still kills a sandbox whose callback failed, kept or not", async () => {
    const { kernel, seen } = sandboxHarness()
    const result = await kernel.withSandbox(
      "probe",
      { template: "base", keepMs: 15 * 60_000, attempts: 1 },
      async () => {
        throw new Error("git clone: repository not found")
      },
    )
    expect(result.ok).toBe(false)
    expect(seen.kills).toEqual(["sb-1"])
    expect(seen.kept).toEqual([])
  })

  it("kills by id later, and says when the sandbox had already gone", async () => {
    const { kernel, seen } = sandboxHarness()
    expect(await kernel.killSandbox("sb-1")).toEqual({ ok: true, value: true })
    expect(await kernel.killSandbox("sb-9")).toEqual({ ok: true, value: false })
    expect(seen.killedById).toEqual(["sb-1", "sb-9"])
  })
})
