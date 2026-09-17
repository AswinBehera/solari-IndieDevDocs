// @samsara/refine — The pipeline (extract/resolve/dedup/score) and the DomainPack contract.
// Scaffolded by P0.1. P0.5 added the registry the worker holds at boot; P2.2 added the
// extract stage and widened the contract as far as that stage needs it. Resolve, dedup
// and score land in P2.3 to P2.5, each with the member of the contract it calls.

export * from "./extract.js"
export * from "./memory.js"
export * from "./pack.js"
export * from "./ports.js"

export const PACKAGE = "@samsara/refine" as const
