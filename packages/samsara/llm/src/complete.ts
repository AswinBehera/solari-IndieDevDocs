import type { MeterId } from "@samsara/core"
import {
  type BudgetGuard,
  classify,
  err,
  type Failure,
  failure,
  type Logger,
  now,
  ok,
  type Result,
  type SpendScope,
  silentLogger,
  withRetry,
} from "@samsara/kernel"
import { z } from "zod"
import { type LlmConfig, type LlmTask, resolveModel, type Sensitivity } from "./config.js"
import { parseJson } from "./json.js"
import type { ChatClient, ChatUsage, ResponseFormat } from "./ports.js"
import type { PromptRef } from "./prompt.js"
import { estimatePromptTokens } from "./tokens.js"

/**
 * `complete(prompt, schema)` — the interface P2.1 exists to provide.
 *
 * Three things are load-bearing here and none of them is the HTTP call.
 *
 * **1. Every attempt meters itself.** The obvious implementation wraps the whole
 * retry loop in `BudgetGuard.spend` and records once. That undercounts exactly
 * when it matters: ADR-0012 requires a schema-invalid response to be *retryable*,
 * so the expensive failure mode of a cheap model is three full round trips that
 * each burn input and output tokens and produce nothing. Metering only the
 * successful attempt would report that model as the cheapest in the comparison
 * while it was quietly spending triple. The recording therefore sits in a
 * `finally` inside the attempt, alongside a fresh pre-check — a retry after a
 * large spend can and should be refused.
 *
 * `spend` is also single-meter by construction and the LLM has two, priced an
 * order of magnitude apart (`@samsara/core`'s `meterId`), so the two-meter
 * check-and-record is written out rather than borrowed.
 *
 * **2. A parse failure is `upstream`, not `internal`.** ADR-0012 says to validate
 * every response against the caller's Zod schema and treat a failure as a
 * retryable error rather than a crash. `upstream` already means "the provider
 * failed: 5xx, connection refused, DNS, malformed response" in the kernel's own
 * taxonomy, and it is one of the two kinds the retry policy retries. The word
 * fits; no new failure kind is needed.
 *
 * **3. A truncated answer is `config`, and is not retried.** `finishReason:
 * "length"` means the JSON was cut mid-object. The identical request will be cut
 * in the identical place, so retrying spends three times the tokens to fail three
 * times. The refusal names `maxOutputTokens`, because raising it — or batching
 * fewer items — is the only thing that fixes it.
 */

export interface Completion<T> {
  value: T
  /** The provider's numbers where it gave them, ours where it did not. */
  usage: ChatUsage
  metered: boolean
  /** What answered, which may differ from what was asked for. */
  model: string
  promptId: string
  promptVersion: string
  promptFingerprint: string
  durationMs: number
  /** 1 on a first-attempt success. Above 1 means earlier attempts spent tokens. */
  attempts: number
}

export interface CompleteOptions {
  task: LlmTask
  /** Attributes the spend to an owner, purpose and run. Straight to the guard. */
  scope?: SpendScope
  /** Values for the prompt's `{{variables}}`. */
  vars?: Readonly<Record<string, string>>
  /** Reserved on the output meter before the call, and a hard cap on the answer. */
  maxOutputTokens?: number
  temperature?: number
  /** Defaults to `private`, the restrictive one. See `Sensitivity`. */
  sensitivity?: Sensitivity
  /** Overrides the configured default. A route that rejects `schema` wants `json`. */
  format?: ResponseFormat["kind"]
  /** Which pack's work this is. Logged, never interpreted. */
  domainId?: string
  attempts?: number
  signal?: AbortSignal
}

