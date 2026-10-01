import { Solari } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"
import type {
  BrowserHandle,
  BrowserLauncher,
  LaunchConfig,
  ProfileStore,
  SandboxConfig,
  SandboxHandle,
  SandboxLauncher,
} from "./ports.js"

/**
 * The only file in the kernel that imports the provider's SDK.
 *
 * Everything above it talks to `ports.ts`, so a change of provider is a rewrite of
 * this file and nothing else — and, more usefully today, every test above this
 * line runs without a key and without spending a minute.
 *
 * Version pinning is deliberate: `@solarisdk/browser` is pinned
 * exactly, because 0.1.3 changed whether `browser.close()` alone lets Node exit.
 * Read changelog.getsolari.com before bumping.
 */

export interface SolariCredentials {
  apiKey: string
}

export function createSolariBrowserLauncher(creds: SolariCredentials): BrowserLauncher {
  const solari = new Solari({ apiKey: creds.apiKey })

  return {
    async launch(config: LaunchConfig): Promise<BrowserHandle> {
      const browser = await solari.launch({
        stealth: config.stealth,
        ...(config.proxy ? { proxy: config.proxy } : {}),
        ...(config.captcha ? { captcha: true } : {}),
        ...(config.profileId ? { profileId: config.profileId } : {}),
        ...(config.recording ? { recording: true } : {}),
      })

      // A viewpoint cannot be set on `browser.newPage()`, which uses the pool's
      // primary context and takes no options. So we build the context ourselves —
      // and carry the profile's `storageState` across by hand, because
      // `newContext()` is documented to open an *empty* context that does not
      // inherit the attached profile. Getting this wrong is silent: the session
      // opens, the pages load, and every cookie the profile was warming is gone.
      const vp = config.viewpoint
      const context = vp
        ? await browser.newContext({
            locale: vp.locale,
            timezoneId: vp.timezoneId,
            ...(vp.geolocation
              ? { geolocation: vp.geolocation, permissions: ["geolocation"] }
              : {}),
            ...(browser.session.storageState
              ? { storageState: browser.session.storageState as never }
              : {}),
          })
        : undefined

      return {
        id: browser.id,
        newPage: () => (context ? context.newPage() : browser.newPage()),
        // Releases the session as well as closing the browser. Closing without
        // releasing holds the slot — and bills for it — until the plan deadline.
        close: () => browser.close(),
      }
    },
    // Separate from `close()` on a browser: this releases the client's loopback
    // proxy listener. Skipping it used to hang Node at exit; since 0.1.3 the
    // listener is unref'd, but a scheduled runner should still free it explicitly.
    dispose: () => solari.close(),
    // The SDK says a replay is ready 1-3 s after release. Measured on 1 October 2026
    // it took 6 s for one store page, answered meanwhile as a 404 with the code
    // `ReplayPending`. Any other error is real and is thrown at once.
    async replay(providerId: string, timeoutMs = 60_000) {
      const until = Date.now() + timeoutMs
      for (;;) {
        try {
          return await solari.sessions.downloadReplay(providerId)
        } catch (e) {
          const pending = e instanceof Error && e.message.includes("ReplayPending")
          if (!pending) throw e
          if (Date.now() > until) {
            throw new Error(`replay still uploading after ${timeoutMs / 1000} s`, { cause: e })
          }
          await new Promise((r) => setTimeout(r, 2_000))
        }
      }
    },
    // Hung off the launcher rather than given its own factory, because a second
    // `new Solari()` is a second API client and a second loopback listener for
    // four HTTP calls. One client, one dispose.
    profiles: {
      create: (name) => solari.profiles.create({ name }),
      list: () => solari.profiles.list(),
      // `storageState` is `unknown` at the port (see `ProfileStore`); this is the
      // one line in the system that knows its real shape, and it is the same line
      // that knows the SDK. The cast does not travel.
      save: (id, storageState) => solari.profiles.save(id, storageState as never),
      delete: (id) => solari.profiles.delete(id),
    } satisfies ProfileStore,
  }
}

export function createSolariSandboxLauncher(creds: SolariCredentials): SandboxLauncher {
  const client = new SolariClient({ apiKey: creds.apiKey })

  return {
    async create(config: SandboxConfig): Promise<SandboxHandle> {
      const sandbox = await client.sandboxes.create({
        template: config.template,
        timeoutMs: config.timeoutMs,
        // Spelled out: a sandbox that pauses on idle keeps its disk, and a kept
        // one nobody stops would sit paused rather than go.
        lifecycle: { onTimeout: "kill" },
        ...(config.metadata ? { metadata: config.metadata } : {}),
      })
      return {
        id: sandbox.sandboxId,
        connect: () => sandbox.connect(),
        // argv, never a shell string. `run("ls -la")` looks for a binary literally
        // named "ls -la"; anything needing pipes or globs runs `sh -c` explicitly.
        run: (cmd, args) => sandbox.commands.run(cmd, { args: [...args] }),
        // kill() also closes the control channel, and the SDK rejects whatever was
        // still listening on it; the VM is gone either way.
        kill: () => sandbox.kill().catch(() => {}),
        previewUrl: async (port) => (await sandbox.previewUrl(port)).url,
        keepAlive: async (ms) => {
          await sandbox.setTimeout(ms)
          // Drop the control channel without killing: the kept VM outlives this process.
          sandbox.close()
        },
      }
    },
    async kill(id) {
      try {
        await client.sandboxes.kill(id)
        return true
      } catch (e) {
        if (/not found/i.test(e instanceof Error ? e.message : String(e))) return false
        throw e
      }
    },
    async dispose() {
      // SolariClient holds no listener that keeps the loop alive; sandboxes are
      // killed individually by the kernel's finally block.
    },
  }
}

/**
 * Read the key from the environment, or say precisely what is missing.
 *
 * Throws rather than returning a default, and never logs the value — the
 * repository and therefore the Actions log are public (ADR-0014).
 */
export function solariCredentials(
  env: Record<string, string | undefined> = process.env,
): SolariCredentials {
  const apiKey = env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set")
  return { apiKey }
}
