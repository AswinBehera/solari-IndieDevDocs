import { describe, expect, it } from "vitest"
import { canonicalTimezoneId, sameTimezone } from "./timezone.js"

describe("timezone ids that name the same zone", () => {
  it("treats an IANA link and its canonical id as one zone", () => {
    // The pair that caused this file to exist. Which of the two a given ICU build
    // prefers is not the point and is not asserted — only that they agree.
    expect(sameTimezone("Asia/Ho_Chi_Minh", "Asia/Saigon")).toBe(true)
    expect(sameTimezone("Asia/Calcutta", "Asia/Kolkata")).toBe(true)
  })

  it("still separates zones that are genuinely different", () => {
    // Same UTC offset, different zones. A comparison that folded these together
    // would pass every test above and be useless: two viewpoints one hour apart
    // in DST history are two viewpoints.
    expect(sameTimezone("Asia/Singapore", "Australia/Perth")).toBe(false)
    expect(sameTimezone("Europe/London", "Europe/Dublin")).toBe(false)
  })

  it("is stable under repetition", () => {
    const once = canonicalTimezoneId("Asia/Ho_Chi_Minh")
    expect(canonicalTimezoneId(once)).toBe(once)
  })

  it("returns an unknown id unchanged rather than throwing", () => {
    // A session row can carry a zone this runtime's tzdb has never heard of —
    // older container image, newer database. Returning the input keeps the
    // comparison honest (it will simply not match) instead of taking down the
    // caller with a RangeError.
    expect(canonicalTimezoneId("Not/AZone")).toBe("Not/AZone")
    expect(sameTimezone("Not/AZone", "Not/AZone")).toBe(true)
  })
})
