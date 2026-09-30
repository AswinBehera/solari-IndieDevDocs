import { describe, expect, it } from "vitest"
import { MAX_TILT, tapeFor, tiltFor, tiltStyle } from "./paper"

describe("tiltFor", () => {
  it("gives one id the same angle every time", () => {
    expect(tiltFor("00000000-0000-4000-8000-000000000040")).toBe(
      tiltFor("00000000-0000-4000-8000-000000000040"),
    )
  })

  it("stays inside the canvas's range", () => {
    for (let i = 0; i < 500; i++) {
      const t = tiltFor(`card-${i}`)
      expect(Math.abs(t)).toBeLessThanOrEqual(MAX_TILT)
    }
  })

  it("does not lay every card at the same angle", () => {
    const angles = new Set(Array.from({ length: 50 }, (_, i) => tiltFor(`card-${i}`)))
    expect(angles.size).toBeGreaterThan(5)
  })

  it("writes an angle the browser can read", () => {
    expect(tiltStyle("x")["--tilt"]).toMatch(/^-?\d+(\.\d)?deg$/)
  })
})

describe("tapeFor", () => {
  it("puts one card's tape in the same place every time, clear of the stamp corner", () => {
    expect(tapeFor("card-1")).toEqual(tapeFor("card-1"))
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      const t = tapeFor(id)
      expect(t.left).toBeGreaterThanOrEqual(6)
      expect(t.left).toBeLessThan(46)
      expect(Math.abs(t.angle)).toBeLessThanOrEqual(5)
    }
  })
})
