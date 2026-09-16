/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest"
import {
  clickMapsTab,
  expandMapsReviews,
  type MapsPageRead,
  readMapsPage,
  scrollMapsPane,
} from "./inpage.js"

/**
 * The one file in this package that runs against a real DOM.
 *
 * `jsdom` is a test-only dependency and it is declared **per file**, not for the
 * package, because the rest of `@samsara/sources` must keep compiling for a runtime
 * that has no `document` — a package-wide DOM environment would let a non-DOM file
 * start depending on one and stay green. Same reasoning as the triple-slash
 * reference in `inpage.ts`, applied to the test runner.
 *
 * It is here because of what P1.5 gave up. The other two adapters store a tree and
 * parse it for free, so their in-page half is four lines and a stub is enough to
 * test it. This one extracts every field inside the browser, which means a selector
 * that moved is a billed session rather than a re-parse — and a stub would only
 * test my model of a DOM. A real `querySelector`, real document order and a real
 * `closest` are the whole point.
 *
 * What it still cannot test is whether these selectors match *Google's* markup. The
 * fragments below are my model of it. Only a recorded capture settles that, which
 * is what `nodeCounts` in the payload is for.
 */

/** Exactly what Playwright does to it: the source crosses, the scope does not. */
function serialised<T>(fn: T): T {
  return new Function(`return (${String(fn)})`)() as T
}

function render(html: string): void {
  document.body.innerHTML = html
}

/**
 * A review as Maps lays one out, including the two details that matter: the "more"
 * control sits *inside* the text wrapper, and it carries the same `data-review-id`
 * as the container around it.
 */
const REVIEW = `
  <div role="tablist">
    <button role="tab" aria-label="Tổng quan">Tổng quan</button>
    <button role="tab" aria-label="Bài đánh giá">Bài đánh giá</button>
    <button role="tab" aria-label="Giới thiệu">Giới thiệu</button>
  </div>
  <div role="feed">
    <div data-review-id="ChdDSUhNMG9nS0VJ" class="jftiEf">
      <a href="https://www.google.com/maps/contrib/104512/reviews">
        <img src="https://lh3.googleusercontent.com/a/avatar-of-a-person">
      </a>
      <div class="d4r55">Ngọc Anh</div>
      <div class="RfnDt">Local Guide · 42 bài đánh giá</div>
      <span role="img" aria-label="5 sao"></span>
      <span class="rsqaWe">2 tháng trước</span>
      <div class="MyEned">
        <span class="wiI7pd">Bánh mì ở đây rất ngon, chủ tiệm dễ thương.</span>
        <button data-review-id="ChdDSUhNMG9nS0VJ" jsaction="pane.review.expandReview">Thêm</button>
      </div>
      <img src="https://lh5.googleusercontent.com/p/photo-one">
      <button jsaction="pane.review.helpful" aria-label="Hữu ích (3)"></button>
      <div jsaction="pane.review.ownerResponse">Cảm ơn bạn rất nhiều!</div>
    </div>
  </div>
`

/**
 * A review as Maps actually laid one out on 2026-09-13, which is **not** what
 * `REVIEW` above models.
 *
 * There is no `/contrib/` link — Google stopped wrapping the reviewer's name in
 * one — so the avatar sits loose in the card, and the review's own photos are
 * painted as CSS backgrounds rather than served as `img` tags. The URLs are
 * verbatim from `maps-reviews-th-TH-2026-09-13`; the markup around them is
 * reconstructed, because that capture stored no fragment. That absence is the
 * reason `fragment` now exists.
 */
const REVIEW_NO_CONTRIB = `
  <div data-review-id="Ci9DQUlRQUNvZENodHl" class="jftiEf">
    <img src="https://lh3.googleusercontent.com/a-/ALV-UjV5ja_wnult7FraD6MaPAqz8mE6L1D1H6UJniNfSkRlDj2EDZlpew=w36-h36-p-rp-mo-ba12-br100">
    <div class="d4r55">Mr.Katoon Kamo</div>
    <span class="wiI7pd">กาแฟอร่อย</span>
    <div style='background-image: url("https://lh3.googleusercontent.com/grass-cs/ACvplmO_4ZJVbRLj9MFFAM1"); width: calc(50% - 1px);'></div>
  </div>
`

