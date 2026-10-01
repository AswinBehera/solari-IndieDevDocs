# ADR-0014: Cloudflare for web and api; GitHub Actions for the worker; no Redis

- **Status:** Accepted
- **Date:** 2026-09-11
- **Decided by:** Aswin (architect) chose Cloudflare; the worker placement follows from its limits
- **Answers:** section 10, question 1 (Fly.io vs Railway)
- **Supersedes:** the "long-lived Node hosts on Fly.io or Railway" rule in section 2.2
- **Amends:** ADR-0004 (BullMQ on Redis)

## Context

The demo has a hard $20 ceiling (section 8). Fly.io and Railway both want a monthly fee for an
always-on box, and an always-on box is the single largest fixed cost in the original topology —
before Solari, before anything that actually produces output.

Cloudflare's free plan removes that fee. The question is whether all three deployables fit inside
it. They do not, and the reason is specific rather than general.

## The limit that decides it

Cloudflare Workers meter **CPU time, not wall-clock time**, and waiting on the network costs
nothing. HTTP-triggered Workers have no duration limit at all; Cron Triggers get 15 minutes of
wall clock. That is unusually well suited to work that is mostly waiting on a remote browser.

The catch is the free plan's CPU ceiling: **10 ms per invocation**, for both HTTP requests and
Cron Triggers.

- `apps/web` — static assets. No CPU concern. Fits.
- `apps/api` — thin by design: validate, enqueue, read. JWT verification, query building, and JSON
  serialisation are real CPU, so 10 ms is tight but plausible. Fits, conditionally.
- `apps/worker` — parses captured HTML and JSON. That is not I/O, it is computation, and it will
  exceed 10 ms on the first page it touches. **Does not fit, and no amount of care makes it fit.**

Workers Paid would raise the Cron Trigger ceiling to 30 seconds (15 minutes for hourly-or-slower
schedules) for $5/month. That would work. It would also consume a quarter of the entire budget to
solve a problem that a free runner solves for nothing.

## Decision

| Deployable | Where | Why |
|---|---|---|
| `apps/web` | Cloudflare Workers Static Assets | Free, global, zero config |
| `apps/api` | Cloudflare Workers (free) | Hono runs natively. Postgres via Hyperdrive, which is on the free plan at 100k queries/day |
| `apps/worker` | GitHub Actions workflow | A real Node process with no CPU ceiling — the right shape for driving a browser for minutes |

**And therefore: no Redis, and no BullMQ.** A queue exists to hand work to an always-on consumer.
Once the consumer is a scheduled job that wakes, drains, and exits, the queue is a table:
`SELECT ... FOR UPDATE SKIP LOCKED` against the Postgres we already run. That deletes a vendor, a
service to monitor, and a line item — and it removes the only remaining reason to pay for a box.

## Consequences

- **`apps/api` must stay genuinely thin, and this is now enforced by the platform rather than by
  discipline.** P0.5 measures CPU per request against the 10 ms ceiling and records the number. If
  it does not fit, the fallback is Supabase Edge Functions — free, Deno, and colocated with the
  database — not a paid Cloudflare plan.
- **Free Workers allow 50 subrequests per invocation.** A thin API makes one to three. Not a
  constraint today; it would become one if the API ever fanned out, which is another reason it
  must not.
- **Hyperdrive or Supavisor is effectively mandatory.** Workers have no persistent connection pool
  across isolates, so something must pool. Hyperdrive is free and uses the Workers TCP socket API.
  `nodejs_compat` must be set; it is on by default for compatibility dates from 2026-08-04.
- **Scheduled GitHub Actions are best-effort, not punctual.** Cron can be delayed under load, the
  minimum interval is five minutes, and a workflow in a repository with no activity for 60 days is
  disabled automatically. Anything scheduled must therefore record its own wall-clock time
  rather than assume the schedule it was meant to run on. (In practice every run is now dispatched,
  per ADR-0016, and the workflow has no schedule.)
- **No fourth meter. The repository is public** (`AswinBehera/solari-IndieDevDocs`), and GitHub Actions minutes are unmetered on public repositories. Had it
  been private, runner wall-clock minutes would have become a fourth thing the kernel has to count.
  They are not, so section 8 stays at three meters.
- **Public means the Actions log is public.** Anything the worker prints, anyone can read. No
  secret may be logged, and neither may captured content that identifies a person. The kernel's
  structured logger redacts by default: it logs meter counts, durations, session ids, and error
  classes — never request bodies, never raw captured text, never any value read from `process.env`.
  This is a hard rule in P0.4, not a convention.
- **Jobs must be idempotent and resumable.** A scheduled runner can be cancelled mid-flight; a
  long-lived worker mostly is not. Every job claims its rows, and a crashed claim is reclaimable
  after a lease expires. This is stricter than BullMQ required, and it is the real cost of this
  decision.
- **Redis is gone from `docker-compose.yml` as of this decision.** It was kept for one draft on
  the theory that the kernel's budget counters still wanted it; they do not. Counters move to
  Postgres rows keyed by meter and window, which is also more correct — a guard that forgets what
  it spent when a runner exits is not a guard. Dead infrastructure in a compose file is a trap.

## Resolved, 11 September 2026

**The repository is public**: `https://github.com/AswinBehera/solari-IndieDevDocs`. Actions minutes are
therefore unmetered, the budget stays at three meters, and — since this is a demo built *for* the
Solari team — a readable repository is part of the deliverable rather than a cost. The obligations
that follow are logging discipline (above) and the standing rule that no credential enters the
tree: `.env` is gitignored, `.env.example` carries names and never values, and every secret reaches
CI as a GitHub Actions secret.

## Alternatives rejected

- **Fly.io or Railway**, per the original section 2.2. The correct choice for a product with
  revenue; the wrong one for a demo whose entire compute budget is $20, where a fixed monthly fee
  competes directly with the browser minutes that produce the actual output.
- **Workers Paid at $5/month.** Buys a 30-second CPU ceiling on cron and keeps everything in one
  place, which is genuinely tidier. Rejected because a free GitHub runner does the same job and
  $5 is 25% of the budget.
- **Cloudflare Queues or Containers** for the worker. Both are paid features, so neither is
  reachable from the premise of this decision.
- **Keeping BullMQ against a free Upstash Redis.** Possible, but it retains a vendor and a
  concept to serve a consumer that no longer exists. The queue was never the point; the always-on
  consumer was.
