import { readFileSync } from "node:fs"
import { createDb } from "@dt/db"
import { harvestRuns, personas, rawItems, sessions } from "@samsara/db"
import { inArray } from "drizzle-orm"
import { CHARACTER_PRESETS } from "./characters.js"

/**
 * The Samsara demo's cast and what they found, for a clone with no keys.
 *
 * Run by `pnpm db:seed:demo`, after `@dt/db`'s trip seed. Idempotent: fixed ids,
 * persona rows upserted, demo runs deleted and re-inserted.
 *
 * **The results are real captures, not written copy.** `fixtures/samsara-demo.json`
 * is built by `tools/build-samsara-demo.ts` from browser captures put through the
 * worker's own parsers, and each run keeps its capture's query and time. What this
 * file adds is the session and run rows a real harvest would have written around
 * them, so the Lab's reads (runs, items, the split screen) work unchanged.
 *
 * A character with runs gets `stat_sessions` to match, so the builder locks where
 * they live, the same as it would for one that had browsed for real.
 */

const USER_ID = "00000000-0000-4000-8000-000000000001"
const FIXTURE = new URL("../fixtures/samsara-demo.json", import.meta.url)
/** Beam's code searches, so the price card's "searched N times" is there on a clone. */
const DEALS_FIXTURE = new URL("../fixtures/deals-demo.json", import.meta.url)
const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/doen_thang"

const fixedId = (kind: "c" | "d" | "e", n: number) =>
  `00000000-0000-4000-8000-0000000${kind}${n.toString(16).padStart(4, "0")}`

interface DemoRun {
  archetype: string
  /** "travel" when absent; the deals runs say "deals" so `/lab/deals` finds them. */
  domainId?: string
  /** Taken from the item count when absent. A blocked run is kept: it was a search. */
  outcome?: "ok" | "empty" | "blocked"
  sourceId: string
  query: string
  capturedAt: string
  items: {
    rank: number
    url: string
    title: string | null
    text: string
    languageGuess: string | null
    engagement: { views: number | null; likes: number | null; comments: number | null } | null
  }[]
}

async function main() {
  const read = (url: URL) => (JSON.parse(readFileSync(url, "utf8")) as { runs: DemoRun[] }).runs
  const runs = [...read(FIXTURE), ...read(DEALS_FIXTURE)]
  const { db, sql } = createDb(connectionString, { max: 1 })

  const personaIds = new Map<string, string>()
  for (const [i, p] of CHARACTER_PRESETS.entries()) {
    const id = fixedId("c", i)
    personaIds.set(p.title, id)
    const sessionCount = runs.filter((r) => r.archetype === p.title).length
    const row = {
      name: p.name,
      locality: p.locality,
      country: p.country,
      locale: p.locale,
      timezoneId: p.timezoneId,
      tier: "anon" as const,
      statSessions: sessionCount,
      statMinutes: sessionCount,
      traits: {
        archetype: p.title,
        bio: p.bio,
        interests: [...p.interests],
        sources: [...p.sources],
        look: { colour: p.colour, prop: p.prop },
      },
    }
    await db
      .insert(personas)
      .values({ id, ...row })
      .onConflictDoUpdate({ target: personas.id, set: row })
  }

  const runIds = runs.map((_, j) => fixedId("d", j))
  const sessionIds = runs.map((_, j) => fixedId("e", j))
  // Items cascade from their run; the session is referenced by the run, so it goes after.
  await db.delete(harvestRuns).where(inArray(harvestRuns.id, runIds))
  await db.delete(sessions).where(inArray(sessions.id, sessionIds))

  for (const [j, run] of runs.entries()) {
    const personaId = personaIds.get(run.archetype)
    const preset = CHARACTER_PRESETS.find((p) => p.title === run.archetype)
    if (!personaId || !preset) throw new Error(`no character "${run.archetype}"`)
    const startedAt = new Date(run.capturedAt)
    const endedAt = new Date(startedAt.getTime() + 60_000)
    await db.insert(sessions).values({
      id: sessionIds[j] as string,
      purpose: "harvest",
      ownerId: USER_ID,
      domainId: run.domainId ?? "travel",
      personaId,
      country: preset.country,
      locale: preset.locale,
      timezoneId: preset.timezoneId,
      startedAt,
      endedAt,
      minutes: 1,
      outcome: run.outcome === "blocked" ? "blocked" : "ok",
    })
    await db.insert(harvestRuns).values({
      id: runIds[j] as string,
      domainId: run.domainId ?? "travel",
      personaId,
      sourceId: run.sourceId,
      query: run.query,
      startedAt,
      endedAt,
      outcome: run.outcome ?? (run.items.length > 0 ? "ok" : "empty"),
      itemCount: run.items.length,
      sessionId: sessionIds[j] as string,
    })
    if (run.items.length > 0) {
      await db.insert(rawItems).values(
        run.items.map((item) => ({
          harvestRunId: runIds[j] as string,
          sourceId: run.sourceId,
          rank: item.rank,
          url: item.url,
          title: item.title,
          text: item.text,
          languageGuess: item.languageGuess,
          engagementViews: item.engagement?.views ?? null,
          engagementLikes: item.engagement?.likes ?? null,
          engagementComments: item.engagement?.comments ?? null,
          capturedAt: startedAt,
          rawRef: `demo/samsara/${run.sourceId}/${j}.json`,
        })),
      )
    }
  }

  console.log(`samsara demo: ${CHARACTER_PRESETS.length} characters, ${runs.length} runs`)
  await sql.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
