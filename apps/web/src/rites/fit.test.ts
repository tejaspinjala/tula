import { expect, test } from 'bun:test'
import { fitPlan } from './fit'

const options = { padding: 0.25, minZoom: 0.6, maxZoom: 1, margin: 16 }

test('a graph that fits is centred at the zoom that fits it, no cue', () => {
  const plan = fitPlan(
    { x: 0, y: 0, width: 400, height: 100 },
    { width: 1000, height: 400 },
    options
  )
  expect(plan.zoom).toBe(1)
  expect(plan.x).toBe(300)
  expect(plan.y).toBe(150)
  expect(plan.overflowRight).toBe(false)
})

test('a wide graph clamps to the minimum zoom, anchors its left edge and cues the overflow', () => {
  const plan = fitPlan(
    { x: 0, y: 0, width: 2000, height: 100 },
    { width: 900, height: 400 },
    options
  )
  expect(plan.zoom).toBe(0.6)
  expect(plan.x).toBe(16)
  expect(plan.overflowRight).toBe(true)
})

test('a graph that starts left of the origin keeps its left edge inside the margin', () => {
  const plan = fitPlan(
    { x: -50, y: 0, width: 2000, height: 100 },
    { width: 900, height: 400 },
    options
  )
  expect(plan.x + -50 * plan.zoom).toBe(16)
})
