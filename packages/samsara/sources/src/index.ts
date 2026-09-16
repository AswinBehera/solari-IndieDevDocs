// @samsara/sources — Source adapters, one folder per source. Per-source, not
// per-domain: one adapter serves every pack that names it, which is only possible
// while it contains no pack's vocabulary.
//
// The interface is in two halves — `capture` spends browser minutes, `parse` does
// not — and that split is a type rather than a convention because iterating a
// parser against stored bytes instead of live sessions is the largest single saving
// available under the budget. See `adapter.ts`.
//
// `./fixture` is a separate entry point, like the kernel's `./node`: it is the only
// file here that touches `node:fs`.

export * from "./adapter.js"
export * from "./counts.js"
export * from "./language.js"
export * from "./maps/index.js"
export * from "./pantip/index.js"
export * from "./redact.js"
export * from "./tiktok/index.js"
export * from "./youtube/index.js"

export const PACKAGE = "@samsara/sources" as const
