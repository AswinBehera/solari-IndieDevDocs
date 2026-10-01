# ADR-0005: Postgres on Supabase, with Drizzle

- **Status:** Accepted
- **Date:** 2026-09-11
- **Decided by:** Aswin (architect)

## Context

The system needs a relational database (section 3 is unapologetically relational), object storage
for raw captures and screenshots, and — separately decided in ADR-0013 — auth. Phase 0 is short.

## Decision

Postgres on Supabase. Drizzle ORM with drizzle-kit migrations, schema written in TypeScript and
derived from the Zod enums (ADR-0001). Local development runs Postgres 17 in Docker; Supabase is
the deployment target, not a local dependency.

## Consequences

- Auth, Postgres, and storage from one vendor cuts a day out of Phase 0 and one id space out of the
  system.
- Drizzle keeps the schema in the same language and the same repository as the schemas it mirrors,
  so the two cannot drift silently.
- Migrations are files, reviewed like code. `packages/research/db/migrations/` owns them, because the
  research schema composes the kernel's tables and only one package can own the migration history.
- Cost: Supabase's connection pooler has opinions, and drizzle-kit is young enough that its
  generated SQL is worth reading before applying. Both were true in P0.3 and both were fine.

## Swap point

Neon + Clerk, if Supabase Auth chafes (ADR-0013 has the same swap point). The kernel stays
unaware of either.
