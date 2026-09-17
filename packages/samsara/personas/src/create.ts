import { randomUUID } from "node:crypto"
import type { PersonaTier } from "@samsara/core"
import {
  classify,
  err,
  type Failure,
  failure,
  Kernel,
  type Logger,
  now,
  ok,
  type ProfileStore,
  type Result,
  silentLogger,
} from "@samsara/kernel"
import type { PersonaRecord, PersonaStore } from "./store.js"

/**
 * Creating an identity (plan section P1.1).
 *
 * Three things happen and the order between them is the design: validate, take a
 * provider profile, write the row. Validation first because it is free; the
 * profile before the row because a row pointing at a profile that was never
 * created is a persona that fails at launch time, whereas a profile with no row is
 * a few kilobytes we can name and delete.
 */

export interface CreatePersonaDeps {
  store: PersonaStore
  /**
   * Required for `seeded`, unused for `anon`. See the refusal below — a seeded
   * persona with nowhere to keep what it learns is not a seeded persona.
   */
  profiles?: ProfileStore
  logger?: Logger
  newId?: () => string
}

export interface CreatePersonaInput {
  name: string
  /** Free text: where this identity reads as being from. */
  locality: string
  /** Lowercase ISO 3166-1 alpha-2, and one the provider's pool actually has. */
  country: string
  locale: string
  /** IANA zone. Stored, never derived from the other two — see the column comment. */
  timezoneId: string
  /** Defaults to `anon`, which is the cheap, disposable, profile-less kind. */
  tier?: PersonaTier
  seedPlanId?: string | null
}

/**
 * A sticky proxy key, so one identity keeps one egress address *within* a flow.
 *
 * **Not across days, and this comment used to claim otherwise.** The provider's
 * `session` pin lapses on a clock: `sessionDuration` is 1 to 30 minutes, default 10,
 * and reusing the key on a later run lands the same address only while the pin is
 * still alive. A persona harvesting once a day gets a different residential IP every
 * day no matter what this key says. What the key actually buys is that a multi-step
 * flow does not change address halfway through, which is what gets challenged as a
 * session hijack — real, and much smaller than "one identity, one address".
 *
 * The consequence is worth stating where somebody will read it: **a persona's
 * continuity across a week lives in its profile, not its address.** See Q13.
 *
 * Random rather than derived from the persona id, for two reasons. It is handed to
 * a third party, and an id that round-trips through a vendor is an id that can be
 * correlated back. And rotation has to be possible: a degraded persona wants the
 * same identity behind a *different* address, which a derived key cannot express.
 */
export const newProxySessionKey = (newId: () => string = randomUUID): string =>
  newId().replace(/-/g, "").slice(0, 16)

export async function createPersona(
  deps: CreatePersonaDeps,
  input: CreatePersonaInput,
): Promise<Result<PersonaRecord, Failure>> {
  const logger = deps.logger ?? silentLogger
  const newId = deps.newId ?? randomUUID
  const tier: PersonaTier = input.tier ?? "anon"

  if (input.name.trim() === "" || input.locality.trim() === "") {
    return err(failure("config", "persona needs a name and a locality"))
  }

  const id = newId()
  const proxySession = newProxySessionKey(newId)

  // Validated by the launch it will one day make, rather than by a second copy of
  // the same rules. An identity that cannot open a session is not an identity, and
  // finding that out at creation costs nothing while finding it out at harvest
  // time costs a queued job and a confused log line.
  const valid = Kernel.validateLaunch({
    stealth: true,
    proxy: { country: input.country, session: proxySession },
    viewpoint: { locale: input.locale, timezoneId: input.timezoneId },
  })
  if (!valid.ok) return valid

  let solariProfileId: string | null = null
  if (tier === "seeded") {
    if (!deps.profiles) {
      // Refused rather than downgraded to `anon`. A silent downgrade produces a
      // persona that looks seeded in every listing, accumulates nothing for weeks,
      // and is indistinguishable from one whose seeding simply did not work.
      return err(
        failure(
          "config",
          "a seeded persona needs a profile store; pass `profiles` or create it as anon",
        ),
      )
    }
    try {
      // Named by id, not by `input.name`. Names are human, they collide, and the
      // provider's profile list is not a place for a caller's vocabulary.
      const profile = await deps.profiles.create(`persona-${id}`)
      solariProfileId = profile.id
    } catch (thrown) {
      return err(classify(thrown))
    }
  }

  const row: PersonaRecord = {
    id,
    name: input.name,
    locality: input.locality,
    country: input.country,
    locale: input.locale,
    timezoneId: input.timezoneId,
    tier,
    solariProfileId,
    proxySession,
    health: "healthy",
    seedPlanId: input.seedPlanId ?? null,
    // Null, not `now`: nothing has proved this identity works yet. A creation
    // timestamp masquerading as an aliveness timestamp makes every brand-new
    // persona look freshly exercised, which is the opposite of the truth.
    lastAliveAt: null,
    stats: { sessions: 0, minutes: 0, blocks: 0 },
  }

  try {
    await deps.store.insert(row)
  } catch (thrown) {
    if (solariProfileId && deps.profiles) {
      try {
        await deps.profiles.delete(solariProfileId)
      } catch {
        // The profile is now an orphan at the provider. Nothing else can be done
        // from here, and the insert failure is the news; `profiles.list()` names
        // the leak later, which is why profiles are named after persona ids.
      }
    }
    return err(classify(thrown))
  }

  logger.emit({
    at: now(),
    event: "persona.created",
    personaId: id,
    country: row.country,
    locale: row.locale,
    tier,
    profile: solariProfileId !== null,
  })
  return ok(row)
}