describe("what crosses into the page", () => {
  /**
   * The rule every in-page function in this package lives under, asserted rather
   * than trusted. TikTok paid two billed sessions to establish it: a named inner
   * function is rewritten by the bundler as `__name(fn, "…")`, and `__name` lives at
   * module scope, which does not cross.
   */
  for (const fn of [readMapsPage, clickMapsTab, scrollMapsPane, expandMapsReviews]) {
    it(`${fn.name} declares no function of its own`, () => {
      const source = String(fn).slice(String(fn).indexOf("{"))
      expect(source).not.toMatch(/\bfunction\b/)
      expect(source).not.toContain("=>")
      expect(source).not.toContain("__name")
    })
  }

  it("survives serialisation and re-parsing through toString", () => {
    render(REVIEW)
    const read = serialised(readMapsPage)()
    expect(read.reviews).toHaveLength(1)
  })
})

describe("reading a review", () => {
  it("takes the container and not the button inside it", () => {
    // Both carry `data-review-id`. `querySelectorAll` is in document order and an
    // ancestor precedes its descendants, so the first one seen is the outer one —
    // and the count of raw matches is still reported, because two matches for one
    // review is exactly the sort of thing that should be visible in the artifact.
    render(REVIEW)
    const read = readMapsPage()
    expect(read.reviews).toHaveLength(1)
    expect(read.nodeCounts["[data-review-id]"]).toBe(2)
  })

  it("reads the sentence without the word More on the end of it", () => {
    // The "more" control is inside the text wrapper, so `.MyEned`'s textContent is
    // the review plus a button label. The inner span is the review.
    render(REVIEW)
    const [review] = readMapsPage().reviews
    expect(review?.text).toBe("Bánh mì ở đây rất ngon, chủ tiệm dễ thương.")
    expect(review?.text).not.toContain("Thêm")
  })

  it("copies the localised labels verbatim and interprets none of them", () => {
    render(REVIEW)
    const [review] = readMapsPage().reviews
    expect(review?.ratingLabel).toBe("5 sao")
    expect(review?.relativeTime).toBe("2 tháng trước")
    expect(review?.helpfulLabel).toBe("Hữu ích (3)")
    expect(review?.authorMeta).toBe("Local Guide · 42 bài đánh giá")
  })

  it("keeps the owner's reply, and keeps it out of the review", () => {
    // It is text in the local language, so it is evidence. It is written by the
    // subject rather than a visitor, so folding it into `text` would file marketing
    // copy as testimony.
    render(REVIEW)
    const [review] = readMapsPage().reviews
    expect(review?.ownerReply).toBe("Cảm ơn bạn rất nhiều!")
    expect(review?.text).not.toContain("Cảm ơn")
  })

  it("collects the review's photo and not the author's face", () => {
    render(REVIEW)
    const [review] = readMapsPage().reviews
    expect(review?.photoRefs).toEqual(["https://lh5.googleusercontent.com/p/photo-one"])
  })

  it("skips the author's face when the link it used to hang from is gone", () => {
    render(REVIEW_NO_CONTRIB)
    const read = readMapsPage()
    const [review] = read.reviews
    // The avatar is excluded on its URL shape, because the `/contrib/` guard that
    // used to exclude it no longer matches anything on this page. What remains is
    // the review's own photo, still as the raw `style` value — unwrapping `url(…)`
    // is interpretation and belongs to `parse`, which does it.
    expect(review?.photoRefs).toHaveLength(1)
    expect(review?.photoRefs[0]).toContain("grass-cs/ACvplmO_4ZJVbRLj9MFFAM1")
    expect(review?.photoRefs[0]).not.toContain("ALV-Uj")
    expect(review?.authorHref).toBeNull()
    expect(review?.authorName).toBe("Mr.Katoon Kamo")
  })

  it("counts every face it skipped, so a guard that stops firing is visible", () => {
    // The whole point. The first guard broke in production and said nothing; five
    // people's photographs went into a capture under a comment claiming they were
    // filtered out. A skip that is not counted is indistinguishable from a skip
    // that never happened, and `0` next to a review count is now a contradiction
    // somebody can read off the file without opening a browser.
    render(REVIEW_NO_CONTRIB)
    expect(readMapsPage().nodeCounts.avatarsSkipped).toBe(1)

    render(REVIEW)
    expect(readMapsPage().nodeCounts.avatarsSkipped).toBe(1)

    render(`<div data-review-id="x"><span class="wiI7pd">no pictures here</span></div>`)
    expect(readMapsPage().nodeCounts.avatarsSkipped).toBe(0)
  })

  it("keeps a photo served from the same host as the face it rejects", () => {
    // The shape rule is narrow on purpose: it is anchored to the `/a/` and `/a-/`
    // path prefixes, not to the hostname, so a review photo on googleusercontent
    // survives it. A guard that ate the evidence would be worse than the leak.
    render(`
      <div data-review-id="y">
        <img src="https://lh3.googleusercontent.com/grass-cs/ACvplmREALPHOTO">
        <img src="https://lh3.googleusercontent.com/a-/ALV-UjFACE">
      </div>
    `)
    const [review] = readMapsPage().reviews
    expect(review?.photoRefs).toEqual([
      "https://lh3.googleusercontent.com/grass-cs/ACvplmREALPHOTO",
    ])
    expect(readMapsPage().nodeCounts.avatarsSkipped).toBe(1)
  })

  it("stores the card's markup, because a null with nothing beside it explains nothing", () => {
    render(REVIEW_NO_CONTRIB)
    const read = readMapsPage()
    const [review] = read.reviews
    // Three of nine plans returned null on the first real capture and not one of
    // them could be told from a true absence, because this field did not exist.
    expect(review?.fragment).toContain("data-review-id")
    expect(review?.fragment).toContain("background-image")
    expect(read.nodeCounts.reviewFragments).toBe(1)
  })

  it("drops scripts and styles from the fragment and truncates it", () => {
    render(`
      <div data-review-id="z">
        <script>window.tracked = 1</script>
        <style>.a{color:red}</style>
        <span class="wiI7pd">${"ก".repeat(4000)}</span>
      </div>
    `)
    const [review] = readMapsPage().reviews
    expect(review?.fragment).not.toContain("window.tracked")
    expect(review?.fragment).not.toContain("color:red")
    expect(review?.fragment?.length).toBe(3000)
  })

  it("reads the author's name from the div beside their link", () => {
    render(REVIEW)
    const [review] = readMapsPage().reviews
    expect(review?.authorName).toBe("Ngọc Anh")
    expect(review?.authorHref).toContain("/contrib/104512")
  })

  it("returns nulls rather than guesses when the markup has moved", () => {
    render(`<div data-review-id="abc"><span>something unrecognisable</span></div>`)
    const [review] = readMapsPage().reviews
    expect(review?.reviewId).toBe("abc")
    expect(review?.text).toBeNull()
    expect(review?.ratingLabel).toBeNull()
    expect(review?.authorName).toBeNull()
  })

  it("skips a node whose id is empty", () => {
    render(`<div data-review-id=""><span class="wiI7pd">orphan</span></div>`)
    expect(readMapsPage().reviews).toHaveLength(0)
  })
})

