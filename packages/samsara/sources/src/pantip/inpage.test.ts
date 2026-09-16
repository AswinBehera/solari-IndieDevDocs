/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest"
import { type PantipPageRead, readPantipPage, scrollPantipPage } from "./inpage.js"

/**
 * The second file in this package that runs against a real DOM, and it is here for
 * the reason the first one is: this adapter extracts every field inside the browser,
 * so a selector that moved is a billed session rather than a re-parse, and a stub
 * would only test my model of a DOM rather than a DOM.
 *
 * `jsdom` is declared **per file** rather than for the package, so the rest of
 * `@samsara/sources` keeps compiling for a runtime that has no `document`.
 *
 * What it still cannot test is whether these selectors match *Pantip's* markup. The
 * fragments below are my model of it, written without having loaded the page. That
 * is what `nodeCounts` and the stored fragments in the payload are for — and the
 * fragments are the part that is new here: on this source a wrong guess is meant to
 * be correctable from bytes we already hold.
 */

/** Exactly what Playwright does to it: the source crosses, the scope does not. */
function serialised<T>(fn: T): T {
  return new Function(`return (${String(fn)})`)() as T
}

const LIMITS = { maxFragments: 30, fragmentChars: 3_000 }

function render(html: string): void {
  document.body.innerHTML = html
}

/**
 * A listing, with the two details that matter in it: a row's link carries tracking
 * that differs per row, and a class-substring selector has decoys to walk past —
 * `pt-preview` contains the word the view-count selector matches on.
 */
const LISTING = `
  <ul class="pt-list">
    <li class="pt-list-item">
      <a class="pt-list-item__title" href="/topic/43210987?ref=recommend">คาเฟ่แถวอารีย์ ที่นั่งทำงานได้ทั้งวัน</a>
      <a class="pt-list-item__owner" href="/profile/1234567">คุณนักชิม</a>
      <span class="pt-list-item__date">2 ชั่วโมงที่แล้ว</span>
      <span class="pt-preview">พรีวิว</span>
      <span class="pt-list-item__vote">12</span>
      <span class="pt-list-item__comment">34 ความคิดเห็น</span>
      <span class="pt-list-item__view">5.6 หมื่น</span>
      <div class="pt-list-item__detail">ลองมาสามที่ ชอบที่นี่ที่สุด</div>
      <a href="/tag/อารีย์">อารีย์</a>
      <a href="/tag/คาเฟ่">คาเฟ่</a>
    </li>
    <li class="pt-list-item">
      <a class="pt-list-item__title" href="/topic/43210988?ref=tag">กาแฟเย็นแก้วไหนอร่อยสุด</a>
      <span class="pt-list-item__vote">3</span>
    </li>
  </ul>
`

/**
 * A topic, laid out the way Pantip lays one out: the opening post's byline sits
 * *beside* its body rather than inside it, and a reply is anchored by an `id` that
 * a second, looser selector also matches.
 */
const TOPIC = `
  <div class="display-post-wrapper-inner">
    <a class="display-post-name owner" href="/profile/1234567">คุณนักชิม</a>
    <abbr title="2026-09-10 09:12:00">3 วันที่แล้ว</abbr>
    <div class="display-post-story">
      เดินหาที่นั่งทำงานแถวอารีย์มาทั้งวัน
      <img src="https://f.ptcdn.info/story-one.jpg">
    </div>
    <span class="like-vote">21</span>
  </div>
  <div id="comment-1" class="display-post-wrapper comment-item">
    <a class="display-post-name" href="/profile/7654321">
      <img src="https://f.ptcdn.info/avatar-of-a-person.jpg">
      คุณกาแฟดำ
    </a>
    <abbr title="2026-09-10 11:30:00">3 วันที่แล้ว</abbr>
    <div class="display-post-story">กาแฟที่นี่ดีมาก นั่งได้ยาว ๆ</div>
    <span class="like-vote">4</span>
  </div>
  <div id="comment-2" class="display-post-wrapper comment-item">
    <div class="display-post-story">เห็นด้วยครับ</div>
  </div>
`

