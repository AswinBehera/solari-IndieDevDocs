/**
 * The provider, as the kernel needs it — and no more than that.
 *
 * These interfaces exist so every test above this line runs without the network,
 * without an API key, and without spending a minute. They are also the seam where
 * a provider outage is simulated: a fake that throws `ECONNREFUSED` proves the
 * `upstream` path works, which is the only way to know that a real maintenance
 * window will be reported as the provider's problem rather than ours.
 *
 * The shapes mirror `@solarisdk/browser` and `@solarisdk/sdk`
 * but deliberately narrowly: `newPage` and `close`, nothing else. A page is
 * `unknown` to this file — Playwright's own type belongs to the caller, and
 * importing it here would drag a browser automation library into a package the
 * Workers runtime may one day have to load.
 */

/**
 * What the browser claims to be, as opposed to where its packets come from.
 *
 * These are the levers that matter and the ones nobody thinks about, because the
 * proxy country is the visible knob. A platform deciding what to show a visitor
 * reads, roughly in descending order of weight: the account's region, the query's
 * language, any explicit region preference it has stored, the browser's locale
 * and timezone, and only then the egress IP. A session's locale and timezone can
 * matter more than its IP, and not every country is in the proxy pool (see
 * `countries.ts`).
 *
 * The provider does **not** set these. Its `newPage()` gives you the pool's
 * default context, which is `en-US` and UTC — i.e. nobody. Every session this
 * kernel opens without a viewpoint is a session pretending to be an American.
 */
export interface Viewpoint {
  /** BCP 47. Sets `navigator.language` and the `Accept-Language` header together. */
  locale: string
  /** IANA zone. `Date` and `Intl` follow it, and so do the scripts reading them. */
  timezoneId: string
  /**
   * The Geolocation API's answer, for surfaces that ask the browser instead of
   * reading the IP. Granted automatically when present, because a permission
   * prompt nobody clicks is the same as a denial.
   */
  geolocation?: { latitude: number; longitude: number; accuracy?: number }
}

export interface LaunchConfig {
  stealth: boolean
  proxy?: { country: string; tier?: "residential" | "mobile"; session?: string }
  captcha?: boolean
  profileId?: string
  recording?: boolean
  viewpoint?: Viewpoint
}

export interface BrowserHandle {
  /** The provider's session id. Recorded on the session row for support requests. */
  id: string
  newPage(): Promise<unknown>
  close(): Promise<void>
}

export interface BrowserLauncher {
  launch(config: LaunchConfig): Promise<BrowserHandle>
  /** Process shutdown. Releases the client's pool; separate from closing a browser. */
  dispose(): Promise<void>
  /**
   * A recorded session's replay, by the provider's session id (`BrowserHandle.id`).
   * Only after the session is closed: the provider uploads it on release, and for
   * some seconds after that it answers "pending". The launcher waits that out, up to
   * `timeoutMs`, and throws after. Optional, like `profiles`.
   */
  replay?(providerId: string, timeoutMs?: number): Promise<Uint8Array>
  /**
   * Optional because every test above this line uses a fake that has no profiles,
   * and because a launcher without one is still a working launcher — it just
   * cannot carry state between sessions.
   */
  profiles?: ProfileStore
}

/**
 * The provider-side cookie and localStorage jar, attached to a session by id.
 *
 * The trap is in `save`, and it is worth stating twice because it is silent:
 * **attaching a profile does not persist what the session accumulated.** The
 * provider hands the stored state to the context on launch and discards whatever
 * the browser did with it on release, unless someone calls `save` before the
 * close. A keepalive that forgets is indistinguishable from one that worked — the
 * session opens, the pages load, the row says `ok`, and the identity is exactly as
 * naive as it was an hour ago.
 *
 * `storageState` is `unknown` for the same reason `newPage()` returns `unknown`:
 * its real type is Playwright's, and that library must not be reachable from a
 * package the Workers runtime may have to load.
 */
export interface ProfileStore {
  create(name: string): Promise<{ id: string; name: string }>
  list(): Promise<{ id: string; name: string }[]>
  /** Explicit, and the only thing that makes a profile worth attaching. */
  save(id: string, storageState: unknown): Promise<{ version: number; sizeBytes: number }>
  delete(id: string): Promise<void>
}

export interface SandboxConfig {
  template: string
  /** Rolling idle window, not a deadline — the kernel enforces the deadline. */
  timeoutMs: number
  /** Labels the provider keeps on the sandbox, so a leaked one can be found and named. */
  metadata?: Record<string, string>
}

export interface SandboxHandle {
  id: string
  connect(): Promise<void>
  /** Argv, never a shell string. `run("ls -la")` looks for a binary named "ls -la". */
  run(
    cmd: string,
    args: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** Destroys the VM. `close()` would only drop the local control channel. */
  kill(): Promise<void>
  /** A public URL for an in-guest port. It carries an access token: never log or store it whole. */
  previewUrl?(port: number): Promise<string>
  /** Resets the provider's idle window to `ms` from now. */
  keepAlive?(ms: number): Promise<void>
}

export interface SandboxLauncher {
  create(config: SandboxConfig): Promise<SandboxHandle>
  /** Destroys a sandbox by id, from any process. False when it was already gone. */
  kill?(id: string): Promise<boolean>
  dispose(): Promise<void>
}
