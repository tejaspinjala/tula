import { expect, test } from 'bun:test'
import { SaveQueue } from './saveQueue'

test('saves of one Rite run one at a time and a queued save is superseded by a newer one', async () => {
  const started: string[] = []
  let inFlight = 0
  let peak = 0
  const release: (() => void)[] = []
  const queue = new SaveQueue<string, string>(async (input) => {
    started.push(input)
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise<void>((resolve) => release.push(resolve))
    inFlight--
    return `saved ${input}`
  })
  const first = queue.enqueue('a')
  const second = queue.enqueue('b')
  const third = queue.enqueue('c')
  expect(started).toEqual(['a'])
  release.shift()?.()
  expect(await first).toBe('saved a')
  await Promise.resolve()
  await Promise.resolve()
  expect(started).toEqual(['a', 'c'])
  release.shift()?.()
  expect(await third).toBe('saved c')
  expect(await second).toBe('saved c')
  expect(peak).toBe(1)
})

test('a failed save rejects its callers and the queue accepts the next save', async () => {
  let calls = 0
  const queue = new SaveQueue<string, string>(async (input) => {
    calls++
    if (calls === 1) {
      throw new Error('boom')
    }
    return input
  })
  await expect(queue.enqueue('a')).rejects.toThrow('boom')
  expect(await queue.enqueue('b')).toBe('b')
})
