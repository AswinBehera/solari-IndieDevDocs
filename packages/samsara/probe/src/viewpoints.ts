/**
 * The eight countries v1 probes from (P3.1), each with the locale and clock a
 * resident's browser would report. Egress alone is half a viewpoint (P1.0 measured
 * this): a `th` IP asking in `en-US` on UTC is not a Thai visitor.
 */
export interface ProbeViewpoint {
  country: string
  locale: string
  timezoneId: string
}

export const PROBE_VIEWPOINTS: readonly ProbeViewpoint[] = [
  { country: "th", locale: "th-TH", timezoneId: "Asia/Bangkok" }, // seam:allow IANA zone id, a clock identifier not a place
  { country: "us", locale: "en-US", timezoneId: "America/New_York" },
  { country: "gb", locale: "en-GB", timezoneId: "Europe/London" },
  { country: "in", locale: "en-IN", timezoneId: "Asia/Kolkata" },
  { country: "jp", locale: "ja-JP", timezoneId: "Asia/Tokyo" }, // seam:allow IANA zone id, a clock identifier not a place
  { country: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
  { country: "au", locale: "en-AU", timezoneId: "Australia/Sydney" },
  { country: "sg", locale: "en-SG", timezoneId: "Asia/Singapore" },
]
