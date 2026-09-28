import { describe, expect, it } from "vitest"
import { postcardIdsIn } from "./trip.js"

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
