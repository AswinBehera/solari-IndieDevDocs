import { samsaraSchema } from "@samsara/db"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import { BudgetGuard } from "./budget.js"
import { loadCeilings } from "./ceilings.js"
import { Kernel } from "./kernel.js"
import { MemoryLogger } from "./log.js"
import { SessionRegistry } from "./registry.js"
import { createSolariBrowserLauncher, solariCredentials } from "./solari.js"
import { MemoryCounterStore, MemorySessionStore } from "./stores/memory.js"
import { PostgresSessionStore } from "./stores/postgres.js"
import { sameTimezone } from "./timezone.js"

/**
 * The `@live` test. This is the only test in the repository that spends money.
 *
 * It is skipped unless `SOLARI_LIVE=1`, so `pnpm test` never opens a browser —
 * `pnpm test:live` does. It stays visible in the default run as a skipped case
 * rather than being excluded by filename, because a live test nobody remembers
 * exists is a live test nobody runs before shipping.
 *
 * Cost: one browser session, a few seconds, a single page load. Well under a cent.
 *
 * **Reading a failure.** The provider may be in a maintenance window. The
 * assertions below are written so the two cases are never confused:
 *
 *   - `upstream` — Solari is unreachable or returned a 5xx. **Not our bug.** The
 *     test says so explicitly and fails with that word in the message.
 *   - anything else — ours.
 *
 * The counters here are in-memory on purpose: a live test must not write to the
 * real budget counters, or a CI run would spend the demo's allowance on itself.
 * The minutes are still measured and printed, which is the number worth knowing.
 *
 * **The session store is not.** Until P0.8 this test used a memory store for both,
 * and that quietly failed the phase's own acceptance criterion, which asks that the
 * session row appear in Postgres. The two stores are not the same kind of thing: a
 * counter is money already spent and must not be double-counted, a session row is a
 * record of something that happened and is worth nothing in memory. So when
 * `DATABASE_URL` is set the session goes to Postgres and the row is read back below;
 * the budget stays isolated either way.
 */

const live = process.env.SOLARI_LIVE === "1"

/**
 * Postgres if there is one, and no complaint if there is not: unlike the queue
 * tests, this file already refuses to run without an explicit `SOLARI_LIVE=1`, so
 * nobody can reach it by accident and read a skipped assertion as a passing one.
 */
const dbUrl = process.env.DATABASE_URL
const pg =
  live && typeof dbUrl === "string" && dbUrl.length > 0
    ? (() => {
        const client = postgres(dbUrl, { max: 2 })
        return { client, db: drizzle(client, { schema: samsaraSchema }) }
      })()
    : undefined

afterAll(async () => {
  await pg?.client.end({ timeout: 5 })
})

