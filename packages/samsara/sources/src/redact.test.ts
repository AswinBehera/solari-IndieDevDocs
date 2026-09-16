import { describe, expect, it } from "vitest"
import { BASE_REDACTIONS, redactShapes } from "./redact.js"

const scrub = (value: string): string => redactShapes(value, BASE_REDACTIONS) ?? ""

/**
 * The address that started this.
 *
 * Not the real one — this is a public repository and writing the egress address into
 * a test to prove the egress address gets redacted would be a joke at our own
 * expense. It is the same *shape*: eight groups, a long run, the thing the pattern
 * has to see.
 */
const EGRESS = "2001:db8:1234:5678:9abc:def0:1234:5678"

/** Exactly how Pantip carried it: JSON, base64, base64 again. */
const doubled = (payload: string): string =>
  Buffer.from(Buffer.from(payload).toString("base64")).toString("base64")

describe("the opaque rule", () => {
  it("redacts a long base64 run without knowing what is inside it", () => {
    // The whole argument for this rule in one assertion. Nothing here matches an IP
    // pattern, a token pattern or any other name: it is unreadable, and unreadable is
    // the reason to remove it rather than the reason to keep it.
    const blob = doubled(JSON.stringify({ ipa: EGRESS, ipv6: EGRESS, mid: "x" }))
    expect(blob.length).toBeGreaterThan(120)
    const out = scrub(`{"ptData":"${blob}"}`)
    expect(out).toBe('{"ptData":"[redacted-opaque]"}')
    expect(out).not.toContain("2001:db8")
  })

  it("is what catches an address no other rule can see", () => {
    // Decoded, the blob is caught by the address rule. Encoded, only rule 1 can
    // reach it — and encoded is how it actually arrived. Both directions asserted,
    // because the failure being prevented is precisely the gap between them. The
    // field list is the one the real `ptData` had.
    const inner = JSON.stringify({ ipa: EGRESS, ipv6: EGRESS, ipx: EGRESS, mid: "", rooms: [] })
    expect(scrub(inner)).toContain("[redacted-ip]")
    const encoded = doubled(inner)
    const withoutOpaqueRule = redactShapes(encoded, BASE_REDACTIONS.slice(1))
    expect(withoutOpaqueRule).toBe(encoded)
    expect(scrub(encoded)).toBe("[redacted-opaque]")
  })

  it("does not reach a blob shorter than the threshold, which is a real gap", () => {
    // Written down because it is the honest limit of rule 1, and a limit nobody has
    // asserted is a limit somebody will later be surprised by. A base64 run under
    // 120 characters survives — roughly 88 bytes of payload — so a *small* opaque
    // field could still carry something. The measured one was 568 characters and the
    // threshold sits where prose cannot reach; lowering it trades this gap for false
    // positives in text the parser reads. That trade has not been made, and the day
    // a short blob is found carrying something, this test is where the argument is.
    const small = doubled(JSON.stringify({ ip: EGRESS }))
    expect(small.length).toBeLessThan(120)
    expect(scrub(small)).toBe(small)
  })

  it("leaves a run short enough to be something a person wrote", () => {
    // 41 characters, taken from a real asset path in the committed Pantip fixture.
    // The threshold is a claim about prose, and a claim about prose deserves a case
    // on the safe side of it as well as one on the other.
    const path = "info/doodle/2026/5d07273900d01f33da0f618c"
    expect(scrub(path)).toBe(path)
  })
})

describe("the address rules", () => {
  it("redacts an address in the clear, v6 and v4", () => {
    expect(scrub(`origin ${EGRESS} ok`)).toBe("origin [redacted-ip] ok")
    expect(scrub("client 203.0.113.7 seen")).toBe("client [redacted-ip] seen")
  })

  it("does not fire on Thai prose, which is the field it is allowed to damage", () => {
    // `scrub` runs over a post's text, and a post's text is what the parser reads.
    // Thai script is outside every alphabet these patterns use, so the rule that
    // makes this list affordable is the one being asserted here.
    const thai = "วันนี้อากาศดีมาก ไปเดินเล่นแถวนี้กัน 2 ชั่วโมง"
    expect(scrub(thai)).toBe(thai)
  })

  it("does not fire on a version number, because a version has three dots and a name", () => {
    // A near miss, written down so the next person does not have to find out whether
    // it was considered. `1.2.3` is short of four groups; `1.2.3.4` is not, and is
    // redacted. That is the accepted false positive, and it is loud rather than
    // silent.
    expect(scrub("typescript 5.9.2")).toBe("typescript 5.9.2")
    expect(scrub("build 1.2.3.4")).toBe("build [redacted-ip]")
  })
})

describe("the named-value rules", () => {
  it("keeps the name and drops the value, for a cookie a page hands back", () => {
    // The fixture's own case. Keeping the key is deliberate: a reader should be able
    // to see that a session cookie was there, which is a different fact from its
    // value and the more useful one.
    const out = scrub('{"cookies":{"pantip_visitc":"tlbc4hisMrV9ZN9QX","pst":""}}')
    expect(out).toContain('"pantip_visitc":"[redacted]"')
    expect(out).not.toContain("tlbc4his")
  })

  it("redacts a token in a query string and in a hidden input", () => {
    expect(scrub("/x?session=abc123&page=2")).toBe("/x?session=[redacted]&page=2")
    expect(scrub('<input name="csrf_token" value="abc123def">')).toContain('value="[redacted]')
  })

  it("redacts a JWT of any issuer", () => {
    const jwt = `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`
    expect(scrub(jwt)).toBe("[redacted-jwt]")
  })
})

describe("the list as a whole", () => {
  it("is idempotent, so a fixture can be re-scrubbed without decaying", () => {
    // `tools/scrub-fixture.ts` exists to run these over bytes that are already on
    // disk, and `fixture.test.ts` asserts a committed file is unchanged by them. Both
    // depend on a second pass being a no-op.
    const once = scrub(`${EGRESS} ${doubled("x".repeat(200))} ?token=aaaaaaaaaaaa`)
    expect(scrub(once)).toBe(once)
  })

  it("passes null through, because an absent field is not an empty one", () => {
    expect(redactShapes(null, BASE_REDACTIONS)).toBeNull()
  })

  it("runs the opaque rule first", () => {
    // Order is load-bearing and cheap to assert. If a narrower rule ran first it
    // would carve a blob into pieces too short for rule 1 to recognise.
    expect(BASE_REDACTIONS[0]?.[1]).toBe("[redacted-opaque]")
  })
})
