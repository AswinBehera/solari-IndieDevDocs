import { describe, expect, it } from "vitest"
import { documentText, postcardIdsIn } from "./trip.js"

const card = (id: string) => ({ type: "postcard", attrs: { postcardId: id } })

describe("postcardIdsIn", () => {
  it("finds cards at any depth, in document order", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Lunch here:" }] },
        card("a"),
        { type: "bulletList", content: [{ type: "listItem", content: [card("b")] }] },
      ],
    }
    expect(postcardIdsIn(doc)).toEqual(["a", "b"])
  })

  it("counts a card referenced twice once", () => {
    expect(postcardIdsIn({ type: "doc", content: [card("a"), card("a")] })).toEqual(["a"])
  })

  it("ignores a node with no id and anything that is not a document", () => {
    expect(postcardIdsIn({ type: "doc", content: [{ type: "postcard", attrs: {} }] })).toEqual([])
    expect(postcardIdsIn(null)).toEqual([])
    expect(postcardIdsIn("doc")).toEqual([])
  })
})

describe("documentText", () => {
  it("returns the prose one line per block and skips Postcards", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          content: [
            { type: "text", text: "Bangkok, " },
            { type: "text", text: "3-10 Nov" },
          ],
        },
        { type: "postcard", attrs: { postcardId: "x" } },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "street food" }] }],
            },
          ],
        },
      ],
    }
    expect(documentText(doc)).toBe("Bangkok, 3-10 Nov\nstreet food")
  })
  it("is empty for a document with nothing typed", () => {
    expect(documentText({ type: "doc", content: [{ type: "paragraph" }] })).toBe("")
    expect(documentText(null)).toBe("")
  })
})
