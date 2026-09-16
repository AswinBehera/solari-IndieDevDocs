# QUESTIONS

Executor writes a question here and stops. Architect answers inline under it, then the executor
resumes. Keep answered questions; they are the cheapest archaeology we have.

Format:

```
## Q<n> — <one-line question>  [OPEN | ANSWERED]
**Asked by:** <executor> on <date>, while doing <task id>
**Why it blocks:** <what you cannot do until this is answered>
**Options you see:** <a, b, c — with your lean>

**Answer (architect, <date>):**
```

---

## Q1 — (none yet)

No questions raised. The plan's section 10 lists eight decisions the architect owes before
Phase 0 closes; those live there, not here. This file is for gaps the executor finds while
building.

## Q9 — a contributor's own contact details, in a fixture, in a public repo

Raised 2026-09-14 (Claude Code), during the P1.6.1 audit.

`packages/samsara/sources/src/tiktok/__fixtures__/tiktok-search-vi-VN-2026-09-13.capture.json`
carries two creators' email addresses and one phone number. All three are inside
`signature` — the profile bio — where their authors put them, on public profiles,
for the purpose of being contacted.

This is not the avatar case. An avatar is a photograph and is evidence of nothing;
excluding it costs nothing. `signature` is **content**, it is **read** by the
parser, and the P1.5 commit says in as many words that over-redacting it once
already "destroyed an author's bio". So the rule that fixed the avatars does not
transfer, and `redact.ts`'s own licence — "admissible because nothing reads the two
fields it guards" — explicitly does not cover this one.

Options, none obviously right:

1. **Leave them.** The field is the item; a bio is what its author chose to
   publish; redacting it makes the fixture a worse record of the surface.
2. **Redact contact shapes in `signature` only.** An email and a phone number have
   recognisable shapes. Cost: a denylist on a field that is read, which is the
   trade-off this repo has twice called the wrong one, and a false positive here is
   silent data loss inside the evidence.
3. **Stop storing `signature`.** Cleanest privately, worst as evidence: bio text is
   one of the few strong locality signals a TikTok item carries, and P1.8's overlap
   measurement may want it.

What tips it either way is a question I cannot answer from the code: is the fixture
corpus a **research record** (argues for 1) or an **artifact the demo ships**
(argues for 2 or 3)? And does "public repository" here mean public today, or public
at alpha?

Nothing is blocked. It wants deciding while there are six fixtures rather than
sixty, because the answer is retroactive either way.

### Answered 2026-09-16 — option 3, and the question contained two errors of fact

The architect's ruling: *"Do we really want to use real people? We should be
creating artificial personas based on data, but not the real people. We may not
have permission for that."*

Both premises this question was built on turned out to be wrong, and checking them
is what made the decision easy rather than close.

**"`signature` is read by the parser" was false.** `tiktok/parse.ts` reads
`author.uniqueId` — with `author.unique_id` as a fallback — and nothing else off an
author object. No other file in the repository mentions the field. Across two
captures the bio was collected by us, published by us, and read by nobody. The
sentence in the P1.5 commit was about an intention for the field, and it was
repeated in this question as though it described the code.

**"An email and a phone number have recognisable shapes" was half false.** Shape
redaction was written first and tried on the corpus before this was decided. It
caught two of the four contact details. It missed
`𝐲𝐭𝐚𝐝𝐨𝐚𝐧.𝐛𝐨𝐨𝐤𝐢𝐧𝐠@𝐠𝐦𝐚𝐢𝐥.𝐜𝐨𝐦` — a real address in Mathematical Bold, which `[A-Za-z]`
does not match — and `0844.ll.OO.ll`, a mobile number with the letter `l` for one
and the letter `O` for zero. Both are perfectly legible to the person the author
wanted to be reached by. A bio is prose its author controls, so a pattern that has
to recognise every way a person might write their own phone number is a pattern
that will be wrong quietly and forever. The fold for Unicode compatibility forms
was written anyway and kept, because it is principled and prose fields elsewhere
need it; the homoglyph case is recorded as a stated limit with a test asserting the
miss.

**The asymmetry settles what the premises left open.** An uncollected bio costs one
browser session to collect again — roughly half a minute against a 4,000-minute
ceiling. A stranger's address in a public git history cannot be taken back at any
price. So the field goes, and P1.8 may ask for it back on the record if it turns
out to want a bio as a locality signal.

Done: `signature` is on `REDACTED_KEYS`; the fixture is re-scrubbed and holds no
bio; the two `capture.test.ts` tests that asserted the opposite are inverted with
the reasoning attached rather than deleted; `fixture.test.ts` gained a folded
contact-shape audit; the contact rules landed in `redact.ts` where the prose fields
of Maps and Pantip now use them.

**Not settled, and not this question:** TikTok and YouTube apply no shape rules at
all — they redact by key name only, so neither runs `BASE_REDACTIONS`, and the rule
that caught our own egress address inside Pantip's page would not fire on theirs.
Measured at fourteen hits on the current TikTok fixture, five of which are a
version string the address rule mistakes for an address. That false-positive rate
is why it is a question rather than a commit. Raised as Q10.

## Q10 — two adapters do not run the shared shape rules

Raised 2026-09-16 (Claude Code), out of the Q9 work.

`redact.ts` says the base rules "belong in one file that every adapter imports",
because the egress address Pantip handed back was ours and any site can do that.
Two adapters do not import it. TikTok and YouTube narrow by key name only.

Applying `BASE_REDACTIONS` to the TikTok fixture today fires fourteen times: nine
opaque base64 runs, five addresses. The five are not addresses. They are
`cookieBanner.resource.version` and four bundle paths, where four dotted numbers
mean a version. Rule 2 cannot tell those apart and does not need to — the fix is a
field split like the one Maps and Pantip now have, not a weaker pattern — but that
is a change to two adapters and six fixtures, and it is not what this session was
for.

Nothing is leaking through the gap today; this is about the next capture, not the
recorded ones.
