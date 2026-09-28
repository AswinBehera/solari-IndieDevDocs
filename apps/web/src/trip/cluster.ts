/**
 * Pins that would overlap on screen, drawn as one (P4.4: "clustered").
 *
 * In screen space rather than on the globe, because overlap is a fact about
 * pixels: two stalls on one soi are one dot at city zoom and two at street zoom.
 * The map calls this again whenever it moves, with every pin projected to where
 * it now sits.
 *
 * Greedy and in input order — each pin joins the first cluster whose centre is
 * within the radius, or starts its own. At a trip's scale (tens of pins) that is
 * exact enough and needs no index; a library for it would be a dependency to
 * cluster twenty dots.
 */

export interface ScreenPoint {
  id: string
  x: number
  y: number
}

export interface Cluster {
  /** The members' ids, in input order. */
  ids: string[]
  /** Where to draw it: the first member's position, so a lone pin sits exactly on its place. */
  x: number
  y: number
}

export function clusterPoints(points: readonly ScreenPoint[], radiusPx = 28): Cluster[] {
  const clusters: Cluster[] = []
  const r2 = radiusPx * radiusPx
  for (const p of points) {
    const home = clusters.find((c) => (c.x - p.x) ** 2 + (c.y - p.y) ** 2 <= r2)
    if (home) home.ids.push(p.id)
    else clusters.push({ ids: [p.id], x: p.x, y: p.y })
  }
  return clusters
}

/** The smallest box around the pins, padded, for fitting the map to them. */
export function boundsOf(
  points: readonly { lat: number; lng: number }[],
): [[number, number], [number, number]] | null {
  if (points.length === 0) return null
  let west = Number.POSITIVE_INFINITY
  let south = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY
  for (const p of points) {
    west = Math.min(west, p.lng)
    east = Math.max(east, p.lng)
    south = Math.min(south, p.lat)
    north = Math.max(north, p.lat)
  }
  // A single pin, or pins on one spot, still needs a box with some size to it.
  const pad = Math.max(0.01, (east - west) * 0.15, (north - south) * 0.15)
  return [
    [west - pad, south - pad],
    [east + pad, north + pad],
  ]
}
