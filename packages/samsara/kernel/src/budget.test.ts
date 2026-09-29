import { meterId } from "@samsara/core"
import { describe, expect, it } from "vitest"
import { BudgetGuard, dayKey, keysFor } from "./budget.js"
import { DEFAULT_CEILINGS, loadCeilings, loadTotals } from "./ceilings.js"
import { MemoryCounterStore } from "./stores/memory.js"

const AT = new Date("2026-09-11T10:00:00.000Z")
const clock = () => AT

const guardWith = (store: MemoryCounterStore) =>
  new BudgetGuard({ store, ceilings: DEFAULT_CEILINGS, clock })

describe("budget guard: every meter refuses at its ceiling", () => {
  // This is P0.4's acceptance criterion, and it is parameterised over the meter
  // enum rather than written out four times — so adding a meter without a ceiling,
  // or a ceiling without enforcement, fails here instead of in production.
  for (const meter of meterId.options) {
    it(`refuses ${meter} once its ceiling is spent, naming the meter`, async () => {
      const store = new MemoryCounterStore()
      const guard = guardWith(store)
      const ceiling = DEFAULT_CEILINGS[meter]

      const before = await guard.check(meter, 1, {})
      expect(before.ok).toBe(true)

      store.seed({ meter, window: "global.day", windowKey: dayKey(AT) }, ceiling)

      const after = await guard.check(meter, 1, {})
      expect(after.ok).toBe(false)
      if (after.ok) return
      expect(after.error.kind).toBe("budget")
      // The meter has to be named in the error, not just in a log line: whoever
      // reads this is deciding which of three budgets to raise.
      expect(after.error.meter).toBe(meter)
      expect(after.error.message).toContain(meter)
      expect(after.error.ceiling).toBe(ceiling)
      expect(after.error.used).toBe(ceiling)
    })
  }
})

describe("a meter sitting exactly on its ceiling is exhausted", () => {
  // Found by the kernel test, not by inspection: `withBrowser` cannot know how
  // many minutes a session will take, so it asks with `requested: 0`. An
  // arithmetic-only check (`used + 0 > ceiling`) waves that through forever at
  // exactly 100% of the budget — the one point where it must not.
  it("refuses a zero-cost enquiry at 100% of the ceiling", async () => {
    const store = new MemoryCounterStore()
    const guard = guardWith(store)
    store.seed(
      { meter: "solari.minutes", window: "global.day", windowKey: dayKey(AT) },
      DEFAULT_CEILINGS["solari.minutes"],
    )
    const result = await guard.check("solari.minutes", 0, {})
    expect(result.ok).toBe(false)
  })

  it("still allows a zero-cost enquiry one unit below the ceiling", async () => {
    const store = new MemoryCounterStore()
    const guard = guardWith(store)
    store.seed(
      { meter: "solari.minutes", window: "global.day", windowKey: dayKey(AT) },
      DEFAULT_CEILINGS["solari.minutes"] - 1,
    )
    expect((await guard.check("solari.minutes", 0, {})).ok).toBe(true)
  })
})

describe("windows", () => {
  it("counts global spend always, owner and run only when scoped", () => {
    expect(keysFor("geocode.calls", {}, AT)).toHaveLength(2)
    expect(keysFor("geocode.calls", { ownerId: "u1" }, AT)).toHaveLength(3)
    expect(
      keysFor("geocode.calls", { ownerId: "u1", purpose: "harvest", runId: "r1" }, AT),
    ).toHaveLength(4)
  })

  it("keys the day in UTC so a runner's timezone cannot shift the window", () => {
    expect(dayKey(new Date("2026-09-11T23:59:59.000Z"))).toBe("2026-09-11")
    expect(dayKey(new Date("2026-09-12T00:00:01.000Z"))).toBe("2026-09-12")
  })

  it("stops one caller taking the whole day", async () => {
    const store = new MemoryCounterStore()
    const guard = guardWith(store)
    const ownerCeiling = guard.ceilingFor("solari.minutes", "owner.day")
    expect(ownerCeiling).toBeLessThan(DEFAULT_CEILINGS["solari.minutes"])

    store.seed(
      { meter: "solari.minutes", window: "owner.day", windowKey: `u1:${dayKey(AT)}` },
      ownerCeiling,
    )

    // The global meter is nowhere near exhausted...
    const other = await guard.check("solari.minutes", 1, { ownerId: "u2" })
    expect(other.ok).toBe(true)
    // ...but this caller is done for the day.
    const refused = await guard.check("solari.minutes", 1, { ownerId: "u1" })
    expect(refused.ok).toBe(false)
  })

  it("stops a runaway loop inside a single run", async () => {
    const store = new MemoryCounterStore()
    const guard = guardWith(store)
    const scope = { ownerId: "u1", purpose: "harvest", runId: "r1" }
    const runCeiling = guard.ceilingFor("llm.output.tokens", "purpose.run")

    store.seed(
      { meter: "llm.output.tokens", window: "purpose.run", windowKey: "harvest:r1" },
      runCeiling,
    )

    const refused = await guard.check("llm.output.tokens", 1, scope)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.message).toContain("purpose.run")
  })
})

