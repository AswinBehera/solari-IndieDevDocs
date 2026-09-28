import type { Place } from "@dt/core"
import { placeFixture } from "@dt/core/fixtures"
import type { CardEvidence } from "@dt/ui"

/**
 * Sample Places, at `/lab/places?sample` — the card in every state at once.
 *
 * Written as a stand-in for the API when no `places` row existed anywhere — see
 * the P2.3 write-up: every harvest run in either database belonged to the
 * `atlas` domain. The page reads the API now. This set stays, on its own URL,
 * because it was chosen to put **every card state on the screen at once**, which
 * a real top thirty will rarely do: the 290km-wrong resolution, the missing
 * score, the place with no quote.
 *
 * They are all real Bangkok and Isan places, and the scores are invented. Nothing
 * here is a measurement of anything, which is why it lives in the app beside the
 * page rather than in `@dt/core`'s fixtures.
 */

const at = new Date("2026-09-20T09:00:00.000Z")
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const base = (n: number, over: Partial<Place>): Place => ({
  ...placeFixture,
  id: uuid(n),
  firstSeenAt: at,
  lastSeenAt: at,
  createdAt: at,
  updatedAt: at,
  ...over,
})

export const samplePlaces: readonly Place[] = [
  // Tier 0, strong local signal, two quotes. The case everything else is read against.
  base(40, {
    canonicalName: "Rung Rueang Pork Noodle",
    localName: "ก๋วยเตี๋ยวหมูรุ่งเรือง",
    geo: { lat: 13.7304, lng: 100.5707 },
    externalRef: { source: "artifact", id: "tiktok:7412000000000000001" },
    resolvedTier: 0,
    category: "food",
    tags: ["noodles", "thonglor"],
    evidenceCount: 6,
    scores: {
      local: {
        value: 0.87,
        because: [
          { factor: "mentioned by th personas", contribution: 0.52, evidenceIds: [uuid(90)] },
          { factor: "thai-language evidence", contribution: 0.35, evidenceIds: [uuid(91)] },
        ],
      },
      tourist: {
        value: 0.22,
        because: [{ factor: "appears in en listicles", contribution: 0.22, evidenceIds: [] }],
      },
    },
  }),

  // Tier 1, the case P2.3 measured. Correct, and the card says how it was found.
  base(41, {
    canonicalName: "Wat Sirindhorn Wararam Phu Prao",
    localName: "วัดสิรินธรวรารามภูพร้าว",
    city: "Bangkok",
    geo: { lat: 13.6959, lng: 100.531 },
    externalRef: { source: "osm", id: "way/123456789" },
    resolvedTier: 1,
    category: "temple",
    tags: ["temple"],
    evidenceCount: 1,
    scores: {
      local: {
        value: 0.54,
        because: [{ factor: "thai-language evidence", contribution: 0.54, evidenceIds: [] }],
      },
      tourist: { value: 0.61, because: [] },
    },
  }),

  // The failure the write-up is about: Tier 1 returned a national park 290km away
  // at 0.64 similarity. Nothing rejected it once the extract went nationwide, so
  // the card has to be the thing that shows it.
  base(42, {
    canonicalName: "Phu Pha Man National Park",
    localName: "อุทยานแห่งชาติภูผาม่าน",
    city: "Bangkok",
    geo: { lat: 16.4346, lng: 104.8048 },
    externalRef: { source: "osm", id: "relation/987654" },
    resolvedTier: 1,
    category: "nature",
    tags: ["national park"],
    evidenceCount: 1,
    scores: {
      local: { value: 0.33, because: [] },
      tourist: { value: 0.4, because: [] },
    },
  }),

  // Latin-script sign: no second line to print.
  base(43, {
    canonicalName: "Ruanjan Nam Nao Cafe & Camp",
    localName: "Ruanjan Nam Nao Cafe & Camp",
    geo: { lat: 13.7649, lng: 100.5383 },
    externalRef: { source: "geocoder", id: "loc:2214" },
    resolvedTier: 2,
    category: "drink",
    tags: ["cafe"],
    evidenceCount: 3,
    scores: {
      local: {
        value: 0.46,
        because: [{ factor: "creator reads local", contribution: 0.46, evidenceIds: [] }],
      },
      tourist: { value: 0.51, because: [] },
    },
  }),

  // Unresolved: named in a post, found by no tier. P2.3 measured 45 of 71 like
  // this, mostly markets OSM has never mapped. It still becomes a Place, flagged.
  base(44, {
    canonicalName: "Talat Khu Khot",
    localName: "ตลาดคูคต",
    geo: null,
    externalRef: null,
    resolvedTier: null,
    category: "market",
    tags: ["fresh market"],
    evidenceCount: 2,
    scores: {
      local: {
        value: 0.79,
        because: [{ factor: "mentioned by th personas", contribution: 0.79, evidenceIds: [] }],
      },
      tourist: { value: 0.05, because: [] },
    },
  }),

  // Scored by nothing yet, and no evidence quoted. Both empty states, one card.
  base(45, {
    canonicalName: "Talat Ozone",
    localName: "ตลาดโอโซน",
    geo: { lat: 13.9287, lng: 100.5764 },
    externalRef: { source: "osm", id: "node/55512" },
    resolvedTier: 1,
    category: "market",
    tags: [],
    evidenceCount: 0,
    scores: {},
  }),
]

export const sampleEvidence: Readonly<Record<string, CardEvidence>> = {
  [uuid(40)]: {
    quote: "เส้นเล็กต้มยำแห้ง ร้านนี้คือที่สุดแล้ว ไปกินตั้งแต่สมัยเรียน ตอนนี้ยังคิวยาวเหมือนเดิม",
    sourceId: "tiktok",
    sourceUrl: "https://www.tiktok.com/@example/video/7412000000000000001",
    language: "th",
  },
  [uuid(41)]: {
    quote: "คนไม่เยอะเท่าไหร่ ไปช่วงเย็นแสงสวยมาก",
    sourceId: "youtube",
    sourceUrl: "https://www.youtube.com/watch?v=example",
    language: "th",
  },
  [uuid(43)]: {
    quote: "Quiet on a weekday, good filter coffee, the owner roasts on site.",
    sourceId: "youtube",
    sourceUrl: "https://www.youtube.com/watch?v=example2",
    language: "en",
  },
  [uuid(44)]: {
    quote: "ตลาดคูคตของสดถูกกว่าในเมืองเยอะ แม่ไปทุกเช้า",
    sourceId: "tiktok",
    sourceUrl: "https://www.tiktok.com/@example/video/7412000000000000002",
    language: "th",
  },
}
