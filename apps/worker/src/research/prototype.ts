/// <reference lib="dom" />
import {
  type BlockRecord,
  type PrototypeBootValue,
  type PrototypeBuildValue,
  type PrototypeConsoleValue,
  type PrototypeLiveValue,
  type PrototypeScreenValue,
  parseParams,
} from "@rd/research"
import type { SandboxHandle } from "@samsara/kernel"
import type { JobContext, JobHandler } from "../handlers.js"
import type { BlockRunDeps, Outcome, Recorder } from "./block-run.js"
import type { PageLike } from "./capture.js"

/**
 * `prototype`: a playable web build beside the research it answers.
 *
 * A Solari sandbox clones the repository at the asked branch and serves the
 * folder holding `index.html`. A recorded Solari browser then opens it, waits for
 * it to boot, presses a few keys and screenshots before and after. The receipts
 * are the build (commit and file list), the page's HTML, both screenshots, the
 * console and the replay. The sandbox is kept for `keepMinutes` so the document can
 * embed it, and a `prototype.stop` job, queued for that time, kills it.
 *
 * The preview URL carries the provider's access token. It goes into the
 * `prototype.live` fact, which only the owner can read, and is scrubbed from
 * every receipt, because receipts are files a later share could serve.
 */

export const PROTOTYPE_STOP = "prototype.stop" as const

const ROOT = "/srv/build"
const PORT = 8000
/** The boot capture runs after the sandbox call returns, so the sandbox outlives it at least this long. */
const CAPTURE_MS = 4 * 60_000
const BOOT_WAIT_MS = 4_000
const KEYS = ["Space", "Enter", "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"]

/**
 * A static file server that knows the types web game exports use. Python's own
 * guesses `.wasm` and `.pck` wrong on some images, and a wrong type on the wasm
 * is a black screen.
 */
const SERVER = `import http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm", ".pck": "application/octet-stream",
        ".data": "application/octet-stream", ".js": "text/javascript", ".mjs": "text/javascript"}
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), H).serve_forever()
`

interface Served {
  sandboxId: string
  url: string
  build: PrototypeBuildValue
  largest: { path: string; bytes: number }[]
}

export async function prototype(
  block: BlockRecord,
  rec: Recorder,
  deps: BlockRunDeps,
  ctx: JobContext,
): Promise<Outcome> {
  const p = parseParams("prototype", block.params)
  if (!p.ok) return { outcome: "failed", note: p.error }
  const { repo, ref, dir, keepMinutes } = p.value
  if (!repo) return { outcome: "failed", note: "no repository set" }
  if (!deps.sandbox) {
    return { outcome: "blocked", note: "prototypes run in a Solari sandbox: set SOLARI_API_KEY" }
  }
  await stopPrevious(block, deps, ctx)

  rec.stats.planned = 1
  await ctx.heartbeat("cloning into a sandbox")
  const keepMs = Math.max(keepMinutes * 60_000, CAPTURE_MS)
  const served = await ctx.kernel.withSandbox<Served>(
    "probe",
    {
      template: "base",
      ownerId: ctx.job.ownerId,
      domainId: "prototype",
      runId: rec.runId,
      attempts: 1,
      deadlineMs: 150_000,
      keepMs,
      metadata: { app: "indiedevdocs", block: block.id, run: rec.runId },
    },
    (sb) => cloneAndServe(sb, repo, ref, dir),
  )
  if (!served.ok) {
    return { outcome: "failed", note: `sandbox: ${served.error.cause ?? served.error.message}` }
  }
  const { sandboxId, url, build, largest } = served.value
  const until = new Date(Date.now() + keepMinutes * 60_000)
  const token = new URL(url).searchParams.get("pt_token") ?? ""
  const origin = new URL(url).origin
  const scrub = (s: string) => (token ? s.split(token).join("(token removed)") : s)

  const buildReceipt = await rec.receipt({
    kind: "json",
    runtime: "sandbox",
    url: repo,
    body: json({
      ...build,
      largest,
      serve: { port: PORT, origin, keptUntil: keepMinutes > 0 ? until.toISOString() : null },
    }),
    // No session id: the column holds browser sessions from the kernel's
    // registry, and a sandbox is not one. The live fact names the sandbox.
    contentType: "application/json",
  })
  rec.fact(buildReceipt.id, "build", "prototype.build", build, { path: "$.commit" })
  if (keepMinutes > 0) {
    const live: PrototypeLiveValue = { url, until: until.toISOString(), sandboxId }
    rec.fact(buildReceipt.id, "build", "prototype.live", live, { path: "$.serve" })
  }

  const notes: string[] = []
  await ctx.heartbeat("opening the build in a cloud browser")
  const booted = deps.browser ? await recordBoot(url, origin, scrub, rec, ctx) : null
  if (!deps.browser) notes.push("no cloud browser, so no boot recording")
  else if (booted) notes.push(...booted.notes)

  if (keepMinutes > 0 && deps.queue) {
    await deps.queue.enqueue({
      type: PROTOTYPE_STOP,
      ownerId: ctx.job.ownerId,
      payload: { sandboxId, blockId: block.id },
      runAfter: until,
      idempotencyKey: `${PROTOTYPE_STOP}:${rec.runId}`,
    })
  } else {
    const killed = await ctx.kernel.killSandbox(sandboxId)
    if (!killed.ok) notes.push(`could not stop the sandbox: ${killed.error.message}`)
    else if (keepMinutes > 0)
      notes.push("no job queue, so the sandbox was stopped after the recording")
  }

  rec.stats.covered = booted?.ok ? 1 : 0
  return {
    outcome: deps.browser && !booted?.ok ? "partial" : "ok",
    note: notes.length > 0 ? notes.join("; ") : null,
  }
}

