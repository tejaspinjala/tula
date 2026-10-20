import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const base = `/api/guilds/${guild}/workflows`

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { WorkflowPanel } = await import('./WorkflowPanel')
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
}

function world(options: Options = {}) {
  const puts: { name: string; graph: { nodes: { id: string; type: string }[] } }[] = []
  const urls: string[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    urls.push(`${method} ${url}`)
    if (url === `${base}?limit=50`) {
      return Response.json({
        workflows: [{ id: 'w', name: 'W', latestVersion: 1, activeVersion: 1 }],
        next: null,
      })
    }
    if (url === `${base}/w`) {
      return Response.json({ version: stored, activeVersion: 1 })
    }
    if (url === `${base}/w/versions?limit=20`) {
      return Response.json({ versions: [stored], next: null })
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
      const reply = options.save ?? {
        status: 200,
        body: { status: 'active', version: { version: 2, classification: 'internal' } },
      }
      return Response.json(reply.body, { status: reply.status })
    }
    return fetcher(url, init)
  }
  const browser = { create: async () => ({}), get: async () => ({ signed: 'abc' }) }
  return { puts, urls, fetcher: wrapped, browser }
}

const doc = globalThis.document

async function mount(w: ReturnType<typeof world>, desktop: boolean, live = false) {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <WorkflowPanel
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

test('adding a node from the palette and saving PUTs the edited graph', async () => {
  const w = world()
  const host = await mount(w, true)
  await click(host, 'Add agent')
  await click(host, 'Save')
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
      { code: 'no_trigger', message: 'a workflow needs at least one trigger' },
    ],
  })
  const host = await mount(w, true)
  expect(host.querySelector('[data-node-id="start"]')?.textContent).toContain(
    'agent start runs after a gate'
  )
  expect(host.textContent).toContain('a workflow needs at least one trigger')
})

test('a saved widening version waits for a passkey confirm; the server says pending', async () => {
  const w = world({
    save: {
      status: 202,
      body: { status: 'pending', version: { version: 2, classification: 'widening' } },
    },
  })
  const host = await mount(w, true)
  await click(host, 'Add agent')
  await click(host, 'Save')
  expect(host.textContent).toContain('widening')
  await click(host, 'Confirm with passkey')
  expect(w.urls.some((u) => u.includes('/session/reauth/begin'))).toBe(true)
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

test('opening a Workflow shows the overlay of its newest run, so leaving and coming back keeps it', async () => {
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
