/// <reference lib="dom" />

/**
 * The two functions in this folder that run inside the browser.
 *
 * File-scoped `dom` lib, and the same serialisation contract every other adapter
 * here is written under: **they close over nothing and declare no function of their
 * own.** Playwright serialises the source, the bundler rewrites a named inner
 * function as `__name(fn, "…")` with `__name` at module scope, and the failure
 * arrives as `__name is not defined` on a clock that is already billing. Hence the
 * `for` loops and the absence of callbacks. `inpage.test.ts` asserts that shape
 * rather than trusting this paragraph.
 *
 * **They select and copy strings; they do not interpret them.** No number parsing,
 * no date arithmetic, no language guess, no stripping of localised words. On a
 * source read from the DOM that line is all that is left of the capture/parse
 * split, and it is what keeps "we were wrong about what a vote label means" a
 * parser edit rather than a browser session.
 *
 * **They also click nothing.** Pantip pages a long topic behind a control this file
 * has never seen, and a selector loose enough to find it — a button that mentions
 * comments and mentions "more" — is loose enough to find something else and press
 * it. The candidate is counted into `nodeCounts` instead, so the next capture says
 * what the control is actually called and the guess after that is not a guess.
 */

import type { PantipPostNode, PantipTopicNode } from "./types.js"

export interface PantipReadLimits {
  /** How many item fragments to keep. */
  maxFragments: number
  /** How much of each one. */
  fragmentChars: number
}

export interface PantipPageRead {
  topics: PantipTopicNode[]
  posts: PantipPostNode[]
  state: string | null
  stateLength: number | null
  stateKeys: string[]
  stateCandidates: string[]
  nodeCounts: Record<string, number>
  fragmentsStored: number
  /** What kind of wall, not merely that there is one. See `capture.ts`. */
  wall: "captcha" | "login" | null
  title: string
  href: string
}

/**
 * Read everything, on every surface, regardless of which one we think we are on.
 *
 * A listing read on a topic page costs nothing and buys a diagnosis: a topic
 * capture that came back holding thirty listing rows and no posts never left the
 * board, which is a different bug from a topic that would not load.
 */