describe("what crosses into the page", () => {
  /**
   * The rule every in-page function in this package lives under, asserted rather
   * than trusted. TikTok paid two billed sessions to establish it: the bundler
   * rewrites a named inner function as `__name(fn, "…")`, and `__name` lives at
   * module scope, which does not cross.
   */
  for (const fn of [readPantipPage, scrollPantipPage]) {
    it(`${fn.name} declares no function of its own`, () => {
      const source = String(fn).slice(String(fn).indexOf("{"))
      expect(source).not.toMatch(/\bfunction\b/)
      expect(source).not.toContain("=>")
      expect(source).not.toContain("__name")
    })
  }

  it("survives serialisation and re-parsing through toString", () => {
    render(LISTING)
    expect(serialised(readPantipPage)(LIMITS).topics).toHaveLength(2)
  })

  it("takes its limits as an argument rather than closing over them", () => {
    // The whole reason the limits are a parameter: a module-scope constant read
    // inside an evaluated function is `undefined` in the page, and the failure
    // arrives on a clock that is already billing.
    render(LISTING)
    const read = serialised(readPantipPage)({ maxFragments: 1, fragmentChars: 20 })
    expect(read.fragmentsStored).toBe(1)
    expect(read.topics[0]?.fragment).toHaveLength(20)
    expect(read.topics[1]?.fragment).toBeNull()
  })
})

describe("reading a listing", () => {
  it("finds one row per topic link and keeps the link verbatim", () => {
    // Verbatim, tracking and all: turning `/topic/43210987?ref=recommend` into an
    // identity is `parse.ts`'s job, and doing it here would cost a session to undo.
    render(LISTING)
    const read = readPantipPage(LIMITS)
    expect(read.topics).toHaveLength(2)
    expect(read.topics[0]?.href).toBe("/topic/43210987?ref=recommend")
    expect(read.nodeCounts['a[href*="/topic/"]']).toBe(2)
  })

  it("copies the localised counts as strings and reads none of them", () => {
    render(LISTING)
    const [row] = readPantipPage(LIMITS).topics
    expect(row?.voteLabel).toBe("12")
    expect(row?.commentLabel).toBe("34 ความคิดเห็น")
    expect(row?.viewLabel).toBe("5.6 หมื่น")
  })

  it("walks past a decoy that matches the selector but holds no number", () => {
    // `pt-preview` contains the string the view selector matches on. Taking the
    // first match would have filed the word "พรีวิว" as a view count; requiring a
    // digit is a rule about which node to copy, not a reading of what it says.
    render(LISTING)
    expect(readPantipPage(LIMITS).topics[0]?.viewLabel).toBe("5.6 หมื่น")
  })

  it("reads the author and the tags the row printed", () => {
    render(LISTING)
    const [row] = readPantipPage(LIMITS).topics
    expect(row?.authorName).toBe("คุณนักชิม")
    expect(row?.authorHref).toBe("/profile/1234567")
    expect(row?.tagLabels).toEqual(["อารีย์", "คาเฟ่"])
    expect(row?.timeLabel).toBe("2 ชั่วโมงที่แล้ว")
  })

  it("returns nulls rather than guesses for a row that printed nothing", () => {
    render(LISTING)
    const row = readPantipPage(LIMITS).topics[1]
    expect(row?.title).toBe("กาแฟเย็นแก้วไหนอร่อยสุด")
    expect(row?.viewLabel).toBeNull()
    expect(row?.commentLabel).toBeNull()
    expect(row?.authorName).toBeNull()
    expect(row?.tagLabels).toEqual([])
  })

  it("stores the markup each row came from", () => {
    // The dividend this source pays and the others do not. A wrong selector above
    // is a re-parse of bytes already held rather than another browser session.
    render(LISTING)
    const read = readPantipPage(LIMITS)
    expect(read.fragmentsStored).toBe(2)
    expect(read.topics[0]?.fragment).toContain("pt-list-item__view")
  })

  it("keeps scripts out of a stored fragment", () => {
    // The markup around a row is content. An inline script inside it is where a
    // token would be, and it is removed in the page rather than on the way out.
    render(`<li class="row"><a href="/topic/1">x</a><script>var csrf="secret"</script></li>`)
    const [row] = readPantipPage(LIMITS).topics
    expect(row?.fragment).not.toContain("secret")
    expect(row?.fragment).toContain("/topic/1")
  })
})

