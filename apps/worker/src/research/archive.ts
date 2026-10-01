import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { type ReceiptKind, sha256Hex } from "@rd/research"

/**
 * Receipt bytes on local disk, content-addressed: the key is the SHA-256 of the
 * bytes, so a receipt cannot be edited in place without its name no longer
 * matching its hash, and two runs that saw identical bytes share one file.
 *
 * Under the web app's `public/` in development, so Vite serves each at
 * `/receipts/<ref>`. Object storage replaces this in production; the ref is
 * already a bucket key.
 *
 * Stored HTML gets a `.txt` extension on purpose. Served as `text/html` from our
 * origin, a captured store page would run Steam's scripts with our cookies. As
 * text it can only be shown, in a sandboxed frame.
 */

const EXT: Record<ReceiptKind, string> = {
  json: "json",
  html: "html.txt",
  screenshot: "jpg",
  replay: "ndjson",
  computation: "json",
}

export interface Archived {
  sha256: string
  bytes: number
  ref: string
}

export class FilesystemReceiptArchive {
  readonly #root: string
  constructor(root: string) {
    this.#root = resolve(root)
    mkdirSync(this.#root, { recursive: true })
  }

  async put(kind: ReceiptKind, body: Uint8Array): Promise<Archived> {
    const sha256 = await sha256Hex(body)
    const ref = `${sha256}.${EXT[kind]}`
    const path = join(this.#root, ref)
    if (!existsSync(path)) writeFileSync(path, body)
    return { sha256, bytes: body.byteLength, ref }
  }
}
