import { randomUUID } from "node:crypto"
import { personas, samsaraSchema, sessions } from "@samsara/db"
import { type DatabaseLock, lockDatabase } from "@samsara/db/testing"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  PostgresDriftExperimentStore,
  PostgresHarvestRunStore,
  PostgresRawItemStore,
} from "./postgres.js"
import type { RawItemRow } from "./store.js"

/**
 * The harvest stores against a real Postgres.
 *
 * What needs a real database here is not concurrency — a harvest run is owned by
 * one session and nothing races it — but the **foreign keys**, which are the
 * constraints doing the actual design work. `harvest_runs.persona_id` is
 * `ON DELETE restrict` and `raw_items.harvest_run_id` is `ON DELETE cascade`, and
 * those two opposite choices encode a rule no in-memory Map can hold: a persona
 * that produced evidence may not be deleted out from under it, while the items of
 * a discarded run go with the run. A fake would let both happen.
 *
 * Runs whenever `DATABASE_URL` is set, and **fails loudly when it is not** unless
 * `SAMSARA_NO_DB=1` says the omission is deliberate. See `jobs.pg.test.ts`.
 */

const url = process.env.DATABASE_URL
const hasDb = typeof url === "string" && url.length > 0
const optedOut = process.env.SAMSARA_NO_DB === "1"

if (!hasDb && !optedOut) {
  describe("harvest, against Postgres", () => {
    it("has a database to run against", () => {
      expect.fail(
        "DATABASE_URL is not set, so the foreign-key tests would have skipped and " +
          "this run would have reported green while testing nothing. Run `pnpm db:up` " +
          "and retry, or set SAMSARA_NO_DB=1 to skip on purpose.",
      )
    })
  })
}

const client = hasDb ? postgres(url as string, { max: 4, onnotice: () => {} }) : null
const db = client ? drizzle(client, { schema: samsaraSchema }) : null

// Held for the whole file: these suites truncate shared tables, and Turbo runs
// the packages that do so at the same time. See `@samsara/db/testing`.
let lock: DatabaseLock | null = null

beforeAll(async () => {
  if (hasDb) lock = await lockDatabase(url as string)
})

afterAll(async () => {
  await client?.end({ timeout: 5 })
  await lock?.release()
})

const capturedAt = new Date("2026-09-12T10:00:00.000Z")