describe("reading a topic", () => {
  it("widens the opening post to the box its byline is in", () => {
    // `display-post-story` is the writing; the name and the time sit beside it. A
    // fragment cropped to the body could not repay what the fragment is for.
    render(TOPIC)
    const [opening] = readPantipPage(LIMITS).posts
    expect(opening?.role).toBe("opening")
    expect(opening?.authorName).toBe("คุณนักชิม")
    // The attribute, not the text: an `abbr` carrying "3 วันที่แล้ว" also carries the
    // absolute date, and a relative label is only meaningful next to the day it was
    // read on. See "takes the timestamp from the title attribute".
    expect(opening?.timeLabel).toBe("2026-09-10 09:12:00")
    expect(opening?.voteLabel).toBe("21")
    expect(opening?.text).toContain("เดินหาที่นั่งทำงานแถวอารีย์")
  })

  it("does not store the opening post twice as a reply of itself", () => {
    // Its wrapper is called `display-post-wrapper-inner`, which is also how a reply
    // is named. Overlap in either direction is one post, not two.
    render(TOPIC)
    const read = readPantipPage(LIMITS)
    expect(read.posts).toHaveLength(3)
    expect(read.posts.filter((post) => post.role === "opening")).toHaveLength(1)
  })

  it("anchors a reply by the id Pantip gave it, once", () => {
    render(TOPIC)
    const replies = readPantipPage(LIMITS).posts.filter((post) => post.role === "reply")
    expect(replies.map((reply) => reply.postId)).toEqual(["comment-1", "comment-2"])
    expect(replies[0]?.text).toBe("กาแฟที่นี่ดีมาก นั่งได้ยาว ๆ")
  })

  it("collects the post's image and not the author's face", () => {
    render(TOPIC)
    const posts = readPantipPage(LIMITS).posts
    expect(posts[0]?.mediaRefs).toEqual(["https://f.ptcdn.info/story-one.jpg"])
    expect(posts[1]?.mediaRefs).toEqual([])
  })

  it("reads the listing on a topic page too", () => {
    // A topic capture holding thirty listing rows and no posts never left the
    // board, which is a different bug from a topic that would not load. Reading
    // both costs nothing and is what makes them distinguishable in the artifact.
    render(LISTING + TOPIC)
    const read = readPantipPage(LIMITS)
    expect(read.topics).toHaveLength(2)
    expect(read.posts.length).toBeGreaterThan(0)
  })
})

/**
 * Written from the first capture of a real topic rather than from a guess: every
 * box below was stored as a post by that capture, and the emoticon comment's body
 * came back reading "ตอบกลับ 0". The markup is trimmed to the parts that decide it,
 * and the class names are Pantip's own.
 */
const FURNITURE = `
  <div class="display-post-wrapper pageno-title-counter" id="comment-counter">
    <span class="title">46 ความคิดเห็น</span>
  </div>
  <div id="comment-120277350" class="display-post-wrapper section-comment">
    <a class="display-post-name" href="/profile/7654321">คุณกาแฟดำ</a>
    <div class="display-post-story-wrapper comment-wrapper">
      <div class="display-post-story">น่าทาน น่าตามรอย</div>
    </div>
    <div class="display-post-story-footer">
      <a class="comment-reply" href="javascript:void(0);">ตอบกลับ</a>
      <span class="like-vote">2</span>
    </div>
  </div>
  <div id="comment-120278009" class="display-post-wrapper section-comment">
    <a class="display-post-name" href="/profile/6027005">สมาชิกหมายเลข 6027005</a>
    <div class="display-post-story-wrapper comment-wrapper">
      <div class="display-post-story">
        <img class="img-in-emotion" src="https://ptcdn.info/emoticons/smiley05.png">
      </div>
    </div>
    <div class="display-post-story-footer">
      <a class="comment-reply" href="javascript:void(0);">ตอบกลับ</a>
      <span class="like-vote">0</span>
    </div>
  </div>
  <div class="display-post-wrapper" id="comment-count-tmpl">
    {{if count}}<h3>{{:count}} ความคิดเห็น</h3>{{/if}}
  </div>
  <div class="display-post-wrapper"><span>1 คห. ถูกลบ</span></div>
  <div class="display-post-wrapper"><span>แสดงความคิดเห็น</span></div>
`

