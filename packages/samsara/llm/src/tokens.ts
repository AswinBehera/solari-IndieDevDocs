/**
 * How many tokens a string is *about* to cost, for the budget check that happens
 * before the call.
 *
 * The guard's own note (kernel `budget.ts`) says that where a cost is knowable up
 * front — tokens, geocoding calls — it should be passed as `requested` so the
 * refusal is exact rather than one-operation-late. Tokens are only knowable up
 * front if somebody estimates them, and the estimate is this file.
 *
 * **The usual "characters ÷ 4" rule is wrong for the text this system actually
 * harvests, and wrong in the dangerous direction.** That ratio comes from English
 * prose in a BPE vocabulary. Scripts that the tokenizer has little merged
 * vocabulary for — Thai, and unsegmented scripts generally — land closer to one
 * token per character, and often worse once the bytes are split. Feeding a 4:1
 * estimate into a pre-check on native-language harvested content would wave
 * through roughly four times the input it believed it was approving, which is the
 * precise failure the pre-check exists to prevent, arriving silently.
 *
 * So the estimate splits on the only signal available without a tokenizer: ASCII
 * at 4 characters per token, everything else at 1. That over-estimates Latin-1
 * accents and is roughly right for CJK and Thai. It is a **floor for safety, not
 * an accounting figure** — the number recorded on the meter after the call is the
 * provider's own, whenever the provider gives us one.
 *
 * Shipping a real tokenizer instead would mean a per-model vocabulary download,
 * and under ADR-0012 the model is an env var that can change between two runs.
 * A dependency that must be right about a value chosen elsewhere is a dependency
 * that will be wrong.
 */

/** Rough, deliberately pessimistic, and never used to bill anything. */
export function estimateTokens(text: string): number {
  let ascii = 0
  let wide = 0
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 128) ascii++
    else wide++
  }
  return Math.ceil(ascii / 4) + wide
}

export const estimatePromptTokens = (prompt: { system?: string; user: string }): number =>
  estimateTokens(prompt.system ?? "") + estimateTokens(prompt.user)
