/**
 * Getting JSON back out of a model's answer.
 *
 * With `response_format: json_schema` this is `JSON.parse` and nothing else. The
 * file exists for the routes where that is not available — which, under ADR-0012,
 * is the interesting half of the model list: the cheap models are exactly the ones
 * whose structured-output support is partial or absent, and the ADR is explicit
 * that "a cheaper model fails this way more often".
 *
 * Two recoveries, and no more:
 *
 * 1. **Fenced code blocks.** ```` ```json ... ``` ```` is not the model
 *    disobeying, it is the model's chat formatting. Unwrapping it is free.
 * 2. **Prose either side.** "Here is the JSON you asked for: {...}. Let me know
 *    if you need anything else!" Scanning to the first bracket and out to its
 *    balanced partner recovers a complete, valid object.
 *
 * What this deliberately does **not** do is repair malformed JSON — no quote
 * fixing, no trailing-comma stripping, no brace balancing. A truncated or broken
 * object means the model failed the request, and the honest response is to report
 * it (retryable, per ADR-0012) rather than to guess at what it meant to say. A
 * repair layer would turn a measurable failure rate into an unmeasurable one,
 * which matters most in the one place this package is about to be used: choosing
 * a model by how often it gets this right.
 */

export type JsonParse =
  | { ok: true; value: unknown }
  | { ok: false; reason: "empty" | "no-json" | "unbalanced" | "invalid" }

const OPENERS: Record<string, string> = { "{": "}", "[": "]" }

/** Strip a leading ```` ```json ```` fence and its partner, if both are there. */
function unfence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith("```")) return trimmed
  const firstNewline = trimmed.indexOf("\n")
  if (firstNewline === -1) return trimmed
  const closing = trimmed.lastIndexOf("```")
  if (closing <= firstNewline) return trimmed
  return trimmed.slice(firstNewline + 1, closing).trim()
}

/**
 * Index just past the value opening at `start`, or -1 if it never closes.
 *
 * String-aware, because a brace inside a quoted value is not structure — and a
 * naive depth counter gets this wrong on the first item whose name contains one.
 */
function endOfValue(text: string, start: number): number {
  const opener = text[start]
  if (!opener || !(opener in OPENERS)) return -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i] as string
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{" || char === "[") depth++
    else if (char === "}" || char === "]") {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

export function parseJson(text: string): JsonParse {
  const body = unfence(text)
  if (body === "") return { ok: false, reason: "empty" }

  let start = -1
  for (let i = 0; i < body.length; i++) {
    const char = body[i] as string
    if (char in OPENERS) {
      start = i
      break
    }
  }
  if (start === -1) return { ok: false, reason: "no-json" }

  const end = endOfValue(body, start)
  if (end === -1) return { ok: false, reason: "unbalanced" }

  try {
    return { ok: true, value: JSON.parse(body.slice(start, end)) }
  } catch {
    return { ok: false, reason: "invalid" }
  }
}
