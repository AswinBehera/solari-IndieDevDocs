/**
 * The redactions every source shares, because the thing they catch is ours.
 *
 * Each adapter used to carry its own list, on the reasoning that a leak is a
 * property of the site being read. The first `pantip.tag` session disproved that in
 * the most direct way available: the field it leaked was not Pantip's secret, it was
 * **our egress IP address**, handed back to us by the page, doubly base64-encoded,
 * five times over, in a field called `ptData`. Any site can do that. Several of them
 * do it deliberately. So the rules that catch it belong in one file that every
 * adapter imports, and a site-specific list is now only for a site's own shapes —
 * see `maps/capture.ts`, which adds Google's key formats to these.
 *
 * Three principles, and the order they appear in is the order they run in.
 *
 * 1. **Redact what cannot be read.** A long unbroken run of base64 is opaque by
 *    construction, and the only instance of one that has ever been measured in this
 *    project contained our egress address. Catching it does not depend on
 *    recognising what is inside it, which makes this the one rule here that is not a
 *    denylist — and therefore the only one that can catch a first instance. It runs
 *    first so that anything it swallows is gone before a narrower pattern has to be
 *    right about it.
 * 2. **Redact what is recognisable and ours.** Addresses in the clear, tokens, and
 *    the session cookies a page echoes back into its own state. These are a
 *    denylist, they leak by omission, and they are kept because when they do fire
 *    they name what they found.
 * 3. **Redact what identifies a person rather than a place.** An email address or a
 *    phone number in somebody's bio is not evidence about anywhere. It is a way to
 *    reach a stranger who did not agree to be in this repository, and no part of this
 *    pipeline reads it to say anything about a place. Rules 1 and 2 protect us from
 *    a page; this one protects a person from us, which is why it is the only rule
 *    here that fires on data we went out of our way to keep.
 *
 * **Why only the email half of rule 3 is in this list.** A phone number has no shape
 * of its own — it is a run of digits, and a page is made of runs of digits. Measured
 * against the one fixture known to contain a real number: a rule tuned to catch it
 * also matches 273 ten-digit resource ids in the same file, and the prize amount in a
 * challenge description two fields away. So the phone pattern lives in
 * `CONTACT_REDACTIONS` below, which adapters apply to a named prose field and never
 * to a state blob. An email survives that test — two matches in the whole corpus,
 * both of them somebody's actual address — so it runs everywhere.
 *
 * Where a shape has a name attached — a query parameter, a form field, a JSON key —
 * the name is kept and only the value goes. A fixture should still show *that* a
 * token was there; hiding that fact would be redacting the evidence rather than the
 * secret.
 *
 * **What these are allowed to damage.** Adapters apply them to fields a parser
 * reads, so a false positive is not free. Each pattern is written to be implausible
 * in prose — Thai script is outside base64's alphabet and English has spaces, so no
 * sentence reaches 120 unbroken alphabet characters; an address needs its colons or
 * its dots in exactly the right positions. When one fires wrongly the cost is a
 * visible `[redacted-…]` in a file a person is required to read before committing.
 * The failure this replaces was the silent one.
 */
