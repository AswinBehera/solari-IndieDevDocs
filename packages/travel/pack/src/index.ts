// @dt/travel-pack — The travel domain pack: Place schema, prompts, resolver, dedup, scoring, queries.
// Scaffolded by P0.1. P2.2 added the mention schema, the extraction prompt and the pack
// object itself; P2.3 added the entity, ADR-0017's tiers and the pack factory that wires
// them. P2.4 added the dedup keys; the scorer lands with P2.5.

export * from "./dedup.js"
export * from "./entity.js"
export * from "./mention.js"
export * from "./osm-tags.js"
export * from "./pack.js"
export * from "./prompt.js"
export * from "./resolve.js"
export * from "./scores.js"
export * from "./tier0.js"

export const PACKAGE = "@dt/travel-pack" as const
