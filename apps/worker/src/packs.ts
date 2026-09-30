import { createTravelPack, dealsPack, type TravelPackDeps, travelPack } from "@dt/travel-pack"
import { PackRegistry } from "@samsara/refine"

/**
 * Domain packs, wired in at boot (section 2.5, ADR-0010).
 *
 * **One line per pack, and that is the point of the file.** P0.5 shipped this
 * with zero packs to prove the runner had no vertical compiled into it. P2.2
 * registered the travel pack as a single line with nothing accompanying it, and
 * the deals pack went in the same way. A pack that needed more than its line
 * here would mean the seam has a hole in it.
 *
 * It is a function rather than a module-level constant so that a test can build an
 * independent registry, and so that registration order is somewhere a reader can
 * see rather than being an import side effect.
 */
export interface PackRegistryDeps {
  /**
   * What the travel pack needs to *resolve*, as opposed to extract.
   *
   * Optional, and the asymmetry is the point. Extraction needs nothing but a
   * prompt, so `travelPack` is a constant three call sites already use — the
   * bake-off, the golden set, and a registry built by a test. Resolution needs a
   * place to write entities and a database to search, which a process without a
   * connection does not have.
   *
   * Absent, the extract-only pack is registered and a `refine.resolve` job for
   * this domain fails by name on `has no resolve spec`. That is the right
   * failure: a runner that silently resolved nothing would report a clean run
   * over a corpus it never touched.
   */
  travel?: TravelPackDeps
}

export function createPackRegistry(deps: PackRegistryDeps = {}): PackRegistry {
  const registry = new PackRegistry()
  registry.register(deps.travel ? createTravelPack(deps.travel) : travelPack)
  // Discount codes: extract only, so their harvests stop after `refine.extract`.
  registry.register(dealsPack)
  return registry
}
