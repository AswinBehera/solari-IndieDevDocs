/**
 * What a traveller says they care about, and what a local would type instead.
 *
 * The app is for English speakers; the content worth finding is written in Thai.
 * "rooftop bars Bangkok" asked in English gets the listicles every tourist gets;
 * "รูฟท็อปบาร์ กรุงเทพ" asked from a `th-TH` browser gets what Bangkok posts about
 * itself (ADR-0015). So each tag carries the search a local would run, written by
 * hand, and a tag nobody wrote a search for is translated by the model at queue
 * time (`persona.explore`), never sent in English.
 *
 * **Pure data and two functions**, so the browser can show the traveller the Thai
 * it is about to ask before anything is queued, and the worker asks exactly that.
 * One list, read by both: onboarding's tags, the character builder's interests,
 * the daily sweep and the explore job.
 */

export type InterestLanguage = "th" | "ja"

export interface InterestTag {
  /** What the traveller sees and the document says. Lower-case English. */
  id: string
  /** The search a local would type, per language. `{city}` is the city in that language. */
  local: Record<InterestLanguage, string>
}

export interface InterestGroup {
  label: string
  tags: readonly InterestTag[]
}

const t = (id: string, th: string, ja: string): InterestTag => ({ id, local: { th, ja } })

export const INTEREST_GROUPS: readonly InterestGroup[] = [
  {
    label: "Eat",
    tags: [
      t("food", "ร้านอาหารอร่อย {city}", "{city} 美味しい店"),
      t("street food", "สตรีทฟู้ด {city} ร้านเด็ด", "{city} 屋台 グルメ"),
      t("noodles", "ก๋วยเตี๋ยวอร่อย {city}", "{city} ラーメン 名店"),
      t("seafood", "ร้านซีฟู้ด {city}", "{city} 海鮮 居酒屋"),
      t("fine dining", "ร้านอาหาร fine dining {city}", "{city} 高級レストラン"),
      t("coffee", "คาเฟ่ {city} ร้านกาแฟ", "{city} カフェ 喫茶店"),
      t("desserts", "ร้านขนมหวาน {city}", "{city} スイーツ"),
      t("breakfast", "อาหารเช้า {city} ร้านเด็ด", "{city} 朝ごはん"),
      t("vegetarian", "ร้านอาหารมังสวิรัติ {city}", "{city} ベジタリアン"),
      t("halal", "ร้านอาหารฮาลาล {city}", "{city} ハラール"),
    ],
  },
  {
    label: "Drink",
    tags: [
      t("rooftop bars", "รูฟท็อปบาร์ {city}", "{city} ルーフトップバー"),
      t("cocktail bars", "บาร์ค็อกเทล {city}", "{city} カクテルバー"),
      t("craft beer", "คราฟต์เบียร์ {city}", "{city} クラフトビール"),
      t("live music", "ร้านดนตรีสด {city}", "{city} ライブハウス"),
      t("nightlife", "ที่เที่ยวกลางคืน {city}", "{city} 夜遊び"),
    ],
  },
  {
    label: "See",
    tags: [
      t("temples", "วัดสวย {city} ไหว้พระ", "{city} 神社 お寺"),
      t("museums", "พิพิธภัณฑ์ {city}", "{city} 博物館"),
      t("art galleries", "แกลเลอรี่ศิลปะ {city}", "{city} ギャラリー"),
      t("old town", "ย่านเก่า {city} เดินเล่น", "{city} 下町 散歩"),
      t("photo spots", "จุดถ่ายรูป {city}", "{city} 映えスポット"),
      t("viewpoints", "จุดชมวิว {city}", "{city} 夜景 スポット"),
    ],
  },
  {
    label: "Shop",
    tags: [
      t("markets", "ตลาด {city} เดินเล่น", "{city} 市場"),
      t("night markets", "ตลาดนัดกลางคืน {city}", "{city} ナイトマーケット"),
      t("vintage", "ร้านมือสอง วินเทจ {city}", "{city} 古着屋"),
      t("local design", "ร้านของดีไซน์ไทย {city}", "{city} 雑貨屋"),
      t("malls", "ห้างสรรพสินค้า {city}", "{city} ショッピングモール"),
    ],
  },
  {
    label: "Do",
    tags: [
      t("massage", "ร้านนวดแผนไทย {city}", "{city} マッサージ"),
      t("muay thai", "ค่ายมวยไทย {city}", "{city} 格闘技ジム"),
      t("cooking class", "คลาสทำอาหารไทย {city}", "{city} 料理教室"),
      t("parks", "สวนสาธารณะ {city}", "{city} 公園"),
      t("nature", "ที่เที่ยวธรรมชาติ ใกล้{city}", "{city} 近郊 自然"),
      t("river & canals", "ล่องเรือ คลอง {city}", "{city} 川 クルーズ"),
      t("day trips", "เที่ยวใกล้{city} ไปเช้าเย็นกลับ", "{city} 日帰り旅行"),
    ],
  },
  {
    label: "Vibe",
    tags: [
      t("hidden gems", "ร้านลับ {city}", "{city} 穴場"),
      t("local favourites", "ร้านเจ้าประจำ คนแถวนี้ {city}", "{city} 地元民 行きつけ"),
      t("budget", "ของถูกและดี {city}", "{city} 安くて美味しい"),
      t("splurge", "ร้านหรู {city}", "{city} ご褒美"),
      t("family", "ที่เที่ยวกับครอบครัว {city}", "{city} 子連れ"),
      t("deals", "โค้ดส่วนลด โรงแรม {city}", "{city} ホテル クーポン"),
    ],
  },
]

