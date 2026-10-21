import { expect, test } from 'bun:test'
import { watchSize } from './watch'

/** A stand-in observer that lets the test fire a size change by hand. */
function fakeObserver() {
  const seen: { fire: () => void; observed: unknown[]; disconnected: boolean }[] = []
  class Fake {
    state = { fire: () => {}, observed: [] as unknown[], disconnected: false }
    constructor(callback: () => void) {
      this.state.fire = callback
      seen.push(this.state)
    }
    observe(target: unknown) {
      this.state.observed.push(target)
    }
    disconnect() {
      this.state.disconnected = true
    }
  }
  return { Fake, seen }
}

test('a change of the frame size (the HUD inset moved it) triggers a refit, until stopped', () => {
  const { Fake, seen } = fakeObserver()
  const frame = {}
  let refits = 0
  const stop = watchSize(frame, () => refits++, Fake)
  expect(seen[0]?.observed).toEqual([frame])
  seen[0]?.fire()
  seen[0]?.fire()
  expect(refits).toBe(2)
  stop()
  expect(seen[0]?.disconnected).toBe(true)
})

test('without a ResizeObserver there is nothing to watch and stopping is harmless', () => {
  let refits = 0
  const stop = watchSize({}, () => refits++, undefined)
  stop()
  expect(refits).toBe(0)
})
