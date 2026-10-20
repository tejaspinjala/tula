/**
 * Reads the bytes queued on a Bun server socket from the untyped `raw` handle Hono exposes.
 * @returns the byte count, or null when the runtime does not provide `getBufferedAmount`, so
 * callers can fail closed rather than treat a missing API as an empty buffer.
 */
export function readBufferedAmount(raw: unknown): number | null {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'getBufferedAmount' in raw &&
    typeof raw.getBufferedAmount === 'function'
  ) {
    const amount: unknown = raw.getBufferedAmount()
    return typeof amount === 'number' ? amount : null
  }
  return null
}

/**
 * Proves, against a real Bun server and client socket, that the runtime exposes
 * `getBufferedAmount`. Slow-consumer protection depends on it, so boot calls this and refuses to
 * start when it rejects.
 */
export async function assertBackpressureSupported(timeoutMs = 5000): Promise<void> {
  let supported: boolean | undefined
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) =>
      srv.upgrade(req) ? undefined : new Response('upgrade required', { status: 426 }),
    websocket: {
      open: (ws) => {
        supported = readBufferedAmount(ws) !== null
        ws.close()
      },
      message: () => {},
    },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('backpressure probe timed out')), timeoutMs)
      const client = new WebSocket(`ws://localhost:${server.port}`)
      client.onclose = () => {
        clearTimeout(timer)
        resolve()
      }
      client.onerror = () => {
        clearTimeout(timer)
        reject(new Error('backpressure probe socket error'))
      }
    })
  } finally {
    await server.stop(true)
  }
  if (!supported) {
    throw new Error(
      'Bun websocket getBufferedAmount is unavailable; refusing to serve the event stream'
    )
  }
}
