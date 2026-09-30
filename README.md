# Doen Thang

A travel document that fills itself from what locals actually say — built on a
domain-agnostic service layer for **situated observation**: seeing the internet the way a
specific kind of person in a specific place sees it, repeatedly, at scale, and turning
that into structured evidence.

Two things live in this repository, and the boundary between them is enforced rather
than intended:

| Scope | What it is | Knows about travel? |
| --- | --- | --- |
| `@samsara/*` | The service layer. Personas, sessions, budgets, harvesting, extraction. Runs on [Solari](https://getsolari.com). | **No.** Mechanically checked. |
| `@dt/*` | Doen Thang, the first vertical. Places, trips, postcards, the document. | Yes. That is its job. |

The service layer is called Samsara. It is not a travel product with the travel parts
factored out — it is a general primitive that travel happens to be the first buyer of.
Algorithm auditing, geo-pricing intelligence, localised SERP monitoring and in-language
market research are the same machinery pointed somewhere else.

> **Status:** Phase 0, in progress. The kernel runs and opens real browser sessions.
> There is no product yet. See [`docs/STATUS.md`](docs/STATUS.md) for exactly where
> things stand and [`docs/PLAN.md`](docs/PLAN.md) for where they are going.

## The idea

Ask Google for "best things to do in Bangkok" and you get the same nine temples everyone
else gets, because you are asking as a tourist from wherever you are sitting. The
interesting content — the noodle shop with forty reviews all in Thai, the market that
locals post about and guidebooks do not — is served to people the platform thinks are
local, and never surfaces for you.

So we ask as somebody else. A **persona** is a browsing viewpoint: a language, a clock, a
set of stored preferences, a warmed profile, an egress country. Point it at a public
surface, read what comes back, and the difference between what two personas see is the
product.

### One thing we got wrong, and what it taught us

The obvious design is "proxy through the country you care about." It is mostly wrong.
Platforms do not serve content *from* servers in your country; they rank it from a
profile assembled out of signals, roughly in this order of weight:

1. Account region — sticky from signup, does not follow your IP
2. The language and script of the query
3. Stored region preferences (`gl`/`hl`, content languages)
4. Browser locale and timezone
5. Engagement history on a warmed profile
6. **The egress IP** — last, and the only one we cannot always buy

A Thai IP asking in English gets the global viral feed. A `th-TH` browser on
`Asia/Bangkok` asking in Thai does not — from anywhere. We found this the hard way when
our provider turned out to have no Thai egress at all, and it made the architecture
better: the viewpoint is a stack of signals, the IP is one ingredient, and every session
records which signals were actually present so the results stay interpretable.

Written up in [ADR-0015](docs/adr/0015-viewpoint-over-egress.md). Measuring the real
weight of each signal is the first task of Phase 1, because the list above is an informed
hypothesis, not a result.

## Layout

```
packages/samsara/     the service layer — no travel vocabulary appears here
  core/               Zod schemas for the engine entities
  db/                 Drizzle tables for those entities
  kernel/             every cloud session goes through here
  personas/ sources/ harvest/ refine/ eyes/ llm/
packages/travel/      @dt/* — the travel vertical
  core/ db/ travel-pack/ ui/
  lab/                the Persona Lab's experiments — designs, runners, results
apps/
  web/                React + Vite. The document.
  api/                Hono. Thin: auth, rows, SSE.
  worker/             Scheduled GitHub Actions job. The pipeline.
docs/
  PLAN.md             the whole plan, phase by phase
  STATUS.md           where we actually are
  adr/                0001–0015, why each decision was made
examples/             upstream Solari cookbook, kept verbatim
```

## The kernel

`@samsara/kernel` is the only way anything opens a cloud session. Not a convention — the
seam check enforces it, and exactly one file in the repository imports the provider SDK.

```ts
const result = await kernel.withBrowser(
  "harvest",
  { country: "sg", locale: "th-TH", timezoneId: "Asia/Bangkok" },
  async (page) => read(page),
)
```

That call, and everything like it, gets:

- **A budget refusal before anything opens.** Three meters — provider minutes, LLM tokens,
  geocoding calls — expressed as counts rather than dollars, because rates drift and counts
  do not. Exhausted means refused, by name. There is no soft mode.
- **A hard deadline that force-closes.** The provider's own timeout is a rolling idle
  window, so a page that never goes idle is never caught by it. A session nobody is
  watching is a session somebody is still paying for.
- **A failure that says whose fault it is.** `budget | blocked | timeout | upstream |
  config | internal`. The `upstream`/`internal` split is the one that matters: it is how a
  provider maintenance window stops looking like our bug. Only those two are retryable.
- **Minutes metered from measurement, not estimate**, whether the operation succeeded
  or not.
- **Structured logs with nowhere to put a secret.** This repository is public, so its CI
  log is public. The event type is a closed union with no free-form field anywhere —
  logging a credential does not typecheck. A redaction denylist was the obvious design and
  the wrong one; denylists leak by omission.

## The seam

No travel vocabulary appears under `packages/samsara/**`. No `@samsara/*` package imports
from `@dt/*`. No engine table carries a foreign key into a travel table.

All three are checked, not trusted — the database one against a live Postgres, and the
engine's own test fixtures are written around a made-up domain called `atlas` precisely so
that nothing travel-shaped can quietly become load-bearing.

The point is cost, not purity: when there is a second vertical, or a buyer for the
platform alone, `packages/samsara/` leaves as a `git filter-repo` rather than a rewrite.

## Running it

Requires Node 22.9+, pnpm 11, and Docker.

```bash
pnpm install
cp .env.example .env        # then fill in SOLARI_API_KEY
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm check                  # lint, typecheck, seam, test
```

`pnpm check` spends nothing and needs no API key: the kernel talks to
`BrowserLauncher`/`SandboxLauncher` interfaces, and the tests supply fakes.

It does need the database, though, and it says so rather than working around it.
The queue's `FOR UPDATE SKIP LOCKED` tests are the only ones that can check the
property everything else rests on — two runners never claim the same row — so if
`DATABASE_URL` is unset they **fail** rather than skipping. `pnpm test` loads `.env`
for you, which is why the Node floor is 22.9. If you genuinely want to run without
Docker, say so: `SAMSARA_NO_DB=1 pnpm check`. The escape hatch exists; it just has
to be visible, the same bargain `// seam:allow` strikes below.

One of those steps is unusual enough to name. `pnpm check:seam` enforces the
claim the whole architecture rests on — that `packages/samsara/**` does not know
it is about travel (ADR-0009). It fails on travel vocabulary, on an engine
package that declares or imports anything under `@dt/*`, and it counts every
`// seam:allow <reason>` escape hatch. Above five allows the seam is in the wrong
place and gets redesigned rather than extended. It currently uses **zero**.

To run all three deployables with hot reload:

```bash
pnpm dev
```

| | | |
|---|---|---|
| web | http://localhost:5173 | Vite, HMR. Proxies `/api/*` to the API, so dev and production agree about origin. |
| api | http://localhost:8788 | `wrangler dev` on the real Workers runtime, not a Node emulation. |
| worker | — | Wakes, drains, exits, sleeps 3s, repeats. `tsx watch` restarts it on save. |

Three things about that worth knowing before they surprise you:

- **The API runs on workerd**, so a Node-only import fails here exactly as it would in
  production, rather than at deploy time.
- **The worker is on a timer, not a daemon.** Production has no long-lived worker
  (ADR-0014): Actions wakes a runner, it drains, it exits. Dev reproduces that shape
  deliberately — a persistent dev worker would hide every bug that only appears because
  the process ends between jobs.
- **The API reaches Postgres through Hyperdrive's local connection string**, pointed at
  the docker-compose database. No Cloudflare account is needed to develop.

`SUPABASE_URL` is only required once a request actually authenticates, so `pnpm dev`
works on a clean checkout with nothing but Docker running.

### Try the app

[![Two minutes through the app](docs/demo/walkthrough.jpg)](docs/demo/walkthrough.mp4)

[`docs/demo/walkthrough.mp4`](docs/demo/walkthrough.mp4) (1:49) records the steps below,
running locally with no API key. It covers:
- onboarding refusing a trip that ends before it starts;
- the `/` menu;
- `/place` in Thai and English;
- two OpenStreetMap places becoming cards and map pins;
- the seven-country price card;
- *Under the hood*.

Tested from a fresh clone on 30 September 2026. The first part needs no API key.

```bash
pnpm db:seed:demo      # a demo trip, and a real seven-country hotel price check
npx tsx --env-file=.env tools/load-osm.ts --from data/osm/bangkok.json.gz --commit
pnpm dev               # then open http://localhost:5173
```

The second line loads 27k named Bangkok places from a committed OpenStreetMap snapshot
(`data/osm/`). Without it, `/place` in a trip finds nothing.

1. **Start a trip.** You answer three questions and get a document. Type `/` in it for
   the commands.
2. **`/place` searches by name, in Thai or English.** Places the pipeline has scored come
   first, with their local/tourist meter. Below them are OpenStreetMap matches marked
   *not scored yet*. Pick one and it becomes a card with a coordinate and a pin on the
   trip's map.
3. **Open `/trips/00000000-0000-4000-8000-0000000000d1`** to see the demo trip's price
   card: one hotel page, as seven countries' visitors were charged for it.

**With your own keys, the pipeline fills in the scores.** Set `SOLARI_API_KEY` and
`OPENROUTER_API_KEY` in `.env`, then:

```bash
npx tsx --env-file=.env tools/harvest-corpus.ts --limit 5            # prints the estimate
npx tsx --env-file=.env tools/harvest-corpus.ts --limit 5 --commit   # queues five searches
```

`pnpm dev`'s worker drains the queue: harvest → extract → resolve → dedup → score. Five
searches cost a few cents. Scored places then appear at the top of `/place`, and under
*Under the hood → Place scores*. Without `--limit` the tool queues all 120 queries
(about $0.50). An extraction is minutes of model time, so a big batch takes a while.
*Under the hood → Spend & jobs* shows the queue.

One test does spend money, and it is skipped unless you ask for it:

```bash
pnpm --filter @samsara/kernel test:live
```

It opens one real browser session, reads its egress address, checks that the viewpoint
reached the page, and closes. Costs about 0.06 browser-minutes. It stays visible as a
*skipped* test in the normal run rather than being hidden behind a filename, because a
live test nobody remembers exists is a live test nobody runs before shipping.

## Cost

The whole demo runs under a hard $20 ceiling, which is a constraint on the architecture
rather than a note to act on later — it is why the budget guard exists in Phase 0 instead
of Phase 8, and why ceilings are counts with their derivation rate in a comment. No price
is hardcoded anywhere. [`docs/PLAN.md` §8](docs/PLAN.md) has the arithmetic.

## Built on Solari

[Solari](https://getsolari.com) supplies the cloud browsers, sandboxes, residential proxy
egress, and profile storage. The `examples/` directory is their cookbook, kept verbatim.

## License

MIT — see [LICENSE](LICENSE).
