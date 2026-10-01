# Handoff: indieDevDocs

Written 30 September 2026, at the pivot from the travel app (Doen Thang) to Steam research
documents. The travel handoff is in git history, in this file before the pivot commit.

## What works, verified end to end on 30 September

From the web UI (`localhost:5174`), with a Solari key:

- **Scout a niche** with Indie + Farming Sim + Cozy created a document with three chained
  blocks. Run on the comparables block, with "then the blocks below" ticked, then did:
  - one store search (222 matches, 25 rows read, 8 kept)
  - 16 API calls and 8 Solari `direct` browser sessions (0.8 browser minutes)
  - AI share of 0% (0 of 8)
  - total 34 receipts, all in under two minutes from click to share.
- **Receipt drawer:**
  - The API response shows the value at its JSON path.
  - The store page shows its screenshot with the fact's box, tabbed with the paired HTML
    and the session id.
  - The share's computation lists its 8 input facts, each opening its own store-page receipt.
  - The drawer re-hashes the archived bytes; the JSON, screenshot and computation receipts
    opened in the walk all showed "bytes match".
- **Cite** puts a chip at the last caret position, or below the block when there is none.
  The chip is saved as `factChip{factId}` and prints the fact's value, not a copy of it.

Typecheck is clean across core, db, steam, worker, api and web. Core has 13 tests.

## Added 1 October: breadth and decisions

- **`/breadth` (`niche_map`)** ran on the same niche: 10 store searches in 22 seconds.
  - The niche: 225 games, with a median price of $9.99 across its first 25.
  - Six narrower lanes, for example +Idler: 82 games, median $3.99.
  - Three broader ones: without Farming Sim it is 3,128 games, 14× the niche.
  - Neighbour tags come from `data-ds-tagids` on the search rows, so they cost no
    store pages.
- **Steam requests now time out after 30 s** (`SteamClient` `timeoutMs`). Before this, one
  stalled search held a breadth run for 24 minutes. A lane that fails is named in the
  run's note, and the run is `partial`.
- **`/decision`** was walked in the browser:
  - Attach mode puts an Attach button beside every number from other blocks. Esc or
    Done leaves it.
  - Record writes a computation receipt holding the cited values.
  - Editing the statement afterwards marks the decision stale.
  - Evidence movement was checked by editing a fact in the database: the banner and the
    "now 225 games · Take the new reading" row appeared, and taking it swapped the fact id.
  - `blockViews` must pass the cited blocks' latest facts to `evidenceMoves`, not the
    decision's own facts. That bug got past the unit test.

## Added 1 October: `/reviews` (`review_signals`)

- Reads a comparables block's games from Steam's reviews API: per game, the newest 100
  reviews of any kind and the newest 100 negative ones, all languages. 16 requests for
  8 games, no browser, about 30 s.
- Per game: the recent score, hours played at review, negative reviews inside the
  two-hour refund window (and how many Steam marks refunded), languages. For the
  lane, one `review-signals` computation pools every sampled review once and cites the
  per-game facts.
- Facts hold counts only. Review text, author names and Steam ids stay in the JSON
  receipts on local disk. The test fixture has them removed.
- First run (Indie + Roguelike Deckbuilder + Pixel Graphics): 169 of 665 negative
  reviews (25%) were written under 2 hours played. The median hours at review are 12.1
  positive and 7.5 negative. Lost In Fantaland (71% recent vs 84% all-time) and Tower
  Tactics (79% vs 88%) are reviewed worse lately.
- **Read the trend with its window.** "Newest 100" spans 2 days for Balatro and 854 for
  Cento. The card shows each game's span.

## Added 1 October: charts

- `apps/web/src/research/editor/charts.tsx`: hand-drawn SVG, no chart library, the
  page's colour tokens. Every mark opens its fact's receipt.
- Comparables: price × reviews. Breadth: lane map (games × median reviews, both log).
  Reviews: hours histogram, recent vs all-time dumbbells, under-2 h share bars (pale
  under 20 negatives in the sample).
- The histogram needs `review.hours` `buckets`, added to the computation on 1 October.
  Reviews runs from before that show the other two charts only; re-run to get it.
- Scatter labels are placed greedily and dropped rather than overlapped; the dropped
  ones show on hover.

## Things that will bite you

- **`pnpm test` wipes the local database.** Some older suites truncate tables. Run a single
  package's tests (`pnpm --filter @rd/research test`) unless you mean it.
- **Receipts live on the disk of the machine that ran the worker**, under
  `apps/web/public/receipts/` (gitignored). The web server must be on the same machine to
  show them. A deployed setup needs `ReceiptArchive` backed by object storage. The
  interface is in the worker; only the filesystem implementation exists.
