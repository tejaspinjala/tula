import { expect, test } from 'bun:test'
import { ASIDE_PX, stepAside } from './aside'

test('a Member on the Guild Master’s tile steps aside by whole pixels', () => {
  const to = stepAside({ x: 100, y: 50 }, { x: 100, y: 50 })
  expect(to.x - 100).toBe(ASIDE_PX)
  expect(to.y).toBe(50)
})

test('a Member standing a little left of the Guild Master steps further left', () => {
  const to = stepAside({ x: 96, y: 50 }, { x: 100, y: 50 })
  expect(to.x).toBe(100 - ASIDE_PX)
})

test('a Member already clear of the Guild Master stays where they are', () => {
  expect(stepAside({ x: 140, y: 50 }, { x: 100, y: 50 })).toEqual({ x: 140, y: 50 })
  expect(stepAside({ x: 100, y: 90 }, { x: 100, y: 50 })).toEqual({ x: 100, y: 90 })
})
