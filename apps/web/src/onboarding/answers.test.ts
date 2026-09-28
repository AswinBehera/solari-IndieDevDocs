import { describe, expect, it } from "vitest"
import { newTripFrom } from "./answers"

describe("newTripFrom", () => {
  it("makes a dated plan with the interests as the document's first line", () => {
    const trip = newTripFrom({
      city: "Bangkok",
      start: "2026-11-14",
      end: "2026-11-17",
      interests: ["food", "markets"],
    })
    expect(trip).toMatchObject({
      title: "Four days in Bangkok.",
      destinationCity: "Bangkok",
      startDate: "2026-11-14T00:00:00.000Z",
      endDate: "2026-11-17T00:00:00.000Z",
      status: "planning",
    })
    expect(trip.content).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "I care about food and markets." }] },
      ],
    })
  })

  it("makes an undated daydream when there are no dates", () => {
    const trip = newTripFrom({ city: "Tokyo", start: null, end: null, interests: [] })
    expect(trip).toMatchObject({ title: "Tokyo, undated.", status: "dreaming", startDate: null })
    expect(trip.content).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
  })

  it("drops an end date that comes before the start", () => {
    const trip = newTripFrom({
      city: "Bangkok",
      start: "2026-11-17",
      end: "2026-11-14",
      interests: [],
    })
    expect(trip.endDate).toBeNull()
    expect(trip.startDate).toBe("2026-11-17T00:00:00.000Z")
  })
})
