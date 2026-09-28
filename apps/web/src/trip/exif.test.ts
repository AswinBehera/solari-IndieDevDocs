import { describe, expect, it } from "vitest"
import { readPhotoFacts } from "./exif"

/**
 * A JPEG with an EXIF block built byte by byte, in either byte order — the same
 * structure a phone writes, cut down to the tags the reader looks for.
 */
function jpeg(opts: {
  little?: boolean
  lat?: [number, number, number]
  latRef?: string
  lng?: [number, number, number]
  lngRef?: string
  taken?: string
  offset?: string
}): ArrayBuffer {
  const little = opts.little ?? false
  const tiff: number[] = []
  const u16 = (v: number) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff])
  const u32 = (v: number) =>
    little
      ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
      : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  const at = (pos: number, bytes: number[]) => {
    for (let i = 0; i < bytes.length; i++) tiff[pos + i] = bytes[i] as number
  }
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat([0])

  // Layout: header 0-7, IFD0 at 8 (2 entries), Exif IFD at 40, GPS IFD at 80, data at 160.
  at(0, little ? [0x49, 0x49] : [0x4d, 0x4d])
  at(2, u16(42))
  at(4, u32(8))
  at(8, u16(2))
  at(10, [...u16(0x8769), ...u16(4), ...u32(1), ...u32(40)])
  at(22, [...u16(0x8825), ...u16(4), ...u32(1), ...u32(80)])
  at(34, u32(0))

  let data = 160
  const exifEntries: number[][] = []
  if (opts.taken) {
    exifEntries.push([...u16(0x9003), ...u16(2), ...u32(20), ...u32(data)])
    at(data, ascii(opts.taken))
    data += 20
  }
  if (opts.offset) {
    exifEntries.push([...u16(0x9011), ...u16(2), ...u32(7), ...u32(data)])
    at(data, ascii(opts.offset))
    data += 8
  }
  at(40, u16(exifEntries.length))
  for (const [i, e] of exifEntries.entries()) at(42 + i * 12, e)

  const gpsEntries: number[][] = []
  const rational3 = (vals: [number, number, number]) => {
    const start = data
    for (const v of vals) {
      at(data, [...u32(Math.round(v * 1000)), ...u32(1000)])
      data += 8
    }
    return start
  }
  if (opts.lat) {
    gpsEntries.push([...u16(0x0001), ...u16(2), ...u32(2), ...ascii(opts.latRef ?? "N"), 0, 0])
    gpsEntries.push([...u16(0x0002), ...u16(5), ...u32(3), ...u32(rational3(opts.lat))])
  }
  if (opts.lng) {
    gpsEntries.push([...u16(0x0003), ...u16(2), ...u32(2), ...ascii(opts.lngRef ?? "E"), 0, 0])
    gpsEntries.push([...u16(0x0004), ...u16(5), ...u32(3), ...u32(rational3(opts.lng))])
  }
  at(80, u16(gpsEntries.length))
  for (const [i, e] of gpsEntries.entries()) at(82 + i * 12, e)

  const body = Array.from({ length: Math.max(data, tiff.length) }, (_, i) => tiff[i] ?? 0)
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...body]
  const bytes = [
    0xff,
    0xd8,
    0xff,
    0xe1,
    (app1.length + 2) >> 8,
    (app1.length + 2) & 0xff,
    ...app1,
    0xff,
    0xd9,
  ]
  return new Uint8Array(bytes).buffer
}

describe("readPhotoFacts", () => {
  it("reads a coordinate and the camera's own clock, big-endian", () => {
    const facts = readPhotoFacts(
      jpeg({
        lat: [13, 46, 46.92],
        lng: [100, 32, 39.12],
        taken: "2026:11:15 09:12:30",
        offset: "+07:00",
      }),
    )
    expect(facts.geo).toEqual({ lat: 13.7797, lng: 100.5442 })
    // 09:12 in Bangkok stays 09:12 on the 15th: the offset is not applied, because
    // a trip's days are the days on the ground.
    expect(facts.takenAt).toBe("2026-11-15T09:12:30.000Z")
  })

  it("reads the same from a little-endian phone", () => {
    const facts = readPhotoFacts(jpeg({ little: true, lat: [13, 44, 0], lng: [100, 30, 0] }))
    expect(facts.geo).toEqual({ lat: 13.733333, lng: 100.5 })
    expect(facts.takenAt).toBeNull()
  })

  it("signs the southern and western hemispheres", () => {
    const facts = readPhotoFacts(
      jpeg({ lat: [33, 52, 0], latRef: "S", lng: [70, 0, 0], lngRef: "W" }),
    )
    expect(facts.geo?.lat).toBeLessThan(0)
    expect(facts.geo?.lng).toBeLessThan(0)
  })

  it("keeps the wall-clock day late at night", () => {
    const facts = readPhotoFacts(jpeg({ taken: "2026:11:15 23:40:00" }))
    expect(facts.takenAt).toBe("2026-11-15T23:40:00.000Z")
  })

  it("reads GPS zeroes as no coordinate", () => {
    expect(readPhotoFacts(jpeg({ lat: [0, 0, 0], lng: [0, 0, 0] })).geo).toBeNull()
  })

  it("answers nothing for a file that is not a JPEG, or is cut short", () => {
    expect(readPhotoFacts(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toEqual({
      geo: null,
      takenAt: null,
    })
    const cut = jpeg({ lat: [13, 44, 0], lng: [100, 30, 0] }).slice(0, 40)
    expect(readPhotoFacts(cut)).toEqual({ geo: null, takenAt: null })
  })
})
