/**
 * One live price probe, by hand: `npx tsx tools/probe-live.ts <property-url> [cc,cc,...] <out-dir>`.
 *
 * **Spends real browser minutes** (one session per country, up to ~90 s each) and is
 * never run by CI. It uses in-memory stores on purpose, so a trial writes nothing to
 * any database; it prints the minutes it used and saves each screenshot to `<out-dir>`
 * so a reading can be checked against the picture.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  BudgetGuard,
  DEFAULT_CEILINGS,
  Kernel,
  MemoryCounterStore,
  MemoryLogger,
  MemorySessionStore,
  SessionRegistry,
} from "../packages/samsara/kernel/src/index.js"
import {
  createSolariBrowserLauncher,
  solariCredentials,
} from "../packages/samsara/kernel/src/solari.js"
import {
  dailyFx,
  MemoryObservationStore,
  PROBE_VIEWPOINTS,
  runProbe,
  type ScreenshotArchive,
} from "../packages/samsara/probe/src/index.js"
import { priceAdapter } from "../packages/travel/pack/src/price/index.js"

const [url, countriesArg, outDir] = process.argv.slice(2)
if (!url || !outDir) {
  console.error("usage: npx tsx tools/probe-live.ts <property-url> <cc,cc|all> <out-dir>")
  process.exit(1)
}
const parsed = priceAdapter.parseUrl(url)
if (!parsed.ok) {
  console.error(`refused: ${parsed.reason}`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const wanted = countriesArg && countriesArg !== "all" ? countriesArg.split(",") : null
const viewpoints = PROBE_VIEWPOINTS.filter((v) => !wanted || wanted.includes(v.country))

const logger = new MemoryLogger()
const launcher = createSolariBrowserLauncher(solariCredentials())
const kernel = new Kernel({
  registry: new SessionRegistry(new MemorySessionStore(), logger),
  guard: new BudgetGuard({ store: new MemoryCounterStore(), ceilings: DEFAULT_CEILINGS }),
  browser: launcher,
  logger,
})
const archive: ScreenshotArchive = {
  async put(_t, country, _at, png) {
    const path = join(outDir, `${country}.png`)
    writeFileSync(path, png)
    return path
  },
}
const observations = new MemoryObservationStore()
const started = Date.now()
try {
  const report = await runProbe(
    { kernel, observations, archive, rates: dailyFx() },
    {
      target: {
        id: "live",
        ownerId: null,
        sourceId: "price.stay",
        url: parsed.parsed.url,
        parsed: parsed.parsed,
        watch: false,
        cadence: null,
        createdAt: new Date(),
      },
      adapter: priceAdapter as never,
      viewpoints,
    },
  )
  for (const r of report.results) {
    const o = observations.rows.find((x) => x.country === r.country)
    const p = o?.payload as
      | {
          status?: string
          displayed?: string
          source?: string
          usd?: number | null
          title?: string
          wall?: string | null
        }
      | undefined
    console.log(
      r.country,
      r.outcome,
      p
        ? `${p.status} | ${p.displayed ?? "-"} | via ${p.source ?? "-"} | usd ${p.usd ?? "-"} | wall ${p.wall ?? "-"} | ${p.title}`
        : r.failure,
    )
  }
  console.log(`wall clock ${(Date.now() - started) / 1000}s`)
} finally {
  await launcher.dispose()
}
