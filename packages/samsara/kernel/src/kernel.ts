import { randomUUID } from "node:crypto"
import type { SessionOutcome, SessionPurpose } from "@samsara/core"
import type { BudgetGuard, SpendScope } from "./budget.js"
import {
  isSupportedProxyCountry,
  NEAREST_AVAILABLE,
  SUPPORTED_PROXY_COUNTRIES,
} from "./countries.js"
import { deadlineFor, withDeadline } from "./deadline.js"
import { type Logger, now, silentLogger } from "./log.js"
import type { BrowserLauncher, LaunchConfig, SandboxLauncher } from "./ports.js"
import type { SessionRegistry } from "./registry.js"
import { classify, err, type Failure, failure, ok, type Result } from "./result.js"
import { withRetry } from "./retry.js"

/**
 * `withBrowser` and `withSandbox` (plan section 2.4).
 *
 * The contract worth stating plainly: **`fn` never receives a raw handle.** Every
 * path through this file opens a session, registers it, races it against a hard
 * deadline, closes it in a `finally`, and meters the minutes it consumed whether
 * it succeeded or not. Anything that wants a browser gets one through here, which
 * is what makes the minutes meter a measurement rather than an estimate.
 */

export interface BrowserOptions {
  /**
   * The proxy's country. With `direct`, no proxy is used and this is only the
   * label written on the session row (the provider's own egress, not a viewpoint).
   */
  country: string
  /**
   * No stealth, no proxy: the provider's plain browser. For reading public pages
   * where the viewpoint is set in the URL (Steam's `cc=`), and the only mode a free
   * plan can launch — proxies need stealth, and stealth is a paid feature.
   */
  direct?: boolean
  /**
   * The viewpoint to present (see `Viewpoint` in `ports.ts`). Optional, and the
   * default is worth naming: without it the session is `en-US` on UTC, which is a
   * viewpoint too — just not one anybody asked for.
   */
  locale?: string
  timezoneId?: string
  geolocation?: { latitude: number; longitude: number; accuracy?: number }
  personaId?: string | null
  ownerId?: string | null
  domainId?: string | null
  /** Sticky egress IP, so one identity keeps one address across sessions. */
  proxySession?: string
  /** Provider-side persisted cookies and localStorage. */
  profileId?: string
  proxyTier?: "residential" | "mobile"
  captcha?: boolean
  /** On for the first runs of a new adapter, off by default (section 8). */
  recording?: boolean
  deadlineMs?: number
  /** Attributes the spend to a run, enabling the `purpose.run` window. */
  runId?: string
  /** One try plus this many retries. Defaults to the section 2.4 policy. */
  attempts?: number
  /**
   * Called once per attempt, after the session is closed and metered.
   *
   * Added because two callers in a row had to reconstruct this by scraping
   * `session.close` out of the log stream, and the second one got it wrong: it
   * read only the last close and so dropped the minutes of a failed first attempt
   * the guard had already charged, under-reporting a run's bill by a third. The
   * information existed; there was just no way to ask for it, so everybody parsed
   * the logs, and log-parsing is how a number stops matching the meter.
   *
   * Fires on the failure path too, because that is exactly when it is easiest to
   * forget that minutes were still spent.
   */
  onSession?: (spend: SessionSpend) => void
}

/** What one attempt of `withBrowser` actually cost. See `onSession`. */
export interface SessionSpend {
  sessionId: string
  /**
   * The provider's id for the same session (`BrowserHandle.id`), which is what the
   * provider's own endpoints take: a replay, a support request.
   */
  providerId: string
  outcome: SessionOutcome
  minutes: number
  /** 1-based, within this `withBrowser` call. */
  attempt: number
}

export interface SandboxOptions {
  template: string
  ownerId?: string | null
  domainId?: string | null
  deadlineMs?: number
  runId?: string
  attempts?: number
  metadata?: Record<string, string>
  /**
   * After `fn` succeeds, leave the sandbox running for this long instead of
   * killing it: something outside the call, a person, is going to use it. The
   * caller owns the stop and must schedule it (`killSandbox`), because the
   * provider's window is idle time and any use extends it. The kept minutes are
   * metered up front.
   */
  keepMs?: number
}

