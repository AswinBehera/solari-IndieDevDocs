import type { Postcard } from "@dt/core"
import * as maplibregl from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
// MapLibre 6 runs its tile work in a module worker it loads by URL, and Vite's
// dependency pre-bundling moves the file that URL points at. `?worker&url` has
// Vite bundle the worker itself and hand back where it put it — in dev and in the
// production build alike.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { useEffect, useRef } from "react"
import { boundsOf, clusterPoints } from "./cluster"
import { cardTitle } from "./labels"
import { frameFor } from "./places"

/**
 * The map view (P4.4): every geo Postcard the document holds, clustered, and a
 * click that scrolls the document to the card.
 *
 * **No basemap yet, on purpose.** ADR-0018 puts the basemap in a Protomaps
 * `.pmtiles` extract we host, with its fonts and sprites beside it, and none of
 * those files exist yet. Until they do the map is the canvas's own drawing — the
 * midnight plane with a grid and pink pins — which is honest about being a frame
 * of reference rather than a street map. MapLibre is already doing the projection,
 * panning and fitting, so the basemap is a style change when it lands, not a
 * rewrite.
 *
 * Pins are HTML markers rather than a symbol layer for the same reason: MapLibre
 * draws text only from a glyph server, which is one of the files not hosted yet.
 */

maplibregl.setWorkerUrl(workerUrl)

/** Only the background: the canvas's midnight blue. The grid is CSS over it. */
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#16204a" } }],
}

interface Pin {
  id: string
  label: string
  lat: number
  lng: number
}

export function MapView({
  cards,
  city,
  onFocus,
}: {
  /** The cards the document references, in document order. */
  cards: readonly Postcard[]
  city: string
  onFocus: (id: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const pins = useRef<Pin[]>([])
  const focus = useRef(onFocus)
  focus.current = onFocus

  pins.current = cards
    .filter((c) => c.geo)
    .map((c) => ({ id: c.id, label: cardTitle(c), lat: c.geo?.lat ?? 0, lng: c.geo?.lng ?? 0 }))

  // One map for the component's life; `city` sets only its first frame, and the
  // pins fit it after, so a change of city on an open map is not a reason to
  // tear it down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!container.current) return
    const [w, s, e, n] = frameFor(city)
    const m = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      bounds: [
        [w, s],
        [e, n],
      ],
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    })
    // Coordinates resolved against OSM carry ODbL's attribution duty (ADR-0017),
    // basemap or not; it lives in the map control and is not removable.
    m.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: "© OpenStreetMap contributors",
      }),
    )
    const redraw = () => drawMarkers(m, pins.current, markers.current, focus)
    m.on("moveend", redraw)
    m.on("load", () => {
      fitMap(m, pins.current)
      redraw()
    })
    map.current = m
    // The rail's height is settled by layout after the map is built, and MapLibre
    // measures its container once. Without this the canvas keeps its first guess.
    const resize = new ResizeObserver(() => {
      m.resize()
      if (m.loaded()) {
        fitMap(m, pins.current)
        redraw()
      }
    })
    resize.observe(container.current)
    const placed = markers.current
    return () => {
      resize.disconnect()
      for (const marker of placed) marker.remove()
      placed.length = 0
      m.remove()
      map.current = null
    }
  }, [])

  const ids = pins.current.map((p) => `${p.id}@${p.lat},${p.lng}`).join("|")
  // Redraw when the pins themselves change; the refs carry what they are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const m = map.current
    if (!m?.loaded()) return
    fitMap(m, pins.current)
    drawMarkers(m, pins.current, markers.current, focus)
  }, [ids])

  return (
    <div className="relative flex-1 overflow-hidden bg-accent-blue">
      {/* MapLibre puts `position: relative` on the element it is given, which
          would undo `absolute inset-0` there and leave it zero pixels tall. The
          wrapper holds the position; the map fills the wrapper. */}
      <div className="absolute inset-0">
        <div ref={container} className="size-full" />
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.06)_1px,transparent_1px)] bg-size-[28px_28px]" />
      <div className="pointer-events-none absolute top-3 left-3 font-mono text-[9px] text-white/55 tracking-[.1em]">
        {city.toUpperCase()} · {pins.current.length} POSTCARD{pins.current.length === 1 ? "" : "S"}{" "}
        WITH GEO
      </div>
      {pins.current.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-white/60">
          A Postcard with a place or a photo’s coordinates appears here.
        </div>
      )}
    </div>
  )
}

function fitMap(m: maplibregl.Map, pins: readonly Pin[]) {
  const b = boundsOf(pins)
  if (b) m.fitBounds(b, { padding: 48, maxZoom: 15, animate: false })
}

/** Replace every marker with one per cluster at the map's current zoom. */
function drawMarkers(
  m: maplibregl.Map,
  pins: readonly Pin[],
  markers: maplibregl.Marker[],
  focus: { current: (id: string) => void },
) {
  for (const marker of markers) marker.remove()
  markers.length = 0
  const byId = new Map(pins.map((p) => [p.id, p]))
  const projected = pins.map((p) => {
    const at = m.project([p.lng, p.lat])
    return { id: p.id, x: at.x, y: at.y }
  })
  for (const cluster of clusterPoints(projected)) {
    const first = byId.get(cluster.ids[0] as string)
    if (!first) continue
    const many = cluster.ids.length > 1
    const el = document.createElement("button")
    el.type = "button"
    el.className = "map-pin"
    const dot = document.createElement("span")
    dot.className = many ? "map-pin-dot map-pin-many" : "map-pin-dot"
    if (many) dot.textContent = String(cluster.ids.length)
    const label = document.createElement("span")
    label.className = "map-pin-label"
    label.textContent = many ? `${first.label} +${cluster.ids.length - 1}` : first.label
    el.append(dot, label)
    el.addEventListener("click", () => {
      if (!many) {
        focus.current(first.id)
        return
      }
      // A cluster opens up rather than choosing one of its members for you.
      const b = boundsOf(cluster.ids.map((id) => byId.get(id)).filter((p): p is Pin => !!p))
      if (b) m.fitBounds(b, { padding: 64, maxZoom: 18 })
    })
    markers.push(
      new maplibregl.Marker({ element: el, anchor: "left" })
        .setLngLat([first.lng, first.lat])
        .addTo(m),
    )
  }
}
