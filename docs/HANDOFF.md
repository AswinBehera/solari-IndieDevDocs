# Handoff: Sourced

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

Typecheck is clean across core, db, steam, worker, api and web. Core has 9 tests.

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

1. **Delete the travel code.** Nothing imports it, and `apps/web/tsconfig.json` excludes
   it. Remove:
   - `packages/travel/*`
   - `apps/web/src/{trip,trips,places,lab,samsara,share,onboarding,kernel}`
   - the travel routes in `apps/api/src` (`lab`, `places`, `probes`, `trips`, `drift`
     and their tests)
   - the travel handlers in `apps/worker/src`

   Then drop `packages/travel/*` from `pnpm-workspace.yaml` and the tsconfig exclude.
2. **More block kinds**, on the same Recorder:
   - price history across regions (`cc=` per viewpoint)
   - review language mix
   - a follower/wishlist proxy from the community hub
   - "what changed since last run" as a diff of two runs' facts. Runs are kept for this.
3. **Sharing.** A read-only doc view whose chips open receipts. It needs receipts off the
   local disk first (see above).
4. **Disclosure coverage.** `ai.disclosure` reads Steam's "AI Generated Content
   Disclosure" section. A game that uses AI without disclosing it reads as "none". The UI
   says "disclose", never "uses".
