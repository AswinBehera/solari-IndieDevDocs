import { err, type Failure, failure, ok, type Result } from "@samsara/kernel"
import { z } from "zod"
import type { ResponseFormat } from "./ports.js"

/**
 * Tasks, not models (ADR-0012).
 *
 * A closed union for the same reason `SessionPurpose` is one: it is a list of
 * things the *engine* does, and it must not grow a member when a vertical is
 * added. A pack that wants a second kind of extraction gets a second prompt, not
 * a second task.
 */
export const llmTask = z.enum(["extract", "summarise"])
export type LlmTask = z.infer<typeof llmTask>

/**
 * Whether the text being sent is ours to be relaxed about.
 *
 * ADR-0012: free (`:free`) routes on OpenRouter carry data-retention terms that
 * are fine for harvested public content and are not fine for anything derived
 * from a real user's private data, and "the routing config must not quietly send
 * the latter to a free tier". This is that rule, made mechanical.
 *
 * The default is `private`, which is the restrictive one. The high-volume path —
 * extraction over public harvested pages — therefore has to opt in explicitly at
 * its call site, and that one word is a line a reviewer can see. A default of
 * `public` would be more convenient exactly once and would then apply itself to
 * every call written afterwards, including the ones nobody thought about.
 */
export type Sensitivity = "public" | "private"

export interface LlmConfig {
  apiKey: string
  baseUrl: string
  /** Task -> model id. Absent is normal: a model is chosen by measurement, not preference. */
  models: Partial<Record<LlmTask, string>>
  /** Default response format when a caller does not say. Overridable per route. */
  format: ResponseFormat["kind"]
  /** OpenRouter's optional attribution headers. Neither is a secret. */
  appUrl?: string
  appTitle?: string
}

const ENV_MODEL: Record<LlmTask, string> = {
  extract: "LLM_MODEL_EXTRACT",
  summarise: "LLM_MODEL_SUMMARISE",
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

const formatKind = z.enum(["schema", "json", "none"])

/**
 * Read the gateway's configuration, or say precisely what is missing.
 *
 * Throws on a missing key, like `solariCredentials`, and never logs the value:
 * the repository and therefore the Actions log are public (ADR-0014).
 *
 * A missing *model* is not an error here. `LLM_MODEL_EXTRACT` is expected to be
 * empty until the comparison in `compare.ts` has been run against a real prompt,
 * and a default baked in "for now" is exactly how a model nobody chose ends up in
 * production. The refusal happens at the call site instead, where it can name the
 * task and the variable.
 */
export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const apiKey = env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set")

  const models: Partial<Record<LlmTask, string>> = {}
  for (const task of llmTask.options) {
    const value = env[ENV_MODEL[task]]
    if (value) models[task] = value
  }

  const rawFormat = env.LLM_RESPONSE_FORMAT
  const parsedFormat = rawFormat ? formatKind.safeParse(rawFormat) : undefined
  if (parsedFormat && !parsedFormat.success) {
    throw new Error(
      `LLM_RESPONSE_FORMAT must be one of ${formatKind.options.join(", ")}, got ${JSON.stringify(rawFormat)}`,
    )
  }

  return {
    apiKey,
    baseUrl: env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    models,
    format: parsedFormat?.data ?? "schema",
    ...(env.OPENROUTER_APP_URL ? { appUrl: env.OPENROUTER_APP_URL } : {}),
    ...(env.OPENROUTER_APP_TITLE ? { appTitle: env.OPENROUTER_APP_TITLE } : {}),
  }
}

/** OpenRouter's marker for a zero-price route. */
export const isFreeRoute = (model: string): boolean => model.endsWith(":free")

/**
 * Task -> model id, with both refusals spelled out.
 *
 * Both are `config`, which the retry policy does not retry — an unset variable
 * and a disallowed route are equally true on the third attempt.
 */
export function resolveModel(
  config: LlmConfig,
  task: LlmTask,
  sensitivity: Sensitivity,
): Result<string, Failure> {
  const model = config.models[task]
  if (!model) {
    return err(
      failure(
        "config",
        `no model configured for task "${task}": set ${ENV_MODEL[task]}. ` +
          "ADR-0012 chooses it by measurement; see compare.ts.",
      ),
    )
  }
  if (sensitivity === "private" && isFreeRoute(model)) {
    return err(
      failure(
        "config",
        `${ENV_MODEL[task]} is a free route (${model}) and this call carries private data. ` +
          "ADR-0012 forbids it. Route the task to a paid model, or mark the call public.",
      ),
    )
  }
  return ok(model)
}

export { ENV_MODEL }
