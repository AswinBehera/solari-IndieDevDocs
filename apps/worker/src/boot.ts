import { createDb } from "@dt/db"
import { PostgresTripStore } from "@dt/db/trips"
import { PostgresOsmSearch, PostgresPlaceRepo } from "@dt/travel-pack/postgres"
import { createJevJudge, createPriceAdapter } from "@dt/travel-pack/price"
import { MemoryPacer } from "@samsara/harvest"
import { FilesystemCaptureArchive } from "@samsara/harvest/node"
import {
  PostgresDriftExperimentStore,
  PostgresHarvestRunStore,
  PostgresRawItemStore,
} from "@samsara/harvest/postgres"
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
import { createSolariBrowserLauncher, solariCredentials } from "@samsara/kernel/solari"
import { LlmClient, loadLlmConfig } from "@samsara/llm"
import { createOpenRouterClient } from "@samsara/llm/openrouter"
import { PostgresPersonaStore } from "@samsara/personas/postgres"
import { dailyFx, type ProbeAdapter } from "@samsara/probe"
import { FilesystemScreenshotArchive } from "@samsara/probe/node"
import { PostgresObservationStore, PostgresProbeTargetStore } from "@samsara/probe/postgres"
import {
  PostgresEntityLinks,
  PostgresEvidenceStore,
  PostgresEvidenceWriter,
  PostgresMentionSink,
  PostgresPendingMentions,
  PostgresResolutionCache,
} from "@samsara/refine/postgres"
import { createDedupHandler } from "./dedup.js"
import { createExploreHandler } from "./explore.js"
import { HandlerRegistry, noopHandler } from "./handlers.js"
import { createHarvestHandler } from "./harvest.js"
import { createIntentHandler } from "./intent.js"
import { createPackRegistry } from "./packs.js"
import { createPersonaSweepHandler } from "./persona-sweep.js"
import { createKeepaliveHandler } from "./personas.js"
import { createProbeHandler } from "./probe.js"
import { createProbeSweepHandler } from "./probe-sweep.js"
import { createRefineHandler } from "./refine.js"
import { createResolveHandler } from "./resolve.js"
import { createScoreHandler } from "./score.js"
import { sourceRegistry } from "./sources.js"
import { createSweepHandler } from "./sweep.js"

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
    totals: loadTotals(env),
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

  // Hoisted out of the `return` below because `harvest.run` now enqueues into it:
  // a harvest that found items queues the `refine.extract` that reads them (P2.6).
  // One store instance, so the chaining writes to the queue this runner drains.
  const jobs = new PostgresJobStore(database.db)

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
      queue: jobs,
    }),
  )

  // Optional for the same reason the browser launcher is, and built here rather
  // than inside the handler so a boot with a malformed `LLM_RESPONSE_FORMAT` fails
  // at startup instead of on the first claimed job. `loadLlmConfig` throws on a
  // missing key; absent here means the handler refuses by name.
  const llmConfig = env.OPENROUTER_API_KEY ? loadLlmConfig(env) : undefined
  const llm = llmConfig
    ? new LlmClient({
        chat: createOpenRouterClient(llmConfig),
        config: llmConfig,
        budget: guard,
        logger,
      })
    : undefined

  handlers.register(
    "refine.extract",
    createRefineHandler({
      runs: new PostgresHarvestRunStore(database.db),
      items: new PostgresRawItemStore(database.db),
      sink: new PostgresMentionSink(database.db),
      ...(llm ? { llm } : {}),
      // The rest of the chain: extract queues resolve, resolve queues dedup,
      // dedup queues score. See `chain.ts` for why each link is non-fatal.
      queue: jobs,
    }),
  )

  // P3.1: one URL from every country. The adapter is the price one; a second probe
  // source is a line here. With a TypeSafe key, Jev judges each page (wall, property,
  // price visible) on top of the regex checks; without one, the regex stands alone.
  const priceAdapter = createPriceAdapter(
    env.TYPESAFE_API_KEY ? { judge: createJevJudge(env.TYPESAFE_API_KEY) } : {},
  )
  handlers.register(
    "probe.run",
    createProbeHandler({
      targets: new PostgresProbeTargetStore(database.db),
      observations: new PostgresObservationStore(database.db),
      // Under the web app's `public/`, so the dev server serves each shot at
      // `/shots/<ref>`. Local disk is the stand-in: production needs object storage.
      archive: new FilesystemScreenshotArchive(env.PROBE_SCREENSHOT_DIR ?? "../web/public/shots"),
      adapters: new Map<string, ProbeAdapter>([[priceAdapter.id, priceAdapter as ProbeAdapter]]),
      rates: dailyFx(),
    }),
  )

  // P5.1: keepalives for personas idle 36-72 h. Queues only.
  handlers.register("persona.sweep", createPersonaSweepHandler({ personas, queue: jobs }))

  // P3.5: daily re-probe of watched targets. Queues only.
  handlers.register(
    "probe.sweep",
    createProbeSweepHandler({
      targets: new PostgresProbeTargetStore(database.db),
      queue: jobs,
      maxTargets: Number(env.PROBE_SWEEP_MAX ?? 5),
    }),
  )

  // P5.2: the daily sweep. Queues harvests; spends nothing itself.
  handlers.register(
    "trip.sweep",
    createSweepHandler({
      trips: new PostgresTripStore(database.db),
      personas,
      queue: jobs,
      maxTrips: Number(env.TRIP_SWEEP_MAX ?? 3),
    }),
  )

  // A character sent exploring: its interests, asked in its language, queued as
  // harvests. Queues only; translates a free-text interest when there is a model.
  handlers.register("persona.explore", createExploreHandler({ personas, queue: jobs, llm }))

  // P4.3: dates the traveller wrote in prose, copied onto the Trip. Refuses by
  // name when there is no LLM, like `refine.extract`.
  handlers.register(
    "trip.intent",
    createIntentHandler({ trips: new PostgresTripStore(database.db), llm }),
  )

  /**
   * The registry, built with what the travel pack needs to resolve.
   *
   * `osm` is passed unconditionally rather than behind a flag for whether the
   * extract has been loaded. An empty `osm_places` returns no candidates, which
   * is exactly what an absent `osm` means to the resolver — so a flag would be a
   * second way to say one thing, and the one that can disagree with reality.
   */
  const packs = createPackRegistry({
    travel: {
      places: new PostgresPlaceRepo(database.db),
      osm: new PostgresOsmSearch(database.db),
    },
  })

  handlers.register(
    "refine.resolve",
    createResolveHandler({
      pending: new PostgresPendingMentions(database.db),
      cache: new PostgresResolutionCache(database.db),
      // Unconditional, unlike `lookup` below. Writing a receipt for a mention
      // that just found its entity costs one insert against rows already in
      // hand, and the alternative — the state this repository was in before
      // P2.5 — is a scorer reading an empty table and reporting every place as
      // unevidenced.
      evidence: new PostgresEvidenceWriter(database.db),
      // No `lookup` yet: Tier 2's provider is undecided and needs a key nobody
      // has created. Tiers 0 and 1 carry the whole corpus until then, which is
      // what ADR-0017 predicts they should mostly be doing anyway.
      queue: jobs,
    }),
  )

  handlers.register(
    "refine.dedup",
    createDedupHandler({ links: new PostgresEntityLinks(database.db), queue: jobs }),
  )

  handlers.register(
    "refine.score",
    createScoreHandler({ evidence: new PostgresEvidenceStore(database.db) }),
  )

  return {
    db: database,
    jobs,
    kernel,
    registry,
    handlers,
    packs,
    logger,
    async close() {
      await database.sql.end({ timeout: 5 })
    },
  }
}
