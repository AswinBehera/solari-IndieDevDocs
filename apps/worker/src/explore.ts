import { askAs, cityLanguage, LANGUAGE_NAME } from "@dt/travel-pack/interests"
import type { JobStore } from "@samsara/kernel/jobs"
import type { LlmClient } from "@samsara/llm"
import { definePrompt } from "@samsara/llm"
import type { PersonaStore } from "@samsara/personas"
import { z } from "zod"
import type { JobHandler } from "./handlers.js"

/**
 * `persona.explore`: send one character out to look for what a traveller cares
 * about, in the character's own language.
 *
 * **It queues; it does not harvest**, like `trip.sweep`. Each (interest, source)
 * becomes an ordinary `harvest.run` as that persona, so the budget guard, pacer,
 * health checks and the refine chain apply unchanged.
 *
 * **The question is asked the way the character would ask it.** A Thai-locale
 * character asks the hand-written Thai search for the tag (`interests.ts`); an
 * interest with no hand-written search is translated by the model, and without a
 * model it is skipped rather than asked in English, because an English question
 * from a Thai identity is the tourist's question in a disguise. A character whose
 * locale is not the city's language (the tourist control) asks in English on
 * purpose: that is the baseline the others are compared with.
 *
 * **Bounded.** At most `MAX_HARVESTS` a job, and each harvest is keyed by
 * persona, source, query and day, so pressing the button twice is one outing.
 */

export const MAX_HARVESTS = 8

export interface ExplorePayload {
  personaId: string
  city: string
  interests?: string[]
  sources?: string[]
}

const DEFAULT_SOURCE = "youtube.search"

function parsePayload(raw: unknown): ExplorePayload {
  const p = z
    .object({
      personaId: z.string().min(1),
      city: z.string().trim().min(1).max(80),
      interests: z.array(z.string().trim().min(1).max(60)).max(24).optional(),
      sources: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
    })
    .safeParse(raw)
  if (!p.success) throw new Error(`persona.explore: ${p.error.issues[0]?.message ?? "bad payload"}`)
  return p.data as ExplorePayload
}

export const exploreHarvestKey = (
  personaId: string,
  sourceId: string,
  query: string,
  day: string,
): string => `persona.explore:${personaId}:${sourceId}:${query}:${day}`

const translation = definePrompt({
  id: "travel/interest.localise",
  version: "1",
  system:
    "You turn a traveller's interest into the web search a local resident would type, " +
    "in the local language, as a short phrase that names the city. " +
    'Reply with JSON: {"query": "..."}. No English unless locals use the English word.',
  template: "City: {{city}} (in {{language}}: {{cityLocal}})\nInterest: {{interest}}",
})
const translated = z.object({ query: z.string().trim().min(2).max(80) })

export interface ExploreDeps {
  personas: Pick<PersonaStore, "byId">
  queue: Pick<JobStore, "enqueue">
  llm?: LlmClient | undefined
  clock?: () => Date
}

/** One planned search, and where its words came from. */
export interface PlannedSearch {
  interest: string
  query: string
  how: "local" | "translated" | "english"
}

export function createExploreHandler(deps: ExploreDeps): JobHandler {
  return async (ctx) => {
    const payload = parsePayload(ctx.job.payload)
    const persona = await deps.personas.byId(payload.personaId)
    if (!persona) {
      await ctx.heartbeat("that character is gone, nothing to do")
      return
    }
    if (persona.health === "banned" || persona.health === "retired") {
      await ctx.heartbeat(`${persona.name} is ${persona.health}, nothing queued`)
      return
    }
    const interests = payload.interests ?? persona.traits?.interests ?? []
    const sources = payload.sources ?? persona.traits?.sources ?? [DEFAULT_SOURCE]
    const lang = cityLanguage(payload.city)

    const planned: PlannedSearch[] = []
    for (const interest of interests) {
      if (planned.length * sources.length >= MAX_HARVESTS) break
      const asked = askAs(interest, payload.city, persona.locale)
      if (asked) {
        planned.push({ interest, ...asked })
        continue
      }
      if (!deps.llm || !lang) {
        await ctx.heartbeat(`no model to translate "${interest}", skipped`)
        continue
      }
      const result = await deps.llm.complete(translation, translated, {
        task: "extract",
        vars: {
          city: payload.city,
          language: LANGUAGE_NAME[lang.language],
          cityLocal: lang.name,
          interest,
        },
        maxOutputTokens: 60,
        scope: { ownerId: ctx.job.ownerId ?? "", purpose: "persona.explore", runId: ctx.job.id },
        domainId: "travel",
        signal: ctx.signal,
      })
      if (!result.ok) {
        await ctx.heartbeat(`could not translate "${interest}": ${result.error.message}`)
        continue
      }
      planned.push({ interest, query: result.value.value.query, how: "translated" })
    }

    const day = (deps.clock ?? (() => new Date()))().toISOString().slice(0, 10)
    let queued = 0
    let asked = 0
    for (const search of planned) {
      for (const sourceId of sources) {
        // Counted by asks, not by fresh rows: a second press re-asks the same
        // eight and dedupes them all, rather than reaching a ninth.
        if (asked++ >= MAX_HARVESTS) break
        const result = await deps.queue.enqueue({
          type: "harvest.run",
          domainId: "travel",
          ownerId: ctx.job.ownerId,
          payload: { personaId: persona.id, sourceId, query: search.query, domainId: "travel" },
          idempotencyKey: exploreHarvestKey(persona.id, sourceId, search.query, day),
        })
        if (!result.deduped) queued++
        await ctx.heartbeat(`${sourceId} · ${search.interest} → ${search.query}`)
      }
    }
    await ctx.heartbeat(`${persona.name}: ${queued} search(es) queued`)
  }
}