describe("what a topic page holds that nobody wrote", () => {
  it("stores the two numbered comments and none of the four boxes around them", () => {
    render(FURNITURE)
    const posts = readPantipPage(LIMITS).posts
    expect(posts.map((post) => post.postId)).toEqual(["comment-120277350", "comment-120278009"])
  })

  it("says how many it dropped, because a silent exclusion is a comment", () => {
    render(FURNITURE)
    expect(readPantipPage(LIMITS).nodeCounts["reply with no comment number"]).toBe(4)
  })

  it("does not store a template as something a person said", () => {
    // `comment-count-tmpl` holds jsrender source. The first capture kept it, which
    // is a fixture certifying that `{{if count}}` is a post.
    render(FURNITURE)
    const json = JSON.stringify(readPantipPage(LIMITS).posts)
    expect(json).not.toContain("{{if count}}")
  })

  it("leaves a comment that is only an emoticon with no text rather than the reply button", () => {
    // `[class*="story"]` matches `display-post-story-footer`, a sibling of the
    // story holding the reply link and the vote. When the story is empty the loop
    // used to walk on and the footer answered.
    render(FURNITURE)
    const [, emoticon] = readPantipPage(LIMITS).posts
    expect(emoticon?.text).toBeNull()
    expect(emoticon?.mediaRefs).toEqual(["https://ptcdn.info/emoticons/smiley05.png"])
    // The vote still comes from the footer, which is where Pantip prints it.
    expect(emoticon?.voteLabel).toBe("0")
  })

  it("still reads a comment that has a body, and stops at the body", () => {
    render(FURNITURE)
    const [first] = readPantipPage(LIMITS).posts
    expect(first?.text).toBe("น่าทาน น่าตามรอย")
  })

  it("keeps the opening post's writing and not the script under it", () => {
    // Pantip closes a CR review with an inline `$(document).ready(…)` that turns
    // the star widget read-only. `textContent` returns it, and the first capture of
    // this surface opened with a jQuery call.
    render(`
      <div class="display-post-wrapper-inner">
        <a class="display-post-name owner" href="/profile/1234567">คุณนักชิม</a>
        <div class="display-post-story">
          อาหารทะเล ปรุงสดๆ ใหม่ๆ
          <script>$('.sel').rating('readOnly', true);</script>
        </div>
      </div>
    `)
    const [opening] = readPantipPage(LIMITS).posts
    expect(opening?.text).toContain("อาหารทะเล")
    expect(opening?.text).not.toContain("readOnly")
  })
})

/**
 * The markup `pantip.forum food` actually returned, reduced to two rows.
 *
 * Copied from the stored fragments of the first real listing capture, and the shape
 * is the finding: the topic link sits inside `<h2>` inside a *title* `<div>` that has
 * a class, and the row links itself a second time from a sibling `<span>`. Everything
 * else about the row — who wrote it, when, how many people answered — is in a
 * different child of the row entirely.
 */
