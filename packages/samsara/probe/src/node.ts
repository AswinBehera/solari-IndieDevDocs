import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { ScreenshotArchive } from "./adapter.js"

/**
 * Screenshots on local disk, the stand-in `FilesystemCaptureArchive` is for captures:
 * section 8 puts them in object storage, there are no credentials for one yet, and
 * `runProbe` treats a failed archive as fatal. The ref shape matches a bucket key so
 * the swap is a copy. Its own entry point because it reaches `node:fs`.
 */
export class FilesystemScreenshotArchive implements ScreenshotArchive {
  readonly #root: string
  constructor(root: string) {
    this.#root = resolve(root)
  }
  async put(targetId: string, country: string, at: Date, png: Uint8Array): Promise<string> {
    const ref = join(
      "probe",
      targetId,
      country,
      `${at.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.png`,
    )
    const path = join(this.#root, ref)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, png)
    return ref
  }
}
