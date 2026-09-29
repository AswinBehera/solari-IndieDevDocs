import { describe, expect, it } from "vitest"
import { createJevJudge } from "./jev.js"

const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe("the Jev page judge", () => {
  it("reads the three probabilities", async () => {
    const judge = createJevJudge(
      "k",
      reply(200, {
        answers: { wall: { noul: 0.9 }, property: { noul: 0.1 }, price_visible: { noul: 0.2 } },
      }),
    )
    expect(await judge({ title: "t", text: "x" })).toEqual({
      wall: 0.9,
      property: 0.1,
      priceVisible: 0.2,
    })
  })
  it("answers null on an error, a missing answer or a thrown fetch", async () => {
    expect(await createJevJudge("k", reply(402, {}))({ title: "", text: "" })).toBeNull()
    expect(
      await createJevJudge(
        "k",
        reply(200, { answers: { wall: { noul: 0.9 } } }),
      )({
        title: "",
        text: "",
      }),
    ).toBeNull()
    const boom = (async () => {
      throw new Error("down")
    }) as unknown as typeof fetch
    expect(await createJevJudge("k", boom)({ title: "", text: "" })).toBeNull()
  })
  it("sends the key as a bearer token and caps the text", async () => {
    let sent: { headers: Record<string, string>; body: string } | undefined
    const spy = (async (_: string, init: { headers: Record<string, string>; body: string }) => {
      sent = init
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    await createJevJudge("secret", spy)({ title: "t", text: "a".repeat(10_000) })
    expect(sent?.headers.authorization).toBe("Bearer secret")
    expect(JSON.parse(sent?.body ?? "{}").state.text.length).toBe(3_000)
  })
})