const REAL_LISTING = `
  <ul class="pt-list">
    <li class="pt-list-item">
      <div class="pt-list-item__title">
        <h2><a href="https://pantip.com/topic/42601472" class="gtm-main-content-link">24 ร้านแนะนำ</a></h2>
        <span><a href="https://pantip.com/topic/42601472"></a></span>
      </div>
      <div class="pt-list-item__info">
        <a href="/profile/1234567">คุณสมชาย</a>
        <span title="12 กันยายน 2569 เวลา 09:00 น.">12 ก.ย.</span>
      </div>
      <div class="pt-li_stats">
        <span class="pt-li_stats-comment"><i class="material-icons">message</i>18</span>
        <span class="pt-li_stats-vote"><i class="material-icons">thumb_up_2</i>7</span>
      </div>
    </li>
    <li class="pt-list-item">
      <div class="pt-list-item__title">
        <h2><a href="https://pantip.com/topic/42710991" class="gtm-main-content-link">เมนูปลาทู</a></h2>
      </div>
      <div class="pt-list-item__info"><a href="/profile/7654321">คุณมานี</a></div>
    </li>
  </ul>`

describe("finding the row", () => {
  it("climbs past the title wrapper, which is what the first real listing did not do", () => {
    // 259 rows came back with a title, an href and six nulls. The selectors were
    // fine; the scope was `<div class="pt-list-item__title">`, because the old rule
    // was `closest("li, article, tr, div[class]")` and that div has a class. Every
    // field below lives outside it.
    render(REAL_LISTING)
    const [first] = readPantipPage(LIMITS).topics
    expect(first?.title).toBe("24 ร้านแนะนำ")
    expect(first?.authorName).toBe("คุณสมชาย")
    expect(first?.authorHref).toBe("/profile/1234567")
    expect(first?.timeLabel).toBe("12 กันยายน 2569 เวลา 09:00 น.")
    expect(first?.commentLabel).toBe("18")
  })

  it("stops before swallowing the next row", () => {
    // The other half of the rule. Climbing is bounded by content, not by class name:
    // the `<ul>` contains a link to a different topic, so the `<li>` was the row.
    render(REAL_LISTING)
    const topics = readPantipPage(LIMITS).topics
    expect(topics).toHaveLength(2)
    expect(topics[1]?.authorName).toBe("คุณมานี")
    // Row one's fields did not bleed into row two.
    expect(topics[1]?.commentLabel).toBeNull()
  })

  it("does not treat a row's second link to itself as a different topic", () => {
    // The row links its own topic twice and the copies differ by tracking
    // parameters, so the climb compares topic ids rather than hrefs.
    render(`
      <ul><li class="pt-list-item">
        <div class="t"><a href="/topic/43210987?ref=a">x</a></div>
        <div class="i"><a href="/topic/43210987?ref=b">y</a><a href="/profile/9">คุณเอ</a></div>
      </li></ul>`)
    const [only] = readPantipPage(LIMITS).topics
    expect(only?.authorName).toBe("คุณเอ")
  })

  it("takes the timestamp from the title attribute, which is the absolute one", () => {
    // Pantip's date is a bare `<span title="…">` with an abbreviation in it, and the
    // attribute carries a year and a clock where the text carries "12 ก.ย.". Four
    // guesses — `abbr`, `<time>`, a "date" class, a "time" class — all missed it, and
    // a real listing returned 259 null timestamps before anyone knew that.
    render(REAL_LISTING)
    const [first] = readPantipPage(LIMITS).topics
    expect(first?.timeLabel).toBe("12 กันยายน 2569 เวลา 09:00 น.")
  })

  it("does not read an icon's name as part of a count", () => {
    // The silent one. Material Icons puts the glyph's name in the element's text, so
    // a count reads as `"thumb_up_2 7"` and `parseCount` returns **27** — a number
    // that looks like an answer. Today's icons are `message` and `add_box`, which
    // have no digits in them, so every count in the first real capture was right by
    // luck. Stripping the icon node is what makes it right on purpose.
    render(REAL_LISTING)
    const [first] = readPantipPage(LIMITS).topics
    expect(first?.commentLabel).toBe("18")
    expect(first?.voteLabel).toBe("7")
    expect(first?.voteLabel).not.toContain("thumb_up")
  })

  it("does not read a title as a count because an analytics class says 'voted'", () => {
    // The fourth thing the forum listing taught, and the one that nearly shipped.
    // Pantip tags a promoted row's title link `class="gtm-voted-topic"`, and
    // `[class*="vote"]` matches "vo**ted**". The old guard asked only whether the
    // text contained a digit — and a title with a date in it does — so four rows
    // recorded a headline as their vote count. A count is a number followed by at
    // most one unit word, and a headline is not.
    render(`
      <ul><li class="pt-list-item">
        <div class="pt-list-item__title">
          <a class="gtm-voted-topic" href="/topic/44226724">24 ร้านแนะนำ 12 กันยายน 2569 มา 4 จาน</a>
        </div>
        <div class="pt-li_stats"><span class="pt-li_stats-vote">7</span></div>
      </li></ul>`)
    const [only] = readPantipPage(LIMITS).topics
    expect(only?.voteLabel).toBe("7")
  })

  it("still takes a localised count that carries its own unit", () => {
    // The other side of the same rule, so that tightening it did not quietly become
    // "digits only". A number and one word is a count; a number and a sentence is not.
    render(`
      <ul><li class="pt-list-item">
        <a href="/topic/1">x</a>
        <span class="pt-li_stats-comment">34 ความคิดเห็น</span>
      </li></ul>`)
    expect(readPantipPage(LIMITS).topics[0]?.commentLabel).toBe("34 ความคิดเห็น")
  })

  it("stores the fragment from one level above the row", () => {
    // A fragment cropped to the scope the fields were read from cannot show a scope
    // error, which is the one kind of wrong guess it was bought to repair. The first
    // capture stored thirty of them and not one could explain its own nulls.
    render(REAL_LISTING)
    const [first] = readPantipPage(LIMITS).topics
    expect(first?.fragment).toContain("pt-list-item__title")
    // The `<ul>`, so a row misidentified one level too low is still visible.
    expect(first?.fragment).toContain("pt-list")
    expect(first?.fragment).toContain("42710991")
  })
})