export interface KernelDeps {
  registry: SessionRegistry
  guard: BudgetGuard
  browser?: BrowserLauncher
  sandbox?: SandboxLauncher
  logger?: Logger
  clock?: () => Date
  newId?: () => string
}

export class Kernel {
  private readonly logger: Logger

  constructor(private readonly deps: KernelDeps) {
    this.logger = deps.logger ?? silentLogger
  }

  /**
   * Validate a launch config before the provider sees it.
   *
   * `proxy` and `captcha` both require `stealth` (section 2.3). Letting the
   * provider reject the pairing costs a round trip and returns an error that has
   * to be decoded; refusing here is instant and says exactly what is wrong. This is
   * a `config` failure, and `config` is deliberately not retryable.
   */
  static validateLaunch(config: LaunchConfig): Result<LaunchConfig, Failure> {
    if ((config.proxy || config.captcha) && !config.stealth) {
      return err(
        failure("config", "proxy and captcha both require stealth: true (plan section 2.3)"),
      )
    }
    if (config.proxy && !/^[a-z]{2}$/.test(config.proxy.country)) {
      return err(failure("config", "proxy country must be lowercase ISO 3166-1 alpha-2"))
    }
    if (config.viewpoint && !/^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/.test(config.viewpoint.locale)) {
      return err(failure("config", "locale must be BCP 47, e.g. vi-VN"))
    }
    if (config.viewpoint && !config.viewpoint.timezoneId.includes("/")) {
      // "Asia/Ho_Chi_Minh", not "GMT+7". An offset drifts across a DST boundary and,
      // worse, an offset is not what a real browser reports — which makes it a
      // tell on exactly the surfaces this exists to blend into.
      return err(failure("config", "timezoneId must be an IANA zone, e.g. Asia/Ho_Chi_Minh"))
    }
    if (config.proxy && !isSupportedProxyCountry(config.proxy.country)) {
      // Caught here rather than at the provider, which answers a 400 — a round
      // trip, a decoded error, and, before `classify` learned to read a 4xx, two
      // pointless retries. The alternative is named but never substituted: a
      // silent country swap changes what a persona sees, which is the one
      // variable the Persona Lab exists to hold still.
      const nearest = NEAREST_AVAILABLE[config.proxy.country]
      return err(
        failure(
          "config",
          `proxy country ${config.proxy.country} is not in the provider's pool` +
            (nearest ? `; nearest available is ${nearest}` : "") +
            `. Supported: ${SUPPORTED_PROXY_COUNTRIES.join(", ")}`,
        ),
      )
    }
    return ok(config)
  }