export function readPantipPage(limits: PantipReadLimits): PantipPageRead {
  const globals = window as unknown as Record<string, unknown>

  const stateKeys: string[] = []
  let state: string | null = null
  let stateLength: number | null = null
  for (const name of ["__NEXT_DATA__", "__NUXT__", "__INITIAL_STATE__", "PANTIP"]) {
    const value = globals[name]
    if (value === undefined || value === null) continue
    // Labelled, because the label is what a person reads first. On the first real
    // capture `window.__NEXT_DATA__` was the *script element*, not the payload:
    // the guard below caught it and the script-tag fallback then read it properly,
    // but `stateKeys` said `__NEXT_DATA__` and so reported a success that had in
    // fact been a near miss rescued by a fallback.
    stateKeys.push(value instanceof Node ? `${name} (element)` : name)
    if (state !== null) continue
    if (value instanceof Node) continue
    let text = ""
    try {
      text = JSON.stringify(value) ?? ""
    } catch {
      text = ""
    }
    if (text.length === 0) continue
    stateLength = text.length
    state = text.slice(0, 200000)
  }
  // Next.js writes its payload into a script tag rather than a global on some
  // builds. Reading the tag's text is a copy, not an interpretation.
  if (state === null) {
    const tag = document.querySelector("script#__NEXT_DATA__")
    const text = tag === null ? "" : (tag.textContent ?? "")
    if (text.length > 0) {
      stateKeys.push("script#__NEXT_DATA__")
      stateLength = text.length
      state = text.slice(0, 200000)
    }
  }

  /**
   * What the blob is *actually* called, when none of the names above is it. Names
   * only — never values — sorted so two captures compare, and capped so a page with
   * a thousand globals cannot turn a diagnostic into the payload. P1.5 paid a
   * session to learn that a diagnostic reporting only which guesses were right stops
   * one question short of the useful one.
   *
   * `for...in`, and not `Object.keys`, which is what this was and why it returned an
   * empty list on the first real capture. `Object.keys` reports a window's **own**
   * enumerable properties, and the interesting ones are not own properties: a named
   * element global — `<div id="APP_STATE">` — lives on the WindowProperties exotic
   * object in the prototype chain, and several browsers put their own globals on
   * `Window.prototype` besides. So the diagnostic written to answer "what is this
   * blob really called" came back saying "nothing", on a page that has a state blob,
   * and the session that bought that answer bought a bug instead.
   */
  const stateCandidates: string[] = []
  for (const key in globals) {
    if (stateCandidates.length >= 200) break
    if (/^(?:__|_page|PANTIP|APP_)/.test(key) || /^[A-Z][A-Z0-9_]{7,}$/.test(key)) {
      stateCandidates.push(key)
    }
  }
  stateCandidates.sort()
  stateCandidates.length = Math.min(stateCandidates.length, 40)

  const nodeCounts: Record<string, number> = {}
  let fragmentsStored = 0

  /**
   * Selector guesses, ordered most-durable-first.
   *
   * Pantip's classes are hand-written rather than compiler-generated, which is why
   * the plan calls this "plain HTML, good signal" — but hand-written classes are
   * still renamed by hand. Every hit is counted, so correcting one after a real
   * capture is a one-line edit rather than a rewrite.
   */
  const topicPlan: Array<[string, string[], string]> = [
    ["authorName", ['a[href*="/profile/"]', '[class*="owner"]', '[class*="author"]'], "text"],
    ["authorHref", ['a[href*="/profile/"]'], "href"],
    // `stamp`, not `text`, and the selector list was rewritten by a real listing.
    // Pantip writes the date as a bare `<span title="8 กันยายน 2569 เวลา 11:46 น.">8
    // ก.ย.</span>` — no `abbr`, no `<time>`, no class with "date" or "time" in it, so
    // all four original guesses missed and 259 rows came back with a null timestamp.
    // The `title` attribute is also the better of the two values: absolute, with a
    // year and a clock on it, where the text is an abbreviation that needs today's
    // date to mean anything.
    [
      "timeLabel",
      ["abbr[title]", "time[datetime]", "span[title]", '[class*="date"]', '[class*="time"]'],
      "stamp",
    ],
    ["voteLabel", ['[class*="vote"]', '[class*="like"]', '[class*="point"]'], "count"],
    ["commentLabel", ['[class*="comment"]', '[class*="reply"]'], "count"],
    ["viewLabel", ['[class*="view"]', '[class*="read"]', '[class*="hit"]'], "count"],
    ["excerpt", ['[class*="detail"]', '[class*="excerpt"]', '[class*="desc"]', "p"], "text"],
  ]

  const topics: PantipTopicNode[] = []
  const seenHref: Record<string, boolean> = {}
  let topicAnchors = 0
  for (const anchor of Array.from(document.querySelectorAll('a[href*="/topic/"]'))) {
    const href = anchor.getAttribute("href") ?? ""
    if (href.length === 0) continue
    if (seenHref[href]) continue
    seenHref[href] = true
    topicAnchors += 1

    /**
     * The row, and finding it structurally rather than by class name.
     *
     * This was `anchor.closest("li, article, tr, div[class]")`, on the reasoning
     * that the tag list should be generic because an `li` on one build is a `div` on
     * the next. The first real listing capture — `pantip.forum food`, 259 rows —
     * showed what generic bought: `div[class]` matched
     * `<div class="pt-list-item__title">`, the innermost wrapper around the link, and
     * so every row's scope was the title alone. Titles and hrefs came back perfect.
     * Author, time, votes, comments, views and excerpt came back null for all 259,
     * not because the selectors were wrong but because none of those fields was
     * inside the scope they were searched in.
     *
     * So the row is defined by what it contains instead. Climb while the ancestor
     * still belongs to this topic alone — the moment it contains a link to a
     * *different* topic, it is the list and not the row, and the one below it was the
     * row. That needs no class names at all, which is the point: class names are the
     * thing that gets renamed.
     *
     * Compared by topic id rather than by href, because a row links its own topic
     * more than once and the copies differ by tracking parameters. The hop cap stops
     * a page with a single topic link on it from climbing to `<body>`.
     */
    // Inline rather than a helper: this function is serialised into the page and
    // may declare no function of its own. See the file header.
    const id = (href.match(/\/topic\/(\d+)/) ?? [])[1] ?? href
    let row: Element = anchor
    let cursor: Element | null = anchor.parentElement
    let hops = 0
    while (cursor !== null && hops < 8) {
      if (cursor === document.body) break
      let foreign = false
      for (const other of Array.from(cursor.querySelectorAll('a[href*="/topic/"]'))) {
        const otherHref = other.getAttribute("href") ?? ""
        if (((otherHref.match(/\/topic\/(\d+)/) ?? [])[1] ?? otherHref) !== id) foreign = true
      }
      if (foreign) break
      row = cursor
      cursor = cursor.parentElement
      hops += 1
    }

    const fields: Record<string, string> = {}
    for (const [field, selectors, how] of topicPlan) {
      let found = false
      for (const selector of selectors) {
        if (found) break
        // Every match for the selector, not merely the first. A selector that
        // matches on a substring of a class name matches `pt-view-count` and
        // `pt-preview` alike, and taking only the first match would let a decoy
        // earlier in the row cost the field entirely.
        for (const node of Array.from(row.querySelectorAll(selector))) {
          let value = ""
          if (how === "href") value = node.getAttribute("href") ?? ""
          else if (how === "stamp") value = node.getAttribute("title") ?? node.textContent ?? ""
          else if (how === "count") {
            /**
             * The icon is inside the number, and that is not a cosmetic problem.
             *
             * Pantip writes a count as `<span class="pt-li_stats-comment"><i
             * class="material-icons">message</i>39</span>`, and Material Icons puts
             * the glyph's *name* in the element's text. So `textContent` is
             * `"message39"`, and `parseCount` reads 39 from it only because
             * "message" happens to contain no digit. `thumb_up_2` does, and
             * `parseCount("thumb_up_2 12")` is **212** — a plausible number, wrong,
             * with nothing anywhere to say so. Today's icons are safe and the next
             * redesign is a coin flip.
             *
             * Cloned and stripped rather than pattern-matched off the front: the
             * icon is a node, it is removable as a node, and a regex that peeled
             * leading letters off a count would also eat a legitimate prefix.
             */
            const copy = node.cloneNode(true) as Element
            for (const icon of Array.from(copy.querySelectorAll("i, svg"))) icon.remove()
            value = copy.textContent ?? ""
          } else value = node.textContent ?? ""
          value = value.trim()
          if (value.length === 0) continue
          /**
           * A count label has to *look* like a count, and "contains a digit" is not
           * that test.
           *
           * It was. The first real listing found the hole: Pantip tags a promoted
           * row's title link with `class="gtm-voted-topic"`, an analytics name, and
           * `[class*="vote"]` matches "vo**ted**". The matched node's text is the
           * thread's title — and a title like "…บุฟเฟต์ 12 กันยายน 2569 … มา 4 จาน"
           * contains plenty of digits, so the old guard waved it through and four
           * rows recorded a headline as their vote count.
           *
           * The rule is: **a number, then at most one unit word.** "39", "5,120",
           * "1.2K", "34 ความคิดเห็น" and "1,234 ครั้ง" all pass; a label whose number
           * is not at the front fails, and so does a title that merely begins with a
           * digit — "24 ร้านแนะนำ ที่ต้องลอง" has a second word and stops there.
           * Failing a candidate is cheap: the per-match loop moves on to the next
           * one, which is what it is for. Still a rule about which node to copy, not
           * a reading of what the copy means — the reading stays in `parse.ts`.
           */
          if (how === "count" && !/^\d[\d,.]*(?:\s?[A-Za-z\u0E00-\u0E7F]{1,12})?$/.test(value)) {
            continue
          }
          fields[field] = value
          nodeCounts[selector] = (nodeCounts[selector] ?? 0) + 1
          found = true
          break
        }
      }
    }

    const tagLabels: string[] = []
    for (const tag of Array.from(row.querySelectorAll('a[href*="/tag/"]'))) {
      const label = (tag.textContent ?? "").trim()
      if (label.length > 0) tagLabels.push(label)
    }

    /**
     * The fragment comes from **one level above the row**, and the extra level is
     * the whole lesson of the first listing capture.
     *
     * A fragment is stored so that a wrong selector is a re-parse rather than a
     * browser session. That works for every kind of wrong guess except one: if the
     * *scope* is wrong, the fragment is cropped to the wrong scope too, and the bytes
     * cannot show what was missed. That is exactly what happened — 30 fragments were
     * stored, all 30 were the title `<div>`, and the author and count markup that
     * would have explained six null fields was outside every one of them. Thirty
     * copies of a diagnostic that could not diagnose the thing it was there for.
     *
     * One level up is cheap insurance: it is bounded by the same character cap, and
     * it means the next scope error is visible in bytes already paid for instead of
     * costing a second session. A diagnostic cropped to the thing being diagnosed is
     * not a diagnostic.
     */
    let fragment: string | null = null
    if (fragmentsStored < limits.maxFragments) {
      const around = row.parentElement ?? row
      const clone = around.cloneNode(true) as Element
      for (const noisy of Array.from(clone.querySelectorAll("script, style, noscript, iframe"))) {
        noisy.remove()
      }
      fragment = clone.outerHTML.slice(0, limits.fragmentChars)
      fragmentsStored += 1
    }

    topics.push({
      href,
      title: (anchor.textContent ?? "").trim() || null,
      authorName: fields.authorName ?? null,
      authorHref: fields.authorHref ?? null,
      tagLabels,
      timeLabel: fields.timeLabel ?? null,
      voteLabel: fields.voteLabel ?? null,
      commentLabel: fields.commentLabel ?? null,
      viewLabel: fields.viewLabel ?? null,
      excerpt: fields.excerpt ?? null,
      fragment,
    })
  }
  nodeCounts['a[href*="/topic/"]'] = topicAnchors

  const posts: PantipPostNode[] = []
  const openingSelectors = [
    '[class*="display-post-story"]',
    '[itemprop="articleBody"]',
    '[class*="post-story"]',
    "article",
  ]
  const replySelectors = [
    '[id^="comment-"]',
    "[data-cid]",
    '[class*="display-post-wrapper"]',
    '[class*="comment-item"]',
  ]

  const postNodes: Array<[Element, string]> = []
  for (const selector of openingSelectors) {
    const found = document.querySelector(selector)
    nodeCounts[selector] = found === null ? 0 : 1
    if (found !== null && postNodes.length === 0) postNodes.push([found, "opening"])
  }
  const seenReply: Record<string, boolean> = {}
  for (const selector of replySelectors) {
    const found = Array.from(document.querySelectorAll(selector))
    nodeCounts[selector] = found.length
    for (const node of found) {
      // Document order puts a container before anything nested inside it, so the
      // first selector to claim a node keeps it and a later, looser one does not
      // store the same reply twice under a different name.
      const key = node.getAttribute("id") ?? node.getAttribute("data-cid") ?? ""
      if (key.length > 0 && seenReply[key]) continue
      if (key.length > 0) seenReply[key] = true
      // Overlap in either direction is one post, not two. A later, looser selector
      // can match a box *around* something already claimed just as easily as a box
      // inside it — the opening post's wrapper is literally called
      // `display-post-wrapper`, which is also how a reply is named.
      let nested = false
      for (const [already] of postNodes) {
        if (already === node) continue
        if (already.contains(node) || node.contains(already)) nested = true
      }
      if (nested) continue
      /**
       * A comment is numbered. Page furniture is not.
       *
       * `[id^="comment-"]` also finds `comment-counter`, the "46 ความคิดเห็น"
       * heading above the thread, and `comment-count-tmpl`, a jsrender template
       * whose text is a literal `{{if count}}`; `[class*="display-post-wrapper"]`
       * also finds three boxes carrying no id at all — the deleted-comment tally,
       * the "leave a comment" heading, and the prompt to log in. The first capture
       * of this surface stored all five as posts, which is a fixture certifying
       * that a template is something a person wrote.
       *
       * Pantip numbers the real ones `comment-120277350` and `reply-40463805`, so
       * requiring digits after the dash keeps all 91 and drops all 5. `data-cid`
       * is exempt from the shape because it is an attribute Pantip puts on nothing
       * but a comment. Counted rather than silently dropped: an exclusion that
       * cannot report its own count is a comment, not a control, and if Pantip
       * renumbers its comments this line is where the posts went.
       */
      if (!/^(?:comment|reply)-\d+$/.test(key) && !node.hasAttribute("data-cid")) {
        nodeCounts["reply with no comment number"] =
          (nodeCounts["reply with no comment number"] ?? 0) + 1
        continue
      }
      postNodes.push([node, "reply"])
    }
  }

  const postPlan: Array<[string, string[], string]> = [
    ["authorName", ['a[href*="/profile/"]', '[class*="owner"]', '[class*="author"]'], "text"],
    ["authorHref", ['a[href*="/profile/"]'], "href"],
    // `stamp`, not `text`, and the selector list was rewritten by a real listing.
    // Pantip writes the date as a bare `<span title="8 กันยายน 2569 เวลา 11:46 น.">8
    // ก.ย.</span>` — no `abbr`, no `<time>`, no class with "date" or "time" in it, so
    // all four original guesses missed and 259 rows came back with a null timestamp.
    // The `title` attribute is also the better of the two values: absolute, with a
    // year and a clock on it, where the text is an abbreviation that needs today's
    // date to mean anything.
    [
      "timeLabel",
      ["abbr[title]", "time[datetime]", "span[title]", '[class*="date"]', '[class*="time"]'],
      "stamp",
    ],
    ["voteLabel", ['[class*="vote"]', '[class*="like"]', '[class*="point"]'], "count"],
    /**
     * `prose`, and `story` is narrowed by what it must not be.
     *
     * `[class*="story"]` matches `display-post-story-footer` too — the bar holding
     * the reply button and the vote count, a *sibling* of the story rather than a
     * child of it. A comment that is only an emoticon has an empty story box, the
     * loop walked on, and the footer answered: 50 of the 96 posts in the first
     * capture of this surface came back reading "ตอบกลับ … 0", which is the page's
     * word for "reply", stored as though somebody had typed it.
     */
    [
      "text",
      ['[class*="story"]:not([class*="footer"])', '[class*="message"]', '[class*="detail"]'],
      "prose",
    ],
  ]

  for (const [node, role] of postNodes) {
    /**
     * The box around the post, not the body of it — for the opening post only.
     *
     * `[class*="display-post-story"]` finds the writing, and on this page the
     * byline sits *beside* the writing rather than inside it, so every field but
     * `text` would come back null and the stored fragment would not contain the
     * answer either. That last part is what makes it worth the four lines: the
     * fragment exists so a wrong selector costs a re-parse instead of a session,
     * and a fragment cropped to the body cannot repay that. Widened one step from
     * the parent and only across Pantip's own `display-post` wrappers, because
     * widening to `main` would make one post's text the whole page's.
     */
    let scope = node
    if (role === "opening" && node.parentElement !== null) {
      const wrapper = node.parentElement.closest('[class*="display-post"], article')
      if (wrapper !== null) scope = wrapper
    }

    const fields: Record<string, string> = {}
    /** Whether a box that holds the body exists, separately from whether it has one. */
    let bodyBox = false
    for (const [field, selectors, how] of postPlan) {
      let found = false
      for (const selector of selectors) {
        if (found) break
        for (const inner of Array.from(scope.querySelectorAll(selector))) {
          // The same four cases as the listing loop above, spelled out a second
          // time. This function is serialised into the page and may declare no
          // function of its own, so there is nowhere to factor them to; the comments
          // that explain each case live at the first copy.
          let value = ""
          if (how === "href") value = inner.getAttribute("href") ?? ""
          else if (how === "stamp") value = inner.getAttribute("title") ?? inner.textContent ?? ""
          else if (how === "count") {
            const copy = inner.cloneNode(true) as Element
            for (const icon of Array.from(copy.querySelectorAll("i, svg"))) icon.remove()
            value = copy.textContent ?? ""
          } else if (how === "prose") {
            // The same removal the fragment does below, for the same reason and with
            // the same list. Pantip closes the opening post's review block with an
            // inline `$(document).ready(…)` that turns the star widget read-only, and
            // `textContent` returns it: the first capture of this surface stored a
            // jQuery call as the first thing the author of the topic said.
            const copy = inner.cloneNode(true) as Element
            for (const noisy of Array.from(copy.querySelectorAll("script, style, noscript"))) {
              noisy.remove()
            }
            value = copy.textContent ?? ""
          } else value = inner.textContent ?? ""
          value = value.trim()
          if (value.length === 0) {
            if (how === "prose") bodyBox = true
            continue
          }
          // The same guard as the listing loop above; see the comment there.
          if (how === "count" && !/^\d[\d,.]*(?:\s?[A-Za-z\u0E00-\u0E7F]{1,12})?$/.test(value)) {
            continue
          }
          fields[field] = value
          nodeCounts[`post ${selector}`] = (nodeCounts[`post ${selector}`] ?? 0) + 1
          found = true
          break
        }
      }
    }
    /**
     * The node's own text when no inner selector claimed it. A post whose body we
     * could not locate precisely is still worth more than a null.
     *
     * Not when the box was found and was empty, though. A comment that is only an
     * emoticon has a real, empty story box and `mediaRefs` holding the emoticon;
     * `scope.textContent` would answer with the byline, the reply button and the
     * vote count instead, which is not a body we failed to locate but a body that
     * is not there. Null says that and a fallback cannot.
     */
    if (fields.text === undefined && !bodyBox) {
      const own = (scope.textContent ?? "").trim()
      if (own.length > 0) fields.text = own
    }

    const mediaRefs: string[] = []
    for (const image of Array.from(scope.querySelectorAll("img"))) {
      // The author's avatar is a picture of a person, not evidence about anything.
      if (image.closest('a[href*="/profile/"]') !== null) continue
      const src = image.getAttribute("src") ?? ""
      if (src.length > 0) mediaRefs.push(src)
    }

    let fragment: string | null = null
    if (fragmentsStored < limits.maxFragments) {
      const clone = scope.cloneNode(true) as Element
      for (const noisy of Array.from(clone.querySelectorAll("script, style, noscript, iframe"))) {
        noisy.remove()
      }
      fragment = clone.outerHTML.slice(0, limits.fragmentChars)
      fragmentsStored += 1
    }

    posts.push({
      role: role === "opening" ? "opening" : "reply",
      postId: scope.getAttribute("id") ?? scope.getAttribute("data-cid"),
      authorName: fields.authorName ?? null,
      authorHref: fields.authorHref ?? null,
      timeLabel: fields.timeLabel ?? null,
      text: fields.text ?? null,
      mediaRefs,
      voteLabel: fields.voteLabel ?? null,
      fragment,
    })
  }

  // Counted, never clicked. See the header.
  nodeCounts["pager candidate"] = document.querySelectorAll(
    '[class*="comment"] button, [class*="comment"] [class*="more"], button[class*="more"]',
  ).length

  const captcha =
    document.querySelector("#challenge-form, #cf-wrapper, [id*='captcha']") !== null ||
    location.pathname.includes("/cdn-cgi/")
  const login = document.querySelector('form input[type="password"]') !== null
  const wall = captcha ? "captcha" : login ? "login" : null

  return {
    topics,
    posts,
    state,
    stateLength,
    stateKeys,
    stateCandidates,
    nodeCounts,
    fragmentsStored,
    wall,
    title: document.title,
    href: location.href,
  }
}

/** Scroll to the bottom and report the document height, so the caller can stop. */
export function scrollPantipPage(): number {
  window.scrollTo(0, document.body.scrollHeight)
  return document.body.scrollHeight
}