describe.runIf(hasDb)("harvest, against Postgres", () => {
  const d = () => db as NonNullable<typeof db>
  const runs = () => new PostgresHarvestRunStore(d())
  const items = () => new PostgresRawItemStore(d())
  const experiments = () => new PostgresDriftExperimentStore(d())

  let personaId: string
  let sessionId: string

  beforeEach(async () => {
    await d().execute(
      sql`truncate table raw_items, harvest_runs, drift_experiments, sessions, personas restart identity cascade`,
    )
    personaId = randomUUID()
    await d().insert(personas).values({
      id: personaId,
      name: "regular",
      locality: "District 1",
      country: "sg",
      locale: "vi-VN",
      timezoneId: "Asia/Ho_Chi_Minh",
      tier: "anon",
    })
    const [session] = await d()
      .insert(sessions)
      .values({ purpose: "harvest", personaId, country: "sg", outcome: "ok", minutes: 0.5 })
      .returning({ id: sessions.id })
    sessionId = session?.id as string
  })

  const startRun = async (id = randomUUID()) => {
    await runs().start({
      id,
      domainId: "atlas",
      personaId,
      sourceId: "fake.search",
      query: "xin chào thế giới",
      sessionId,
      startedAt: capturedAt,
      experiment: null,
    })
    return id
  }

  const item = (runId: string, over: Partial<RawItemRow> = {}): RawItemRow => ({
    id: randomUUID(),
    harvestRunId: runId,
    sourceId: "fake.search",
    rank: 0,
    url: "https://fake.test/a",
    title: "A",
    text: "xin chào",
    languageGuess: "th",
    mediaRefs: [],
    engagement: null,
    capturedAt,
    rawRef: `captures/fake.search/${runId}/1.json`,
    ...over,
  })

  it("stores a run and reads it back, query text in its own script", async () => {
    const id = await startRun()
    const read = await runs().byId(id)
    expect(read?.outcome).toBe("running")
    expect(read?.endedAt).toBeNull()
    // The query is the dominant signal P1.0 measured. Storing it mangled would
    // make every later comparison of "what did we ask" meaningless.
    expect(read?.query).toBe("xin chào thế giới")
  })

  it("finishes a run in one write", async () => {
    const id = await startRun()
    const endedAt = new Date("2026-09-12T10:01:00.000Z")
    await runs().finish(id, "ok", 3, endedAt)
    const read = await runs().byId(id)
    expect(read?.outcome).toBe("ok")
    expect(read?.itemCount).toBe(3)
    expect(read?.endedAt?.toISOString()).toBe(endedAt.toISOString())
  })

  it("writes a batch of items in one statement", async () => {
    const id = await startRun()
    await items().insertMany([item(id), item(id, { url: "https://fake.test/b" })])
    const rows = await d().execute(sql`select count(*)::int as n from raw_items`)
    expect((rows as unknown as { n: number }[])[0]?.n).toBe(2)
  })

  it("accepts an empty batch without asking the database anything", async () => {
    const id = await startRun()
    // Ordinary, not exceptional: a source can answer honestly with nothing.
    await expect(items().insertMany([])).resolves.toBeUndefined()
    expect((await runs().byId(id))?.itemCount).toBe(0)
  })

  it("keeps zero and unknown engagement apart through the database", async () => {
    const id = await startRun()
    await items().insertMany([
      item(id, { engagement: { views: 0, likes: null, comments: null } }),
      item(id, { url: "https://fake.test/b", engagement: null }),
    ])
    const rows = (await d().execute(
      sql`select engagement_views from raw_items order by url`,
    )) as unknown as { engagement_views: number | null }[]
    // Zero views is a measurement. No views is an absence. A column that collapses
    // them makes every unmeasured item look unpopular.
    expect(rows.map((r) => r.engagement_views)).toEqual([0, null])
  })

  it("refuses to delete a persona that produced a run", async () => {
    await startRun()
    // `ON DELETE restrict`. Evidence has to keep pointing at whose eyes saw it, or
    // a scored result can no longer explain itself.
    await expect(d().execute(sql`delete from personas where id = ${personaId}`)).rejects.toThrow()
  })

  it("takes a run's items with it when the run is deleted", async () => {
    const id = await startRun()
    await items().insertMany([item(id), item(id, { url: "https://fake.test/b" })])
    // `ON DELETE cascade`, the opposite call to the one above and for the opposite
    // reason: items without their run are unattributable, not precious.
    await d().execute(sql`delete from harvest_runs where id = ${id}`)
    const rows = await d().execute(sql`select count(*)::int as n from raw_items`)
    expect((rows as unknown as { n: number }[])[0]?.n).toBe(0)
  })

  it("refuses an item whose run does not exist", async () => {
    await expect(items().insertMany([item(randomUUID())])).rejects.toThrow()
  })

  it("reads a run's items back in rank order, whatever order they were written in", async () => {
    const id = await startRun()
    // Inserted backwards on purpose. Nothing else in the row can stand in for this
    // order — `captured_at` is one timestamp for the whole batch and `id` is
    // random — so a store that returned insertion order would look correct here
    // every day until the day a batch was written twice.
    await items().insertMany([
      item(id, { rank: 2, url: "https://fake.test/c" }),
      item(id, { rank: 0, url: "https://fake.test/a" }),
      item(id, { rank: 1, url: "https://fake.test/b" }),
    ])
    const rows = await items().listByRun(id)
    expect(rows.map((r) => r.url)).toEqual([
      "https://fake.test/a",
      "https://fake.test/b",
      "https://fake.test/c",
    ])
  })

  it("bounds what a caller can ask for, and takes the bound off the top", async () => {
    const id = await startRun()
    await items().insertMany(
      Array.from({ length: 5 }, (_, rank) => item(id, { rank, url: `https://fake.test/${rank}` })),
    )
    // The top two, not two arbitrary rows: a bounded read of a ranked list is only
    // meaningful if the bound is applied after the order.
    expect((await items().listByRun(id, 2)).map((r) => r.rank)).toEqual([0, 1])
    // A caller that asks for more than the ceiling gets the ceiling, not an error:
    // the read is bounded to protect the handler's 10 ms, and the honest answer to
    // "give me a million" is the hundred that exist.
    expect(await items().listByRun(id, 1_000_000)).toHaveLength(5)
  })

  it("brings engagement back as an absence, not as three zeroes", async () => {
    const id = await startRun()
    await items().insertMany([
      item(id, { rank: 0, engagement: { views: 0, likes: null, comments: null } }),
      item(id, { rank: 1, url: "https://fake.test/b", engagement: null }),
    ])
    const [measured, unknown] = await items().listByRun(id)
    expect(measured?.engagement).toEqual({ views: 0, likes: null, comments: null })
    // Three null columns is a source that does not publish these numbers. Rebuilt
    // as `{ views: null, ... }` it would read as a measurement that came back empty.
    expect(unknown?.engagement).toBeNull()
  })

  it("lists runs newest first, because the Lab always wants the latest one", async () => {
    const older = randomUUID()
    await runs().start({
      id: older,
      domainId: "atlas",
      personaId,
      sourceId: "fake.search",
      query: "xin chào thế giới",
      sessionId,
      startedAt: new Date("2026-09-11T10:00:00.000Z"),
      experiment: null,
    })
    const newer = await startRun()
    const [first] = await runs().list({ personaId, limit: 1 })
    expect(first?.id).toBe(newer)
    expect(first?.id).not.toBe(older)
  })

  it("matches a query exactly, since a comparison only holds within one question", async () => {
    await startRun()
    expect(await runs().list({ query: "xin chào thế giới" })).toHaveLength(1)
    // Not a prefix, not a fuzzy match. Two different questions produce two
    // different rankings, and comparing them would measure the question.
    expect(await runs().list({ query: "xin chào" })).toHaveLength(0)
  })

  it("lists by source and by persona, which is how a rerun finds its history", async () => {
    const a = await startRun()
    await runs().finish(a, "ok", 1, new Date())
    await startRun()

    expect(await runs().list({ sourceId: "fake.search" })).toHaveLength(2)
    expect(await runs().list({ personaId })).toHaveLength(2)
    expect(await runs().list({ sourceId: "other.source" })).toHaveLength(0)
    expect(await runs().list()).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // The drift experiment (P1.8). What needs real SQL here is the pair of CHECK
  // constraints: one says an experiment cannot compare an identity with itself,
  // the other says a run's `(experiment_id, experiment_day)` is set together or
  // not at all. Both are rules a Map cannot hold, and both exist because the
  // alternative is a row that produces a plausible-looking plot of nothing.

  /**
   * The constraint a statement actually tripped over.
   *
   * Drizzle wraps the driver error, so the name lives on `cause` and a plain
   * `rejects.toThrow()` would pass for any failure at all — including a typo in
   * the SQL. These tests exist to prove one specific constraint fires, so they
   * have to name it.
   */
  const violated = async (work: Promise<unknown>): Promise<string | undefined> => {
    try {
      await work
      return undefined
    } catch (error) {
      const cause = (error as { cause?: { constraint_name?: string } }).cause
      return cause?.constraint_name
    }
  }

  const secondPersona = async () => {
    const id = randomUUID()
    await d().insert(personas).values({
      id,
      name: "the other one",
      // A second identity, and deliberately an unremarkable one: the engine does
      // not know what these two places are, only that they are different. The
      // seam check caught the first draft of this, which named a city the
      // lexicon forbids here (ADR-0009) for exactly that reason.
      locality: "Mapo",
      country: "kr",
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      tier: "anon",
    })
    return id
  }

  const experiment = async (over: Record<string, unknown> = {}) => {
    const id = randomUUID()
    await experiments().insert({
      id,
      domainId: "atlas",
      ownerId: "owner-1",
      sourceId: "fake.search",
      query: "xin chào thế giới",
      personaAId: personaId,
      personaBId: await secondPersona(),
      days: 7,
      k: 20,
      intervalMinutes: 1440,
      startedAt: capturedAt,
      state: "running",
      ...over,
    })
    return id
  }

  it("refuses an experiment that compares one identity with itself", async () => {
    // `overlapAt(x, x, k)` is a perfectly good 1.0, which is the problem: a week
    // of them is a flat line at the top of the chart that looks like a finding.
    expect(await violated(experiment({ personaBId: personaId }))).toBe(
      "drift_experiments_two_personas",
    )
  })

  it("holds the persona a week of evidence belongs to", async () => {
    const id = await experiment()
    const row = await experiments().byId(id)
    // `ON DELETE restrict`, like `harvest_runs.persona_id`: an identity that is
    // half of a running comparison cannot be deleted out from under it.
    expect(
      await violated(d().execute(sql`delete from personas where id = ${row?.personaAId ?? ""}`)),
    ).toBe("drift_experiments_persona_a_id_personas_id_fk")
  })

  it("will not let a run carry half a pairing key", async () => {
    const id = await experiment()
    await startRun()
    expect(
      await violated(
        d().execute(
          sql`update harvest_runs set experiment_id = ${id} where persona_id = ${personaId}`,
        ),
      ),
    ).toBe("harvest_runs_experiment_pair")
  })

  it("lists an experiment's runs in day order, oldest first", async () => {
    const id = await experiment()
    const mk = async (day: number, at: Date) => {
      const runId = randomUUID()
      await runs().start({
        id: runId,
        domainId: "atlas",
        personaId,
        sourceId: "fake.search",
        query: "xin chào thế giới",
        sessionId,
        startedAt: at,
        experiment: { id, day },
      })
      return runId
    }
    const day1 = await mk(1, new Date("2026-09-13T10:00:00.000Z"))
    const day0 = await mk(0, new Date("2026-09-12T10:00:00.000Z"))
    await startRun()

    const series = await runs().listByExperiment(id)
    // Oldest first and only this experiment's: the ad-hoc run above shares the
    // persona, the source and the question, and belongs to no measurement.
    expect(series.map((r) => r.id)).toEqual([day0, day1])
    expect(series[0]?.experiment).toEqual({ id, day: 0 })
  })

  it("reads only the urls a plot needs, k per run", async () => {
    const a = await startRun()
    const b = await startRun()
    await items().insertMany([
      ...Array.from({ length: 5 }, (_, rank) => item(a, { rank, url: `https://a.test/${rank}` })),
      ...Array.from({ length: 5 }, (_, rank) => item(b, { rank, url: `https://b.test/${rank}` })),
    ])

    const urls = await items().rankedUrls([a, b], 3)
    expect(urls.get(a)).toEqual(["https://a.test/0", "https://a.test/1", "https://a.test/2"])
    expect(urls.get(b)).toHaveLength(3)
    // A run with no items is absent rather than empty — that is what lets the
    // series say "this day returned nothing" instead of "these two agreed on
    // nothing", which are different findings that both plot as zero.
    expect(await items().rankedUrls([randomUUID()], 3)).toEqual(new Map())
  })

  it("stops an experiment without touching what it already measured", async () => {
    const id = await experiment()
    await experiments().setState(id, "stopped")
    expect((await experiments().byId(id))?.state).toBe("stopped")
    // Stopped, not deleted. A deleted plan would leave its remaining queued jobs
    // pointing at nothing and spending anyway, and would take the evidence with
    // it — the days already run are the reason the experiment existed.
    expect((await experiments().list({ state: "running" })).map((e) => e.id)).not.toContain(id)
  })
})