/** One playable sandbox per block: a re-run stops the last run's, rather than leaving it to its timer. */
async function stopPrevious(block: BlockRecord, deps: BlockRunDeps, ctx: JobContext) {
  if (!block.lastRunId) return
  const facts = await deps.store.factsForRuns([block.lastRunId])
  for (const f of facts) {
    if (f.key !== "prototype.live") continue
    const live = f.value as PrototypeLiveValue
    if (Date.parse(live.until) > Date.now()) await ctx.kernel.killSandbox(live.sandboxId)
  }
}

async function cloneAndServe(
  sb: SandboxHandle,
  repo: string,
  ref: string,
  dir: string,
): Promise<Served> {
  if (!sb.previewUrl) throw new Error("this sandbox launcher has no preview URLs")
  // argv throughout: the repository, branch and folder are the writer's text and
  // never pass through a shell.
  const clone = await sb.run("git", [
    "clone",
    "--depth=1",
    "--single-branch",
    ...(ref ? [`--branch=${ref}`] : []),
    "--",
    repo,
    ROOT,
  ])
  if (clone.exitCode !== 0) throw new Error(`git clone: ${lastLine(clone.stderr)}`)

  const head = await sb.run("git", ["-C", ROOT, "log", "-1", "--format=%H%n%cI"])
  const [commit = "", committedAt = ""] = head.stdout.trim().split("\n")
  const root = dir ? `${ROOT}/${dir}` : ROOT
  const index = await sb.run("test", ["-f", `${root}/index.html`])
  if (index.exitCode !== 0) throw new Error(`no index.html in ${dir || "the repository's root"}`)

  const listing = await sb.run("find", [
    root,
    "-path",
    "*/.git",
    "-prune",
    "-o",
    "-type",
    "f",
    "-printf",
    "%s %P\\n",
  ])
  const files = listing.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ")
      return { path: line.slice(space + 1), bytes: Number(line.slice(0, space)) }
    })

  const write = await sb.run("sh", ["-c", `cat > /tmp/serve.py <<'PY'\n${SERVER}PY`])
  if (write.exitCode !== 0) throw new Error(`server: ${lastLine(write.stderr)}`)
  // Detached with setsid, so the server outlives this command's session. The
  // folder arrives as $1, not spliced into the script.
  const start = await sb.run("sh", [
    "-c",
    `cd "$1" && (setsid nohup python3 /tmp/serve.py ${PORT} >/tmp/serve.log 2>&1 &) && sleep 1 && curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/`,
    "sh",
    root,
  ])
  if (start.stdout.trim() !== "200")
    throw new Error(`server answered ${start.stdout.trim() || "nothing"}`)

  return {
    sandboxId: sb.id,
    url: await sb.previewUrl(PORT),
    build: {
      repo,
      ref,
      commit,
      committedAt: committedAt || null,
      dir,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
    },
    largest: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 20),
  }
}

