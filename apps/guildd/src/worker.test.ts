import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { buildPrompt, runWorker, WorkerError, type WorkerFetch } from './worker'

const LEASE = { questId: crypto.randomUUID(), attempt: 1, token: 'signed-lease' }
const toolCall = z.object({ params: z.object({ name: z.string() }) })

/** A fake gateway: records each call as `path` or `tools/call:<name>` and answers like the real ones. */
function fakeGateway(refuse: string | null = null, requiresSeal = false) {
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
        ? { brief: 'Quest: Q\nDone when: it is done\n', requiresSeal }
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

  test('a Seal Quest files its draft with submit_proposal after the artifact and before completing', async () => {
    const g = fakeGateway(null, true)
    await runWorker(input(g.fetch))
    expect(g.calls).toEqual([
      'tools/call:read_brief',
      '/gateway/complete',
      'tools/call:put_artifact',
      'tools/call:submit_proposal',
      'tools/call:complete_quest',
    ])
    const filed = toolCall
      .extend({
        params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
      })
      .parse(JSON.parse(g.bodies[3] ?? ''))
    expect(filed.params.arguments).toMatchObject({ lease: LEASE, text: 'ready', evidenceLinks: [] })
  })

  test('a refused submit_proposal stops the worker before the Quest is completed', async () => {
    const g = fakeGateway('submit_proposal', true)
    await expect(runWorker(input(g.fetch))).rejects.toEqual(new WorkerError('submit_proposal'))
    expect(g.calls).not.toContain('tools/call:complete_quest')
  })

  test('a Quest without a Seal files no Proposal', async () => {
    const g = fakeGateway()
    await runWorker(input(g.fetch))
    expect(g.calls).not.toContain('tools/call:submit_proposal')
  })
})

describe('the prompt a Member sends', () => {
  const brief = 'Quest: Announce 1.0\nDone when: An announcement draft is ready for a Seal\n'

  test('carries the Brief and the done-condition, and asks for the deliverable itself', () => {
    const prompt = buildPrompt(brief, 'An announcement draft is ready for a Seal')
    expect(prompt).toContain(brief)
    expect(prompt).toContain('An announcement draft is ready for a Seal')
    expect(prompt.toLowerCase()).toContain('deliverable itself')
  })

  test('the model call sends that prompt, with room for a real draft', async () => {
    const gateway = fakeGateway()
    await runWorker(input(gateway.fetch))
    const complete = z
      .object({
        messages: z.array(z.object({ content: z.string() })),
        maxTokens: z.number(),
      })
      .parse(JSON.parse(gateway.bodies[gateway.calls.indexOf('/gateway/complete')] ?? '{}'))
    expect(complete.messages[0]?.content).toContain('Quest: Q')
    expect(complete.messages[0]?.content).toContain('it is done')
    expect(complete.messages[0]?.content).not.toContain('Reply with one short sentence')
    expect(complete.maxTokens).toBeGreaterThanOrEqual(512)
  })
})
