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
 * Two principles, and the order they appear in is the order they run in.
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
]

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