describe("reading the result list", () => {
  const LIST = `
    <div role="feed">
      <div class="Nv2PK">
        <a aria-label="Tiệm Bánh Ngọc"
           href="https://www.google.com/maps/@10.77,106.69,17z/data=!4m6!3m5!1s0x31752f3e:0xb2a1c9!8m2">x</a>
        <span role="img" aria-label="4,6 sao"></span>
        <span class="UY7F9" aria-label="231 bài đánh giá"></span>
        <div class="W4Efsd">Tiệm bánh · 12 Đường Nguyễn Huệ</div>
        <div class="W4Efsd">Mở cửa · Đóng cửa lúc 21:00</div>
      </div>
      <a href="https://www.google.com/maps/contrib/104512/reviews">a contributor, not a result</a>
      <a href="https://support.google.com/maps">help</a>
    </div>
  `

  it("recognises a result by its feature id and ignores the chrome around it", () => {
    render(LIST)
    const read = readMapsPage()
    expect(read.entities).toHaveLength(1)
    expect(read.entities[0]?.name).toBe("Tiệm Bánh Ngọc")
    expect(read.nodeCounts["a[href*=/maps/]"]).toBe(1)
  })

  it("keeps every detail line in the order the card rendered them", () => {
    render(LIST)
    expect(readMapsPage().entities[0]?.detailLines).toEqual([
      "Tiệm bánh · 12 Đường Nguyễn Huệ",
      "Mở cửa · Đóng cửa lúc 21:00",
    ])
  })

  it("refuses an accessibility label that happens to sit where a count sits", () => {
    // Verbatim from `maps-search-cafes-th-TH-2026-09-13`, where `span +
    // span[aria-label]` matched this on three of six cards and filed "no
    // wheelchair accessible entrance" as a review count. `parseCount` returned
    // null downstream, so nothing wrong reached `engagement` — the containment was
    // luck, and this is the guard that makes it a design.
    render(`
      <div role="feed"><div><a href="/maps/x/data=!1s0x1:0x2" aria-label="Brewlab Cafe Ari">
        <span>ร้านกาแฟ</span><span aria-label="ไม่มีทางเข้าที่รองรับเก้าอี้รถเข็น"></span>
      </a></div></div>
    `)
    const read = readMapsPage()
    expect(read.entities[0]?.reviewCountLabel).toBeNull()
    expect(read.nodeCounts.countLabelsRejected).toBe(1)
  })

  it("accepts a localised count whose number is not the first thing in it", () => {
    // The guard is only "contains a digit", on purpose. Pantip's equivalent is
    // anchored to a leading number because Thai listings put it first; a Maps
    // aria-label does not, and an anchored pattern here would reject the localised
    // forms this system exists to read.
    render(`
      <div role="feed"><div><a href="/maps/x/data=!1s0x1:0x2" aria-label="ร้าน">
        <span>ร้านกาแฟ</span><span aria-label="รีวิว 1,234 รายการ"></span>
      </a></div></div>
    `)
    const read = readMapsPage()
    expect(read.entities[0]?.reviewCountLabel).toBe("รีวิว 1,234 รายการ")
    expect(read.nodeCounts.countLabelsRejected).toBe(0)
  })

  it("keeps the leaf detail lines and not the wrapper that runs them together", () => {
    // A wrapper and its children both carry `W4Efsd`. Reading every match stored
    // the address twice and, in the wrapper's copy, welded it to the opening time
    // with no separator — because there was none in the DOM either.
    render(`
      <div role="feed"><div><a href="/maps/x/data=!1s0x1:0x2" aria-label="ร้าน"></a>
        <div class="W4Efsd">4.9</div>
        <div class="W4Efsd">
          <span class="W4Efsd">ร้านกาแฟ · 33 ซ. อารีย์ 3</span>
          <span class="W4Efsd">ปิดอยู่ · เปิดเวลา 09:00 น.</span>
        </div>
      </div></div>
    `)
    const [entity] = readMapsPage().entities
    expect(entity?.detailLines).toEqual([
      "4.9",
      "ร้านกาแฟ · 33 ซ. อารีย์ 3",
      "ปิดอยู่ · เปิดเวลา 09:00 น.",
    ])
    for (const line of entity?.detailLines ?? []) expect(line).not.toContain("3ปิดอยู่")
  })

  it("keeps the rating and the count apart, both as strings", () => {
    render(LIST)
    const [entity] = readMapsPage().entities
    expect(entity?.ratingLabel).toBe("4,6 sao")
    expect(entity?.reviewCountLabel).toBe("231 bài đánh giá")
  })

  it("reads both surfaces on every capture", () => {
    // A reviews capture that comes back holding result cards never left the search
    // page, and that is a different bug from an entity with no reviews. Reading both
    // costs nothing and is what makes the two distinguishable in the artifact.
    render(REVIEW + LIST)
    const read = readMapsPage()
    expect(read.reviews).toHaveLength(1)
    expect(read.entities).toHaveLength(1)
  })
})

