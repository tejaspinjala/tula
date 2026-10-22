import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { z } from 'zod'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const base = `/api/guilds/${guild}/rites`

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { RitePanel } = await import('./RitePanel')
const { holdReconnectTimers } = await import('../stream-test-kit')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const graph = { nodes: [{ id: 'start', type: 'trigger.manual' }], edges: [] }
const stored = {
  version: 1,
  name: 'W',
  graph,
  status: 'active',
  classification: 'internal',
  createdAt: 'now',
}
const config = {
  steward: { id: 'steward', name: 'Steward' },
  halls: [
    {
      id: 'heralds',
      name: 'Heralds Hall',
      kind: 'work',
      locked: false,
      privateEligible: false,
      captain: null,
      members: [],
    },
  ],
}

interface Options {
  errors?: { code: string; nodeId?: string; message: string }[]
  save?: { status: number; body: unknown }
  /** The publish reply; defaults to an internal version going live. */
  publish?: { status: number; body: unknown }
  /** The versions list the history shows, newest first; defaults to the newest version alone. */
  history?: Record<string, unknown>[]
}

function world(options: Options = {}) {
  const puts: { name: string; graph: { nodes: { id: string; type: string }[] } }[] = []
  const publishes: unknown[] = []
  const urls: string[] = []
  // The newest version and the active one, as the server would report them after each write.
  let latest: Record<string, unknown> = stored
  let activeVersion = 1
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    urls.push(`${method} ${url}`)
    if (url === `${base}?limit=50`) {
      return Response.json({
        rites: [{ id: 'w', name: 'W', latestVersion: 1, activeVersion }],
        next: null,
      })
    }
    if (url === `${base}/w`) {
      return Response.json({ version: latest, activeVersion })
    }
    if (url === `${base}/w/versions?limit=20`) {
      return Response.json({ versions: options.history ?? [latest], next: null })
    }
    if (url === `${base}/w/validate`) {
      const errors = options.errors ?? []
      return Response.json({ valid: errors.length === 0, errors })
    }
    if (url === `${base}/w/runs?limit=20`) {
      return Response.json({
        instances: [
          { id: 'r0', version: 1, createdAt: '2026-10-19T00:00:00Z' },
          { id: 'r1', version: 1, createdAt: '2026-10-20T00:00:00Z' },
        ],
        next: null,
      })
    }
    if (url === `${base}/w/runs` && method === 'POST') {
      return Response.json({ instance: { id: 'r1' }, quests: [] }, { status: 201 })
    }
    if (url === `${base}/w/runs/r1`) {
      return Response.json({
        instance: { id: 'r1', version: 1, createdAt: 'now' },
        nodes: [{ id: 'start', type: 'agent', status: 'running', questId: 'q1' }],
      })
    }
    if (url.startsWith(`/api/guilds/${guild}/config`)) {
      return Response.json({ version: 1, config })
    }
    if (url.startsWith(`/api/guilds/${guild}/quests`)) {
      return Response.json({
        quests: [
          {
            id: 'q1',
            title: 'Q',
            hallId: 'heralds',
            ownerId: 'm',
            state: 'active',
            doneCondition: 'd',
            round: 1,
            roundLimit: 2,
            attempts: 2,
            lastError: null,
          },
        ],
        next: null,
      })
    }
    if (url.startsWith(`/api/guilds/${guild}/gateway/usage`)) {
      return Response.json({
        rows: [{ key: 'q1', calls: 1, inputTokens: 1, outputTokens: 1, costMicros: 12_500 }],
        next: null,
      })
    }
    return Response.json({}, { status: 404 })
  }
  const wrapped = async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && url === `${base}/w`) {
      urls.push(`PUT ${url}`)
      puts.push(JSON.parse(String(init.body)))
      const body = JSON.parse(String(init.body))
      const reply = options.save ?? {
        status: 200,
        body: { status: 'draft', version: { version: 2, classification: 'internal' } },
      }
      latest = { ...stored, version: 2, graph: body.graph, status: 'draft' }
      return Response.json(reply.body, { status: reply.status })
    }
    if (init?.method === 'POST' && url === `${base}/w/versions/2/publish`) {
      urls.push(`POST ${url}`)
      publishes.push(JSON.parse(String(init.body)))
      const reply = options.publish ?? {
        status: 200,
        body: { status: 'active', version: { version: 2, classification: 'internal' } },
      }
      const body = z
        .object({ status: z.string(), version: z.object({ classification: z.string() }) })
        .safeParse(reply.body)
      if (reply.status < 300 && body.success) {
        latest = {
          ...latest,
          status: body.data.status,
          classification: body.data.version.classification,
        }
        activeVersion = body.data.status === 'active' ? 2 : activeVersion
      }
      return Response.json(reply.body, { status: reply.status })
    }
    return fetcher(url, init)
  }
  const browser = { create: async () => ({}), get: async () => ({ signed: 'abc' }) }
  return { puts, publishes, urls, fetcher: wrapped, browser }
}

