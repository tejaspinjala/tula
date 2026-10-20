import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { runWorker, WorkerError, type WorkerFetch } from './worker'

const LEASE = { questId: crypto.randomUUID(), attempt: 1, token: 'signed-lease' }
const toolCall = z.object({ params: z.object({ name: z.string() }) })

/** A fake gateway: records each call as `path` or `tools/call:<name>` and answers like the real ones. */
function fakeGateway(refuse: string | null = null) {
  const calls: string[] = []
  const bodies: string[] = []
  const fetch: WorkerFetch = async (url, init) => {
    const path = new URL(url).pathname
    const raw = String(init.body)
    bodies.push(raw)
    if (path === '/gateway/complete') {
      calls.push(path)
      return Response.json({ text: 'ready' })
    }
    const name = toolCall.parse(JSON.parse(raw)).params.name
    calls.push(`tools/call:${name}`)
    if (name === refuse) {
      return Response.json({ result: { isError: true, structuredContent: { error: 'x' } } })
    }
    const data =
      name === 'read_brief'
        ? { brief: 'Quest: Q\nDone when: it is done\n' }
        : name === 'put_artifact'
          ? { hash: 'a'.repeat(64) }
          : { state: 'done' }
    return Response.json({ result: { structuredContent: data } })
  }
  return { calls, bodies, fetch }
}

const input = (fetch: WorkerFetch) => ({
  gatewayUrl: 'http://gateway.test',
  runToken: 'run',
  leaseHandle: JSON.stringify(LEASE),
  doneCondition: 'it is done',
  fetch,
})

describe('worker', () => {
  test('reads the Brief with its lease before anything else, then works the Quest', async () => {
    const g = fakeGateway()
    await runWorker(input(g.fetch))
    expect(g.calls).toEqual([
      'tools/call:read_brief',
      '/gateway/complete',
      'tools/call:put_artifact',
      'tools/call:complete_quest',
    ])
    expect(g.bodies[0]).toContain(LEASE.token)
  })

  test('a refused read_brief stops the worker before any model call', async () => {
    const g = fakeGateway('read_brief')
    await expect(runWorker(input(g.fetch))).rejects.toEqual(new WorkerError('read_brief'))
    expect(g.calls).toEqual(['tools/call:read_brief'])
  })
})
