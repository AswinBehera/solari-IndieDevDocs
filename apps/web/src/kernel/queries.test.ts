import { describe, expect, it } from "vitest"
import { usedFraction } from "./queries"

describe("usedFraction", () => {
  it("is the share of the ceiling, clamped to a full bar", () => {
    expect(usedFraction(1, 4)).toBe(0.25)
    expect(usedFraction(9, 4)).toBe(1)
  })
  it("is empty for a ceiling that is not positive", () => {
    expect(usedFraction(5, 0)).toBe(0)
    expect(usedFraction(-1, 4)).toBe(0)
  })
})
