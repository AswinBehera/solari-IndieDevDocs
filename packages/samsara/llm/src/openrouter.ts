import OpenAI from "openai"
import type { LlmConfig } from "./config.js"
import type { ChatClient, ChatRequest, ChatResponse } from "./ports.js"
import { estimatePromptTokens, estimateTokens } from "./tokens.js"

/**
 * The only file in this package that imports a provider SDK.
 *
 * Same shape as the kernel's `solari.ts`, and for the same payoff: every test
 * above this line runs without a key and without spending a token, and ADR-0012's
 * stated exit — "a direct provider key, if OpenRouter's markup or a rate limit
 * ever exceeds the cost of the vendor sprawl it removes" — is a rewrite of one
 * file.
 *
 * The client is the `openai` package pointed at OpenRouter's base URL, because
 * OpenRouter speaks the OpenAI wire format (ADR-0012). It is never pointed at
 * OpenAI, and there is no `OPENAI_API_KEY` anywhere in this system.
 */

export function createOpenRouterClient(config: LlmConfig): ChatClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    defaultHeaders: {
      // Optional attribution on openrouter.ai. Neither header is a secret, and
      // both are omitted rather than sent empty when unset.
      ...(config.appUrl ? { "HTTP-Referer": config.appUrl } : {}),
      ...(config.appTitle ? { "X-Title": config.appTitle } : {}),
    },
  })

  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const response = await client.chat.completions.create(
        {
          model: req.model,
          messages: [
            ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
            { role: "user" as const, content: req.user },
          ],
          max_tokens: req.maxOutputTokens,
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          ...responseFormat(req),
        },
        // The abort signal is a request option, not a body field.
        req.signal ? { signal: req.signal } : {},
      )

      const choice = response.choices[0]
      const text = choice?.message?.content ?? ""
      const usage = response.usage

      // A provider that returns no usage block is not a reason to record zero.
      // See `ChatResponse.metered`: the meter is fed from our own estimate and the
      // log says which of the two numbers it is looking at.
      const metered = usage !== undefined && usage !== null
      return {
        text,
        metered,
        usage: metered
          ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
          : {
              inputTokens: estimatePromptTokens({
                ...(req.system === undefined ? {} : { system: req.system }),
                user: req.user,
              }),
              outputTokens: estimateTokens(text),
            },
        // What answered, which OpenRouter may have routed away from what we asked.
        model: response.model || req.model,
        finishReason: choice?.finish_reason ?? "unknown",
      }
    },
  }
}

/**
 * `strict` is deliberately off.
 *
 * Strict structured output requires every property to be required and
 * `additionalProperties: false` throughout, which a Zod schema with an optional
 * field does not produce. Making one conform means rewriting optionals as
 * required-and-nullable — a change to *what the model is asked for*, made behind
 * the caller's back, in a package that must not have opinions about a pack's
 * schema. A non-strict schema is still sent and still steers the model; the
 * guarantee comes from the Zod validation above, which ADR-0012 requires on every
 * response regardless of what the route promised.
 */
function responseFormat(req: ChatRequest) {
  if (req.format.kind === "none") return {}
  if (req.format.kind === "json") return { response_format: { type: "json_object" as const } }
  return {
    response_format: {
      type: "json_schema" as const,
      json_schema: {
        name: req.format.name,
        strict: false,
        schema: req.format.schema as Record<string, unknown>,
      },
    },
  }
}
