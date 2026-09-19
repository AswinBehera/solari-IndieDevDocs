import { place } from "@dt/core"
import type { z } from "zod"

/**
 * What the resolve stage is allowed to write about a place.
 *
 * Derived from `@dt/core`'s `place` rather than restated, so the two cannot
 * drift: if a column is added there, this either picks it up or visibly does
 * not, and neither can happen silently.
 *
 * What is left out is the argument. `id` belongs to the database. `scores` is
 * P2.5's and every score it holds carries its own explanations, which a resolver
 * has none of. `firstSeenAt`, `lastSeenAt` and `evidenceCount` are facts about
 * the corpus that the repo maintains across many mentions, and a resolver
 * handed one mention would set them from a sample of one. The engine validates
 * this shape before the pack's repo is allowed to write — see `ResolveSpec` —
 * so a field that is not here is a field the resolver cannot set by accident.
 *
 * `geo` stays nullable and `resolvedTier` stays nullable together, and they are
 * the Tier 3 case: a mention nobody could place is still written, with no
 * coordinate and no tier. ADR-0008's rule that a place without geo is not a
 * marker is kept by not drawing it, not by refusing to remember it — a name the
 * tiers all missed is the only evidence of what they are missing.
 */
export const placeEntity = place.pick({
  canonicalName: true,
  localName: true,
  city: true,
  geo: true,
  externalRef: true,
  resolvedTier: true,
  category: true,
  tags: true,
})

export type PlaceEntity = z.infer<typeof placeEntity>
