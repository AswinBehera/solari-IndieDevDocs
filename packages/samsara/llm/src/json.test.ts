import { describe, expect, it } from "vitest"
import { parseJson } from "./json.js"
import { estimateTokens } from "./tokens.js"

describe("parseJson", () => {
  it("parses a bare object", () => {
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })

  it("parses a bare array", () => {
    expect(parseJson("[1,2]")).toEqual({ ok: true, value: [1, 2] })
  })

  it("unwraps a fenced block", () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJson('```\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
  })

  it("ignores prose on either side", () => {
    const answer = 'Sure! Here you go:\n{"a":1}\nLet me know if you need more.'
    expect(parseJson(answer)).toEqual({ ok: true, value: { a: 1 } })
  })

  it("is not fooled by a brace inside a string", () => {
    // The naive depth counter closes at the wrong place here and returns `{"n":"a`.
    const answer = '{"n":"a { b","m":2}'
    expect(parseJson(answer)).toEqual({ ok: true, value: { n: "a { b", m: 2 } })
  })

  it("is not fooled by an escaped quote", () => {
    expect(parseJson('{"n":"say \\"hi\\" }","m":2}')).toEqual({
      ok: true,
      value: { n: 'say "hi" }', m: 2 },
    })
  })

  it("reports a truncated object rather than repairing it", () => {
    // A model cut off mid-answer. Guessing at the close would turn a measurable
    // failure rate into an unmeasurable one, which is the number P2.2 needs most.
    expect(parseJson('{"a":1,"b":')).toEqual({ ok: false, reason: "unbalanced" })
  })

  it("reports malformed JSON rather than repairing it", () => {
    expect(parseJson("{'a':1}")).toEqual({ ok: false, reason: "invalid" })
    expect(parseJson('{"a":1,}')).toEqual({ ok: false, reason: "invalid" })
  })

  it("distinguishes an empty answer from one with no JSON in it", () => {
    expect(parseJson("   ")).toEqual({ ok: false, reason: "empty" })
    expect(parseJson("I cannot help with that.")).toEqual({ ok: false, reason: "no-json" })
  })
})

describe("estimateTokens", () => {
  it("counts ASCII at about four characters to the token", () => {
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcdefgh")).toBe(2)
  })

  it("counts non-ASCII at one token per character", () => {
    // The dangerous direction: a 4:1 rule would approve four times the input it
    // believed it was approving on native-script harvested text.
    const thai = "ก๋วยเตี๋ยว"
    expect(estimateTokens(thai)).toBe([...thai].length)
    expect(estimateTokens(thai)).toBeGreaterThan(Math.ceil(thai.length / 4))
  })

  it("counts an astral character once, not twice", () => {
    expect(estimateTokens("😀")).toBe(1)
  })

  it("is zero for an empty string", () => {
    expect(estimateTokens("")).toBe(0)
  })
})
