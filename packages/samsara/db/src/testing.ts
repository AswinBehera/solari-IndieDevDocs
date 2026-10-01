import postgres from "postgres"

/**
 * One database, several test packages, and `turbo run test` runs them at once.
 *
 * Every `.pg.test.ts` file in this repository starts by truncating the tables it
 * is about to use, because a test that inherits the previous run's rows is a test
 * that passes for the wrong reason. That is correct in isolation and wrong in
 * parallel: Turbo runs `@samsara/kernel` and `@rd/db` concurrently
 * against the same `DATABASE_URL`, so one
 * package's `truncate ... cascade` deletes rows another package inserted two
 * milliseconds ago. The symptom is a handful of `expected undefined to be 8`
 * failures that move around between runs and disappear entirely at
 * `--concurrency=1` — which is to say, the most expensive kind of failure to
 * read, because it looks like a bug in whichever test happened to lose.
 *
 * The fix is a **Postgres advisory lock**, which is the database's own mutex and
 * therefore works across processes without any of them knowing about each other.
 * The alternative — `--concurrency=1` for the whole repo — serialises twenty-six
 * tasks to fix a conflict between three of them, and it fixes it by accident: the
 * next package that opens a connection reintroduces the bug silently.
 *
 * The lock is **session-scoped**, so it must be held on one connection that
 * nothing else borrows. `postgres`'s pool hands out whichever connection is free,
 * so this opens its own with `max: 1` rather than sharing the test's client.
 */

/** Any positive integer, the same in every caller. The value carries no meaning. */
const LOCK_KEY = 8_417_233

export interface DatabaseLock {
  release(): Promise<void>
}

/**
 * Waits until no other test process holds the database, then holds it.
 *
 * Call in `beforeAll` and release in `afterAll`. A file that forgets the release
 * blocks the next one until its process exits, which ends the session and drops
 * the lock — noisy, but not a deadlock that survives the run.
 */
export async function lockDatabase(url: string): Promise<DatabaseLock> {
  const client = postgres(url, { max: 1, onnotice: () => {} })
  await client`select pg_advisory_lock(${LOCK_KEY})`
  return {
    async release() {
      // Unlocked explicitly rather than left to `end()`, so the wait time of the
      // next process is bounded by this file finishing rather than by this
      // process finishing.
      await client`select pg_advisory_unlock(${LOCK_KEY})`
      await client.end({ timeout: 5 })
    },
  }
}
