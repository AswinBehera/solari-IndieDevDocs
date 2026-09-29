/**
 * The page judge (Jev, TypeSafe's System One model): three narrow yes/no questions
 * about a rendered stay page, answered in one parallel call.
 *
 * It returns *probabilities from a fixed schema*, never text, so it cannot invent a
 * price: the figure still comes from the page. What it replaces is the brittle part,
 * deciding what kind of page this is, where a regex over English phrases fails on a
 * Japanese or German wall. It is an *upgrade with a fallback*, never a dependency:
 * any failure, timeout or low-confidence answer returns null and the regex stands, so
 * a provider outage cannot break a probe or the demo.
 */
export interface PageVerdict {
  /** P(the page is a bot wall, captcha or access block). */
  wall: number
  /** P(the page is a single property's page, not a list, search or error). */
  property: number
  /** P(the scan's candidate figure is a price for one stay); ~0 when there is none. */
  priceVisible: number
}

export type PageJudge = (page: {
  title: string
  text: string
  /** Text around a figure the text scan read, when it read one. */
  candidate?: string | null
}) => Promise<PageVerdict | null>

const ENDPOINT = "https://api.typesafe.ai/v1/systemone"
const TIMEOUT_MS = 8_000
/** Text sent per page. Tokens are metered; the top of a page carries the verdict. */
const MAX_TEXT = 3_000

const QUESTIONS = {
  wall: {
    type: "noul",
    instructions:
      "Is this page a bot wall, captcha, access-denied or region block, rather than a real page of the site?",
  },
  property: {
    type: "noul",
    instructions:
      "Is this the page of one specific accommodation property, rather than a search list, city page or error page?",
  },
  price_visible: {
    type: "noul",
    instructions:
      "The candidate field is text around a number read from this page. Is that number a price for staying at this property on specific dates, rather than a calendar day, filter bound, review score or sample figure? If candidate is empty, answer no.",
  },
} as const

export function createJevJudge(apiKey: string, fetchImpl: typeof fetch = fetch): PageJudge {
  return async ({ title, text, candidate = null }) => {
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          state: { title, text: text.slice(0, MAX_TEXT), candidate: candidate ?? "" },
          model: "jev-latest",
          questions: QUESTIONS,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) return null
      const body = (await res.json()) as {
        answers?: Record<string, { noul?: unknown }>
      }
      const p = (k: string) => {
        const v = body.answers?.[k]?.noul
        return typeof v === "number" && v >= 0 && v <= 1 ? v : null
      }
      const wall = p("wall")
      const property = p("property")
      const priceVisible = p("price_visible")
      if (wall === null || property === null || priceVisible === null) return null
      return { wall, property, priceVisible }
    } catch {
      return null
    }
  }
}

/** Above this the judge's word overrides the regex; between the two the regex decides. */
export const JUDGE_SURE = 0.85
