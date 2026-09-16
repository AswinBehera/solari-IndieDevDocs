// @samsara/harvest — Run orchestration: identity x source x query -> RawItem[].
//
// Two halves, built in two tasks. The measurement half (P1.0) is a factorial design
// over viewpoint signals (`matrix.ts`) and the comparison of what each cell
// returned (`overlap.ts`); both are pure and network-free, because the expensive
// part of an experiment is the sessions and none of the arithmetic reading them
// should need one.
//
// The orchestration half (P1.2) is `run.ts`: open a session through a persona's
// viewpoint, let an adapter capture, archive the bytes before parsing them, write
// the items, close the run, and tell the persona what the source thought of it.
// `pace.ts` is the per-source interval, and is honest in its own header about what
// an in-process limiter can and cannot promise across a scheduled runner's exit.
//
// `./overlap` is a separate entry point for the same reason `./postgres` is, in the
// other direction: the comparison arithmetic is pure, and the API has to run it
// inside a Worker that cannot load Playwright. Importing the barrel to get
// `overlapAt` would pull `run.ts` and `@samsara/sources` in with it. `./drift`
// (P1.8) is the same again — it schedules a week of runs and draws the series they
// produce, both of which happen in the Worker and neither of which opens a browser.
//
// `./postgres` is a separate entry point, like the kernel's, so importing this
// package does not drag a database driver into a runtime that cannot load one.

export * from "./drift.js"
export * from "./matrix.js"
export * from "./overlap.js"
export * from "./pace.js"
export * from "./run.js"
export * from "./store.js"

export const PACKAGE = "@samsara/harvest" as const
