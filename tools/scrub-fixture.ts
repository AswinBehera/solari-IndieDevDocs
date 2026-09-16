/**
 * Re-applies a source's shipped redactions to an already-recorded fixture.
 *
 * Written for one job and kept for the next one. The first `pantip.tag` capture came
 * back with the session's own egress IPv6 inside a doubly-base64'd field in the
 * state blob, which `SHAPE_REDACTIONS` did not yet know how to see. Once the rules
 * were fixed there were two ways to get a committable fixture: delete the file and
 * buy a second browser session, or run the corrected rules over the bytes already on
 * disk. They produce the same file, and the entire argument for the fixture
 * mechanism is that re-reading a capture is free where re-opening a session is not.
 *
 * It walks the parsed capture and scrubs **the fields the adapter scrubs**, with the
 * same list, in the same way. Parsing first is what makes that possible, and it
 * matters for a second reason — running the patterns over the raw file misses a key
 * inside the state blob, because there the JSON is a *string* and its quotes are
 * backslash-escaped, which is exactly how the first attempt at this left a session
 * cookie in place.
 *
 * **It used to walk every string, and that was wrong.** The argument for the superset
 * was that this script runs with no knowledge of which fields hold page bytes, so the
 * safe reading of "no knowledge" is "assume any of them do". The reading is not safe.
 * Run over the Maps reviews fixture, the superset redacted five photograph references
 * — 120-character ids that rule 1 cannot tell from an opaque blob, and that the
 * adapter deliberately keeps because they are the harvest. The result would have been
 * a fixture no session could have produced, which is worse than a dirty one: a dirty
 * fixture is caught by the audit tests, and a fixture cleaner than its own adapter
 * silently certifies behaviour the adapter does not have.
 *
 * So the field lists below are a copy of what each adapter passes to its own `scrub`
 * and `scrubProse`, and keeping them in step is a cost this tool is required to pay.
 * A source missing from them is a source this tool refuses.
 *
 * Usage:
 *   npx tsx tools/scrub-fixture.ts <path-to.capture.json>
 */
import { readFileSync, writeFileSync } from "node:fs"
import { SHAPE_REDACTIONS as MAPS_RULES } from "../packages/samsara/sources/src/maps/capture.js"
import { SHAPE_REDACTIONS as PANTIP_RULES } from "../packages/samsara/sources/src/pantip/capture.js"
import { redactContacts, redactShapes } from "../packages/samsara/sources/src/redact.js"
import { REDACTED_KEYS as TIKTOK_KEYS } from "../packages/samsara/sources/src/tiktok/capture.js"
import { REDACTED_KEYS as YOUTUBE_KEYS } from "../packages/samsara/sources/src/youtube/capture.js"

/**
 * Keyed by the folder the fixture sits in, because that is the only thing about the
 * file this script can read without parsing it. A source missing from here is a
 * source whose fixtures this tool will refuse rather than scrub with the wrong list.
 */
const RULES: Record<string, ReadonlyArray<readonly [RegExp, string]>> = {
  pantip: PANTIP_RULES,
  maps: MAPS_RULES,
  // Empty on purpose, and the emptiness is the point. TikTok's adapter applies no
  // shape rule at all — it redacts by key name, which is what `DROPPED_KEYS` below
  // re-runs. That it alone skips `BASE_REDACTIONS` is a real gap, measured at
  // fourteen hits on the current fixture, five of them a version string the address
  // rule mistakes for an address. It is recorded as a question rather than closed
  // here by a tool.
  tiktok: [],
  // Same shape of adapter as TikTok, and the same gap.
  youtube: [],
}

/** The fields each adapter hands to its own `scrub`: markup, and state blobs. */
const SHAPE_FIELDS: Record<string, ReadonlySet<string>> = {
  pantip: new Set(["fragment", "state"]),
  maps: new Set(["fragment", "state"]),
  tiktok: new Set(),
  youtube: new Set(),
}

/**
 * The fields each adapter hands to `scrubProse` instead: text a person wrote.
 *
 * These get the contact rules on top of the shape list. The split is not cosmetic — a
 * phone number is a run of digits and so is a resource id, so the pattern that
 * catches one is only safe where the other cannot appear. See `CONTACT_SHAPES`.
 */
const PROSE_FIELDS: Record<string, ReadonlySet<string>> = {
  pantip: new Set(["excerpt", "text", "title", "pageTitle"]),
  maps: new Set(["text", "ownerReply"]),
  tiktok: new Set(),
  youtube: new Set(),
}

/**
 * Keys the adapter drops outright, for the one adapter that redacts by name.
 *
 * Shape rules cannot express "this field should not exist", and TikTok's redaction is
 * entirely of that kind. Imported from the adapter rather than restated, because a
 * copy of a denylist is a denylist that will be one entry behind.
 */
const DROPPED_KEYS: Record<string, ReadonlySet<string>> = {
  tiktok: TIKTOK_KEYS,
  youtube: YOUTUBE_KEYS,
}

const path = process.argv[2]
if (!path) {
  console.error("usage: npx tsx tools/scrub-fixture.ts <path-to.capture.json>")
  process.exit(2)
}
const source =
  path
    .split("/")
    .filter((p) => p !== "__fixtures__")
    .at(-2) ?? ""
const rules = RULES[source]
const shapeFields = SHAPE_FIELDS[source]
const prose = PROSE_FIELDS[source]
const dropped = DROPPED_KEYS[source] ?? new Set<string>()
if (!rules || !shapeFields || !prose) {
  console.error(`no redaction list for source folder "${source}"; one of ${Object.keys(RULES)}`)
  process.exit(2)
}

let changed = 0
let contacts = 0
let removed = 0
const walk = (value: unknown, key: string | null): unknown => {
  if (typeof value === "string") {
    if (key === null) return value
    const isProse = prose.has(key)
    // Anything the adapter does not scrub, this does not scrub. That is the whole
    // correction described at the top of the file.
    if (!isProse && !shapeFields.has(key)) return value
    const out = (isProse ? redactContacts(value, rules) : redactShapes(value, rules)) ?? value
    if (out !== value) {
      changed += 1
      if (isProse) contacts += 1
    }
    return out
  }
  // An array element inherits its parent's key: a post inside `posts: [...]` is
  // still a post, and losing the name at the bracket is how a field-scoped rule
  // quietly stops applying.
  if (Array.isArray(value)) return value.map((entry) => walk(entry, key))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (dropped.has(k)) {
        removed += 1
        continue
      }
      out[k] = walk(v, k)
    }
    return out
  }
  return value
}

const before = readFileSync(path, "utf8")
const after = `${JSON.stringify(walk(JSON.parse(before), null), null, 2)}\n`
writeFileSync(path, after)
console.log(`  ${path}`)
console.log(`  ${changed} string(s) changed, ${before.length} -> ${after.length} bytes`)
console.log(`  ${contacts} in a prose field, ${removed} key(s) dropped by name`)
