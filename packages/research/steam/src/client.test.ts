import { describe, expect, it } from "vitest"
import { SteamClient, SteamThrottled } from "./client.js"

function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })

describe("SteamClient", () => {
  it("spaces requests, including concurrent ones", async () => {
    const clock = fakeClock()
    const at: number[] = []
    const client = new SteamClient({
      ...clock,
      minIntervalMs: 1000,
      fetch: async () => {
        at.push(clock.now())
        return ok()
      },
    })
    await Promise.all([client.get("a"), client.get("b"), client.get("c")])
    expect(at).toEqual([0, 1000, 2000])
    expect(client.requests).toBe(3)
  })

  it("backs off on 429 and gives up after the last backoff", async () => {
    const clock = fakeClock()
    let calls = 0
    const client = new SteamClient({
      ...clock,
      minIntervalMs: 0,
      backoffMs: [100],
      fetch: async () => {
        calls++
        return new Response("", { status: 429 })
      },
    })
    await expect(client.get("x")).rejects.toBeInstanceOf(SteamThrottled)
    expect(calls).toBe(2)
  })

  it("keeps the exact bytes", async () => {
    const client = new SteamClient({
      ...fakeClock(),
      fetch: async () => new Response('{"a":1}', { status: 200 }),
    })
    const { fetched, json } = await client.json("x")
    expect(new TextDecoder().decode(fetched.body)).toBe('{"a":1}')
    expect(json).toEqual({ a: 1 })
  })
})