const BY_ID = new Map(INTEREST_GROUPS.flatMap((g) => g.tags).map((tag) => [tag.id, tag]))

/** Every tag id, in display order. */
export const INTEREST_IDS: readonly string[] = INTEREST_GROUPS.flatMap((g) =>
  g.tags.map((tag) => tag.id),
)

/** A city's local language and its name in it, or null for a city the pack does not know. */
export function cityLanguage(city: string): { language: InterestLanguage; name: string } | null {
  const lower = city.toLowerCase()
  if (lower.includes("bangkok")) return { language: "th", name: "กรุงเทพ" }
  if (lower.includes("tokyo")) return { language: "ja", name: "東京" }
  return null
}

export const LANGUAGE_NAME: Record<InterestLanguage, string> = { th: "Thai", ja: "Japanese" }

/**
 * The local search for one interest in one city, or null when there is no
 * hand-written one (a free-text interest, or an unknown city). Null is the
 * caller's cue to translate, not to fall back to English.
 */
export function localQuery(interest: string, city: string): string | null {
  const lang = cityLanguage(city)
  const tag = BY_ID.get(interest.trim().toLowerCase())
  if (!lang || !tag) return null
  return tag.local[lang.language].replaceAll("{city}", lang.name)
}

/**
 * The tags a line of prose names, in the order they appear in `INTEREST_IDS`.
 *
 * Onboarding writes the interests into the document as "I care about food,
 * markets and temples.", and the daily sweep reads them back from there. Longest
 * ids first, so "night markets" is not also read as "markets".
 */
export function interestsIn(text: string): string[] {
  let rest = text.toLowerCase()
  const found = new Set<string>()
  for (const id of [...INTEREST_IDS].sort((a, b) => b.length - a.length)) {
    if (rest.includes(id)) {
      found.add(id)
      rest = rest.replaceAll(id, " ")
    }
  }
  return INTEREST_IDS.filter((id) => found.has(id))
}

/**
 * How a persona with `locale` would type `interest` about `city`, before any model.
 *
 * `local` when the locale speaks the city's language and the tag has a hand-written
 * search; `english` when the locale does not (the tourist control asks as a
 * tourist, on purpose); null when it speaks the language but there is no
 * hand-written search, which is the cue to translate. One function so the builder's
 * preview and the worker's outing cannot disagree about what was asked.
 */
export function askAs(
  interest: string,
  city: string,
  locale: string,
): { query: string; how: "local" | "english" } | null {
  const lang = cityLanguage(city)
  const speaks = lang !== null && locale.toLowerCase().startsWith(lang.language)
  if (!speaks) return { query: `${interest.trim()} ${city.trim()}`, how: "english" }
  const local = localQuery(interest, city)
  return local ? { query: local, how: "local" } : null
}