describe("what it refuses to press", () => {
  it("counts a pager candidate instead of clicking one", () => {
    // A selector loose enough to find an unseen "more comments" control is loose
    // enough to press something else. The next capture says what it is called.
    render(`
      <div class="comment-footer"><button class="btn-more">ดูความคิดเห็นเพิ่มเติม</button></div>
      <button class="show-more">อีก</button>
    `)
    let clicks = 0
    for (const button of document.querySelectorAll("button")) {
      button.addEventListener("click", () => {
        clicks += 1
      })
    }
    // Two, not three: the three selectors overlap on the first button and
    // `querySelectorAll` returns a set of elements, so this counts controls rather
    // than matches — which is the number worth reading off a capture.
    expect(readPantipPage(LIMITS).nodeCounts["pager candidate"]).toBe(2)
    expect(clicks).toBe(0)
  })
})

describe("the blob and the walls", () => {
  it("stores the blob as a truncated string and says how long it really was", () => {
    const big = { rows: Array.from({ length: 30_000 }, (_, i) => `row-${i}`) }
    ;(window as unknown as Record<string, unknown>).__NEXT_DATA__ = big
    render(LISTING)
    const read = readPantipPage(LIMITS)
    expect(read.stateKeys).toContain("__NEXT_DATA__")
    expect(read.stateLength).toBe(JSON.stringify(big).length)
    expect(read.state).toHaveLength(200000)
    ;(window as unknown as Record<string, unknown>).__NEXT_DATA__ = undefined
  })

  it("falls back to the script tag, which is where Next.js usually puts it", () => {
    render(`<script id="__NEXT_DATA__" type="application/json">{"props":{"n":1}}</script>`)
    const read = readPantipPage(LIMITS)
    expect(read.stateKeys).toEqual(["script#__NEXT_DATA__"])
    expect(read.state).toBe(`{"props":{"n":1}}`)
  })

  it("reports what the blob might be called when every guess was wrong", () => {
    // P1.5 paid a session to learn that a diagnostic reporting only which guesses
    // were right stops one question short of the useful one. Names, never values.
    ;(window as unknown as Record<string, unknown>).PANTIP_BOOTSTRAP = { secret: "x" }
    render(LISTING)
    const read = readPantipPage(LIMITS)
    expect(read.stateKeys).toEqual([])
    expect(read.stateCandidates).toContain("PANTIP_BOOTSTRAP")
    expect(JSON.stringify(read.stateCandidates)).not.toContain("secret")
    ;(window as unknown as Record<string, unknown>).PANTIP_BOOTSTRAP = undefined
  })

  it("walks the prototype chain, because that is where the interesting globals live", () => {
    // The bug the first real capture found. `stateCandidates` came back empty on a
    // page that has a state blob, because it was built from `Object.keys(window)` —
    // which reports only a window's **own** enumerable properties. A named element
    // global (`<div id="APP_STATE">`) lives on the WindowProperties exotic object in
    // the prototype chain, and browsers put globals of their own on `Window.prototype`
    // besides. So the diagnostic written to answer "what is this blob really called"
    // answered "nothing", and the session that bought that answer bought a bug.
    //
    // Asserted through the prototype chain directly rather than by rendering an
    // element with an id: jsdom does not implement named element globals at all, so
    // the shape has to be built by hand. What is being tested is the traversal, and
    // the traversal is the part that was wrong.
    const proto = Object.getPrototypeOf(window) as Record<string, unknown>
    Object.defineProperty(proto, "APP_BOOTSTRAP_DATA", {
      value: { secret: "x" },
      enumerable: true,
      configurable: true,
    })
    render(LISTING)
    try {
      expect(Object.keys(window)).not.toContain("APP_BOOTSTRAP_DATA")
      const read = readPantipPage(LIMITS)
      expect(read.stateCandidates).toContain("APP_BOOTSTRAP_DATA")
      expect(JSON.stringify(read.stateCandidates)).not.toContain("secret")
    } finally {
      delete proto.APP_BOOTSTRAP_DATA
    }
  })

  it("says when a state key was an element rather than the payload", () => {
    // Also from the first real capture, and the quieter of the two findings.
    // `window.__NEXT_DATA__` was the *script element*, not its contents: the
    // `instanceof Node` guard caught it and the script-tag fallback then read it
    // properly, so the capture worked — but `stateKeys` listed `__NEXT_DATA__` plain
    // and reported a success that had actually been a near miss rescued by a
    // fallback. The label is what a person reads first, so the label should say so.
    render(`<script id="__NEXT_DATA__" type="application/json">{"props":{"n":1}}</script>`)
    const tag = document.querySelector("script#__NEXT_DATA__")
    ;(window as unknown as Record<string, unknown>).__NEXT_DATA__ = tag
    const read = readPantipPage(LIMITS)
    expect(read.stateKeys).toEqual(["__NEXT_DATA__ (element)", "script#__NEXT_DATA__"])
    expect(read.state).toBe(`{"props":{"n":1}}`)
    ;(window as unknown as Record<string, unknown>).__NEXT_DATA__ = undefined
  })

  it("names the wall rather than reporting that there is one", () => {
    render(`<div id="cf-wrapper"></div>`)
    expect(readPantipPage(LIMITS).wall).toBe("captcha")
    render(`<form><input type="password" name="pass"></form>`)
    expect(readPantipPage(LIMITS).wall).toBe("login")
    render(LISTING)
    expect(readPantipPage(LIMITS).wall).toBeNull()
  })
})

describe("the shape of a read", () => {
  it("is the interface capture.ts consumes", () => {
    render(LISTING)
    const read: PantipPageRead = readPantipPage(LIMITS)
    expect(Object.keys(read).sort()).toEqual(
      [
        "fragmentsStored",
        "href",
        "nodeCounts",
        "posts",
        "state",
        "stateCandidates",
        "stateKeys",
        "stateLength",
        "title",
        "topics",
        "wall",
      ].sort(),
    )
  })

  it("scrolls the document and reports the height it reached", () => {
    // jsdom has no layout and therefore no `scrollTo`. Stubbed rather than skipped:
    // the assertion is about what the function reaches for, not about a pixel.
    let scrolled = false
    window.scrollTo = () => {
      scrolled = true
    }
    render(LISTING)
    expect(scrollPantipPage()).toBe(document.body.scrollHeight)
    expect(scrolled).toBe(true)
  })
})