- **Vite listens on `::1`.** Use `localhost:5174`, not `127.0.0.1:5174`. The proxy to the
  API deliberately targets `127.0.0.1:8789`.
- **Staleness has three causes**, all computed in the API:
  - the source ran after this block's run started;
  - the snapshot's games differ from the source's current list (pruned);
  - the block's own question changed (`paramsChanged`: tags and sort only, since
    `exclude` and `limit` apply when facts are read).
- **Review counts differ between blocks, and should.** A comparables row takes them from
  the search result's tooltip; the snapshot takes them from `appreviews`. Each shows its
  own receipt.
- **Local Postgres runs in the container named `doen_thang_pg`.** It is shared with the
  travel app on the author's machine. A fresh clone gets a `research_docs` database from
  `docker-compose.yml`.

## Open

0. **Solari profiles and desktops.** Proposed and not built; see the end of this file.

1. **More block kinds**, on the same Recorder:
   - price history across regions (`cc=` per viewpoint)
   - review language mix
   - a follower/wishlist proxy from the community hub
   - "what changed since last run" as a diff of two runs' facts. Runs are kept for this.
2. **Sharing.** A read-only doc view whose chips open receipts. It needs receipts off the
   local disk first (see above).
3. **Review themes, judged.** `/reviews` counts when players review, not why. The next
   step reads the text already in the receipts:
   - an LLM proposes themes per lane, positive and negative separately;
   - a cheaper model tags each review against them, which gives counts;
   - every theme fact cites review ids and verbatim quotes, and the drawer checks each
     quote is in the archived JSON.
   The model and prompt go into a computation receipt, and the UI labels these facts
   "judged", never "read". `packages/samsara/llm` has an OpenRouter client from the
   travel app. It needs a second key, so it should stay optional for reviewers.
4. **Disclosure coverage.** `ai.disclosure` reads Steam's "AI Generated Content
   Disclosure" section. A game that uses AI without disclosing it reads as "none". The UI
   says "disclose", never "uses".

## Solari profiles and desktops

Ordered by value for the risk. 1 and 2 are built (1 October); the rest are proposals.

1. **Replays as receipts. Built.** Store-page sessions launch with `recording: true`.
   After the browser is released, the worker calls `kernel.replay(providerId)`, which
   polls `downloadReplay` past `ReplayPending` (the upload took about 6 s when measured).
   It archives the rrweb NDJSON as a `replay` receipt paired with the page's HTML.
   The receipt drawer shows the page group (HTML, screenshot, replay) as tabs and plays
   the replay with `rrweb-player`, loaded only when that tab opens. A missing replay is
   a run note; the page's other receipts stand. In the first live run, 7 of 8 pages kept
   a replay; in later runs about 3 of 8 did. The rest stay `ReplayPending` for good:
   the ones that arrive do so within about 6 s, and waiting 180 s instead of 60 s
   brought none of the others. Replays are now collected at the end of the run, all
   in parallel, with heartbeats, so a missing one costs at most 60 s once. Worth
   raising with Solari.
2. **A pinned viewpoint profile. Built.** Once per snapshot run, `kernel.ensureProfile`
   finds or creates `indiedevdocs-steam-us-<sha8>`, where the hash covers its cookies
   (the age-gate answer, the mature-content preference and English). A profile that
   already exists is never re-saved, so its version stays put. Each browser receipt
   records `profile` as `name@vN` (migration `0002_receipt_profile`). If the profile
   cannot be made, pages are still read, because `captureStorePage` sets the same
   cookies by hand.
3. **Regional viewpoints.** Same profile shape, plus `proxy: {country}`, which needs
   `stealth: true`. This is the "price across regions" block in Open #1. It needs a check
   that the README's "no evading bot checks" still holds: a proxy for locale is not
   evasion, but captcha solving would be, so `captcha` stays off.
4. **"Connect your Steamworks": dropped** (1 October, the owner's call). No logged-in
   Steam sessions, and Solari's `captcha` stays off everywhere. The safer route to
   your own numbers is Valve's Steamworks Web API with a publisher key, if that is
   ever wanted.
5. **A paused research desktop per document**, resumed when you open the doc
   (`pause`/`resume` snapshot RAM and disk), for checking a page by hand inside the same
   viewpoint the blocks used.
6. **Prototype blocks** in a sandbox, with `previewUrl(port)` embedding a playable build in
   the document beside the research it answers. This starts the "pipeline" half of the
   pitch.