// ---- boot recording ----------------------------------------------------------------

/** The Playwright page methods the recording uses, beyond a store page's. */
interface GamePage extends PageLike {
  on(event: string, fn: (arg: never) => void): void
  mouse: { click(x: number, y: number): Promise<void> }
  keyboard: { press(key: string): Promise<void> }
}

interface Boot {
  html: string
  shots: { boot: Uint8Array; input: Uint8Array }
  /** When each screenshot was taken, so the drawer orders them as they happened. */
  shotAt: { boot: Date; input: Date }
  log: {
    loadMs: number | null
    title: string
    canvas: { width: number; height: number } | null
    console: { errors: string[]; warnings: number; pageErrors: string[] }
    failed: string[]
    input: string[]
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function bootBuild(page: GamePage, url: string): Promise<Boot> {
  const errors: string[] = []
  const pageErrors: string[] = []
  const failed: string[] = []
  let warnings = 0
  page.on("console", (m: { type(): string; text(): string }) => {
    if (m.type() === "error") errors.push(m.text())
    else if (m.type() === "warning") warnings++
  })
  page.on("pageerror", (e: Error) => pageErrors.push(e.message))
  page.on("requestfailed", (r: { url(): string; failure(): { errorText: string } | null }) =>
    failed.push(`${r.url()} (${r.failure()?.errorText ?? "failed"})`),
  )
  page.on("response", (r: { url(): string; status(): number }) => {
    if (r.status() >= 400) failed.push(`${r.url()} (${r.status()})`)
  })

  await page.setViewportSize?.({ width: 1280, height: 800 })
  const started = Date.now()
  let loadMs: number | null = null
  try {
    await page.goto(url, { waitUntil: "load", timeout: 45_000 })
    loadMs = Date.now() - started
  } catch {
    // A build that never fires `load` is the finding; the screenshots still show what it did.
  }
  await sleep(BOOT_WAIT_MS)
  const seen = await page.evaluate(() => {
    let canvas: { width: number; height: number } | null = null
    for (const c of document.querySelectorAll("canvas")) {
      const r = c.getBoundingClientRect()
      if (r.width * r.height > (canvas ? canvas.width * canvas.height : 0)) {
        canvas = { width: Math.round(r.width), height: Math.round(r.height) }
      }
    }
    return { title: document.title, canvas }
  }, null)
  const boot = await page.screenshot({ fullPage: false, type: "jpeg", quality: 70 })
  const bootAt = new Date()

  // A click to take focus (and satisfy autoplay rules), then the keys most web
  // games start or move on.
  await page.mouse.click(640, 400)
  await sleep(500)
  for (const key of KEYS) {
    await page.keyboard.press(key)
    await sleep(250)
  }
  await sleep(1500)
  const input = await page.screenshot({ fullPage: false, type: "jpeg", quality: 70 })
  const inputAt = new Date()

  return {
    html: await page.content(),
    shots: { boot, input },
    shotAt: { boot: bootAt, input: inputAt },
    log: {
      loadMs,
      title: seen.title,
      canvas: seen.canvas,
      console: { errors, warnings, pageErrors },
      failed,
      input: ["click centre", ...KEYS],
    },
  }
}

async function recordBoot(
  url: string,
  origin: string,
  scrub: (s: string) => string,
  rec: Recorder,
  ctx: JobContext,
): Promise<{ ok: boolean; notes: string[] }> {
  let sessionId: string | null = null
  let providerId: string | null = null
  const captured = await ctx.kernel.withBrowser(
    "probe",
    {
      country: "direct",
      direct: true,
      attempts: 1,
      deadlineMs: 90_000,
      ownerId: ctx.job.ownerId,
      domainId: "prototype",
      runId: rec.runId,
      recording: true,
      onSession: (s) => {
        sessionId = s.sessionId
        providerId = s.providerId
        rec.stats.browserSessions++
        rec.stats.browserMinutes += s.minutes
      },
    },
    (page) => bootBuild(page as GamePage, url),
  )
  if (!captured.ok)
    return { ok: false, notes: [`browser: ${captured.error.kind}, no boot recording`] }

  const b = captured.value
  const at = new Date()
  const pageUrl = `${origin}/`
  const html = await rec.receipt({
    kind: "html",
    runtime: "browser",
    url: pageUrl,
    body: new TextEncoder().encode(scrub(b.html)),
    contentType: "text/html",
    sessionId,
    at,
  })
  for (const moment of ["boot", "input"] as const) {
    const shot = await rec.receipt({
      kind: "screenshot",
      runtime: "browser",
      url: pageUrl,
      body: b.shots[moment],
      contentType: "image/jpeg",
      sessionId,
      pairedWith: html.id,
      at: b.shotAt[moment],
    })
    // A build that ignored the input gives the same bytes twice: one receipt, cited by both facts.
    const v: PrototypeScreenValue = { moment }
    rec.fact(shot.id, "build", "prototype.screen", v, {})
  }

  const trim = (xs: string[]) => xs.slice(0, 8).map((x) => scrub(x).slice(0, 240))
  const log = {
    ...b.log,
    url: pageUrl,
    console: {
      ...b.log.console,
      errors: b.log.console.errors.map(scrub),
      pageErrors: b.log.console.pageErrors.map(scrub),
    },
    failed: b.log.failed.map(scrub),
  }
  const logReceipt = await rec.receipt({
    kind: "json",
    runtime: "browser",
    url: pageUrl,
    body: json(log),
    contentType: "application/json",
    sessionId,
    pairedWith: html.id,
    at,
  })
  const errors = [...log.console.pageErrors, ...log.console.errors]
  const boot: PrototypeBootValue = {
    loadMs: log.loadMs,
    title: log.title,
    canvas: log.canvas,
    errors: errors.length,
    warnings: log.console.warnings,
    failedRequests: log.failed.length,
    changedAfterInput: !sameBytes(b.shots.boot, b.shots.input),
  }
  rec.fact(logReceipt.id, "build", "prototype.boot", boot, { path: "$" })
  const consoleValue: PrototypeConsoleValue = { errors: trim(errors), failed: trim(log.failed) }
  rec.fact(logReceipt.id, "build", "prototype.console", consoleValue, { path: "$.console" })

  const notes: string[] = []
  if (providerId) {
    await ctx.heartbeat("waiting for the session replay")
    const replay = await ctx.kernel.replay(providerId, 60_000)
    if (replay.ok) {
      await rec.receipt({
        kind: "replay",
        runtime: "browser",
        url: pageUrl,
        body: new TextEncoder().encode(scrub(new TextDecoder().decode(replay.value))),
        contentType: "application/x-ndjson",
        sessionId,
        pairedWith: html.id,
      })
    } else {
      notes.push("no session replay arrived; the screenshots and log stand")
    }
  }
  return { ok: true, notes }
}

// ---- stop -------------------------------------------------------------------------

/** Kills a kept sandbox when its time is up. Already gone is a success. */
export function createPrototypeStopHandler(): JobHandler {
  return async (ctx) => {
    const { sandboxId } = (ctx.job.payload ?? {}) as { sandboxId?: unknown }
    if (typeof sandboxId !== "string")
      throw new Error("prototype.stop: payload.sandboxId is required")
    const killed = await ctx.kernel.killSandbox(sandboxId)
    if (!killed.ok) throw new Error(killed.error.message)
    await ctx.heartbeat(killed.value ? "sandbox stopped" : "sandbox had already stopped")
  }
}

// ---- helpers ----------------------------------------------------------------------

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2))
const lastLine = (s: string) => s.trim().split("\n").at(-1)?.slice(0, 200) ?? "failed"
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i])