  async withBrowser<T>(
    purpose: SessionPurpose,
    opts: BrowserOptions,
    fn: (page: unknown, signal: AbortSignal) => Promise<T>,
  ): Promise<Result<T, Failure>> {
    const launcher = this.deps.browser
    if (!launcher) return err(failure("config", "kernel has no browser launcher configured"))

    const config: LaunchConfig = {
      // On for every proxied session: the provider requires stealth for a proxy.
      // Off only when the caller asked for the provider's plain egress.
      stealth: !opts.direct,
      ...(opts.direct
        ? {}
        : {
            proxy: {
              country: opts.country,
              ...(opts.proxyTier ? { tier: opts.proxyTier } : {}),
              ...(opts.proxySession ? { session: opts.proxySession } : {}),
            },
          }),
      ...(opts.locale && opts.timezoneId
        ? {
            viewpoint: {
              locale: opts.locale,
              timezoneId: opts.timezoneId,
              ...(opts.geolocation ? { geolocation: opts.geolocation } : {}),
            },
          }
        : {}),
      ...(opts.captcha ? { captcha: true } : {}),
      ...(opts.profileId ? { profileId: opts.profileId } : {}),
      ...(opts.recording ? { recording: true } : {}),
    }

    const valid = Kernel.validateLaunch(config)
    if (!valid.ok) return valid

    const scope: SpendScope = {
      ownerId: opts.ownerId ?? null,
      purpose,
      ...(opts.runId ? { runId: opts.runId } : {}),
    }

    // Refuse before opening anything. `0` requested because browser minutes are
    // not knowable in advance — this asks only "is the meter already exhausted?",
    // which is the question that matters (see the note on BudgetGuard).
    const allowed = await this.guardCheck("solari.minutes", 0, scope)
    if (!allowed.ok) return allowed

    const deadlineMs = deadlineFor(purpose, opts.deadlineMs)

    return withRetry(
      async (attempt) => {
        const sessionId = (this.deps.newId ?? randomUUID)()
        let handle: Awaited<ReturnType<BrowserLauncher["launch"]>> | undefined
        let outcome: SessionOutcome = "error"

        try {
          handle = await launcher.launch(config)
        } catch (thrown) {
          // Nothing opened, so nothing to close and nothing to meter. The failure
          // classification is the whole value here: a 5xx from the provider is
          // `upstream` and will be retried; a bad config is not.
          return err(classify(thrown))
        }

        const live = handle
        await this.deps.registry.open(
          {
            id: sessionId,
            purpose,
            ownerId: opts.ownerId ?? null,
            domainId: opts.domainId ?? null,
            personaId: opts.personaId ?? null,
            country: opts.country,
            locale: config.viewpoint?.locale ?? null,
            timezoneId: config.viewpoint?.timezoneId ?? null,
            startedAt: (this.deps.clock ?? (() => new Date()))(),
            endedAt: null,
            minutes: 0,
            outcome: "running",
            recordingRef: opts.recording ? live.id : null,
          },
          () => live.close(),
        )

        try {
          const raced = await withDeadline(
            deadlineMs,
            async (signal) => {
              const page = await live.newPage()
              return fn(page, signal)
            },
            // Force-close on timeout. Without this the session bills until the
            // provider's idle window expires, and `timeoutMs` is rolling, so a
            // busy page may never be idle at all.
            () => live.close(),
          )
          outcome = raced.ok ? "ok" : raced.error.kind === "timeout" ? "timeout" : "error"
          if (!raced.ok) return raced
          return ok(raced.value)
        } catch (thrown) {
          const f = classify(thrown)
          outcome = f.kind === "blocked" ? "blocked" : "error"
          return err(f)
        } finally {
          try {
            await live.close()
          } catch {
            // Already closed by the deadline path, or the provider is gone. Either
            // way the session row still has to be closed and the minutes metered,
            // which is what the next two lines do.
          }
          const minutes = await this.deps.registry.close(sessionId, outcome)
          await this.meter("solari.minutes", minutes, scope, purpose)
          opts.onSession?.({ sessionId, providerId: live.id, outcome, minutes, attempt })
        }
      },
      {
        attempts: opts.attempts ?? 3,
        logger: this.logger,
        purpose,
      },
    )
  }

