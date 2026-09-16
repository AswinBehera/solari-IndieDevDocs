import { createDb } from "@dt/db"
import { MemoryPacer } from "@samsara/harvest"
import { FilesystemCaptureArchive } from "@samsara/harvest/node"
import {
  PostgresDriftExperimentStore,
  PostgresHarvestRunStore,
  PostgresRawItemStore,
} from "@samsara/harvest/postgres"
import { BudgetGuard, Kernel, type Logger, loadCeilings, SessionRegistry } from "@samsara/kernel"
import { jsonLogger } from "@samsara/kernel/node"
import {
  PostgresCounterStore,
  PostgresJobStore,
  PostgresSessionStore,
} from "@samsara/kernel/postgres"
import { createSolariBrowserLauncher, solariCredentials } from "@samsara/kernel/solari"
import { PostgresPersonaStore } from "@samsara/personas/postgres"
import { HandlerRegistry, noopHandler } from "./handlers.js"
import { createHarvestHandler } from "./harvest.js"
import { createPackRegistry } from "./packs.js"
import { createKeepaliveHandler } from "./personas.js"
import { sourceRegistry } from "./sources.js"

/**
 * Everything the runner needs, assembled once at boot.
 *
 * Separated from `index.ts` so a test can build the same object graph against a
 * real database without also acquiring a process, signal handlers and an exit
 * code. The only thing `index.ts` adds is the lifecycle.
 */
export interface Boot {
  db: ReturnType<typeof createDb>
  jobs: PostgresJobStore
  kernel: Kernel
  registry: SessionRegistry
  handlers: HandlerRegistry
  packs: ReturnType<typeof createPackRegistry>
  logger: Logger
  close(): Promise<void>
}

export function boot(env: NodeJS.ProcessEnv = process.env): Boot {
  const url = env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is not set")

  const logger: Logger = jsonLogger
  const database = createDb(url)
  const registry = new SessionRegistry(new PostgresSessionStore(database.db), logger)
  const guard = new BudgetGuard({
    store: new PostgresCounterStore(database.db),
    ceilings: loadCeilings(env),
  })

  // Optional on purpose. The whole of Phase 0's work — claim, drain, lease,
  // shutdown — is exercisable without a provider key, and a runner that refuses to
  // boot without one would make the no-op job, whose entire value is being
  // testable anywhere, untestable in CI.
  // Spread rather than `browser: undefined`: `exactOptionalPropertyTypes` is on
  // (an executor decision from P0.1), so "absent" and "present and undefined" are
  // different types, and the kernel means the first one.
  const launcher = env.SOLARI_API_KEY
    ? createSolariBrowserLauncher(solariCredentials(env))
    : undefined
  const browser = launcher ? { browser: launcher } : {}

  const kernel = new Kernel({ registry, guard, logger, ...browser })

  const handlers = new HandlerRegistry()
  handlers.register("noop", noopHandler)
  // `launcher.profiles` and not a second client: the profile API and the browser
  // API are the same provider account, and a second `new Solari()` would be a
  // second loopback listener for four HTTP calls. Absent without a key, which
  // means a keyless runner claims the job and fails it with `config` rather than
  // quietly running a keepalive that saves nothing — the silent failure
  // `ProfileStore` exists to warn about.
  const personas = new PostgresPersonaStore(database.db)
  handlers.register(
    "persona.keepalive",
    createKeepaliveHandler({
      store: personas,
      ...(launcher?.profiles ? { profiles: launcher.profiles } : {}),
    }),
  )

  // The registry is in `sources.ts`, where a test can reach it. See that file.
  const sources = sourceRegistry()

  handlers.register(
    "harvest.run",
    createHarvestHandler({
      sources,
      personas,
      runs: new PostgresHarvestRunStore(database.db),
      items: new PostgresRawItemStore(database.db),
      // Local disk, and a stand-in — see the class header. Section 8 puts captures
      // in Supabase Storage; there are no credentials for it yet, and `runHarvest`
      // treats a failed archive as fatal, so "no archive" would mean "no harvest".
      // The ref shape matches a bucket key so the swap stays a copy.
      archive: new FilesystemCaptureArchive(env.CAPTURE_ARCHIVE_DIR ?? ".captures"),
      // One source, one process, one request every five seconds. Honest about its
      // limits: this cannot span a scheduled runner's exit, and the cross-process
      // answer is `jobs.run_after`, not a shared limiter.
      pacer: new MemoryPacer(),
      // Read before a browser opens, and the only reason stopping a drift
      // experiment stops anything: its remaining days are already rows in the
      // queue, so there is nothing to cancel — only something to refuse (P1.8).
      experiments: new PostgresDriftExperimentStore(database.db),
    }),
  )

  return {
    db: database,
    jobs: new PostgresJobStore(database.db),
    kernel,
    registry,
    handlers,
    packs: createPackRegistry(),
    logger,
    async close() {
      await database.sql.end({ timeout: 5 })
    },
  }
}
