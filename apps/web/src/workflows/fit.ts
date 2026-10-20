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

/** Not yet implemented. */
export function fitPlan(
  _bounds: Bounds,
  _viewport: { width: number; height: number },
  _options: FitOptions
): FitPlan {
  return { x: 0, y: 0, zoom: 1, overflowRight: false }
}
