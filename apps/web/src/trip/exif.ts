/**
 * Where and when a photo was taken, read from its EXIF block (P4.6: "EXIF geo/time
 * extracted, becomes a mappable block").
 *
 * JPEG only, and only the four things a Postcard can use: latitude, longitude,
 * `DateTimeOriginal` and its offset. Written here rather than pulled in as a
 * library because those four fields are a few hundred bytes of one TIFF structure
 * and the approved dependency list (PLAN §4) has no EXIF reader on it. A HEIC or
 * PNG answers "nothing found", which the card then says.
 *
 * **Time is the wall clock, written as if it were UTC.** A trip's days are the
 * days on the ground — the 15th in Bangkok — and every trip date in this app is
 * that calendar day at midnight UTC. Converting a 06:00 photo taken at +07:00 to
 * its true instant would land it at 23:00 on the 14th and file it under the wrong
 * day. So `OffsetTimeOriginal` is not applied: the camera's own clock reading is
 * kept, which is exactly the day and hour the traveller would say.
 */

export interface PhotoFacts {
  geo: { lat: number; lng: number } | null
  /** ISO 8601, or null when the camera recorded no time. */
  takenAt: string | null
}

const NONE: PhotoFacts = { geo: null, takenAt: null }

const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_DATETIME_ORIGINAL = 0x9003
const TAG_GPS_LAT_REF = 0x0001
const TAG_GPS_LAT = 0x0002
const TAG_GPS_LNG_REF = 0x0003
const TAG_GPS_LNG = 0x0004

const TYPE_ASCII = 2
const TYPE_LONG = 4
const TYPE_RATIONAL = 5

interface Entry {
  tag: number
  type: number
  count: number
  /** Offset of the value (or of the 4-byte inline value) from the TIFF start. */
  valueOffset: number
}

export function readPhotoFacts(buffer: ArrayBuffer): PhotoFacts {
  const view = new DataView(buffer)
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return NONE

  // Walk the JPEG segments to APP1 "Exif\0\0".
  let offset = 2
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset)
    if ((marker & 0xff00) !== 0xff00) return NONE
    const length = view.getUint16(offset + 2)
    if (marker === 0xffe1 && isExifHeader(view, offset + 4)) {
      return readTiff(view, offset + 10)
    }
    // Start of scan: image data follows and no metadata comes after it.
    if (marker === 0xffda) return NONE
    offset += 2 + length
  }
  return NONE
}

function isExifHeader(view: DataView, at: number): boolean {
  if (at + 6 > view.byteLength) return false
  return (
    view.getUint32(at) === 0x45786966 && // "Exif"
    view.getUint16(at + 4) === 0x0000
  )
}

function readTiff(view: DataView, tiff: number): PhotoFacts {
  try {
    const order = view.getUint16(tiff)
    const little = order === 0x4949
    if (!little && order !== 0x4d4d) return NONE
    const u16 = (at: number) => view.getUint16(tiff + at, little)
    const u32 = (at: number) => view.getUint32(tiff + at, little)
    if (u16(2) !== 42) return NONE

    const readIfd = (at: number): Entry[] => {
      const n = u16(at)
      const entries: Entry[] = []
      for (let i = 0; i < n; i++) {
        const e = at + 2 + i * 12
        const type = u16(e + 2)
        const count = u32(e + 4)
        const size = count * (type === TYPE_RATIONAL ? 8 : type === TYPE_LONG ? 4 : 1)
        // Values of four bytes or fewer live in the entry itself.
        entries.push({ tag: u16(e), type, count, valueOffset: size <= 4 ? e + 8 : u32(e + 8) })
      }
      return entries
    }
    const find = (entries: Entry[], tag: number) => entries.find((e) => e.tag === tag)
    const ascii = (e: Entry | undefined) => {
      if (!e || e.type !== TYPE_ASCII) return null
      let s = ""
      for (let i = 0; i < e.count; i++) {
        const c = view.getUint8(tiff + e.valueOffset + i)
        if (c === 0) break
        s += String.fromCharCode(c)
      }
      return s
    }
    const rationals = (e: Entry | undefined) => {
      if (!e || e.type !== TYPE_RATIONAL) return null
      const out: number[] = []
      for (let i = 0; i < e.count; i++) {
        const den = u32(e.valueOffset + i * 8 + 4)
        out.push(den === 0 ? Number.NaN : u32(e.valueOffset + i * 8) / den)
      }
      return out
    }

    const ifd0 = readIfd(u32(4))

    let takenAt: string | null = null
    const exifPointer = find(ifd0, TAG_EXIF_IFD)
    if (exifPointer) {
      const exif = readIfd(u32(exifPointer.valueOffset))
      takenAt = toIso(ascii(find(exif, TAG_DATETIME_ORIGINAL)))
    }

    let geo: PhotoFacts["geo"] = null
    const gpsPointer = find(ifd0, TAG_GPS_IFD)
    if (gpsPointer) {
      const gps = readIfd(u32(gpsPointer.valueOffset))
      const lat = degrees(rationals(find(gps, TAG_GPS_LAT)), ascii(find(gps, TAG_GPS_LAT_REF)), "S")
      const lng = degrees(rationals(find(gps, TAG_GPS_LNG)), ascii(find(gps, TAG_GPS_LNG_REF)), "W")
      // (0, 0) is a phone with GPS off writing zeroes, not a photo off Ghana.
      if (lat !== null && lng !== null && !(lat === 0 && lng === 0)) geo = { lat, lng }
    }

    return { geo, takenAt }
  } catch {
    // A truncated or malformed block reads as "nothing found", never as a crash.
    return NONE
  }
}

function degrees(parts: number[] | null, ref: string | null, negative: string): number | null {
  if (!parts || parts.length < 3) return null
  const [d, m, s] = parts as [number, number, number]
  const value = d + m / 60 + s / 3600
  if (!Number.isFinite(value)) return null
  const signed = ref?.toUpperCase() === negative ? -value : value
  return Math.round(signed * 1e6) / 1e6
}

function toIso(stamp: string | null): string | null {
  const m = stamp?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
  return Number.isNaN(new Date(iso).getTime()) ? null : new Date(iso).toISOString()
}
