import { describe, expect, it } from "vitest"
import { probeFinished, REACHABLE } from "./probe"

const at = (ms: number) => ({ capturedAt: new Date(ms).toISOString() })
const NOW = Date.parse("2026-09-29T14:00:00Z")

describe("probeFinished", () => {
  it("is finished once every reachable country is back", () => {
    expect(
      probeFinished(
        Array.from({ length: REACHABLE }, () => at(NOW)),
        NOW,
        NOW,
      ),
    ).toBe(true)
  })
  it("keeps waiting while results are still arriving", () => {
    expect(probeFinished([at(NOW - 20_000), at(NOW - 5_000)], NOW, NOW - 60_000)).toBe(false)
  })
  it("is finished after a quiet spell, even one country short", () => {
    expect(probeFinished([at(NOW - 400_000), at(NOW - 300_000)], NOW, NOW)).toBe(true)
  })
  it("waits, then gives up, when nothing has arrived", () => {
    expect(probeFinished([], NOW, NOW - 60_000)).toBe(false)
    expect(probeFinished([], NOW, NOW - 300_000)).toBe(true)
  })
})