const doc = globalThis.document

async function mount(w: ReturnType<typeof world>, desktop: boolean, live = false) {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <RitePanel
        session={session}
        fetcher={w.fetcher}
        browser={w.browser}
        desktop={desktop}
        validateDelayMs={0}
        live={live}
      />
    )
  })
  await settle()
  return host
}
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
}
async function click(host: HTMLElement, name: string) {
  const found = [...host.querySelectorAll<HTMLElement>('button, [role="option"]')].find(
    (b) =>
      (b.getAttribute('role') === 'option'
        ? b.getAttribute('aria-label')
        : b.textContent?.trim()) === name
  )
  if (!found) {
    throw new Error(`no button "${name}"`)
  }
  await act(async () => {
    found.click()
  })
  await settle()
}

test('adding a node from the palette and saving a draft PUTs the edited graph', async () => {
  const w = world()
  const host = await mount(w, true)
  await click(host, 'Add agent')
  await click(host, 'Save draft')
  expect(w.puts[0]?.name).toBe('W')
  expect(w.puts[0]?.graph.nodes.map((n) => n.id)).toEqual(['start', 'agent'])
})

test('the palette lists every node type of the shared schema', async () => {
  const host = await mount(world(), true)
  const labels = [...host.querySelectorAll('.palette [role="option"]')].map((b) =>
    b.getAttribute('aria-label')
  )
  expect(labels).toEqual([
    'Add trigger.manual',
    'Add trigger.schedule',
    'Add agent',
    'Add subagents',
    'Add team',
    'Add verify',
    'Add approval',
    'Add post',
  ])
})

test('a server validation error is badged on the node it names, and graph-level ones in a list', async () => {
  const w = world({
    errors: [
      { code: 'agent_after_gate', nodeId: 'start', message: 'agent start runs after a gate' },
      { code: 'no_trigger', message: 'a rite needs at least one trigger' },
    ],
  })
  const host = await mount(w, true)
  expect(host.querySelector('[data-node-id="start"]')?.textContent).toContain(
    'agent start runs after a gate'
  )
  expect(host.textContent).toContain('a rite needs at least one trigger')
})

const chip = (host: HTMLElement) => host.querySelector('[data-testid="rite-chip"]')?.textContent

test('Save draft then Publish: the chip reads Draft, then Live, and the publish carries the active version', async () => {
  const w = world()
  const host = await mount(w, true)
  expect(chip(host)).toBe('Live')
  expect(
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Publish')?.disabled
  ).toBe(true)
  await click(host, 'Add agent')
  await click(host, 'Save draft')
  expect(chip(host)).toBe('Draft')
  expect(host.textContent).toContain('Saved as draft version 2')
  await click(host, 'Publish')
  expect(w.publishes).toEqual([{ basedOn: 1 }])
  expect(chip(host)).toBe('Live')
  expect(host.textContent).toContain('Version 2 is published and in force')
})

test('publishing a widening draft asks for the passkey; the old version stays in force until confirmed', async () => {
  const w = world({
    publish: {
      status: 202,
      body: { status: 'pending', version: { version: 2, classification: 'widening' } },
    },
  })
  const host = await mount(w, true)
  await click(host, 'Add agent')
  await click(host, 'Save draft')
  await click(host, 'Publish')
  expect(host.textContent).toContain('widening')
  expect(chip(host)).toBe('Pending')
  await click(host, 'Confirm with passkey')
  expect(w.urls.some((u) => u.includes('/session/reauth/begin'))).toBe(true)
})

