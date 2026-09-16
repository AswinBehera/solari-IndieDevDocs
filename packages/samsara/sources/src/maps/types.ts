/**
 * What a Google Maps capture holds.
 *
 * The other two adapters in this package store a tree that a source serialised for
 * its own client, and parse it later for free. Maps cannot be read that way. Its
 * embedded payload — `APP_INITIALIZATION_STATE` — is nested arrays with no keys in
 * them at all: a review's text is at some index of some index, and there is nothing
 * to search a tree *for*. A positional parser written from memory fails the same way
 * whether the position moved or was never known, which is the one failure mode a
 * per-minute budget cannot absorb.
 *
 * So this adapter reads the rendered DOM, and the consequence is stated rather than
 * hidden: `parse` has no DOM, so field extraction happens in the half that spends.
 * The line that survives is narrower and still worth having —
 *
 *   **the in-page half selects and copies strings; it does not interpret them.**
 *
 * `readMapsPage` returns the raw `aria-label`, the raw relative time, the raw
 * helpful-count label. Turning "5 stars" into a number, a count into an integer, or
 * a script into a language stays in `parse.ts`, where being wrong is free. Changing
 * our mind about what a rating *is* still costs nothing; recovering from a selector
 * change now costs a session, which is why `nodeCounts` and `tabLabels` exist.
 */

/**
 * `search` asks where something is; `reviews` asks what was said about one entity.
 * Separate ids for the same reason every other pair in this package is separate:
 * this is the column a stored row is grouped and re-parsed by, and a result card is
 * not the same kind of evidence as a review.
 */
export type MapsSurface = "search" | "reviews"

export interface MapsPayload {
  surface: MapsSurface
  /**
   * One record per review node found in the panel. Empty on the `search` surface.
   */
  reviews: readonly MapsReviewNode[]
  /**
   * One record per result card. Empty on the `reviews` surface.
   */
  entities: readonly MapsEntityNode[]
  /**
   * `APP_INITIALIZATION_STATE`, as a **string**, truncated.
   *
   * Nothing parses this. It is stored because re-reading a capture is free and
   * re-opening a session is not: the day somebody works out the index path, it can
   * be run against every capture ever taken, and a capture is the only part of this
   * system that cannot be reconstructed afterwards.
   *
   * A string rather than a tree because it is an anonymous array either way, and a
   * truncated string with its original length beside it is honest about what was
   * dropped in a way a truncated tree is not.
   */
  state: string | null
  /** Length of the blob before truncation. `null` when there was no blob. */
  stateLength: number | null
  /** The page title as served — evidence when a capture turns out refused. */
  pageTitle: string
  /**
   * Every tab's label, verbatim and in the persona's language.
   *
   * The reviews tab has to be chosen by position, because its label is localised
   * and a list of the word "reviews" in eleven languages is a thing this package
   * would then own and have to maintain. Position is a guess. This field is what
   * turns a wrong guess into something a person reads off the artifact instead of
   * paying for a second session to discover.
   */
  tabLabels: readonly string[]
  /** Which tab index was opened, or `null` when no tab strip was found. */
  tabOpened: number | null
  /** How many times the results pane was scrolled before reading. */
  scrolls: number
  /**
   * What each candidate selector matched, by selector.
   *
   * Same purpose as `tabLabels` and as P1.4's `tiles`: "zero reviews" cannot
   * distinguish an entity with no reviews from a selector Google renamed last
   * Tuesday, and those want opposite responses. One integer per selector settles it
   * without another session.
   */
  nodeCounts: Readonly<Record<string, number>>
  /** Which globals were present on `window`, by name. See `stateKeys` in `inpage.ts`. */
  stateKeys: readonly string[]
  /**
   * Globals whose *names* look like a state blob, when none of the expected ones was
   * there. The answer to "then what is it called", bought by a capture that failed.
   */
  stateCandidates: readonly string[]
  /**
   * Every response path the page requested, deduplicated and sorted. Paths only,
   * and with contributor profile photos removed — see `observedAvatarsSkipped`.
   */
  observedPaths: readonly string[]
  /**
   * How many responses were dropped from `observedPaths` as contributor photos.
   *
   * The counter is here rather than in `nodeCounts` because `nodeCounts` is written
   * inside `page.evaluate` and this exclusion happens on the network side. It is
   * here at all for the reason `avatarsSkipped` is: an exclusion that cannot report
   * its own count is a comment, not a control, and this one was silently doing
   * nothing while a test asserted it worked.
   */
  observedAvatarsSkipped: number
  strategies: {
    state: boolean
    reviews: number
    entities: number
  }
}

/**
 * One review, as strings the page rendered.
 *
 * Every field is nullable and nothing is normalised. A review with an unreadable
 * author is still a review; a rating we could not find is not a rating of zero.
 */
export interface MapsReviewNode {
  /** `data-review-id`. Google's own identifier, stable across viewers. */
  reviewId: string | null
  authorName: string | null
  authorHref: string | null
  /** "Local Guide · 42 reviews", localised. Verbatim. */
  authorMeta: string | null
  /** The rating's `aria-label`, localised and verbatim: "5 stars", "5 ดาว จาก 5". */
  ratingLabel: string | null
  /** "2 months ago", localised. Verbatim — `parse` does not turn it into a date. */
  relativeTime: string | null
  /** The review body in its own script. Never translated, never trimmed of words. */
  text: string | null
  /**
   * Image references exactly as the attribute held them — an `img` `src`, or the
   * raw `style` value of a node that paints one as a background. Not unwrapped
   * here: turning `url("https://…")` into a URL is interpretation, and
   * interpretation is `parse`'s job even when it is one regex long.
   */
  photoRefs: readonly string[]
  /** "Helpful (3)", localised. The digits are read in `parse`, not here. */
  helpfulLabel: string | null
  /**
   * The owner's reply, when there is one.
   *
   * Kept and kept **separate**. It is text in the local language, so it is
   * evidence; it is also written by the subject rather than a visitor, so folding
   * it into `text` would file marketing copy as testimony.
   */
  ownerReply: string | null
  /**
   * The review's own markup, stripped of scripts and styles and truncated.
   *
   * Added after the first real reviews capture, in which three of nine selector
   * plans returned null for every review and **not one of them could be
   * diagnosed**, because this field did not exist. A null with no markup beside
   * it cannot distinguish "the page does not have this" from "the selector is
   * stale" — and those want opposite responses: one is a finding, the other is a
   * one-line edit. Without the fragment, telling them apart costs a billed
   * session; with it, it costs a re-parse.
   *
   * Pantip learned the sharper version of this — a fragment cropped to the scope
   * the fields were read from cannot show a scope error — and this one is cropped
   * to the review card, which is the scope `[data-review-id]` already
   * established. The card is not the thing in doubt here; the selectors inside it
   * are.
   */
  fragment: string | null
}

/** One result card from the search surface. Same rules: strings, verbatim. */
export interface MapsEntityNode {
  /** The card's own link. Carries the feature id `parse` reads identity out of. */
  href: string | null
  name: string | null
  ratingLabel: string | null
  /** "(231)" or "231 reviews", localised. */
  reviewCountLabel: string | null
  /** The category and address line as rendered, one string per line. */
  detailLines: readonly string[]
}
