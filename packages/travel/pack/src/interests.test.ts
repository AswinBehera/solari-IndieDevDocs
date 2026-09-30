import { describe, expect, it } from "vitest"
import { INTEREST_IDS, interestsIn, localQuery } from "./interests.js"

describe("interests", () => {
  it("asks in Thai for Bangkok and Japanese for Tokyo, never in English", () => {
    expect(localQuery("rooftop bars", "Bangkok")).toBe("รูฟท็อปบาร์ กรุงเทพ")
    expect(localQuery("Street Food", "Bangkok")).toBe("สตรีทฟู้ด กรุงเทพ ร้านเด็ด")
    expect(localQuery("coffee", "Tokyo")).toBe("東京 カフェ 喫茶店")
  })

  it("has no search for a free-text interest or an unknown city, so the caller translates", () => {
    expect(localQuery("jazz vinyl shops", "Bangkok")).toBeNull()
    expect(localQuery("temples", "Lisbon")).toBeNull()
  })

  it("has a unique id and a local search in every language for every tag", () => {
    expect(new Set(INTEREST_IDS).size).toBe(INTEREST_IDS.length)
    for (const id of INTEREST_IDS) {
      expect(localQuery(id, "Bangkok")).toMatch(/กรุงเทพ/)
      expect(localQuery(id, "Tokyo")).toMatch(/東京/)
    }
  })

  it("reads the tags back out of onboarding's sentence, longest first", () => {
    expect(interestsIn("I care about street food, night markets and temples.")).toEqual([
      "street food",
      "temples",
      "night markets",
    ])
    expect(interestsIn("I care about food and markets.")).toEqual(["food", "markets"])
  })
})
