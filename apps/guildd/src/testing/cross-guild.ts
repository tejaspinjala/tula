import { expect } from 'bun:test'
import { z } from 'zod'

const IdBody = z.object({ id: z.string() })

type Requester = { request: (path: string, init?: RequestInit) => Promise<Response> }

/** One route under cross-guild test. */
export interface CrossGuildProbe {
  /** Builds the route's request made by guild `caller` aimed at the data of guild `target`. */
  build: (
    caller: string,
    target: string
  ) => [path: string, init?: RequestInit] | Promise<[path: string, init?: RequestInit]>
  /** Reads guild `guildId`'s own view of the data the probe could touch, for before/after equality. */
  snapshot: (guildId: string) => Promise<unknown>
}

async function found(harness: Requester, name: string): Promise<string> {
  const res = await harness.request('/guilds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, goal: `${name} goal` }),
  })
  return IdBody.parse(await res.json()).id
}

/**
 * Reusable cross-guild check for a route: founds guilds A and B, then asserts that A, aiming at B,
 * gets exactly what it gets aiming at a guild that does not exist (no existence leak), never sees
 * B's data, and leaves B's own view unchanged.
 */
export async function expectGuildIsolation(harness: Requester, probe: CrossGuildProbe) {
  const a = await found(harness, 'Guild A')
  const b = await found(harness, 'Guild B-secret')
  const ghost = crypto.randomUUID()
  const before = await probe.snapshot(b)

  const [pathB, initB] = await probe.build(a, b)
  const [pathGhost, initGhost] = await probe.build(a, ghost)
  const atB = await harness.request(pathB, initB)
  const atGhost = await harness.request(pathGhost, initGhost)
  const bodyAtB = await atB.text()

  expect(atB.status).not.toBe(200)
  expect(bodyAtB).not.toContain('B-secret')
  expect({ status: atB.status, body: bodyAtB.replaceAll(b, '<id>') }).toEqual({
    status: atGhost.status,
    body: (await atGhost.text()).replaceAll(ghost, '<id>'),
  })
  expect(await probe.snapshot(b)).toEqual(before)
}
