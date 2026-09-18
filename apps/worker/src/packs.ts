import { travelPack } from "@dt/travel-pack"
import { PackRegistry } from "@samsara/refine"

/**
 * Domain packs, wired in at boot (section 2.5, ADR-0010).
 *
 * **One pack, registered in one line, and that is the point of the file.** P0.5
 * shipped this with zero packs to prove the runner had no vertical compiled into
 * it. P2.2 registers the travel pack — and the claim held: it is the single line
 * below, with nothing accompanying it. Had it needed anything else, the seam would
 * have a hole in it.
 *
 * It is a function rather than a module-level constant so that a test can build an
 * independent registry, and so that registration order is somewhere a reader can
 * see rather than being an import side effect.
 */
export function createPackRegistry(): PackRegistry {
  const registry = new PackRegistry()
  registry.register(travelPack)
  return registry
}
