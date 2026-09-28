import type { TripStore } from "@dt/db/trips"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { requireAuth, type Verifier } from "./auth.js"

/**
 * The Trip Document's API (P4.1): trips, their one document, and its Postcards.
 *
 * **A product route, not a Lab one.** These are the first routes a traveller's
 * browser calls, so they are top-level resources with a contract: `/trips`,
 * `/trips/:id/document`, `/postcards/:id`. Everything is scoped to the signed-in
 * owner by the store, and a trip that is someone else's is a 404, never a 403 —
 * a 403 would confirm that the id exists.
 *
 * **The document is saved with the version it was loaded at.** A stale version is
 * a 409 carrying the current one, so the editor can say "changed in another tab"
 * instead of overwriting it.
 *
 * The 10 ms CPU rule (ADR-0014) is why a document body is capped by size before it
 * is parsed: the work here is JSON in and JSON out, and the one input a client
 * controls the size of is the document.
 */

export interface TripsDeps {
  /** Per-request, for the Hyperdrive reason `jobs` gives in `index.ts`. */
  store: (env: unknown) => TripStore
  verifier: Verifier
}

/** A generous trip document is tens of kilobytes; this is an order of magnitude over that. */
export const MAX_DOCUMENT_BYTES = 512 * 1024

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s))
const geo = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
const time = z.object({ start: isoDate, end: isoDate.nullable() })
const status = z.enum(["dreaming", "planning", "travelling", "done"])
const kind = z.enum(["place", "price", "note", "photo", "link", "checklist"])
const state = z.enum(["fresh", "stale", "pinned"])

const EMPTY_DOCUMENT = { type: "doc", content: [{ type: "paragraph" }] }

const createTrip = z.object({
  title: z.string().trim().min(1).max(200),
  destinationCity: z.string().trim().min(1).max(80),
  startDate: isoDate.nullable().default(null),
  endDate: isoDate.nullable().default(null),
  status: status.default("dreaming"),
  content: z.unknown().optional(),
})

const patchTrip = z
  .object({
    title: z.string().trim().min(1).max(200),
    destinationCity: z.string().trim().min(1).max(80),
    startDate: isoDate.nullable(),
    endDate: isoDate.nullable(),
    status,
  })
  .partial()

const saveDocument = z.object({
  content: z.unknown().refine((v) => v !== undefined, "content is required"),
  version: z.number().int().positive(),
})

const createPostcard = z.object({
  kind,
  placeId: z.uuid().nullable().default(null),
  payload: z.unknown().default({}),
  geo: geo.nullable().default(null),
  time: time.nullable().default(null),
  sourceRefs: z.array(z.uuid()).max(200).default([]),
  state: state.optional(),
})

const patchPostcard = z
  .object({ payload: z.unknown(), geo: geo.nullable(), time: time.nullable(), state })
  .partial()

/** The first issue's path and message — never the zod tree, which echoes the body back. */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new HTTPException(400, {
      message: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body",
    })
  }
  return parsed.data
}

/**
 * Drops the keys zod left `undefined`. With `exactOptionalPropertyTypes` on, a key
 * that is present and undefined is a different type from one that is absent, and
 * the store means absent: "leave this field alone".
 */
function present<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}

const notFound = () => new HTTPException(404, { message: "no such trip" })

export function tripsRoutes(deps: TripsDeps) {
  const routes = new Hono<{ Bindings: Record<string, unknown> }>()
  // Per route rather than `use("*")`: these mount at the root, and a wildcard there
  // would put `/health` behind a token too.
  const auth = requireAuth(deps.verifier)

  routes.get("/trips", auth, async (c) => {
    const rows = await deps.store(c.env).list(c.get("ownerId"))
    return c.json({ trips: rows })
  })

  routes.post("/trips", auth, async (c) => {
    const body = parse(createTrip, await c.req.json().catch(() => null))
    const store = deps.store(c.env)
    const ownerId = c.get("ownerId")
    // Trips hang off the owner's `users` row, which sign-up creates (P6.1). Said by
    // name rather than left to a foreign-key violation, which would be a 500.
    if (!(await store.hasAccount(ownerId))) {
      throw new HTTPException(403, { message: "no account for this sign-in yet" })
    }
    const { content, ...fields } = body
    const created = await store.create(ownerId, { ...fields, content: content ?? EMPTY_DOCUMENT })
    return c.json(created, 201)
  })

  routes.get("/trips/:id", auth, async (c) => {
    const found = await deps.store(c.env).get(c.get("ownerId"), c.req.param("id"))
    if (!found) throw notFound()
    return c.json(found)
  })

  routes.patch("/trips/:id", auth, async (c) => {
    const patch = present(parse(patchTrip, await c.req.json().catch(() => null)))
    const trip = await deps.store(c.env).update(c.get("ownerId"), c.req.param("id"), patch)
    if (!trip) throw notFound()
    return c.json({ trip })
  })

  routes.put("/trips/:id/document", auth, async (c) => {
    // The bytes themselves, not `content-length`: a chunked request has no such
    // header, and a check a client can skip by omitting a header is not a check.
    const raw = await c.req.arrayBuffer()
    if (raw.byteLength > MAX_DOCUMENT_BYTES) {
      throw new HTTPException(413, { message: "document is too large to save" })
    }
    let json: unknown = null
    try {
      json = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      // Falls through to the schema, which names what is missing.
    }
    const body = parse(saveDocument, json)
    const result = await deps
      .store(c.env)
      .saveDocument(c.get("ownerId"), c.req.param("id"), body.content, body.version)
    if (!result) throw notFound()
    if (!result.saved) {
      return c.json(
        { error: "changed elsewhere since it was loaded", version: result.version },
        409,
      )
    }
    return c.json({ version: result.version })
  })

  routes.post("/trips/:id/postcards", auth, async (c) => {
    const { state, ...body } = parse(createPostcard, await c.req.json().catch(() => null))
    const card = await deps
      .store(c.env)
      .addPostcard(c.get("ownerId"), c.req.param("id"), { ...body, ...(state ? { state } : {}) })
    if (!card) throw notFound()
    return c.json({ postcard: card }, 201)
  })

  routes.patch("/postcards/:id", auth, async (c) => {
    const patch = present(parse(patchPostcard, await c.req.json().catch(() => null)))
    const card = await deps.store(c.env).updatePostcard(c.get("ownerId"), c.req.param("id"), patch)
    if (!card) throw new HTTPException(404, { message: "no such postcard" })
    return c.json({ postcard: card })
  })

  routes.delete("/postcards/:id", auth, async (c) => {
    const gone = await deps.store(c.env).deletePostcard(c.get("ownerId"), c.req.param("id"))
    if (!gone) throw new HTTPException(404, { message: "no such postcard" })
    return c.body(null, 204)
  })

  return routes
}
