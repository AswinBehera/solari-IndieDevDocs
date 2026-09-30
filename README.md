# Sourced

**Research documents for indie game developers, where every number carries its receipt.**

You write the case for your game (the pitch, the go/no-go, the postmortem) as you would
anyway. The numbers in it come from blocks that go and read Steam. Some read Steam's
public API. Others open each store page in a [Solari](https://getsolari.com) cloud browser
and keep the HTML plus a screenshot with the cited region marked. Every number in the
document opens the receipt it was read from, and the receipt drawer re-hashes the
archived bytes in your browser, so "this is what the run saw" is checked rather than
taken on trust.

```
"222 games on Steam carry Indie + Farming Sim + Cozy. Of the 8 closest, [0% (0 of 8)↗]
 disclose generative AI on their store page."
                                       └── click: the computation, its 8 inputs, and
                                           each input's store-page screenshot
```

## Why

Indie developers make expensive decisions on thin evidence: whether a niche is
crowded, what comparable games charge, how they are received, and how much of the
lane is filling with AI-generated work. The usual sources are a spreadsheet of
copy-pasted numbers nobody can trace, or third-party sites whose data you can't check.
Sourced keeps the question, the answer and the evidence in one document, and keeps
them attached to each other.

## The model

```
Document → Block → Run → Receipt → Fact
```

- A **block** is a question with parameters ("which games carry all of these tags?").
  In the document it is an atom that holds only its id. Its state lives in Postgres, so
  autosaving prose can never overwrite an answer.
- A **run** is one attempt to answer it. It records the parameters it answered, the
  runtimes it used (API, cloud browser, derived) and what it cost.
- A **receipt** is what a run saw, stored immutably and content-addressed by SHA-256:
  an API response, a page's HTML, a screenshot, or a computation's inputs and formula.
- A **fact** is one typed value read out of one receipt, with a locator (JSON path,
  quoted text, CSS selector, screenshot box, or the facts it was computed from).
  Prose cites facts, never receipts.

Blocks form a DAG. A snapshot reads its games from a comparables block, and the AI share
reads from a snapshot. Change or prune a source and the blocks below it say they are
stale and what re-running would cost. They never re-run on their own.

| Block | Reads | Runtime |
| --- | --- | --- |
| `/comparables` | Steam store search for games carrying every tag you pick. Strike rows that aren't real comparables; the list refills from the same search. | API |
| `/snapshot` | For each comparable: price, release date and developers (appdetails), review counts (appreviews), and the store page itself: tags and Steam's AI-generated-content disclosure. | API + Solari browser |
| `/ai-share` | The share of those store pages that disclose generative AI. Pages that could not be read are left out of the denominator and named, never counted as clean. | Derived |

## Built on Solari

Store pages are read in Solari cloud browsers in `direct` mode, one session per page,
three at a time. Each page yields two receipts, paired: the HTML the browser rendered,
and a full-page screenshot with boxes around the regions facts were read from. The
receipt drawer shows the screenshot scrolled to the box, and lists the browser session
id. Without `SOLARI_API_KEY` the same blocks fall back to plain HTTP, and the receipts
say so.

The kernel (`packages/samsara/kernel`) owns sessions, retries, deadlines and the
per-owner budget. The worker (`apps/worker`) claims `block.run` jobs from a Postgres
queue and, when asked, cascades to the blocks downstream.

## Run it

You need Node 22.9+, pnpm 11, and Docker (for Postgres). A Solari key is optional but is
the point: without one, store pages are read over HTTP and there are no screenshots.

```sh
git clone https://github.com/AswinBehera/solari-Sourced.git && cd solari-Sourced
pnpm install
cp .env.example .env          # set SOLARI_API_KEY; DATABASE_URL already points at local Docker
pnpm db:up && pnpm db:migrate
pnpm dev                      # API :8789 (wrangler), web :5174 (Vite), worker loop
```

Open http://localhost:5174, pick two or three Steam tags under **Scout a niche**, create
the document, and press **Run** on the first block with "then the blocks below" ticked.
Eight store pages take about a minute. Click any underlined number for its receipt;
press **Cite** to put a number in your prose.

Auth in development: `apps/api/.dev.vars` sets `DEV_OWNER_ID`, which makes the API accept
any bearer token as that owner. It is committed on purpose and holds nothing secret;
`wrangler deploy` never uploads it.

## Respecting Steam

- Only Steam's own public endpoints and store pages, at a polite concurrency. No
  SteamDB or other third-party scraping, no logged-in sessions, and no evading age
  gates or bot checks. A gated page becomes an `unavailable` fact, not a workaround.
- Receipts stay on the machine that ran the block (`apps/web/public/receipts/`,
  gitignored). They are Steam's content and are not ours to redistribute.
- The data is for your own research. Sourced is not a data product.

## Layout

```
apps/api            Hono on Cloudflare Workers: docs, blocks, runs, facts, receipts, job SSE
apps/worker         job runner; apps/worker/src/research/block-run.ts answers every block kind
apps/web            React + Tiptap editor, block cards, fact chips, receipt drawer
packages/research/core   the model, staleness, cost estimates, fact formatting (pure, tested)
packages/research/db     Postgres store and the migration history
packages/research/steam  Steam URLs and parsers, each returning a locator with its value
packages/samsara/*       the kernel: jobs, sessions, budgets, Solari launcher
```

## History

This repository started as Doen Thang, a travel document built on the same kernel; that
history is kept below the pivot commit. The travel packages (`packages/travel/*` and the
travel pages under `apps/web/src`) are no longer imported or built and will be removed.
See [`docs/HANDOFF.md`](docs/HANDOFF.md) for what is open.
