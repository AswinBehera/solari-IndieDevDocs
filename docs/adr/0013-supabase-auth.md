# ADR-0013: Supabase Auth, not Clerk

- **Status:** Accepted
- **Date:** 2026-09-11
- **Decided by:** Aswin (architect)
- **Answers:** section 10, question 3
- **Related:** ADR-0005 (Postgres on Supabase with Drizzle)

## Context

ADR-0005 already put Postgres and object storage on Supabase. That left auth genuinely open,
because Clerk is the better auth product in isolation: nicer components, better session handling,
organisations and invitations out of the box.

The question was never which auth product is better on its own. It was whether a second vendor
earns its place in a demo that has a hard $20 ceiling, one month of runway, and a service layer
whose entire value proposition is that it does not know what a user is.

## Decision

**Supabase Auth.** The JWT it issues is verified by `apps/api`'s middleware, and the `sub` claim
is the user id everywhere above the kernel.

Every owned row (documents, blocks, jobs) keys on that id rather than generating its own. One
identity, one lifetime, no join table reconciling two id spaces.

## Consequences

- **`apps/api` verifies a JWT; it does not call an auth service per request.** Signature check
  against the project's JWKS, then `sub` becomes `ownerId`. No network hop on the hot path, and
  nothing to pay for per monthly active user.
- **`ownerId` stays an opaque string to the engine** — exactly as `Session.ownerId` and
  `Job.ownerId` already declare. The kernel does not learn that Supabase exists, and this decision
  therefore touches nothing under `packages/samsara/`.
- **Row Level Security becomes available and is deliberately not used in v1.** All database access
  goes through `apps/api` and `apps/worker` with a service role; the worker writes rows on behalf
  of users who are not present, and RLS fights that. Authorisation lives in the API layer, which
  is the only place that has the request's identity anyway. Revisit if the web app ever talks to
  Postgres directly — it does not today and should not start casually.
- **The service role key never reaches the browser.** `apps/web` gets the anon key and the project
  URL; `apps/api` and `apps/worker` get the service role key. Mixing these up is the standard way
  to leak a Supabase database, so the two are separate variables in `.env.example` with the
  distinction written down.
- One vendor for auth, Postgres, and object storage means one dashboard, one bill, one status page
  to watch during the demo — and one blast radius if it goes down. Accepted knowingly.
- P0.5's auth middleware is unblocked. Hosting (question 1) still blocks the rest of it.

## Alternatives rejected

- **Clerk.** Better components and a better organisations model, but a second vendor, a second
  bill, and a second id space to reconcile against Supabase Postgres — for a demo whose auth
  requirement is "email in, JWT out". ADR-0005's swap point (Neon + Clerk) stands if Supabase auth
  chafes; nothing in this decision makes that move harder, because the kernel never sees auth.
- **Roll our own sessions.** Cheapest in dollars, most expensive in the one currency this project
  does not have: a month of calendar time, spent on a solved problem that is not the demo.