describe("the blob and the walls", () => {
  it("stores the blob as a truncated string and says how long it really was", () => {
    const big = { rows: Array.from({ length: 30_000 }, (_, i) => `row-${i}`) }
    ;(window as unknown as Record<string, unknown>).APP_INITIALIZATION_STATE = big
    render(REVIEW)
    const read = readMapsPage()
    expect(read.stateKeys).toContain("APP_INITIALIZATION_STATE")
    expect(read.stateLength).toBe(JSON.stringify(big).length)
    expect(read.state).toHaveLength(200000)
    expect(read.stateLength).toBeGreaterThan(read.state?.length ?? 0)
    ;(window as unknown as Record<string, unknown>).APP_INITIALIZATION_STATE = undefined
  })

  it("records the tab labels it could not read", () => {
    // The reviews tab is chosen by position because its label is localised. This is
    // the field that turns a wrong position into something read off the artifact
    // instead of paid for twice.
    render(REVIEW)
    expect(readMapsPage().tabLabels).toEqual(["Tổng quan", "Bài đánh giá", "Giới thiệu"])
  })

  it("names the wall rather than reporting that there is one", () => {
    render(`<form action="https://consent.google.com/save"></form>`)
    expect(readMapsPage().wall).toBe("consent")
    render(`<div id="captcha-form"></div>`)
    expect(readMapsPage().wall).toBe("captcha")
    render(REVIEW)
    expect(readMapsPage().wall).toBeNull()
  })
})

