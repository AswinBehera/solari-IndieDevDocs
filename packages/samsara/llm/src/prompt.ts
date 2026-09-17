/**
 * A prompt, as the engine carries it: identified, versioned, and fingerprinted.
 *
 * The engine never writes prompt text. A pack owns its own (PLAN §2.5, §6 seam
 * table: "Any engine prompt file" is on the list of things the vertical may not
 * touch, and the converse holds — engine code may not author a pack's prompt).
 * What crosses the seam is this reference, and the reason it is more than a
 * string is `version`.
 *
 * **`version` is stamped on every Evidence row** (`@samsara/core`'s `mention`
 * carries `packVersion`, and §2.5 says to bump it "when prompts or weights
 * change"). So the failure this file exists to catch is a person editing prompt
 * text and forgetting the bump: every row written afterwards then claims to have
 * come from a prompt that no longer exists, and a golden-set regression becomes
 * unattributable — the rows look identical and are not.
 *
 * A declared version cannot detect that on its own, so `definePrompt` also
 * derives a **fingerprint** from the text. Nothing enforces a bump, because the
 * engine cannot know whether an edit was meaningful. What it can do is make the
 * discrepancy visible: the fingerprint is logged and stored beside the version,
 * and two rows claiming version `3` with different fingerprints are a bug with
 * its own receipt.
 *
 * The hash is FNV-1a, not SHA-256. It is a change detector between two strings we
 * wrote ourselves, not a security boundary, and `node:crypto`'s synchronous
 * `createHash` does not exist on the Workers runtime while `crypto.subtle` is
 * async — an async `definePrompt` would be a strange thing to hand a pack author
 * for no benefit.
 */

/** `{{name}}`, with tolerated inner whitespace. Deliberately not an expression. */
const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

const FNV_OFFSET = 14695981039346656037n
const FNV_PRIME = 1099511628211n
const MASK = 0xffffffffffffffffn

/** 64-bit FNV-1a over UTF-8, as 16 lowercase hex digits. */
export function fingerprint(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let hash = FNV_OFFSET
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK
  }
  return hash.toString(16).padStart(16, "0")
}

export interface RenderedPrompt {
  readonly system?: string
  readonly user: string
}

export interface PromptRef {
  /** Namespaced by its owner, e.g. `travel/extract.mentions`. Opaque to the engine. */
  readonly id: string
  /** The pack's declared version. Bumped by a person; stored with every row. */
  readonly version: string
  /** Derived from the text. Bumped by the text itself, whether or not anyone meant it. */
  readonly fingerprint: string
  readonly system?: string
  readonly template: string
  /** The variable names this prompt expects, in first-appearance order. */
  readonly variables: readonly string[]
  render(vars?: Readonly<Record<string, string>>): RenderedPrompt
}

export interface PromptDefinition {
  id: string
  version: string
  system?: string
  template: string
}

/**
 * Both directions of the variable check throw, and the second one is the useful
 * one.
 *
 * A missing variable is the obvious bug and would be caught by the model
 * returning nonsense about a literal `{{city}}`. An *extra* variable is the quiet
 * one: a caller passing `items` to a prompt that reads `{{item}}` sends a prompt
 * with no data in it, gets back a plausible, confidently empty answer, and spends
 * real tokens on every batch until somebody reads the output closely. Silence is
 * the wrong response to being handed data nobody asked for.
 */
export function definePrompt(def: PromptDefinition): PromptRef {
  if (!def.id) throw new Error("prompt id is required")
  if (!def.version) throw new Error(`prompt ${def.id} has no version`)

  const variables: string[] = []
  for (const match of def.template.matchAll(VARIABLE)) {
    const name = match[1]
    if (name && !variables.includes(name)) variables.push(name)
  }

  const ref: PromptRef = {
    id: def.id,
    version: def.version,
    fingerprint: fingerprint(`${def.system ?? ""}\u0000${def.template}`),
    ...(def.system === undefined ? {} : { system: def.system }),
    template: def.template,
    variables,
    render(vars = {}) {
      const supplied = Object.keys(vars)
      const missing = variables.filter((name) => vars[name] === undefined)
      if (missing.length > 0) {
        throw new Error(`prompt ${def.id} is missing ${missing.join(", ")}`)
      }
      const unused = supplied.filter((name) => !variables.includes(name))
      if (unused.length > 0) {
        throw new Error(`prompt ${def.id} was given ${unused.join(", ")}, which it does not use`)
      }
      const user = def.template.replace(VARIABLE, (_, name: string) => vars[name] ?? "")
      return def.system === undefined ? { user } : { system: def.system, user }
    },
  }
  return ref
}
