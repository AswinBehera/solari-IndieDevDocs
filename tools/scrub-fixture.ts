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
 * It walks **every string in the parsed capture**, not just the fields the adapter
 * scrubs. That is deliberately a superset: the adapter scrubs at the point where it
 * knows which fields hold page bytes, and this runs afterwards with no such
 * knowledge, so the safe reading of "no knowledge" is "assume any of it could hold
 * something". Parsing first also matters — running the patterns over the raw file
 * misses a key inside the state blob, because there the JSON is a *string* and its
 * quotes are backslash-escaped, which is exactly how the first attempt at this left
 * a session cookie in place.
 *
 * Usage:
 *   npx tsx tools/scrub-fixture.ts <path-to.capture.json>
 */
import { readFileSync, writeFileSync } from "node:fs"
import { SHAPE_REDACTIONS as MAPS_RULES } from "../packages/samsara/sources/src/maps/capture.js"
import { SHAPE_REDACTIONS as PANTIP_RULES } from "../packages/samsara/sources/src/pantip/capture.js"

/**
 * Keyed by the folder the fixture sits in, because that is the only thing about the
 * file this script can read without parsing it. A source missing from here is a
 * source whose fixtures this tool will refuse rather than scrub with the wrong list.
 */
const RULES: Record<string, ReadonlyArray<readonly [RegExp, string]>> = {
  pantip: PANTIP_RULES,
  maps: MAPS_RULES,
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
if (!rules) {
  console.error(`no redaction list for source folder "${source}"; one of ${Object.keys(RULES)}`)
  process.exit(2)
}

let changed = 0
const walk = (value: unknown): unknown => {
  if (typeof value === "string") {
    let out = value
    for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement)
    if (out !== value) changed += 1
    return out
  }
  if (Array.isArray(value)) return value.map(walk)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
  }
  return value
}

const before = readFileSync(path, "utf8")
const after = `${JSON.stringify(walk(JSON.parse(before)), null, 2)}\n`
writeFileSync(path, after)
console.log(`  ${path}`)
console.log(`  ${changed} string(s) changed, ${before.length} -> ${after.length} bytes`)
