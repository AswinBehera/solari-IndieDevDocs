// @samsara/refine — The pipeline (extract/resolve/dedup/score) and the DomainPack contract.
// Scaffolded by P0.1. P0.5 added the registry the worker holds at boot; P2.2 added the
// extract stage and widened the contract as far as that stage needs it. Resolve, dedup
// and score land in P2.3 to P2.5, each with the member of the contract it calls.
//
// `./postgres` is a separate entry point, like the kernel's and harvest's, so
// importing this package does not drag a database driver into a runtime that
// cannot load one — `apps/api` runs inside a Worker, and it is the reader of
// mentions. The barrel keeps the stage, the contract and the in-memory sink,
// all of which are pure.

export * from "./extract.js"
export * from "./memory.js"
export * from "./pack.js"
export * from "./ports.js"
export * from "./resolve.js"

export const PACKAGE = "@samsara/refine" as const
