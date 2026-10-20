import { expect, test } from 'bun:test'
import { steppedCorners } from './steppedCorners'

test('one step cuts each corner by one step length', () => {
  expect(steppedCorners('1rem', 1)).toBe(
    'polygon(0 calc(1rem * 1), calc(1rem * 1) calc(1rem * 1), calc(1rem * 1) 0, ' +
      'calc(100% - calc(1rem * 1)) 0, calc(100% - calc(1rem * 1)) calc(1rem * 1), 100% calc(1rem * 1), ' +
      '100% calc(100% - calc(1rem * 1)), calc(100% - calc(1rem * 1)) calc(100% - calc(1rem * 1)), ' +
      'calc(100% - calc(1rem * 1)) 100%, calc(1rem * 1) 100%, calc(1rem * 1) calc(100% - calc(1rem * 1)), ' +
      '0 calc(100% - calc(1rem * 1)))'
  )
})

test('two steps make a two-stair corner', () => {
  const css = steppedCorners('1rem', 2)
  const topLeft = css.slice(0, css.indexOf('calc(100%'))
  expect(topLeft).toBe(
    'polygon(0 calc(1rem * 2), calc(1rem * 1) calc(1rem * 2), calc(1rem * 1) calc(1rem * 1), ' +
      'calc(1rem * 2) calc(1rem * 1), calc(1rem * 2) 0, '
  )
})

test('zero steps is a plain rectangle', () => {
  expect(steppedCorners('1rem', 0)).toBe('polygon(0 0, 100% 0, 100% 100%, 0 100%)')
})
