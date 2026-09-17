/**
 * The model provider, as this package needs it — and no more than that.
 *
 * Same move as the kernel's `ports.ts`: everything above this line is testable
 * without a key, without the network, and without spending a token, and a change
 * of gateway is a rewrite of `openrouter.ts` alone. ADR-0012 makes that swap less
 * hypothetical than it sounds — it names "a direct provider key" as the exit if
 * OpenRouter's markup or a rate limit ever costs more than the vendor sprawl it
 * removes.
 *
 * One request shape, one method. There is no streaming here because nothing in
 * this system wants it: extraction is a nightly pipeline (ADR-0012), and a token
 * stream would only be a slower way to arrive at the same JSON.
 */

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
}

/** How a response must be shaped. `none` is the escape hatch, not the default. */
export type ResponseFormat =
  /** `json_schema` with the schema attached. What we want, when the route supports it. */
  | { kind: "schema"; name: string; schema: unknown }
  /** `json_object`. The model is told to emit JSON and nothing checks its shape. */
  | { kind: "json" }
  /** Free text. Validation still happens above; the model is simply not constrained. */
  | { kind: "none" }

export interface ChatRequest {
  model: string
  system?: string
  user: string
  format: ResponseFormat
  /** A hard cap, and also what the output meter is asked to reserve up front. */
  maxOutputTokens: number
  temperature?: number
  signal?: AbortSignal
}

export interface ChatResponse {
  /** The message content, exactly as returned. Parsing and validation live above. */
  text: string
  /**
   * What the provider says it charged us.
   *
   * `metered: false` means the provider returned no usage block and these are our
   * own estimates. The budget guard is fed either way — an unmetered call still
   * spent something, and recording zero because the receipt was missing is how a
   * meter silently stops being a meter — but the distinction survives into the log
   * so that a model comparison never puts a measured number and a guessed one in
   * the same column without saying so.
   */
  usage: ChatUsage
  metered: boolean
  /** The model that actually answered. OpenRouter may route away from what we asked. */
  model: string
  /**
   * `stop`, `length`, `content_filter`, … Normalised only where the provider is
   * inconsistent. `length` is the one the caller must branch on: it means the JSON
   * was cut mid-object and no amount of retrying the same request will help.
   */
  finishReason: string
}

export interface ChatClient {
  chat(req: ChatRequest): Promise<ChatResponse>
}
