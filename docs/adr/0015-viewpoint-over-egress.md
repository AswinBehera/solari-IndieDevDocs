# ADR-0015: A viewpoint is a stack of signals, and the IP is the weakest one

- **Status:** Accepted
- **Date:** 2026-09-11
- **Decided by:** Aswin (architect), on a finding from the first live browser test

## Context

What a page shows depends on who the site thinks is reading it. The egress IP is one signal, and
for most content it is the weakest. The others are the query's language, stored region and language
preferences (cookies), the browser's locale and timezone, and the session's history.

Solari's browser pool covers a fixed set of countries, and `browser.newPage()` returns the pool's
default context, which is `en-US` on UTC whatever the proxy country. Before this ADR, every session
the kernel opened claimed the same locale regardless of where it egressed.

For a Steam store page the signals that matter are the store region (`cc`, which sets the currency
and price), the language cookie (`Steam_Language`), and the age gate (a cookie, answered once). An
IP alone changes little.

## Decision

**Separate the viewpoint from the egress, and make both first-class.**

- `Viewpoint` (`packages/samsara/kernel/src/ports.ts`) carries `locale`, `timezoneId`, and an
  optional `geolocation`. `withBrowser` takes them alongside `country`.
- The kernel builds the browser context itself rather than calling `newPage()`, because the
  provider's page helper accepts no options. It carries the attached profile's `storageState` into
  that context by hand: `newContext()` is documented to open an *empty* one, and losing a stored
  profile that way would be silent.
- **The `sessions` row records both** (`country`, `locale`, `timezone_id`). A
  capture cannot be interpreted without the viewpoint that produced it.
- `session.open` logs both, so a public Actions log carries the provenance too. A BCP 47 tag and an
  IANA zone are drawn from fixed public vocabularies and can hold no secret.
- **No country is ever substituted automatically.** The kernel refuses an unavailable country by
  name; choosing another is the caller's explicit act.
- Validation is strict where it is a tell: the timezone must be an IANA zone, never a `GMT+7`
  offset, because an offset is not what a real browser reports.

## Consequences

- Steam store pages are read with a pinned Solari profile: a cookie jar holding the age gate
  answered and `Steam_Language=english`, read as the `us` store. Each receipt names the profile and
  its version. Changing the jar makes a new profile rather than editing one that receipts already
  cite, and the kernel never re-saves a profile it finds.
- A timezone/IP mismatch is itself a fingerprinting signal, so a viewpoint should stay plausible
  for its egress.
- Cost: more knobs, and knobs that can be set inconsistently. The validation rules and the recorded
  session row are the mitigation: an inconsistent viewpoint is visible in the data rather than
  hidden in a launch call.

## What this does not claim

No arrangement of cookies and locale makes an egress IP something it is not. A surface that gates on
IP geolocation for legal or licensing reasons is reachable only from where the pool has egress, and
where that bites it is reported as a gap, not papered over.
