/**
 * A reviewer's "real" or "wrong" on a place — the Phase 2 gate, counted where it
 * is done.
 *
 * The gate is "quality review of the top 30. If more than a third are wrong
 * (wrong place, closed, hallucinated), fix extract/resolve before Phase 3." That
 * review happens on `/lab/places`, so the page keeps the marks and says whether
 * the gate is passing.
 *
 * **Kept in this browser's storage, not the database**, which is a decision and
 * not an accident: the gate is one person's review, and a table for it would be
 * a schema change for a checklist. P6.6's "thumbs on Place Postcards feed back
 * into scoring" is the version that needs a table, because it is many people and
 * it moves numbers. Storage can fail (private windows, blocked site data), so
 * every read and write here survives it and the page works without it.
 */

export type Verdict = "real" | "wrong"
export type Verdicts = Record<string, Verdict>

const KEY = "dt.lab.places.verdicts"

export function loadVerdicts(storage: Pick<Storage, "getItem"> | null = safeStorage()): Verdicts {
  try {
    const raw = storage?.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    if (!parsed || typeof parsed !== "object") return {}
    const out: Verdicts = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === "real" || v === "wrong") out[id] = v
    }
    return out
  } catch {
    return {}
  }
}

export function saveVerdicts(
  v: Verdicts,
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
) {
  try {
    storage?.setItem(KEY, JSON.stringify(v))
  } catch {
    // A full or blocked store loses the marks on reload, and nothing else.
  }
}

/** Mark, or unmark by choosing the same verdict again. */
export function toggle(v: Verdicts, id: string, verdict: Verdict): Verdicts {
  const next = { ...v }
  if (next[id] === verdict) delete next[id]
  else next[id] = verdict
  return next
}

export interface Tally {
  real: number
  wrong: number
  unmarked: number
}

/** Counted over the places on screen, not over every mark ever made. */
export function tally(v: Verdicts, ids: readonly string[]): Tally {
  let real = 0
  let wrong = 0
  for (const id of ids) {
    if (v[id] === "real") real++
    else if (v[id] === "wrong") wrong++
  }
  return { real, wrong, unmarked: ids.length - real - wrong }
}

/** "4 of 30 wrong · the gate allows 10", or the same line saying it has failed. */
export function gateLine(t: Tally): string {
  const n = t.real + t.wrong + t.unmarked
  if (n === 0) return "Nothing to review yet"
  const allowed = Math.floor(n / 3)
  const verdict =
    t.wrong > allowed
      ? `over a third wrong — fix extract/resolve before Phase 3`
      : `the gate allows ${allowed}`
  const pending = t.unmarked > 0 ? ` · ${t.unmarked} not reviewed` : ""
  return `${t.wrong} of ${n} wrong · ${verdict}${pending}`
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}
