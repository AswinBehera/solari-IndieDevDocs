# ADR-0016: Progress is pushed on completion, not polled; jobs are dispatched, not waited for

- **Status:** Accepted
- **Date:** 2026-09-11
- **Decided by:** Aswin (architect), after a second-model review of ADR-0014
- **Amends:** ADR-0014 (Cloudflare for web and api; GitHub Actions for the worker)

## Context

ADR-0014 settled *where* the three deployables run. It did not settle how a browser watching a
run learns that the run is progressing, and the working assumption that filled the gap —
"the API streams progress inline over SSE by reading job rows from Postgres, and GitHub Actions
cron fires the worker" — was never examined. Reviewed on 11 September 2026 by Gemini 3.1 Pro,
reading ADR-0014 cold. Two of its findings survived verification against Cloudflare's own
documentation; a third did not, and is recorded below so nobody re-discovers it.

## Finding 1: a fixed-interval poll behind SSE spends the day's database quota

The cost of an SSE stream backed by polling is not paid by the stream. It is paid by Hyperdrive.

Cloudflare's free plan allows **100,000 Hyperdrive queries per day, account-wide**
([pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing)). One browser tab polling
once per second is 86,400 queries per day. **A single tab left open overnight exhausts the quota for
the entire account**, and the API — which shares that quota — starts failing for everyone, on a
resource nobody chose to spend.

Note what the constraint is *not*. The review's stated mechanism was that each poll burns one of the
free plan's 50 subrequests, killing the stream after ~50 seconds. That is wrong: since
[February 2026](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/) the
50 applies to *external* subrequests, and Hyperdrive is a service binding, counted against a separate
1,000-per-invocation internal ceiling. The stream does not die at 50 seconds. It dies at 1,000
polls — about 16 minutes — which is long enough to look fine in a demo and short enough to break a
real run. Both ceilings are real; the daily quota is the one that bites first and hardest.

## Finding 2: cron latency makes "live progress" a lie

ADR-0014 acknowledged that scheduled Actions are best-effort and that the cron floor is five minutes,
but reasoned about it only for background work, where lateness is a measurement problem. In a foreground flow it is a product problem: a user who presses
Run watches a motionless progress bar for up to five minutes before the runner even wakes to
claim the row. Nothing is broken, nothing reports an error, and the product looks dead.

## Decision

**1. Progress is pushed on state change, not polled on a timer.** The worker writes a job's state
transitions to Postgres as they happen and the API streams them. Where a poll is genuinely
unavoidable, it backs off — one second for the first ten seconds, then five, then fifteen, capped —
and the stream closes itself after a bounded lifetime rather than living as long as the tab does.
The budget-guard principle applies here too: a stream that can spend an unbounded amount of a shared
quota is not metered, it is merely unobserved.

**2. Foreground work is dispatched, not scheduled.** The API triggers the worker directly via
`workflow_dispatch`, so a user-initiated run starts in seconds. Cron is for background work, where best-effort timing
is the correct semantics; indieDevDocs has none today, so the workflow has no schedule.

## Consequences

- **The API now holds a GitHub token**, scoped to `actions:write` on this repository and nothing
  else, as a Worker secret. This is a new credential and a new blast radius: the repository is
  public, so the token must never be logged, and `workflow_dispatch` must be the only thing it can
  do. It goes in `.env.example` as a name with no value, like every other secret.
- **Dispatch is rate-limited and asynchronous.** `workflow_dispatch` returns 204 with no run id; the
  run must be correlated afterwards by the job id the API passes as an input. The API must also
  refuse to dispatch when a run for that job is already in flight, or a double-click spends two
  runners on one job.
- **A fourth thing to count, and deliberately not a fourth meter.** Hyperdrive queries per day are a
  real ceiling with a real failure mode, but they are a *platform* limit rather than a spend — going
  over costs availability, not money, and the $20 is untouched. Section 8 stays at three meters. The
  backoff above is the mitigation.
- **P0.5 acceptance gains a case**: an SSE stream held open for the length of a real run must
  issue a bounded, counted number of database queries, and the test asserts the bound.

## Rejected finding, recorded so it is not rediscovered

The review also predicted connection-pool exhaustion — many open SSE streams each holding a Postgres
connection until the free tier's pool is dry. Hyperdrive explicitly
[does not cap client connections from Workers](https://developers.cloudflare.com/hyperdrive/platform/limits/)
and pools origin connections independently of them, so an idle stream between polls holds nothing.
The daily query quota in Finding 1 is the real form of this concern.

## Alternatives rejected

- **Durable Objects or Cloudflare Queues** to fan out progress properly. Both are paid. Unreachable
  from the premise of ADR-0014.
- **Postgres `LISTEN/NOTIFY`.** The correct primitive, and unavailable: Hyperdrive multiplexes
  connections, so there is no session to hold a listener on.
- **Dropping live progress entirely** and showing a result when the job finishes. Honest, cheap, and
  it throws away the thing that makes a run legible as work being done on your behalf, page by
  page, while you watch.
