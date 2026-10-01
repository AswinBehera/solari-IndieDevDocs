/**
 * Solari's residential proxy pool, as it actually is.
 *
 * Read from a live 400 on 11 September 2026, not from documentation:
 *
 *   POST /sessions -> 400 {"error":"Unsupported proxy country", ...
 *     "supported":["au","br","ca","de","es","fr","gb","in","it","jp","kr",
 *                  "mx","nl","sg","us"]}
 *
 * The kernel checks a launch against it so an unsupported country fails at once,
 * by name, instead of at a launch that has already cost a round trip. Pools change,
 * so this is the part that goes stale.
 */
export const SUPPORTED_PROXY_COUNTRIES = [
  "au",
  "br",
  "ca",
  "de",
  "es",
  "fr",
  "gb",
  "in",
  "it",
  "jp",
  "kr",
  "mx",
  "nl",
  "sg",
  "us",
] as const

export type SupportedProxyCountry = (typeof SUPPORTED_PROXY_COUNTRIES)[number]

export const isSupportedProxyCountry = (country: string): country is SupportedProxyCountry =>
  (SUPPORTED_PROXY_COUNTRIES as readonly string[]).includes(country)
