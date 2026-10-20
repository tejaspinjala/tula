import { useNodesInitialized, useReactFlow, useStore } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { fitPlan } from '../workflows/fit'

/** The readable range and edge of a fitted board. */
export interface BoardFit {
  padding: number
  minZoom: number
}

const MARGIN = 16

/**
 * Fits the whole graph into the board once its nodes are measured (and again when the board is
 * resized or the number of nodes changes): the zoom that shows everything, clamped to a readable range, with
 * the first node anchored inside the left margin. Returns whether the clamp left part of the graph
 * past the right edge, so the board can show a cue that it pans sideways.
 */
export function useBoardFit(fit: BoardFit, count: number): boolean {
  const { setViewport, getNodesBounds, getNodes } = useReactFlow()
  const initialized = useNodesInitialized()
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  const [overflowRight, setOverflowRight] = useState(false)

  useEffect(() => {
    if (!initialized || width === 0 || height === 0) {
      return
    }
    if (count === 0) {
      return
    }
    const nodes = getNodes()
    const plan = fitPlan(
      getNodesBounds(nodes),
      { width, height },
      { ...fit, maxZoom: 1, margin: MARGIN }
    )
    setOverflowRight(plan.overflowRight)
    setViewport({ x: plan.x, y: plan.y, zoom: plan.zoom })
  }, [initialized, width, height, count, fit, setViewport, getNodesBounds, getNodes])

  return overflowRight
}
