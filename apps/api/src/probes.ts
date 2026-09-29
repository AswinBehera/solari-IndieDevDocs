import { PRICE_SOURCE_ID, parseStayUrl } from "@dt/travel-pack/price/parse"
import type { JobStore } from "@samsara/kernel/jobs"
import type { ObservationStore, ProbeTargetStore } from "@samsara/probe/types"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { requireAuth, type Verifier } from "./auth.js"

/**
 * Hundred Eyes' product routes (P3, P4.7): paste a property URL, get one price per
 * country.
 *
 * `POST /probes` refuses a URL the adapter does not understand *here*, before a job
 * or a browser exists, and answers with the reason. It then enqueues `probe.run`
 * keyed by target and hour, so a double click or a re-paste is one probe of eight
 * sessions and not two. `GET /probes/:id` reads what has landed so far, which is
 * partial while the worker is still working through the countries.
 *
 * Scoped to the owner by the store, like trips: someone else's target is a 404.
 */
export interface ProbesDeps {
  targets: (env: unknown) => ProbeTargetStore
  observations: (env: unknown) => ObservationStore
  verifier: Verifier
  clock?: () => Date
}

const body = z.object({ url: z.string().trim().min(1).max(2000) })

export function probesRoutes(deps: ProbesDeps & { jobs: (env: unknown) => JobStore }) {
  const routes = new Hono<{ Bindings: Record<string, unknown> }>()
  routes.use("*", requireAuth(deps.verifier))

  routes.post("/", async (c) => {
    const parsedBody = body.safeParse(await c.req.json().catch(() => null))
    if (!parsedBody.success) throw new HTTPException(400, { message: "url is required" })
    const parsed = parseStayUrl(parsedBody.data.url, deps.clock?.() ?? new Date())
    if (!parsed.ok) throw new HTTPException(422, { message: parsed.reason })
    const ownerId = c.get("ownerId")
    const target = await deps.targets(c.env).upsert({
      ownerId,
      sourceId: PRICE_SOURCE_ID,
      url: parsed.parsed.url,
      parsed: parsed.parsed,
    })
    const now = (deps.clock?.() ?? new Date()).getTime()
    const queued = await deps.jobs(c.env).enqueue({
      type: "probe.run",
      domainId: "travel",
      ownerId,
      payload: { targetId: target.id },
      idempotencyKey: `probe.run:${target.id}:${Math.floor(now / 3_600_000)}`,
    })
    return c.json({ targetId: target.id, jobId: queued.id, deduped: queued.deduped }, 202)
  })

  routes.get("/:id", async (c) => {
    const target = await deps.targets(c.env).getOwned(c.get("ownerId"), c.req.param("id"))
    if (!target) throw new HTTPException(404, { message: "no such probe" })
    const rows = await deps.observations(c.env).latestByCountry(target.id)
    return c.json({
      target: { id: target.id, url: target.url, parsed: target.parsed },
      observations: rows.map((r) => ({
        country: r.country,
        capturedAt: r.capturedAt,
        payload: r.payload,
        screenshotRef: r.screenshotRef,
        notes: r.notes,
      })),
    })
  })
  return routes
}
