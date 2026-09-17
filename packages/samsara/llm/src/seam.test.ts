import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The package-local seam check. P0.7 generalises this across the whole tree; this
 * one stays, so a package that breaks the rule fails in the package that broke it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, "..")

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : []
  })

const importsProductScope = /(?:\bfrom|\bimport|\brequire\()\s*["']@dt\//

describe("@samsara/llm stays on the engine side of the seam", () => {
  it("imports nothing from the product scope", () => {
    const offenders = sourceFiles(join(pkgRoot, "src")).filter((file) =>
      importsProductScope.test(readFileSync(file, "utf8")),
    )
    expect(offenders).toEqual([])
  })

  it("declares no product-scope dependency", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    expect(all.filter((d) => d.startsWith("@dt/"))).toEqual([])
  })

  it("reaches the provider SDK from exactly one file", () => {
    // The point of ports.ts, and the thing that makes ADR-0012's stated exit — a
    // direct provider key — a rewrite of one file rather than of this package.
    const offenders = sourceFiles(join(pkgRoot, "src"))
      .filter((f) => !f.endsWith("openrouter.ts") && !f.endsWith("seam.test.ts"))
      .filter((f) => /["']openai["']/.test(readFileSync(f, "utf8")))
    expect(offenders).toEqual([])
  })

  it("holds no model id, because the model is config and not code (ADR-0012)", () => {
    // A default baked in "for now" is how a model nobody measured ends up in
    // production. The only model ids in this package are in tests, and they are
    // deliberately fictional vendors.
    const vendors = /\b(anthropic|openai|google|meta-llama|mistralai|deepseek|qwen)\//
    const offenders = sourceFiles(join(pkgRoot, "src"))
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => vendors.test(readFileSync(f, "utf8")))
    expect(offenders).toEqual([])
  })
})
