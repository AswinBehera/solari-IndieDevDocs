// @samsara/probe — Locale probe: one URL x N countries -> Observation[] (P3.1).
//
// The engine is generic: it never reads an adapter's `parsed` target or `payload`.
// Adapters live with the vertical that needs them, because the seam check bans the
// vocabulary of the sites they read from this side of it.
//
// `./postgres` is a separate entry point, like the kernel's, so importing this
// package does not drag a database driver into a runtime that cannot load one.

export * from "./adapter.js"
export * from "./fx.js"
export * from "./memory.js"
export * from "./run.js"
export * from "./viewpoints.js"

export const PACKAGE = "@samsara/probe" as const
