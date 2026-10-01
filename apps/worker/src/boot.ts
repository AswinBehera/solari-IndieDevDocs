import { createDb, PostgresResearchStore } from "@rd/db"
import { SteamClient } from "@rd/steam"
import {
  BudgetGuard,
  Kernel,
  type Logger,
  loadCeilings,
  loadTotals,
  SessionRegistry,
} from "@samsara/kernel"
import { jsonLogger } from "@samsara/kernel/node"
import {
  PostgresCounterStore,
  PostgresJobStore,
  PostgresSessionStore,
} from "@samsara/kernel/postgres"
import {
  createSolariBrowserLauncher,
  createSolariSandboxLauncher,
  solariCredentials,
} from "@samsara/kernel/solari"
import { PackRegistry } from "@samsara/refine"
import { HandlerRegistry, noopHandler } from "./handlers.js"
import { FilesystemReceiptArchive } from "./research/archive.js"
import { BLOCK_RUN, createBlockRunHandler } from "./research/block-run.js"
import { createPrototypeStopHandler, PROTOTYPE_STOP } from "./research/prototype.js"

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
  packs: PackRegistry
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
    totals: loadTotals(env),
  })

  // Optional: without a key, store pages are read over plain HTTP and the
  // receipts say so. With one, each page is also screenshotted with the cited
  // sections boxed. Spread rather than `browser: undefined` because
  // `exactOptionalPropertyTypes` is on.
  const launcher = env.SOLARI_API_KEY
    ? createSolariBrowserLauncher(solariCredentials(env))
    : undefined
  // Same key, for the prototype block's sandboxes.
  const sandbox = env.SOLARI_API_KEY
    ? createSolariSandboxLauncher(solariCredentials(env))
    : undefined
  const kernel = new Kernel({
    registry,
    guard,
    logger,
    ...(launcher ? { browser: launcher } : {}),
    ...(sandbox ? { sandbox } : {}),
  })

  const jobs = new PostgresJobStore(database.db)
  const handlers = new HandlerRegistry()
  handlers.register("noop", noopHandler)
  handlers.register(
    BLOCK_RUN,
    createBlockRunHandler({
      store: new PostgresResearchStore(database.db),
      // Under the web app's `public/`, so Vite serves each at `/receipts/<ref>`.
      archive: new FilesystemReceiptArchive(env.RECEIPT_DIR ?? "../web/public/receipts"),
      steam: () => new SteamClient(),
      browser: launcher !== undefined && env.RESEARCH_BROWSER !== "off",
      sandbox: sandbox !== undefined,
      queue: jobs,
      concurrency: Number(env.RESEARCH_CONCURRENCY ?? 3),
    }),
  )

  handlers.register(PROTOTYPE_STOP, createPrototypeStopHandler())

  return {
    db: database,
    jobs,
    kernel,
    registry,
    handlers,
    // The refine pipeline's packs. Research blocks read no mentions, so none.
    packs: new PackRegistry(),
    logger,
    async close() {
      await database.sql.end({ timeout: 5 })
    },
  }
}