test('a publish refused as stale says the Rite moved on', async () => {
  const w = world({ publish: { status: 409, body: { error: 'stale' } } })
  const host = await mount(w, true)
  await click(host, 'Add agent')
  await click(host, 'Save draft')
  await click(host, 'Publish')
  expect(host.textContent).toContain('changed since you opened it')
})

test('running shows each node with status in words, attempts and cost', async () => {
  const w = world()
  const host = await mount(w, true)
  await click(host, 'Run')
  const item = host.querySelector('[data-node-id="start"]')
  expect(item?.textContent).toContain('Running')
  expect(item?.textContent).toContain('2 attempts')
  expect(item?.textContent).toContain('$0.0125')
})

test('on a phone the graph is read only: no palette or save, but Run and the overlay stay', async () => {
  const w = world()
  const host = await mount(w, false)
  expect(host.querySelector('.palette')).toBeNull()
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Save')).toBe(false)
  await click(host, 'Run')
  expect(host.querySelector('[data-node-id="start"]')?.textContent).toContain('Running')
})

test('opening a Rite shows the overlay of its newest run, so leaving and coming back keeps it', async () => {
  const host = await mount(world(), true)
  expect(host.querySelector('[data-node-id="start"]')?.textContent).toContain('Running')
})

test('the run stream reconnects on the shared jittered backoff and says so in-world after 3 failures in a row', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = Object.assign(async () => Response.json({ error: 'down' }, { status: 503 }), {
    preconnect: realFetch.preconnect,
  })
  const timers = holdReconnectTimers()
  try {
    const host = await mount(world(), true, true)
    for (let i = 0; i < 2; i += 1) {
      expect(host.textContent).not.toContain('messenger')
      await act(async () => {
        timers.fireNext()
        await new Promise((r) => setTimeout(r, 30))
      })
    }
    expect(timers.delays.slice(0, 3)).toEqual([250, 500, 1000])
    expect(host.querySelector('[role="status"]')?.textContent).toContain('messenger')
  } finally {
    timers.restore()
    globalThis.fetch = realFetch
  }
})

const wider = {
  version: 2,
  name: 'W',
  graph: {
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      { id: 'out', type: 'post', of: 'start' },
    ],
    edges: [{ from: 'start', to: 'out' }],
  },
  status: 'draft',
  classification: 'widening',
  createdAt: 'now',
}

test('each history row shows its status and classification; expanding shows the diff against the active version', async () => {
  const host = await mount(world({ history: [wider, stored] }), true)
  const rows = [...host.querySelectorAll('[aria-label="Versions"] > li')]
  expect(rows[0]?.textContent).toContain('Version 2')
  expect(rows[0]?.textContent).toContain('widening')
  expect(rows[0]?.textContent).toContain('draft')
  expect(rows[1]?.textContent).toContain('internal')
  expect(rows[1]?.textContent).toContain('active')
  expect(host.textContent).not.toContain('Added node out')
  await click(host, 'Show changes in version 2')
  expect(host.textContent).toContain('Added node out')
  expect(host.textContent).toContain('Added edge start to out')
  await click(host, 'Hide changes in version 2')
  expect(host.textContent).not.toContain('Added node out')
})

test('the active version has no diff against itself', async () => {
  const host = await mount(world({ history: [wider, stored] }), true)
  await click(host, 'Show changes in version 1')
  expect(host.textContent).toContain('This is the version in force.')
})

test('restoring an old version saves its graph as a new draft and never makes it live', async () => {
  const w = world({ history: [wider, stored] })
  const host = await mount(w, true)
  await click(host, 'Restore version 2')
  expect(w.puts).toHaveLength(1)
  expect(w.puts[0]?.graph.nodes.map((n) => n.id)).toEqual(['start', 'out'])
  expect(w.publishes).toEqual([])
  expect(chip(host)).toBe('Draft')
  expect(host.textContent).toContain('Saved as draft version 2')
  expect(host.textContent).toContain('Publish it to put it in force')
})
