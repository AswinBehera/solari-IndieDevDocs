# ADR-0019: The queue port lives in the kernel, and the kernel is split by runtime, not by layer

- **Status:** Accepted
- **Date:** 2026-09-12
- **Decided by:** executor, during P0.5, for the architect to overrule
- **Depends on:** ADR-0004 (Postgres queue), ADR-0014 (Cloudflare + GitHub Actions), ADR-0016 (dispatch and bounded streaming)

## Context

P0.5 had to put the job queue somewhere. Two facts made that harder than it sounds.

The first is that **both apps need it, from opposite ends**. `apps/api` enqueues a job and reads its
events; `apps/worker` claims rows, heartbeats, and finishes them. The obvious home — a package of its
own, `@samsara/queue` — is not available: the plan of record fixed the engine's package count, and adding
one was not the executor's call.

The second is that **the two apps do not run on the same runtime**, and until P0.5 nothing had
noticed. Packages are source-only (an executor decision from P0.1: `exports` points at `./src/*.ts`,
no build step). That is a good decision with a consequence nobody had cashed: when `apps/api` imports
`@samsara/kernel`, the Workers typechecker compiles the kernel's *source*. The kernel's barrel reaches
`process.stdout`, `NodeJS.Timeout`, `node:crypto` and `.unref()`. None of those exist on Workers. The
build broke the first time an app above the kernel ran somewhere other than Node — which is the correct
time for it to break, and later than it feels like it should have.

## Decision

**1. The queue port lives in `@samsara/kernel`, beside the session registry and the budget counters.**

The kernel already owns the two other pieces of durable runtime plumbing the apps share. A queue whose
rows outlive the process is the same kind of thing, and the port/adapter shape is already established
there: the interface is in `jobs.ts`, the real implementation in `stores/postgres.ts`, and a memory
fake in `stores/memory.ts` so that everything above the port tests without a database.

**2. The kernel is subdivided by runtime, exposed as subpath exports.**

```
"."         → src/index.ts        the barrel. Node.
"./node"    → src/log.node.ts     the only thing that touches `process`.
"./jobs"    → src/jobs.ts         types and pure functions. Runtime-free.
"./postgres"→ src/stores/postgres.ts
"./solari"  → src/solari.ts       the only file that imports the provider SDK.
```

`apps/api` imports `./jobs` and `./postgres` and never the barrel. `apps/worker` imports the barrel
and `./node`.

**3. `apps/api` typechecks twice**, because its source and its tests run on different runtimes:
`tsconfig.json` with `@cloudflare/workers-types` over `src` minus tests, `tsconfig.test.json` with
Node's types over the tests alone. A single config would have to lie about one of them.

## Consequences

- **The runtime split is a compile error, not a deploy-time surprise.** Reaching for `process` from a
  Workers-side file fails `pnpm typecheck` in CI. The alternative — a bundler shim or a
  `nodejs_compat` polyfill — would have made it work locally and fail differently in production.
- **`nodejs_compat` stays on** for `apps/api` anyway, because postgres-js needs it. The flag is what
  makes the driver run; the subpath split is what stops it from being an excuse.
- **The kernel stays domain-free.** Nothing here is domain-aware; `@samsara/kernel` still imports no
  `@rd/*` package.
- **A memory fake cannot test the property that matters.** `MemoryJobStore` reproduces ordering, lease
  expiry, and attempt accounting, but it cannot reproduce `FOR UPDATE SKIP LOCKED`, because nothing in
  it is concurrent. So `jobs.pg.test.ts` runs against a real Postgres, gated on `DATABASE_URL`, and
  its headline case runs two `claim()` calls through `Promise.all` and asserts the claimed id sets are
  disjoint. The fake is for speed; the database test is for truth.
- **If the architect wants a tenth package later**, the move is mechanical: `jobs.ts` and the two
  stores already have no kernel-internal imports beyond `result.ts`.

## Alternatives rejected

- **A tenth engine package.** Cleanest on paper; not the executor's call to make.
- **Duplicating the port in each app.** Two interfaces that must stay identical, kept identical by
  hope. The claim SQL is subtle enough that a second copy would be a second set of bugs.
- **Building the packages (a `dist` per package) so the API consumes compiled output.** Would have
  hidden the Node/Workers mismatch rather than fixing it — the compiled output has the same
  `process` reference in it — and reintroduces the stale-dist class of bug P0.1 removed.
