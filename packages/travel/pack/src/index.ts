// @dt/travel-pack — The travel domain pack: Place schema, prompts, resolver, dedup, scoring, queries.
// Scaffolded by P0.1. P2.2 added the mention schema, the extraction prompt and the pack
// object itself; the resolver, dedup keys and scorer land with P2.3 to P2.5.

export * from "./mention.js"
export * from "./pack.js"
export * from "./prompt.js"

export const PACKAGE = "@dt/travel-pack" as const
