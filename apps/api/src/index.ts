// @dt/api — Hono on Cloudflare Workers (ADR-0014). Thin: validates, enqueues, reads.

import { createDb } from "@dt/db"
import { PostgresPlaceReader } from "@dt/travel-pack/read"
import {
  PostgresDriftExperimentStore,
  PostgresHarvestRunStore,
  PostgresRawItemStore,
} from "@samsara/harvest/postgres"
import { PostgresJobStore } from "@samsara/kernel/postgres"
import { PostgresPersonaStore } from "@samsara/personas/postgres"
import { PostgresMentionStore } from "@samsara/refine/postgres"
import { createApp } from "./app.js"
import { devVerifier, supabaseVerifier, type Verifier } from "./auth.js"
import { githubDispatcher, noopDispatcher } from "./dispatch.js"
import type { Env } from "./env.js"
import { required } from "./env.js"

/**
 * This module exports **only** the default handler, and that is a runtime rule
 * rather than a style preference: workerd refuses to start if the entrypoint module
 * has a named export that is not a handler or a Durable Object class
 * (`Incorrect type for map entry 'PACKAGE': the provided value is not of type
 * 'function or ExportedHandler'`). The P0.1 convention of "every package exports its
 * own name" does not apply here, because this is an entrypoint, not a library.
 * Tests import `./app.js` and the other modules directly.
 */

/**
 * One app per isolate, built lazily on the first request.
 *
 * Cloudflare reuses an isolate across many requests, so anything built here is
 * paid for once rather than per invocation — which matters more than usual against
 * a 10 ms CPU ceiling. What must *not* be hoisted is the database connection:
 * Hyperdrive hands out a pooled connection per request, and holding one across
 * requests in a long-lived isolate is how a pool gets exhausted by an API that
 * looks idle.
 */
let app: ReturnType<typeof createApp> | undefined
let verifier: Verifier | undefined

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!app) {
      app = createApp({
        jobs: (bindings) => {
          const e = bindings as Env
          return new PostgresJobStore(createDb(e.HYPERDRIVE.connectionString, { max: 1 }).db)
        },
        // The Lab's five stores over one connection. Same per-request rule as
        // `jobs` above and for the same reason: Hyperdrive hands out a pooled
        // connection per request, and holding one across requests in a long-lived
        // isolate is how a pool is exhausted by an API that looks idle.
        lab: {
          stores: (bindings) => {
            const e = bindings as Env
            const { db } = createDb(e.HYPERDRIVE.connectionString, { max: 1 })
            return {
              personas: new PostgresPersonaStore(db),
              runs: new PostgresHarvestRunStore(db),
              items: new PostgresRawItemStore(db),
              experiments: new PostgresDriftExperimentStore(db),
              // The read side only. `PostgresMentionSink` is not built here:
              // the worker writes mentions, the API must never be able to.
              mentions: new PostgresMentionStore(db),
            }
          },
        },
        // The Place Postcard grid (P2.7). Its own connection, per request, for
        // the same Hyperdrive reason as the two above.
        places: {
          reader: (bindings) => {
            const e = bindings as Env
            return new PostgresPlaceReader(createDb(e.HYPERDRIVE.connectionString, { max: 1 }).db)
          },
        },
        // Built on first use, not at boot. `/health` is unauthenticated and must
        // answer on a machine with no Supabase project configured — otherwise the
        // first thing a new contributor sees is an auth error from a route that
        // does not authenticate. An authenticated request still fails fast, with
        // `SUPABASE_URL is not set` and nothing vaguer.
        verifier: {
          verify: (token) => {
            // `.dev.vars` is read by `wrangler dev` and never uploaded by
            // `wrangler deploy`, so this branch cannot exist in production unless
            // somebody puts the variable there deliberately. Written as a presence
            // check rather than "no SUPABASE_URL, so allow" precisely so that a
            // deployment missing a secret falls through to the line below and
            // refuses every request instead of accepting every request.
            if (env.DEV_OWNER_ID) return devVerifier(env.DEV_OWNER_ID).verify(token)
            verifier ??= supabaseVerifier(required(env, "SUPABASE_URL"))
            return verifier.verify(token)
          },
        },
        dispatcher:
          env.GITHUB_TOKEN && env.GITHUB_REPOSITORY
            ? githubDispatcher({
                token: env.GITHUB_TOKEN,
                repository: env.GITHUB_REPOSITORY,
                workflow: env.GITHUB_WORKFLOW ?? "worker.yml",
                ref: env.GITHUB_REF ?? "main",
              })
            : noopDispatcher,
      })
    }
    return app.fetch(request, env, ctx)
  },
}
