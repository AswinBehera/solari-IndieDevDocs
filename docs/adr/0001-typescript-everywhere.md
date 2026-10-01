# ADR-0001: TypeScript everywhere

- **Status:** Accepted
- **Date:** 2026-09-11
- **Decided by:** Aswin (architect)

## Context

The system spans a browser app, an HTTP API, a batch worker, and a set of shared schema packages.
Each of those could reasonably be written in a different language, and the parts that do the most
interesting work — driving a headless browser, parsing captured pages — have strong Python
ecosystems.

Solari's primary SDK is TypeScript. The schemas in section 3 are the contract between every layer,
and they are worth writing exactly once.

## Decision

TypeScript in every package, `strict` on, plus `verbatimModuleSyntax`, `exactOptionalPropertyTypes`,
and `noUncheckedIndexedAccess`. Zod schemas are the single source of truth for entity shapes; the
Drizzle tables and the inferred TS types both derive from them rather than restating them.

## Consequences

- One toolchain, one formatter, one test runner. An executor session never context-switches.
- Cost: Python's parsing and data-wrangling libraries are off the table. Accepted — the parsing here
  is DOM-shaped, which is TypeScript's home ground.
- The strict flags are cheap to adopt now and expensive to retrofit. `noUncheckedIndexedAccess` in
  particular will be irritating and will also, reliably, catch a real bug per phase.

## Swap point

None. A change here is a rewrite, not a swap.
