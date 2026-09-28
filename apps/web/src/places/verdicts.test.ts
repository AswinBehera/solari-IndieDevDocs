import { describe, expect, it } from "vitest"
import { gateLine, loadVerdicts, saveVerdicts, tally, toggle } from "./verdicts"

describe("verdicts", () => {
  it("marks, and unmarks by choosing the same verdict again", () => {
    const one = toggle({}, "a", "wrong")
    expect(one).toEqual({ a: "wrong" })
    expect(toggle(one, "a", "wrong")).toEqual({})
    expect(toggle(one, "a", "real")).toEqual({ a: "real" })
  })

  it("counts only the places on screen", () => {
    expect(tally({ a: "real", b: "wrong", gone: "wrong" }, ["a", "b", "c"])).toEqual({
      real: 1,
      wrong: 1,
      unmarked: 1,
    })
  })

  it("says the gate holds at a third and fails above it", () => {
    expect(gateLine({ real: 20, wrong: 10, unmarked: 0 })).toBe(
      "10 of 30 wrong · the gate allows 10",
    )
    expect(gateLine({ real: 19, wrong: 11, unmarked: 0 })).toContain("over a third wrong")
    expect(gateLine({ real: 0, wrong: 0, unmarked: 30 })).toBe(
      "0 of 30 wrong · the gate allows 10 · 30 not reviewed",
    )
    expect(gateLine({ real: 0, wrong: 0, unmarked: 0 })).toBe("Nothing to review yet")
  })

  it("survives storage that is missing, broken or full", () => {
    expect(loadVerdicts(null)).toEqual({})
    expect(loadVerdicts({ getItem: () => "{not json" })).toEqual({})
    expect(
      loadVerdicts({
        getItem: () => {
          throw new Error("blocked")
        },
      }),
    ).toEqual({})
    // Values that are not a verdict are dropped, not trusted.
    expect(loadVerdicts({ getItem: () => JSON.stringify({ a: "real", b: 7 }) })).toEqual({
      a: "real",
    })
    expect(() =>
      saveVerdicts(
        { a: "real" },
        {
          setItem: () => {
            throw new Error("quota")
          },
        },
      ),
    ).not.toThrow()
  })
})