describe.skipIf(!live)("@live kernel against the real provider", () => {
  it("opens a proxied browser, reads its egress address, and closes", {
    timeout: 120_000,
  }, async () => {
    const launcher = createSolariBrowserLauncher(solariCredentials())
    const logger = new MemoryLogger()
    const sessionStore = pg ? new PostgresSessionStore(pg.db) : new MemorySessionStore()
    const kernel = new Kernel({
      registry: new SessionRegistry(sessionStore, logger),
      guard: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: loadCeilings() }),
      browser: launcher,
      logger,
    })

    // `sg`, one of the countries in Solari's residential pool (`countries.ts`): a
    // real session, a real residential proxy, a real egress address.
    const result = await kernel.withBrowser(
      "probe",
      {
        country: "sg",
        // The viewpoint disagrees with the egress on purpose, and this test's job
        // is to prove the disagreement actually reaches the page. Solari sets
        // neither of these — its default context is en-US on UTC — so if the
        // assertions below pass, they pass because the kernel built the context.
        locale: "vi-VN",
        timezoneId: "Asia/Ho_Chi_Minh",
        deadlineMs: 90_000,
        attempts: 1,
      },
      async (page) => {
        // `page` is Playwright-compatible. Typed as unknown by the kernel so that
        // Playwright's types stay out of a package the Workers runtime may load.
        const p = page as {
          goto(url: string): Promise<unknown>
          evaluate<R>(fn: () => R): Promise<R>
          locator(sel: string): { innerText(): Promise<string> }
        }
        await p.goto("https://api.ipify.org?format=json")
        const ip = await p.locator("pre").innerText()
        const claimed = await p.evaluate(() => ({
          language: navigator.language,
          languages: navigator.languages.join(","),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          offsetMinutes: new Date().getTimezoneOffset(),
        }))
        return JSON.stringify({ ip: JSON.parse(ip).ip, ...claimed })
      },
    )

    await kernel.shutdown()

    if (!result.ok) {
      // Every failure says which class it is, in words, on the first line. A live
      // test that reports only `expected false to be true` makes the reader open
      // a debugger to learn something the kernel already classified — which
      // defeats the entire point of having classified it.
      const { kind, message, status, cause } = result.error
      const whose =
        kind === "upstream"
          ? "UPSTREAM — the provider did not answer. This is NOT a kernel bug."
          : kind === "config"
            ? "CONFIG — our launch options are wrong."
            : kind === "blocked"
              ? "BLOCKED — the target refused the session."
              : kind === "budget"
                ? "BUDGET — a meter refused before anything opened."
                : kind === "timeout"
                  ? "TIMEOUT — our own deadline fired."
                  : "INTERNAL — this one is ours."
      throw new Error(
        [
          whose,
          `kind:    ${kind}`,
          `message: ${message}`,
          status ? `status:  ${status}` : null,
          cause ? `cause:   ${cause}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }

    // ipify echoes the egress IP the target actually saw, i.e. the proxy's.
    // Parsing it proves the page rendered, not merely that a session opened.
    const body = JSON.parse(result.value) as {
      ip: string
      language: string
      languages: string
      timeZone: string
      offsetMinutes: number
    }
    expect(body.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)

    // The viewpoint, as the page itself sees it. This is the whole point: a script
    // on the page reading `navigator.language` is one of the signals that decides
    // what gets served, and it is under our control in a way the IP is not.
    expect(body.language).toBe("vi-VN")
    // Compared as zones, not as strings. The kernel is launched with
    // `Asia/Ho_Chi_Minh` and the page answers `Asia/Saigon`: one zone, two
    // spellings, and ICU prefers the older one. This assertion was a string
    // equality until P0.8's live run failed on it — see `timezone.ts`.
    expect(sameTimezone(body.timeZone, "Asia/Ho_Chi_Minh")).toBe(true)
    // UTC+7, so getTimezoneOffset() is -420. Singapore would be -480; asserting the
    // number proves the clock moved rather than only the label.
    expect(body.offsetMinutes).toBe(-420)
    console.log(`[live] egress ${body.ip} | claims ${body.languages} | ${body.timeZone}`)

    const closed = logger.events.find((e) => e.event === "session.close")
    expect(closed).toBeDefined()
    if (closed && closed.event === "session.close") {
      expect(closed.outcome).toBe("ok")
      expect(closed.minutes).toBeGreaterThan(0)
      // Printed so the first real number for the minutes meter is on the record.
      console.log(`[live] session cost ${closed.minutes.toFixed(3)} minutes`)

      // Phase 0 acceptance: the row is in the database, not only in the log. Read
      // back through SQL rather than through the store that wrote it, because a
      // store asserting its own return value proves nothing about what landed.
      if (pg && closed.event === "session.close") {
        const [row] = await pg.db.execute<{
          purpose: string
          country: string
          locale: string | null
          timezone_id: string | null
          outcome: string
          minutes: number
        }>(
          sql`select purpose, country, locale, timezone_id, outcome, minutes
              from sessions where id = ${closed.sessionId}`,
        )
        expect(row).toBeDefined()
        expect(row?.outcome).toBe("ok")
        expect(row?.country).toBe("sg")
        // Both halves of the viewpoint, because an Observation cannot be read
        // without the viewpoint that produced it (ADR-0015).
        expect(row?.locale).toBe("vi-VN")
        // Stored as asked for, which is correct: the row records the viewpoint we
        // requested. What the page reported back is a separate fact.
        expect(row?.timezone_id).toBe("Asia/Ho_Chi_Minh")
        expect(Number(row?.minutes)).toBeGreaterThan(0)
        console.log(`[live] sessions row ${closed.sessionId} written to Postgres`)
      }
    }
  })
})
