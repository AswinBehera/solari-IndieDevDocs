/**
 * One valid fixture per engine entity.
 *
 * Deliberately domain-neutral. The first draft of this file used the travel
 * vertical's vocabulary to make the examples concrete, which would have failed
 * `pnpm check:seam` — correctly, because if the engine's own fixtures need a
 * vertical's words to be legible, the schemas are not actually agnostic. The
 * domain here is a made-up one called `atlas`.
 *
 * Exported rather than inlined in the test so downstream packages can build on
 * these instead of inventing their own shapes.
 */

import type {
  Evidence,
  HarvestRun,
  Mention,
  Observation,
  Persona,
  ProbeTarget,
  RawItem,
  SeedPlan,
  Session,
} from "./index.js"

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const at = new Date("2026-09-11T09:00:00.000Z")
const stamps = { createdAt: at, updatedAt: at }

export const personaFixture: Persona = {
  id: uuid(1),
  name: "nok",
  locality: "Riverside District",
  country: "th",
  locale: "vi-VN",
  tier: "seeded",
  solariProfileId: "prof_nok",
  proxySession: "sticky_nok_01",
  health: "healthy",
  seedPlanId: uuid(2),
  lastAliveAt: at,
  stats: { sessions: 12, minutes: 43.5, blocks: 0 },
  ...stamps,
}

export const seedPlanFixture: SeedPlan = {
  id: uuid(2),
  locality: "Riverside District",
  version: 1,
  steps: [
    { kind: "visit", url: "https://example.co.th/news", dwellSeconds: 40 },
    { kind: "scroll", times: 6 },
    // Non-Latin script on purpose: every downstream stage has to survive it.
    { kind: "search", term: "ของอร่อย" },
  ],
  ...stamps,
}

export const sessionFixture: Session = {
  id: uuid(3),
  purpose: "harvest",
  ownerId: "owner_42",
  domainId: "atlas",
  personaId: uuid(1),
  // Egress and viewpoint deliberately disagree, because that is the normal case
  // and the schema has to make it legible rather than merely possible: the packets
  // leave from `sg`, while the browser claims `vi-VN` on an Indochina clock. An
  // Observation read without both halves is uninterpretable.
  country: "sg",
  locale: "vi-VN",
  timezoneId: "Asia/Ho_Chi_Minh",
  startedAt: at,
  endedAt: at,
  minutes: 3.2,
  outcome: "ok",
  recordingRef: null,
  ...stamps,
}

export const harvestRunFixture: HarvestRun = {
  id: uuid(4),
  domainId: "atlas",
  personaId: uuid(1),
  sourceId: "shortvideo",
  query: "ของอร่อย ใกล้ฉัน",
  startedAt: at,
  endedAt: at,
  outcome: "ok",
  itemCount: 18,
  sessionId: uuid(3),
  ...stamps,
}

export const rawItemFixture: RawItem = {
  id: uuid(5),
  harvestRunId: uuid(4),
  sourceId: "shortvideo",
  rank: 0,
  url: "https://example.com/@someone/video/1234567890",
  title: null,
  text: "อันนี้ดีมาก ราคาไม่แพง",
  languageGuess: "th",
  mediaRefs: ["raw/shortvideo/1234567890/cover.jpg"],
  engagement: { views: 240_000, likes: 18_400, comments: null },
  capturedAt: at,
  rawRef: "raw/shortvideo/1234567890/body.json",
  ...stamps,
}

export const mentionFixture: Mention = {
  id: uuid(6),
  rawItemId: uuid(5),
  domainId: "atlas",
  packVersion: "atlas@0.1.0",
  payload: { name: "ที่ลับ", quote: "อันนี้ดีมาก" },
  entityId: null,
  resolution: "pending",
  confidence: 0.72,
  ...stamps,
}

export const evidenceFixture: Evidence = {
  id: uuid(7),
  domainId: "atlas",
  entityId: uuid(8),
  rawItemId: uuid(5),
  sourceId: "shortvideo",
  sourceUrl: "https://example.com/@someone/video/1234567890",
  personaId: uuid(1),
  language: "th",
  capturedAt: at,
  extract: { name: "ที่ลับ", quote: "อันนี้ดีมาก" },
  rawRef: "raw/shortvideo/1234567890/body.json",
  engagement: { views: 240_000, likes: 18_400, comments: null },
  ...stamps,
}

export const probeTargetFixture: ProbeTarget = {
  id: uuid(9),
  ownerId: "owner_42",
  sourceId: "listings",
  url: "https://example.com/listing/12345",
  parsed: { listingId: "12345", from: "2026-11-02", nights: 2 },
  watch: true,
  cadence: "daily",
  ...stamps,
}

export const observationFixture: Observation = {
  id: uuid(10),
  targetId: uuid(9),
  country: "de",
  personaId: null,
  capturedAt: at,
  payload: { currency: "EUR", total: 148.5 },
  screenshotRef: "probe/9/de/2026-09-11.png",
  sessionId: uuid(3),
  notes: null,
  ...stamps,
}
