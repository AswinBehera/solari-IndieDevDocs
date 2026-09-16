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
