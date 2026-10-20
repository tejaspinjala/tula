/** A rectangle in flow coordinates. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** How the graph is fitted into the viewport. */
export interface FitOptions {
  padding: number
  minZoom: number
  maxZoom: number
  /** The least space kept left of the graph, in screen pixels. */
  margin: number
}

/** The viewport to apply, and whether part of the graph still lies past the right edge. */
export interface FitPlan {
  x: number
  y: number
  zoom: number
  overflowRight: boolean
}

/**
 * Fits the graph bounds into the viewport: the zoom that shows everything with padding, clamped
 * to the readable range. If the clamp leaves the graph wider than the viewport, the left edge is
 * anchored inside the margin (the graph begins at its first step) and `overflowRight` asks for a
 * cue that the board can be panned sideways.
 */
export function fitPlan(
  bounds: Bounds,
  viewport: { width: number; height: number },
  options: FitOptions
): FitPlan {
  const spread = 1 + options.padding * 2
  const wanted = Math.min(
    viewport.width / Math.max(bounds.width * spread, 1),
    viewport.height / Math.max(bounds.height * spread, 1)
  )
  const zoom = Math.min(Math.max(wanted, options.minZoom), options.maxZoom)
  const centredX = viewport.width / 2 - (bounds.x + bounds.width / 2) * zoom
  const y = viewport.height / 2 - (bounds.y + bounds.height / 2) * zoom
  const left = bounds.x * zoom + centredX
  const x = left < options.margin ? options.margin - bounds.x * zoom : centredX
  const right = (bounds.x + bounds.width) * zoom + x
  return { x, y, zoom, overflowRight: right > viewport.width - options.margin }
}
