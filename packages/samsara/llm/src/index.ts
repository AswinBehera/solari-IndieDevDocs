// @samsara/llm — Provider-agnostic interface over OpenRouter (ADR-0012). Engine prompts only.
//
// No vertical vocabulary appears anywhere under packages/samsara/. That is not a
// style preference; `pnpm check:seam` fails the build on it (P0.7). A pack owns
// its prompt text and its schema; this package carries them without reading them.
//
// The provider SDK is reachable only through `./openrouter.js`, which is exported
// separately so that importing this package does not drag an HTTP client into a
// runtime that has no use for one.

export * from "./compare.js"
export * from "./complete.js"
export * from "./config.js"
export * from "./fake.js"
export * from "./json.js"
export * from "./ports.js"
export * from "./prompt.js"
export * from "./tokens.js"

export const PACKAGE = "@samsara/llm" as const
