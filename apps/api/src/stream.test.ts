import type { JobStore, StoredJobEvent } from "@samsara/kernel/jobs"
import {
  maxStreamQueries,
  STREAM_MAX_LIFETIME_MS,
  streamPollIntervalMs,
} from "@samsara/kernel/jobs"
import { describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import type { Verifier } from "./auth.js"
import { noopDispatcher } from "./dispatch.js"

/**
 * P0.5's second acceptance criterion (ADR-0016): *a bounded query count for an SSE
 * stream held across a real run*.
 *
 * The number being defended is not this app's. Hyperdrive's free plan meters
 * 100,000 queries a day **account-wide** — shared by every environment, every
 * branch preview, and every other service on the account. So the failure this test
 * exists to prevent is not "the stream is slow", it is "one tab left open on a
 * laptop lid overnight exhausts the quota and every other request starts failing".
 * That failure is invisible in development, where no tab lives long enough, which
 * is exactly why it needs a test rather than care.
 *
 * The bound is compared against `maxStreamQueries()`, which is computed by walking
 * `streamPollIntervalMs` — the same function the handler calls. Writing the
 * expected number here as a literal would let a later edit to the schedule pass
 * this test while quietly tripling the real cost.
 */

const verifier: Verifier = {
  async verify() {
    return "owner-1"
  },
}
const AUTH = { authorization: "Bearer token" }

/** Counts reads and can be told what the job is doing. Nothing else. */
class CountingStore {
  queries = 0
  constructor(private readonly events: StoredJobEvent[] = []) {}

  async eventsAfter(_jobId: string, after: number, limit: number): Promise<StoredJobEvent[]> {
    this.queries += 1
    return this.events.filter((e) => e.seq > after).slice(0, limit)
  }
}

/**
 * A clock the test drives. `sleep` does not sleep — it advances the clock by
 * exactly what the handler asked for. That makes a fifteen-minute stream take
 * milliseconds to test *and* makes the assertion exact rather than timing-dependent:
 * the query count is a property of the schedule, not of how loaded the machine was.
 */
function fakeTime() {
  let now = 0
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      now += ms
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

function appWith(store: CountingStore, time: ReturnType<typeof fakeTime>) {
  return createApp({
    jobs: () => store as unknown as JobStore,
    verifier,
    dispatcher: noopDispatcher,
    clock: time.clock,
    sleep: time.sleep,
  })
}

const event = (seq: number, state: StoredJobEvent["state"]): StoredJobEvent => ({
  seq,
  state,
  note: null,
  at: new Date(0),
})

describe("the progress stream's query budget", () => {
  it("stays under the ADR-0016 bound for a stream held its whole lifetime", async () => {
    // A job that never finishes: the worst case, and the realistic one for a
    // run that hit a retry loop or a tab whose owner walked away.
    const store = new CountingStore([event(0, "queued"), event(1, "running")])
    const time = fakeTime()
    const res = await appWith(store, time).request("/jobs/job-1/events", { headers: AUTH })
    await res.text()

    expect(store.queries).toBe(maxStreamQueries())
    expect(store.queries).toBeLessThanOrEqual(maxStreamQueries())

    // The comparison that gives the number meaning. A flat one-second poll over the
    // same window is 900 queries; one such tab open all day is 86,400, against an
    // account-wide daily ceiling of 100,000.
    const flatPoll = STREAM_MAX_LIFETIME_MS / 1_000
    expect(store.queries).toBeLessThan(flatPoll / 10)
  })

  it("closes itself rather than living as long as the job does", async () => {
    const store = new CountingStore([event(0, "queued")])
    const time = fakeTime()
    const res = await appWith(store, time).request("/jobs/job-1/events", { headers: AUTH })
    const body = await res.text()

    // The stream ends on its own deadline even though the job is still queued. The
    // client reconnects if a human is still watching, and does not if they are not.
    expect(body).toContain("stream.closed")
    expect(body).toContain('"reason":"lifetime"')
    expect(time.clock()).toBeGreaterThanOrEqual(STREAM_MAX_LIFETIME_MS)
  })

  it("spends one query per tick, not two", async () => {
    // The events carry their own state, so there is never a second read of the job
    // row to ask "is it done yet". Ten ticks in the first ten seconds, ten queries.
    const store = new CountingStore([event(0, "running")])
    const time = fakeTime()
    const app = createApp({
      jobs: () => store as unknown as JobStore,
      verifier,
      dispatcher: noopDispatcher,
      clock: time.clock,
      sleep: time.sleep,
      maxLifetimeMs: 10_000,
    })
    await (await app.request("/jobs/job-1/events", { headers: AUTH })).text()
    expect(store.queries).toBe(10)
  })

  it("stops early when the job reaches a terminal state", async () => {
    const store = new CountingStore([
      event(0, "queued"),
      event(1, "running"),
      event(2, "succeeded"),
    ])
    const time = fakeTime()
    const res = await appWith(store, time).request("/jobs/job-1/events", { headers: AUTH })
    const body = await res.text()

    // One query. A finished job costs a single round trip, no matter how long the
    // client would have been willing to wait.
    expect(store.queries).toBe(1)
    expect(body).toContain('"reason":"terminal"')
  })

  it("resumes from Last-Event-ID instead of replaying", async () => {
    const store = new CountingStore([
      event(0, "queued"),
      event(1, "running"),
      event(2, "succeeded"),
    ])
    const time = fakeTime()
    const res = await appWith(store, time).request("/jobs/job-1/events", {
      headers: { ...AUTH, "last-event-id": "1" },
    })
    const body = await res.text()

    // This is what makes the bounded lifetime cheap rather than lossy: the client
    // that was closed at fifteen minutes picks up exactly where it stopped, so the
    // reconnect costs one query rather than the whole history.
    expect(body).not.toContain('"state":"queued"')
    expect(body).toContain('"state":"succeeded"')
  })

  it("backs off on the schedule the bound is derived from", () => {
    // Guards the shape, not the constants: fast while a human is plausibly still
    // looking at the screen they just pressed a button on, slow afterwards.
    expect(streamPollIntervalMs(0)).toBe(1_000)
    expect(streamPollIntervalMs(9_999)).toBe(1_000)
    expect(streamPollIntervalMs(10_000)).toBe(5_000)
    expect(streamPollIntervalMs(59_999)).toBe(5_000)
    expect(streamPollIntervalMs(60_000)).toBe(15_000)
    expect(streamPollIntervalMs(STREAM_MAX_LIFETIME_MS)).toBe(15_000)
  })
})
