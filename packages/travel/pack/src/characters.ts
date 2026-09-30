/**
 * The Bangkok characters: preset personas a traveller starts from.
 *
 * A character is a persona with a life: where they live, what they care about,
 * where they read. The engine stores all of it as opaque `traits`; this file is
 * where travel gives those traits meaning. Each preset exists because it sees a
 * different Bangkok. An auntie in Yaowarat and a promoter in Thonglor, both asking
 * in Thai, get back different cities, and the tourist, asking in English, is the
 * control that shows what the others are worth.
 *
 * **Egress is Singapore for every Thai character.** Solari has no Thai exit, and
 * ADR-0015 found the language, locale and clock carry more weight than the IP.
 * The builder says so rather than implying a Thai address.
 */

export interface CharacterPreset {
  archetype: string
  name: string
  title: string
  bio: string
  locality: string
  country: string
  locale: string
  timezoneId: string
  interests: readonly string[]
  sources: readonly string[]
  colour: string
  prop: CharacterProp
}

export const CHARACTER_PROPS = [
  "ladle",
  "laptop",
  "camera",
  "umbrella",
  "headphones",
  "tag",
  "map",
] as const
export type CharacterProp = (typeof CHARACTER_PROPS)[number]

export const CHARACTER_COLOURS = [
  "#ff6b5b",
  "#ffc83d",
  "#ff8bd1",
  "#22c993",
  "#7b8cff",
  "#2ec4f1",
  "#bdb6a6",
] as const

export const CHARACTER_PRESETS: readonly CharacterPreset[] = [
  {
    archetype: "street-food-auntie",
    name: "Auntie Noi",
    title: "Street-food auntie",
    bio: "Has eaten on the same Yaowarat corner for thirty years. Knows which stall moved and why.",
    locality: "Yaowarat, Bangkok",
    country: "sg",
    locale: "th-TH",
    timezoneId: "Asia/Bangkok",
    interests: ["street food", "noodles", "markets", "local favourites"],
    sources: ["youtube.search", "pantip.forum"],
    colour: "#ff6b5b",
    prop: "ladle",
  },
  {
    archetype: "ari-office-worker",
    name: "Ton",
    title: "Office worker in Ari",
    bio: "Works in Phaya Thai, lives on coffee and a lunch hour. Tries every new café the week it opens.",
    locality: "Ari, Bangkok",
    country: "sg",
    locale: "th-TH",
    timezoneId: "Asia/Bangkok",
    interests: ["coffee", "breakfast", "craft beer", "hidden gems"],
    sources: ["youtube.search", "maps.search"],
    colour: "#ffc83d",
    prop: "laptop",
  },
  {
    archetype: "siam-student",
    name: "Fah",
    title: "Student near Siam",
    bio: "Second year at Chula. Desserts, thrift finds and wherever the photos come out best.",
    locality: "Siam, Bangkok",
    country: "sg",
    locale: "th-TH",
    timezoneId: "Asia/Bangkok",
    interests: ["desserts", "vintage", "photo spots", "night markets", "budget"],
    sources: ["youtube.search", "pantip.forum"],
    colour: "#ff8bd1",
    prop: "camera",
  },
  {
    archetype: "thonburi-uncle",
    name: "Lung Chai",
    title: "Temple-going uncle",
    bio: "Thonburi born, makes merit on Buddhist holy days, takes the river boat everywhere and has opinions about massage.",
    locality: "Thonburi, Bangkok",
    country: "sg",
    locale: "th-TH",
    timezoneId: "Asia/Bangkok",
    interests: ["temples", "old town", "river & canals", "massage"],
    sources: ["pantip.forum", "youtube.search"],
    colour: "#22c993",
    prop: "umbrella",
  },
  {
    archetype: "thonglor-promoter",
    name: "Mint",
    title: "Nightlife promoter",
    bio: "Runs guest lists on Sukhumvit 55. Sleeps till noon, knows which rooftop is over.",
    locality: "Thonglor, Bangkok",
    country: "sg",
    locale: "th-TH",
    timezoneId: "Asia/Bangkok",
    interests: ["rooftop bars", "cocktail bars", "live music", "nightlife"],
    sources: ["youtube.search", "maps.search"],
    colour: "#7b8cff",
    prop: "headphones",
  },
  {
    archetype: "deal-hunter",
    name: "Beam",
    title: "Deal hunter",
    bio: "Never books without a code. Reads the Pantip threads where people post this week's hotel discounts.",
    locality: "Bang Na, Bangkok",
    country: "sg",
    locale: "th-TH",
    timezoneId: "Asia/Bangkok",
    interests: ["deals", "budget", "splurge"],
    sources: ["pantip.forum", "youtube.search"],
    colour: "#2ec4f1",
    prop: "tag",
  },
  {
    archetype: "tourist-control",
    name: "Sam from Sydney",
    title: "First-time tourist",
    bio: "The control. Asks in English from an Australian browser: what every visitor already sees.",
    locality: "Sydney",
    country: "au",
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    interests: ["food", "temples", "markets", "nightlife"],
    sources: ["youtube.search"],
    colour: "#bdb6a6",
    prop: "map",
  },
]

/**
 * Sources a character may be sent to, with what a traveller needs to know about
 * each. TikTok is listed and off: logged out, it serves a shell with no posts
 * (STATUS, P1.6), so it needs a signed-in profile before it is worth a minute.
 */
export const CHARACTER_SOURCES: readonly {
  id: string
  label: string
  note: string
  ready: boolean
}[] = [
  { id: "youtube.search", label: "YouTube", note: "vlogs and reviews", ready: true },
  { id: "pantip.forum", label: "Pantip", note: "Thailand's forum", ready: true },
  { id: "maps.search", label: "Google Maps", note: "local listings", ready: true },
  { id: "tiktok.search", label: "TikTok", note: "needs a signed-in profile", ready: false },
]
