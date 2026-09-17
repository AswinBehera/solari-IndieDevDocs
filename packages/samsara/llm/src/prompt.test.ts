import { describe, expect, it } from "vitest"
import { definePrompt, fingerprint } from "./prompt.js"

describe("definePrompt", () => {
  it("collects variables in first-appearance order, without repeats", () => {
    const prompt = definePrompt({
      id: "engine/test",
      version: "1",
      template: "{{ b }} then {{a}} then {{b}} again",
    })
    expect(prompt.variables).toEqual(["b", "a"])
  })

  it("substitutes every occurrence", () => {
    const prompt = definePrompt({
      id: "engine/test",
      version: "1",
      template: "{{x}}-{{x}}",
    })
    expect(prompt.render({ x: "9" }).user).toBe("9-9")
  })

  it("carries the system message through when there is one, and omits it when not", () => {
    const withSystem = definePrompt({
      id: "engine/test",
      version: "1",
      system: "be terse",
      template: "go",
    })
    expect(withSystem.render()).toEqual({ system: "be terse", user: "go" })

    const without = definePrompt({ id: "engine/test", version: "1", template: "go" })
    expect(without.render()).toEqual({ user: "go" })
    expect("system" in without.render()).toBe(false)
  })

  it("refuses to render with a variable missing", () => {
    const prompt = definePrompt({ id: "engine/test", version: "1", template: "{{city}}" })
    expect(() => prompt.render({})).toThrow(/missing city/)
  })

  it("refuses to render with a variable nobody asked for", () => {
    // The quiet bug: `items` against a template reading `{{item}}` renders a
    // prompt with no data in it and gets back a confident, empty answer.
    const prompt = definePrompt({ id: "engine/test", version: "1", template: "{{item}}" })
    expect(() => prompt.render({ item: "a", items: "b" })).toThrow(/does not use/)
  })

  it("requires an id and a version", () => {
    expect(() => definePrompt({ id: "", version: "1", template: "x" })).toThrow(/id is required/)
    expect(() => definePrompt({ id: "engine/test", version: "", template: "x" })).toThrow(
      /no version/,
    )
  })
})

describe("fingerprint", () => {
  it("is stable for the same text and different for a changed one", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"))
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"))
  })

  it("is 16 hex digits", () => {
    expect(fingerprint("abc")).toMatch(/^[0-9a-f]{16}$/)
  })

  it("changes when the text changes but the declared version does not", () => {
    // The whole reason the field exists. Nothing forces the bump; the discrepancy
    // is simply visible afterwards, in two rows that both claim version 3.
    const before = definePrompt({ id: "engine/test", version: "3", template: "name the entity" })
    const after = definePrompt({
      id: "engine/test",
      version: "3",
      template: "name the entity, in both scripts",
    })
    expect(after.version).toBe(before.version)
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it("separates the system message from the template", () => {
    // Without the separator, ("ab", "c") and ("a", "bc") would hash identically.
    const a = definePrompt({ id: "engine/test", version: "1", system: "ab", template: "c" })
    const b = definePrompt({ id: "engine/test", version: "1", system: "a", template: "bc" })
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })
})