export interface LlmClientOptions {
  chat: ChatClient
  config: LlmConfig
  budget: BudgetGuard
  logger?: Logger
  /** Injectable for tests; real callers get the defaults. */
  clock?: () => number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

const INPUT: MeterId = "llm.input.tokens"
const OUTPUT: MeterId = "llm.output.tokens"

/**
 * Enough room for a batch of extractions and not enough to run away.
 *
 * PLAN §8 puts ~20 raw items in a call and keeps the mention schema tight ("one
 * supporting quote under 15 words" is described there as already doing budget
 * work), because output tokens dominate the bill. This is the ceiling that makes
 * a prompt which ignores that advice fail loudly instead of expensively.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000

export class LlmClient {
  private readonly chat: ChatClient
  private readonly config: LlmConfig
  private readonly budget: BudgetGuard
  private readonly logger: Logger
  private readonly clock: () => number

  constructor(private readonly opts: LlmClientOptions) {
    this.chat = opts.chat
    this.config = opts.config
    this.budget = opts.budget
    this.logger = opts.logger ?? silentLogger
    this.clock = opts.clock ?? (() => Date.now())
  }

  async complete<T>(
    prompt: PromptRef,
    schema: z.ZodType<T>,
    opts: CompleteOptions,
  ): Promise<Result<Completion<T>, Failure>> {
    const sensitivity = opts.sensitivity ?? "private"
    const routed = resolveModel(this.config, opts.task, sensitivity)
    if (!routed.ok) return routed
    const model = routed.value

    // Rendering throws on a variable mismatch (see `definePrompt`). A caller that
    // built its prompt wrongly has a bug in its own code, not a provider failure,
    // so it is caught here and classified rather than escaping as an exception
    // through a function whose whole contract is that it returns failures.
    let rendered: { system?: string; user: string }
    try {
      rendered = prompt.render(opts.vars)
    } catch (thrown) {
      const cause = thrown instanceof Error ? thrown.message : String(thrown)
      return err(failure("config", "prompt could not be rendered", { cause }))
    }

    const estimatedInput = estimatePromptTokens(rendered)
    const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    const scope = opts.scope ?? {}
    const format = this.formatFor(opts.format ?? this.config.format, schema)

    let attemptsUsed = 0

    const result = await withRetry<Completion<T>>(
      async (attempt) => {
        attemptsUsed = attempt

        // Re-checked per attempt, not once up front: the previous attempt may
        // have been what exhausted the meter.
        const room = await this.checkBoth(estimatedInput, maxOutputTokens, scope)
        if (!room.ok) return room

        const startedAt = this.clock()
        let usage: ChatUsage = { inputTokens: estimatedInput, outputTokens: 0 }
        let metered = false
        let outcome = "failed"
        let kind: Failure["kind"] | null = null
        let answered = model

        try {
          const response = await this.chat.chat({
            model,
            ...(rendered.system === undefined ? {} : { system: rendered.system }),
            user: rendered.user,
            format,
            maxOutputTokens,
            ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
            ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          })

          usage = response.usage
          metered = response.metered
          answered = response.model

          if (response.finishReason === "length") {
            outcome = "invalid"
            kind = "config"
            return err(
              failure(
                "config",
                `model ${answered} hit maxOutputTokens (${maxOutputTokens}) and its answer is ` +
                  "truncated. Raise the cap or send fewer items per call; retrying cuts it again.",
              ),
            )
          }

          const parsed = parseJson(response.text)
          if (!parsed.ok) {
            outcome = "invalid"
            kind = "upstream"
            return err(
              failure("upstream", `model ${answered} returned no usable JSON (${parsed.reason})`),
            )
          }

          const validated = schema.safeParse(parsed.value)
          if (!validated.success) {
            outcome = "invalid"
            kind = "upstream"
            return err(
              failure("upstream", `model ${answered} returned JSON that failed the schema`, {
                // Zod's paths and codes only. An issue's `message` can quote the
                // offending value, and the value is harvested text — which the
                // logging rule (ADR-0014, public Actions log) keeps out of here.
                cause: summariseIssues(validated.error),
              }),
            )
          }

          outcome = "ok"
          return ok({
            value: validated.data,
            usage,
            metered,
            model: answered,
            promptId: prompt.id,
            promptVersion: prompt.version,
            promptFingerprint: prompt.fingerprint,
            durationMs: this.clock() - startedAt,
            attempts: attempt,
          })
        } catch (thrown) {
          const classified = classify(thrown)
          kind = classified.kind
          return err(classified)
        } finally {
          // The tokens are gone whether or not we could read the answer, and a
          // guard that only counts the attempts that worked undercounts precisely
          // when a model is failing.
          await this.budget.record(INPUT, usage.inputTokens, scope)
          await this.budget.record(OUTPUT, usage.outputTokens, scope)
          this.logger.emit({
            at: now(),
            event: "llm.call",
            task: opts.task,
            model: answered,
            promptId: prompt.id,
            promptVersion: prompt.version,
            domainId: opts.domainId ?? null,
            attempt,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            metered,
            durationMs: this.clock() - startedAt,
            outcome,
            kind,
          })
        }
      },
      {
        ...(opts.attempts === undefined ? {} : { attempts: opts.attempts }),
        logger: this.logger,
        // The retry logger's `purpose` is a `SessionPurpose` and no LLM call is a
        // session. `agent` is its default and the honest one of the six.
        purpose: "agent",
        ...(this.opts.sleep === undefined ? {} : { sleep: this.opts.sleep }),
        ...(this.opts.random === undefined ? {} : { random: this.opts.random }),
      },
    )

    if (result.ok) return ok({ ...result.value, attempts: attemptsUsed })
    return result
  }

  /** Both meters, in one refusal. Input first: it is the one an oversized batch trips. */
  private async checkBoth(
    input: number,
    output: number,
    scope: SpendScope,
  ): Promise<Result<void, Failure>> {
    const inputRoom = await this.budget.check(INPUT, input, scope)
    if (!inputRoom.ok) return inputRoom
    return this.budget.check(OUTPUT, output, scope)
  }

  /**
   * Zod schema -> the wire's response format.
   *
   * `target: "draft-2020-12"` because that is what the OpenAI-format `json_schema`
   * block expects, and `io: "output"` because the schema describes what comes
   * back: a field with a Zod default is optional on the way in and always present
   * on the way out, and describing the input shape to the model makes it
   * optional in the one direction where it is not.
   */
  private formatFor(kind: ResponseFormat["kind"], schema: z.ZodType<unknown>): ResponseFormat {
    if (kind === "none") return { kind: "none" }
    if (kind === "json") return { kind: "json" }
    return {
      kind: "schema",
      name: "response",
      schema: z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }),
    }
  }
}

/** `path: code`, joined. No values, no messages. */
const summariseIssues = (error: z.ZodError): string =>
  error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join("; ")