describe("the three controls", () => {
  it("clicks a tab by position and reports when there is no tab strip", () => {
    render(REVIEW)
    let clicked = false
    document.querySelectorAll('[role="tab"]')[1]?.addEventListener("click", () => {
      clicked = true
    })
    expect(clickMapsTab(1)).toBe(1)
    expect(clicked).toBe(true)
    expect(clickMapsTab(9)).toBeNull()
    render("<div></div>")
    expect(clickMapsTab(1)).toBeNull()
  })

  it("scrolls the feed and falls back to the window when there is none", () => {
    // jsdom has no layout and therefore no `scrollTo`. Stubbed rather than skipped:
    // the assertion is about which element the function reaches for, not about
    // whether a pixel moved.
    window.scrollTo = () => {}
    render(REVIEW)
    expect(scrollMapsPane()).toBe(document.querySelector('div[role="feed"]')?.scrollHeight)
    render("<div></div>")
    expect(scrollMapsPane()).toBe(document.body.scrollHeight)
  })

  it("expands every truncated review, matching the action and not the label", () => {
    render(REVIEW)
    let clicks = 0
    for (const button of document.querySelectorAll("button[jsaction]")) {
      button.addEventListener("click", () => {
        clicks += 1
      })
    }
    expect(expandMapsReviews()).toBe(1)
    expect(clicks).toBe(1)
  })
})

describe("the shape of a read", () => {
  it("is the interface capture.ts consumes", () => {
    render(REVIEW)
    const read: MapsPageRead = readMapsPage()
    expect(Object.keys(read).sort()).toEqual(
      [
        "entities",
        "href",
        "nodeCounts",
        "reviews",
        "state",
        "stateCandidates",
        "stateKeys",
        "stateLength",
        "tabLabels",
        "title",
        "wall",
      ].sort(),
    )
  })
})