  async withSandbox<T>(
    purpose: SessionPurpose,
    opts: SandboxOptions,
    fn: (
      sandbox: Awaited<ReturnType<SandboxLauncher["create"]>>,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<Result<T, Failure>> {
    const launcher = this.deps.sandbox
    if (!launcher) return err(failure("config", "kernel has no sandbox launcher configured"))

    const deadlineMs = deadlineFor(purpose, opts.deadlineMs)
    const scope: SpendScope = {
      ownerId: opts.ownerId ?? null,
      purpose,
      ...(opts.runId ? { runId: opts.runId } : {}),
    }

    const allowed = await this.guardCheck("solari.minutes", 0, scope)
    if (!allowed.ok) return allowed

    return withRetry(
      async () => {
        let sandbox: Awaited<ReturnType<SandboxLauncher["create"]>> | undefined
        try {
          sandbox = await launcher.create({
            template: opts.template,
            // Give the provider's idle window headroom over our own deadline, so
            // that when something does fire it is ours, with our error and our
            // force-close, rather than a provider timeout we have to decode.
            timeoutMs: deadlineMs + 60_000,
            ...(opts.metadata ? { metadata: opts.metadata } : {}),
          })
        } catch (thrown) {
          return err(classify(thrown))
        }

        const live = sandbox
        const startedAt = (this.deps.clock ?? (() => new Date()))()
        let kept = false
        try {
          await live.connect()
          const raced = await withDeadline(
            deadlineMs,
            (signal) => fn(live, signal),
            () => live.kill(),
          )
          if (!raced.ok) return raced
          if (opts.keepMs && live.keepAlive) {
            await live.keepAlive(opts.keepMs)
            kept = true
          }
          return ok(raced.value)
        } catch (thrown) {
          return err(classify(thrown))
        } finally {
          if (!kept) {
            try {
              // kill(), not close(): close() drops the local control channel and
              // leaves the VM running until its idle timeout, still billing.
              await live.kill()
            } catch {
              // Nothing further we can do; the idle timeout is the backstop.
            }
          }
          const minutes =
            (Date.now() - startedAt.getTime()) / 60_000 + (kept ? (opts.keepMs ?? 0) / 60_000 : 0)
          await this.meter("solari.minutes", minutes, scope, purpose)
        }
      },
      { attempts: opts.attempts ?? 3, logger: this.logger, purpose },
    )
  }

  /** Stops a sandbox `withSandbox` kept. False when it had already gone. */
  async killSandbox(id: string): Promise<Result<boolean, Failure>> {
    const launcher = this.deps.sandbox
    if (!launcher?.kill) return err(failure("config", "this launcher cannot kill by id"))
    try {
      return ok(await launcher.kill(id))
    } catch (thrown) {
      return err(classify(thrown))
    }
  }

  /**
   * A recorded session's replay, by the provider id `onSession` reported. Call it
   * after `withBrowser` returns: the provider uploads the replay on release. No
   * minutes are metered, because no session is open while it downloads.
   */
  async replay(providerId: string, timeoutMs?: number): Promise<Result<Uint8Array, Failure>> {
    const launcher = this.deps.browser
    if (!launcher?.replay) return err(failure("config", "this launcher cannot fetch replays"))
    try {
      return ok(await launcher.replay(providerId, timeoutMs))
    } catch (thrown) {
      return err(classify(thrown))
    }
  }

  /**
   * The provider profile called `name`, created with `storageState` if there is none.
   *
   * An existing profile is used as it is and never re-saved: every save bumps the
   * provider's version, and the version is what a receipt records to say "read with
   * this exact jar". A caller that changes the state changes the name too.
   */
  async ensureProfile(
    name: string,
    storageState: unknown,
  ): Promise<Result<{ id: string; name: string; version: number }, Failure>> {
    const profiles = this.deps.browser?.profiles
    if (!profiles) return err(failure("config", "this launcher has no profiles"))
    try {
      const found = (await profiles.list()).find((p) => p.name === name)
      if (found) return ok({ id: found.id, name, version: versionOf(found) })
      const made = await profiles.create(name)
      const saved = await profiles.save(made.id, storageState)
      return ok({ id: made.id, name, version: saved.version })
    } catch (thrown) {
      return err(classify(thrown))
    }
  }

  /** Every kernel session is released. For the SIGTERM path in the worker. */
  async shutdown(): Promise<void> {
    await this.deps.registry.shutdown()
    await Promise.allSettled([this.deps.browser?.dispose(), this.deps.sandbox?.dispose()])
  }

  private async guardCheck(
    meter: Parameters<BudgetGuard["check"]>[0],
    requested: number,
    scope: SpendScope,
  ): Promise<Result<void, Failure>> {
    const result = await this.deps.guard.check(meter, requested, scope)
    if (!result.ok && result.error.meter) {
      this.logger.emit({
        at: now(),
        event: "budget.refused",
        meter,
        window: scope.ownerId ? "owner.day" : "global.day",
        ceiling: result.error.ceiling ?? 0,
        used: result.error.used ?? 0,
        requested: result.error.requested ?? requested,
      })
    }
    return result
  }

  private async meter(
    meter: Parameters<BudgetGuard["record"]>[0],
    amount: number,
    scope: SpendScope,
    purpose: SessionPurpose,
  ): Promise<void> {
    if (amount <= 0) return
    await this.deps.guard.record(meter, amount, scope)
    this.logger.emit({ at: now(), event: "budget.spent", meter, amount, purpose })
  }
}

/** The provider's list carries `version`; the port's type does not promise it. */
const versionOf = (p: object): number => {
  const v = (p as { version?: unknown }).version
  return typeof v === "number" ? v : Number(v ?? 0)
}