export const BASE_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Rule 1. 120 characters of unbroken base64 alphabet. Measured against a real page
  // before being written down: the blob that carried the egress address was 568.
  [/[A-Za-z0-9+/]{120,}={0,2}/g, "[redacted-opaque]"],
  // Rule 2, starting with the part that is actually about us. An egress address is
  // the one piece of this project's infrastructure that reliably turns up inside
  // somebody else's page.
  [/(?:[0-9A-Fa-f]{1,4}:){3,}[0-9A-Fa-f]{1,4}/g, "[redacted-ip]"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[redacted-ip]"],
  // A JWT, of any issuer. The first TikTok capture carried a live Apple Music one
  // three levels inside every music object; nobody expected it there either.
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer [redacted]"],
  // A token in a query string, whatever it is called.
  [/([?&](?:token|csrf|auth|key|sig|session|sid|uid)=)[^"'&\s<>]+/gi, "$1[redacted]"],
  // The same thing as a hidden input, which is how a form carries one.
  [/(name=["'][^"']*(?:csrf|token)[^"']*["'][^>]*value=["'])[^"']+/gi, "$1[redacted]"],
  // And as a field in a state blob, which is how a server-rendered page hands a
  // visitor their own cookies back. Pantip's was `pantip_visitc`.
  [
    /("[A-Za-z0-9_]*(?:token|session|cookie|visitc|_sid|_uid)[A-Za-z0-9_]*"\s*:\s*")[^"]+/gi,
    "$1[redacted]",
  ],
  // Rule 3. An address is kept whole or not at all: redacting the local part and
  // leaving the domain would still single out a person at a small business, and
  // keeping the domain buys nothing a reader of the fixture needs.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
]

/**
 * Rule 3 in full, for a field that holds prose a person wrote.
 *
 * Applied by name — a review, a post, a comment — through `redactContacts` below,
 * and never to markup or to a state blob, for the reason given above: the phone
 * pattern cannot tell a number from an id, and the only thing that can is knowing
 * which field is being scrubbed. That is knowledge an adapter has and this file does
 * not, so this list is exported rather than merged into `BASE_REDACTIONS`.
 *
 * Two conditions, both set by a false positive rather than by taste.
 *
 * **Nine digits is the floor.** The run that decided it was `10.000.000` — a prize
 * in dong, written with stops, in a challenge description. Eight digits. A mobile
 * number in any country this project reads is nine or more, so the threshold
 * separates them without knowing which locale it is looking at.
 *
 * **And the run has to be written the way a person writes a number**, rather than
 * the way a machine writes an id: a `+`, a leading trunk zero, or a group separator
 * somewhere inside the run. That clause was added after the first `pantip.topic`
 * capture, where the floor alone was not enough — the rule ate the count in
 * `123456789 คห. ถูกลบ`, "N comments deleted", which is page furniture rather than
 * anybody's phone number but was content as far as the redaction could tell. The
 * lookahead is anchored to a digit (`\d{0,13}[\s.-]\d`) so that the space *after* a
 * bare run does not satisfy it, which was the first attempt and silently did nothing.
 *
 * It also fixed two hits nobody had noticed: a bare ten-digit resource id and a Unix
 * timestamp, both of which the floor-only rule would have redacted had either landed
 * in a prose field. Measured after the change: zero hits across every prose string in
 * the committed corpus.
 *
 * What it costs is a number written bare, without separators and not starting with
 * zero. In the locales this project reads, a mobile number starts with a trunk zero
 * or a country code, so the gap is narrow — but it is a gap, and it is the price of
 * not eating counts.
 *
 * Both patterns replace the whole match and use no capture group, which is what lets
 * `redactContacts` apply them to a folded copy and splice the result back by offset.
 */
/** Applies a list of shape redactions. Greedy on purpose — see `BASE_REDACTIONS`. */
export function redactShapes(
  value: string | null,
  rules: ReadonlyArray<readonly [RegExp, string]>,
): string | null {
  if (value === null) return null
  let out = value
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement)
  return out
}

export const CONTACT_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
  [
    /(?<!\d)(?=\+|0|\d{0,13}[\s.-]\d)(?:\+\d{1,3}[\s.-]?)?\d(?:[\s.-]?\d){8,13}(?!\d)/g,
    "[redacted-phone]",
  ],
]

/**
 * One UTF-16 unit per code point, folded toward ASCII where the fold is exact.
 *
 * Written because the first run of rule 3 over a real corpus missed an address that
 * was plainly an address: `𝐲𝐭𝐚𝐝𝐨𝐚𝐧.𝐛𝐨𝐨𝐤𝐢𝐧𝐠@𝐠𝐦𝐚𝐢𝐥.𝐜𝐨𝐦`, in Mathematical Bold, in a bio
 * that also contained an envelope emoji so nobody could miss the intent. `[A-Za-z]`
 * does not match U+1D400, and the rule reported success. It is the same failure as
 * the avatar paths: the guard covered a representation, and the subject had another.
 *
 * NFKC per code point rather than over the whole string, because the replacement has
 * to land in the *original* — folding the string and keeping it would rewrite what
 * somebody wrote, which is editing evidence to make a test pass. Per code point, the
 * fold is index-aligned, so a match found at offset n in the folded copy is at code
 * point n in the original.
 *
 * A code point whose fold is not exactly one UTF-16 unit — a ligature that expands,
 * an emoji that does not fold at all — becomes U+FFFF, which no pattern here can
 * match. That is a deliberate blind spot in exchange for the alignment, and it is
 * asserted in `redact.test.ts` rather than left to be discovered.
 */
const foldForDetection = (points: readonly string[]): string =>
  points
    .map((ch) => {
      const folded = ch.normalize("NFKC")
      return folded.length === 1 ? folded : "\uFFFF"
    })
    .join("")

/**
 * A prose field: the adapter's own shape rules, then the contact rules over a fold.
 *
 * **What this still cannot see.** A phone number written `0844.ll.OO.ll`, with the
 * letter `l` for one and the letter `O` for zero, which is in the corpus today and
 * survives this function. Folding homoglyphs would catch it and would also read
 * `lollipop` as digits, and a rule that turns prose into phone numbers is worse than
 * the leak it prevents. So the limit is stated here and tested there: shape
 * redaction narrows a prose field, it does not clean one. A field that must be clean
 * is a field that must not be collected — see `REDACTED_KEYS` in `tiktok/capture.ts`,
 * where that argument is made against a bio and wins.
 */
export function redactContacts(
  value: string | null,
  rules: ReadonlyArray<readonly [RegExp, string]>,
): string | null {
  const base = redactShapes(value, rules)
  if (base === null) return null
  const points = [...base]
  const folded = foldForDetection(points)
  const hits: { start: number; end: number; with: string }[] = []
  for (const [pattern, replacement] of CONTACT_SHAPES) {
    for (const match of folded.matchAll(pattern)) {
      const start = match.index
      const end = start + match[0].length
      // First rule to claim a span keeps it. Email runs before phone, so an address
      // with digits in the local part is redacted once and as an address.
      if (hits.some((hit) => start < hit.end && hit.start < end)) continue
      hits.push({ start, end, with: replacement })
    }
  }
  if (hits.length === 0) return base
  hits.sort((a, b) => a.start - b.start)
  let out = ""
  let cursor = 0
  for (const hit of hits) {
    out += points.slice(cursor, hit.start).join("") + hit.with
    cursor = hit.end
  }
  return out + points.slice(cursor).join("")
}
