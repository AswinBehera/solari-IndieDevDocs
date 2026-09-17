import type { ChatClient, ChatRequest, ChatResponse } from "./ports.js"
import { estimatePromptTokens, estimateTokens } from "./tokens.js"

/**
 * A `ChatClient` that answers from a script.
 *
 * This is the reason `ports.ts` exists. Every behaviour worth asserting about
 * `complete` — a schema-invalid answer that retries and then succeeds, a
 * truncated answer that does not retry, a provider outage classified as theirs
 * rather than ours, a meter exhausted halfway through a batch — is a property of
 * how this package reacts to a response, and none of them are worth a real call
 * to observe. A test that needs a 500 from OpenRouter to prove the `upstream`
 * path works is a test that will not be written.
 *
 * Replies are consumed in order. Running out is an error rather than a repeat of
 * the last one: a test that makes more calls than it scripted has found something
 * the author did not mean, and the loudest place to say so is here.
 *
 * A single function may be passed instead of an array, and then it answers every
 * call. That is not a softening of the rule above — it is the case where the rule
 * cannot be stated. `@samsara/refine`'s extract stage splits a failed batch in
 * half and halves again, so the number of calls it makes is a function of which
 * item was bad; a test scripting that as a list would have to compute the
 * splitting arithmetic in order to describe it, and would then be asserting its
 * own arithmetic rather than the stage's. A responder says "answer whatever you
 * are asked" and lets the test assert the resulting call count afterwards, which
 * is the thing actually worth checking.
 */

export type FakeResponder = (
  req: ChatRequest,
  call: number,
) => string | Partial<ChatResponse> | { throws: unknown }

export type FakeReply = string | Partial<ChatResponse> | { throws: unknown } | FakeResponder

export interface FakeChatClient extends ChatClient {
  /** Every request that was made, in order. Assert on these, not on a transcript. */
  readonly requests: ChatRequest[]
  readonly calls: number
}

const isThrow = (value: unknown): value is { throws: unknown } =>
  typeof value === "object" && value !== null && "throws" in value

export function fakeChatClient(script: readonly FakeReply[] | FakeResponder): FakeChatClient {
  const requests: ChatRequest[] = []
  const responder = typeof script === "function" ? script : undefined
  const replies = responder ? [] : (script as readonly FakeReply[])

  return {
    get requests() {
      return requests
    },
    get calls() {
      return requests.length
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const index = requests.length
      requests.push(req)
      const scripted = responder ?? replies[index]
      if (scripted === undefined) {
        throw new Error(
          `fake chat client was called ${index + 1} times but only ${replies.length} replies were scripted`,
        )
      }

      const resolved = typeof scripted === "function" ? scripted(req, index) : scripted
      if (isThrow(resolved)) throw resolved.throws

      const partial: Partial<ChatResponse> =
        typeof resolved === "string" ? { text: resolved } : resolved
      const text = partial.text ?? ""
      return {
        text,
        usage: partial.usage ?? {
          inputTokens: estimatePromptTokens({
            ...(req.system === undefined ? {} : { system: req.system }),
            user: req.user,
          }),
          outputTokens: estimateTokens(text),
        },
        metered: partial.metered ?? true,
        model: partial.model ?? req.model,
        finishReason: partial.finishReason ?? "stop",
      }
    },
  }
}
