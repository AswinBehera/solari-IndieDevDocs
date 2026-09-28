import type { PlaceReader } from "@dt/travel-pack/read"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { requireAuth, type Verifier } from "./auth.js"

/**
 * The read behind `/lab/places` (P2.7): the Place Postcard grid, from the table.
 *
 * **Its own file and its own mount, not a route in `lab.ts`,** because `lab.ts`
 * holds a rule this would break: every noun in the Persona Lab is a persona, a
 * source, a query or an item, and none of them is a place. The web app draws the
 * same line — `/lab/places` is a separate page that shares a path prefix and
 * nothing else — and the API draws it in the same place.
 *
 * **Under `/lab` all the same**, for the reason the Lab's own routes are: the
 * shape is tuned for one grid in an internal tool, and `/places` would be a
 * promise to a client that does not exist yet. P4.2's `/place` search is where a
 * product route with a contract lands.
 *
 * The 10 ms CPU rule (ADR-0014) is why the choice of quote and the evidence count
 * are the reader's, in SQL, and why the page is clamped: this handler serialises
 * at most `MAX_LIMIT` rows and does nothing else. `cpu.test.ts` measures it.
 */

export interface PlacesDeps {
  /** Per-request, for the Hyperdrive reason `jobs` gives in `index.ts`. */
  reader: (env: unknown) => PlaceReader
  verifier: Verifier
}

/**
 * The most one request may ask for, and it is a measurement rather than a taste.
 *
 * A place carries its explanations with their receipts — travel's factors keep
 * up to twenty evidence ids each, eight factors across two scores — so a card is
 * about eight kilobytes of JSON and the cost of a page is almost all
 * serialisation. `cpu.test.ts` measured it in Node at 3.5 ms for thirty, 6.4 ms
 * for sixty and 22 ms for two hundred, against a 5 ms budget under the 10 ms
 * ceiling. Thirty is also exactly what the Phase 2 gate reviews. A longer grid is
 * a cursor, not a bigger number.
 */
export const MAX_LIMIT = 30
/** The whole allowance, since the grid is the only caller. */
export const DEFAULT_LIMIT = MAX_LIMIT

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new HTTPException(400, { message: "limit must be a positive integer" })
  }
  return Math.min(n, MAX_LIMIT)
}

export function placesRoutes(deps: PlacesDeps) {
  const routes = new Hono<{ Bindings: Record<string, unknown> }>()

  routes.use("*", requireAuth(deps.verifier))

  routes.get("/", async (c) => {
    const limit = parseLimit(c.req.query("limit"))
    const rows = await deps.reader(c.env).top(limit)
    // `quote` becomes `evidence` on the way out because that is the card's word
    // for it (`CardEvidence`); the reader's word is about where it came from.
    return c.json({ places: rows.map((r) => ({ place: r.place, evidence: r.quote })) })
  })

  return routes
}
