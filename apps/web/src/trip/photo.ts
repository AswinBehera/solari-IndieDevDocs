import type { NewPostcardInput } from "../trips/api"
import { readPhotoFacts } from "./exif"

/**
 * A dropped photo, turned into a Postcard (P4.6).
 *
 * The plan uploads the photo to storage; there is no bucket yet, so the card
 * carries its own thumbnail — a downscaled JPEG, small enough to sit inside the
 * Postcard's 256 KB body cap. When storage exists this becomes an upload and the
 * payload holds a key instead; nothing else about the card changes.
 */

/** Longest edge of the kept thumbnail. Enough for a card 300px wide on a 2x screen. */
const MAX_EDGE = 900
/** Characters of data URL, kept well under the API's 256 KB Postcard body cap. */
const MAX_CHARS = 200_000

export async function photoPostcard(file: File): Promise<NewPostcardInput> {
  const facts = readPhotoFacts(await file.arrayBuffer())
  const image = await thumbnail(file)
  return {
    kind: "photo",
    payload: { image, caption: "" },
    geo: facts.geo,
    time: facts.takenAt ? { start: facts.takenAt, end: null } : null,
  }
}

async function thumbnail(file: File): Promise<string | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // A format the browser cannot decode (HEIC on most of them). The card still
    // keeps its coordinate and time; it says it has no image.
    return null
  }
  let edge = MAX_EDGE
  for (let attempt = 0; attempt < 5; attempt++) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const url = canvas.toDataURL("image/jpeg", 0.78)
    if (url.length <= MAX_CHARS) return url
    edge = Math.round(edge * 0.75)
  }
  return null
}
