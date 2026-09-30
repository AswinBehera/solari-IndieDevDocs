# Design canvas

`Doen Thang.dc.html` is the Claude Design canvas Aswin iterated on with Fable. Open it with
`support.js` alongside it. It is the visual reference for Phases 3 to 6 and the source of truth
for palette, type, and copy tone until `@dt/ui` exists.

Nine screens, in the order they appear in the file:

| Screen | Plan reference |
|---|---|
| Trip Document | Phase 4 (P4.1 to P4.9) |
| Persona Lab | Phase 1 (P1.7) |
| Kernel | Phase 5 (P5.5) |
| Onboarding | Phase 6 (P6.1) |
| Trips Home | Phase 4 |
| Hundred Eyes | Phase 3 (P3.4) |
| Personas | Phase 1 / Phase 5 |
| Plans | Phase 6 (P6.2) |
| Digest Email | Phase 5 (P5.3) |

Tokens read off the canvas, for `@dt/ui`:

| Token | Value |
|---|---|
| Surface | `#F4F1EA` |
| Surface, raised | `#EDE9DF` |
| Ink | `#23242A` |
| Ink, muted | `#5B584F` |
| Ink, faint | `#66625A` (the canvas's `#8A867B` failed AA contrast at label sizes) |
| Rule | `#D9D4C7` |
| Accent, neon pink | `#FF2D95` |
| Accent, midnight blue | `#16204A` |
| Display | Instrument Serif |
| Body | Work Sans (400/500/600) |
| Mono | DM Mono (400/500) |

Note the canvas says `TRAVEL OS` in the top bar and calls the ops screen `/kernel`. That is
deliberate and stays — see ADR-0011. It is product language, not a description of the
architecture.