describe("lifetime total", () => {
  // The day windows reset; a prepaid balance does not. A week of days each under
  // the day ceiling can still spend more than the balance holds.
  it("refuses once the total is spent, even on a fresh day", async () => {
    const store = new MemoryCounterStore()
    const guard = new BudgetGuard({
      store,
      ceilings: DEFAULT_CEILINGS,
      totals: { "solari.minutes": 100 },
      clock,
    })
    store.seed({ meter: "solari.minutes", window: "global.total", windowKey: "all" }, 100)
    const refused = await guard.check("solari.minutes", 1, {})
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.message).toContain("global.total")
  })

  it("counts a meter with no total but never refuses on it", async () => {
    const store = new MemoryCounterStore()
    const guard = guardWith(store)
    store.seed({ meter: "geocode.calls", window: "global.total", windowKey: "all" }, 1e9)
    expect((await guard.check("geocode.calls", 1, {})).ok).toBe(true)
  })

  it("reads totals from <VAR>_TOTAL and throws on a bad one", () => {
    expect(loadTotals({})["solari.minutes"]).toBe(8_000)
    expect(loadTotals({ BUDGET_SOLARI_MINUTES_TOTAL: "500" })["solari.minutes"]).toBe(500)
    expect(() => loadTotals({ BUDGET_SOLARI_MINUTES_TOTAL: "lots" })).toThrow(
      /BUDGET_SOLARI_MINUTES_TOTAL/,
    )
  })
})

describe("accounting", () => {
  it("records a spend against every window the scope touches", async () => {
    const store = new MemoryCounterStore()
    const guard = guardWith(store)
    const scope = { ownerId: "u1", purpose: "harvest", runId: "r1" }

    await guard.record("geocode.calls", 3, scope)

    const totals = await store.read(keysFor("geocode.calls", scope, AT))
    expect([...totals.values()]).toEqual([3, 3, 3, 3])
  })

  it("counts what a failed operation spent, not only a successful one", async () => {
    const store = new MemoryCounterStore()
    const guard = guardWith(store)

    await expect(
      guard.spend("geocode.calls", {}, 2, async () => {
        throw new Error("lookup exploded halfway through")
      }),
    ).rejects.toThrow("lookup exploded")

    // The estimate is what gets booked when the callback never reports a cost.
    // The point is that the counter is not left at zero: a repeatedly-failing job
    // that spends real calls must move its meter, or it can loop forever for free.
    const totals = await store.read(keysFor("geocode.calls", {}, AT))
    expect([...totals.values()]).toEqual([2, 2])
  })

  it("books the actual cost a successful operation reports", async () => {
    const store = new MemoryCounterStore()
    const guard = guardWith(store)

    const result = await guard.spend("llm.input.tokens", {}, 100, async () => ({
      value: "extracted",
      cost: 4_210,
    }))

    expect(result.ok).toBe(true)
    const totals = await store.read(keysFor("llm.input.tokens", {}, AT))
    expect([...totals.values()]).toEqual([4_210, 4_210])
  })

  it("refuses before running the callback at all", async () => {
    const store = new MemoryCounterStore()
    const guard = guardWith(store)
    store.seed(
      { meter: "geocode.calls", window: "global.day", windowKey: dayKey(AT) },
      DEFAULT_CEILINGS["geocode.calls"],
    )

    let ran = false
    const result = await guard.spend("geocode.calls", {}, 1, async () => {
      ran = true
      return { value: null, cost: 1 }
    })

    expect(ran).toBe(false)
    expect(result.ok).toBe(false)
  })
})

describe("ceilings", () => {
  it("uses the section 8 defaults when the environment says nothing", () => {
    expect(loadCeilings({})).toEqual(DEFAULT_CEILINGS)
  })

  it("takes an override from the environment", () => {
    const ceilings = loadCeilings({ BUDGET_GEOCODE_CALLS: "50" })
    expect(ceilings["geocode.calls"]).toBe(50)
    expect(ceilings["solari.minutes"]).toBe(DEFAULT_CEILINGS["solari.minutes"])
  })

  it("throws on an unparseable ceiling rather than silently using the default", () => {
    // The failure mode this prevents: a typo in a GitHub Actions secret quietly
    // restoring a 4,000-minute ceiling that someone thought they had lowered to 50.
    expect(() => loadCeilings({ BUDGET_SOLARI_MINUTES: "eight hundred" })).toThrow(
      /BUDGET_SOLARI_MINUTES/,
    )
    expect(() => loadCeilings({ BUDGET_LLM_INPUT_TOKENS: "-1" })).toThrow()
    expect(() => loadCeilings({ BUDGET_GEOCODE_CALLS: "0" })).toThrow()
  })

  it("has a ceiling for every meter, with no extras", () => {
    expect(Object.keys(DEFAULT_CEILINGS).sort()).toEqual([...meterId.options].sort())
  })
})
