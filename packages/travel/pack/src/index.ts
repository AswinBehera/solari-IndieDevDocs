// @dt/travel-pack — The travel domain pack: Place schema, prompts, resolver, dedup, scoring, queries.
// Scaffolded by P0.1. P2.2 added the mention schema, the extraction prompt and the pack
// object itself; P2.3 added the entity, ADR-0017's tiers and the pack factory that wires
// them. Dedup keys and the scorer land with P2.4 and P2.5.

export * from "./entity.js"
export * from "./mention.js"
export * from "./pack.js"
export * from "./prompt.js"
export * from "./resolve.js"
export * from "./tier0.js"

export const PACKAGE = "@dt/travel-pack" as const
