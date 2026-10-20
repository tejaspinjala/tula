import { expect, test } from 'bun:test'
import { createBackoff, reconnectDelayMs, streamHandlers, streamNotice } from './stream-retry'

test('the reconnect delay doubles from half a second, jittered between half and all of the ceiling, capped at 30s', () => {
  expect(reconnectDelayMs(0, 0)).toBe(250)
  expect(reconnectDelayMs(0, 1)).toBe(500)
  expect(reconnectDelayMs(2, 0)).toBe(1000)
  expect(reconnectDelayMs(2, 1)).toBe(2000)
  expect(reconnectDelayMs(20, 1)).toBe(30_000)
  expect(reconnectDelayMs(20, 0)).toBe(15_000)
})

test('the Hall says so in-world only after several failed attempts in a row', () => {
  expect(streamNotice(0)).toBeNull()
  expect(streamNotice(2)).toBeNull()
  expect(streamNotice(3)).toContain('messenger')
  expect(streamNotice(9)).toContain('messenger')
})

/** A WebSocket stand-in: the page wires `onclose`/`onmessage`; the test plays the network. */
class FakeSocket {
  onmessage: ((data: string) => void) | null = null
  onclose: (() => void) | null = null
}

test('a stream that opens then closes without a message keeps backing off and reaches the notice', () => {
  const backoff = createBackoff()
  const waits: number[] = []
  const failures: number[] = []
  for (let round = 0; round < 5; round += 1) {
    const socket = new FakeSocket()
    const handlers = streamHandlers(backoff, {
      onMessage: () => undefined,
      onRetry: (wait, count) => {
        waits.push(wait)
        failures.push(count)
      },
      random: () => 0,
    })
    socket.onmessage = handlers.message
    socket.onclose = handlers.close
    // The socket upgrades (open) and is then dropped, e.g. the ticket was rejected after upgrade.
    socket.onclose?.()
  }
  expect(waits).toEqual([0, 1, 2, 3, 4].map((n) => reconnectDelayMs(n, 0)))
  expect(failures).toEqual([1, 2, 3, 4, 5])
  expect(streamNotice(failures[2] ?? 0)).not.toBeNull()
})

test('the first message resets the backoff and the failure count', () => {
  const backoff = createBackoff()
  const seen: number[] = []
  const handlers = streamHandlers(backoff, {
    onMessage: () => undefined,
    onRetry: (_wait, count) => seen.push(count),
    onHealthy: () => seen.push(0),
    random: () => 0,
  })
  handlers.close()
  handlers.close()
  handlers.message('{}')
  handlers.close()
  expect(seen).toEqual([1, 2, 0, 1])
})
