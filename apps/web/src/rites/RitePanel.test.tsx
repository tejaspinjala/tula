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
  basedOn: null,
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
  /** Lists a second Rite, `v`, besides `w`. */
  second?: boolean
  /** Holds every save until it resolves, to test saves that overlap. */
  gate?: Promise<void>
  /** The version in force; defaults to 1. */
  active?: number
  /** The version the panel loads first; defaults to the stored one. */
  latest?: Record<string, unknown>
}

function world(options: Options = {}) {
  const flight = { now: 0, peak: 0 }
  const puts: { name: string; graph: { nodes: { id: string; type: string }[] } }[] = []
  const publishes: unknown[] = []
  const urls: string[] = []
  // The newest version and the active one, as the server would report them after each write.
  let latest: Record<string, unknown> = options.latest ?? stored
  let activeVersion = options.active ?? 1
  let archived = false
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    urls.push(`${method} ${url}`)
    if (url === `${base}/w/archive` && method === 'POST') {
      archived = true
      return Response.json({ riteId: 'w', archived: true })
    }
    if (url === `${base}/w/unarchive` && method === 'POST') {
      archived = false
      latest = { ...latest, status: 'superseded' }
      return Response.json({ riteId: 'w', archived: false })
    }
    if (url === `${base}?limit=50&archived=true`) {
      return Response.json({
        rites: archived
          ? [{ id: 'w', name: 'W', latestVersion: 1, activeVersion, archivedAt: 'then' }]
          : [],
        next: null,
      })
    }
    if (url === `${base}?limit=50` && archived) {
      return Response.json({
        rites: options.second ? [{ id: 'v', name: 'V', latestVersion: 1, activeVersion: 1 }] : [],
        next: null,
      })
    }
    if (url === `${base}?limit=50`) {
      return Response.json({
        rites: [
          { id: 'w', name: 'W', latestVersion: 1, activeVersion },
          ...(options.second ? [{ id: 'v', name: 'V', latestVersion: 1, activeVersion: 1 }] : []),
        ],
        next: null,
      })
    }
    if (url === `${base}/w`) {
      return Response.json({ version: latest, activeVersion })
    }
    if (url === `${base}/w?version=1`) {
      return Response.json({ version: stored, activeVersion })
    }
    if (url === `${base}/v`) {
      return Response.json({ version: stored, activeVersion: 1 })
    }
    if (url === `${base}/v/versions?limit=20`) {
      return Response.json({ versions: options.history ?? [stored], next: null })
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
      flight.now++
      flight.peak = Math.max(flight.peak, flight.now)
      await options.gate
      flight.now--
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
          basedOn: body.data.status === 'pending' ? activeVersion : null,
        }
        activeVersion = body.data.status === 'active' ? 2 : activeVersion
      }
      return Response.json(reply.body, { status: reply.status })
    }
    return fetcher(url, init)
  }
  const browser = { create: async () => ({}), get: async () => ({ signed: 'abc' }) }
  return { puts, publishes, urls, flight, fetcher: wrapped, browser }
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
        ? (b.getAttribute('aria-label') ?? b.textContent?.trim())
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

test('two rapid saves send one request at a time and the latest graph wins', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const w = world({ gate })
  const host = await mount(w, true)
  await click(host, 'Add agent')
  await click(host, 'Save draft')
  await click(host, 'Add agent')
  await click(host, 'Save draft')
  await click(host, 'Add agent')
  await click(host, 'Save draft')
  expect(w.puts).toHaveLength(1)
  release()
  await settle()
  expect(w.flight.peak).toBe(1)
  expect(w.puts).toHaveLength(2)
  expect(w.puts[1]?.graph.nodes).toHaveLength(4)
})

test('a save after the session changes goes to the new guild path', async () => {
  const w = world()
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = createRoot(host)
  const render = (sess: typeof session) =>
    act(async () => {
      root.render(
        <RitePanel
          session={sess}
          fetcher={w.fetcher}
          browser={w.browser}
          desktop={true}
          validateDelayMs={0}
          live={false}
        />
      )
    })
  await render(session)
  await settle()
  await click(host, 'Add agent')
  await click(host, 'Save draft')
  const next = { token: 't2', guildId: '22222222-2222-4222-8222-222222222222' }
  await render(next)
  await settle()
  await click(host, 'Add agent')
  await click(host, 'Save draft')
  const put = w.urls.filter((u) => u.startsWith('PUT '))
  expect(put.at(-1)).toBe(`PUT /api/guilds/${next.guildId}/rites/w`)
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
  basedOn: null,
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

test('when the active version is outside the loaded page its graph is fetched, so the diff is real', async () => {
  const filler = Array.from({ length: 20 }, (_, i) => ({ ...wider, version: i + 3 }))
  const host = await mount(world({ history: [{ ...wider, version: 23 }, ...filler] }), true)
  await click(host, 'Show changes in version 23')
  expect(host.textContent).toContain('Added node out')
  expect(host.textContent).not.toContain('No version is in force yet')
})

test('switching to another Rite collapses every expanded history row', async () => {
  const host = await mount(world({ history: [wider, stored], second: true }), true)
  await click(host, 'Show changes in version 2')
  expect(host.textContent).toContain('Added node out')
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Rite"]')
  if (!select) {
    throw new Error('no Rite select')
  }
  await act(async () => {
    select.value = 'v'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
  expect(host.querySelector('[aria-label="Versions"] [aria-expanded="true"]')).toBeNull()
  expect(host.textContent).not.toContain('Added node out')
})

test('Archive asks a one-line confirm, then archives the Rite and drops it from the list', async () => {
  const w = world({ second: true })
  const host = await mount(w, true)
  await click(host, 'Archive')
  expect(host.textContent).toContain('Archive W? It leaves the list and cannot run until restored.')
  expect(w.urls).not.toContain(`POST ${base}/w/archive`)
  await click(host, 'No')
  expect(host.textContent).not.toContain('Archive W?')
  await click(host, 'Archive')
  await click(host, 'Yes')
  expect(w.urls).toContain(`POST ${base}/w/archive`)
  const options = [...host.querySelectorAll('select[aria-label="Rite"] option')].map(
    (o) => o.textContent
  )
  expect(options).toEqual(['V'])
})

test('the Archived filter lists only archived Rites and Unarchive restores one, needing a publish again', async () => {
  const w = world({ second: true })
  const host = await mount(w, true)
  await click(host, 'Archive')
  await click(host, 'Yes')
  const filter = [...host.querySelectorAll<HTMLElement>('button')].find((b) =>
    (b.textContent ?? '').includes('Show archived')
  )
  if (!filter) {
    throw new Error('no Archived filter')
  }
  await act(async () => {
    filter.click()
  })
  await settle()
  expect(w.urls).toContain(`GET ${base}?limit=50&archived=true`)
  const options = [...host.querySelectorAll('select[aria-label="Rite"] option')].map(
    (o) => o.textContent
  )
  expect(options).toEqual(['W'])
  const run = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Run')
  expect(run?.disabled).toBe(true)
  await click(host, 'Unarchive')
  expect(w.urls).toContain(`POST ${base}/w/unarchive`)
  expect(host.textContent).toContain('must be published again')
  expect(host.textContent).toContain('Show archived')
  const live = [...host.querySelectorAll('select[aria-label="Rite"] option')].map(
    (o) => o.textContent
  )
  expect(live).toContain('W')
  const runAfter = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Run')
  expect(runAfter?.disabled).toBe(true)
})

async function key(target: Element, name: string) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    )
  })
  await settle()
}
const option = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === text)

test('the archive confirm lists the safe No first, focused, and Cancel returns focus to Archive', async () => {
  const host = await mount(world(), true)
  await click(host, 'Archive')
  const options = [...host.querySelectorAll('[role="option"]')].filter((o) =>
    ['Yes', 'No'].includes(o.textContent ?? '')
  )
  expect(options.map((o) => o.textContent)).toEqual(['No', 'Yes'])
  expect(doc.activeElement).toBe(option(host, 'No') ?? null)
  await click(host, 'No')
  const archive = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Archive')
  expect(archive).toBeDefined()
  expect(doc.activeElement).toBe(archive ?? null)
})

test('Esc cancels only the archive confirm and does not reach the Bag', async () => {
  const host = await mount(world(), true)
  const reached: string[] = []
  doc.addEventListener('keydown', (e) => reached.push(e.key))
  await click(host, 'Archive')
  const no = option(host, 'No')
  if (!no) {
    throw new Error('no confirm')
  }
  await key(no, 'Escape')
  expect(host.textContent).not.toContain('Archive W?')
  expect(reached).not.toContain('Escape')
})

test('a rename alone enables Save draft, and the archive confirm names the saved Rite', async () => {
  const host = await mount(world(), true)
  const save = () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save draft')
  expect(save()?.disabled).toBe(true)
  const name = host.querySelector<HTMLInputElement>('.builder-save input')
  if (!name) {
    throw new Error('no name input')
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Renamed')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(save()?.disabled).toBe(false)
  expect(host.textContent).toContain('Unsaved changes')
  await click(host, 'Archive')
  expect(host.textContent).toContain('Archive W? It leaves')
  expect(host.textContent).not.toContain('Archive Renamed?')
})

test('Discard puts the name back as well as the graph', async () => {
  const host = await mount(world(), true)
  const name = host.querySelector<HTMLInputElement>('.builder-save input')
  if (!name) {
    throw new Error('no name input')
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Renamed')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(host, 'Discard')
  expect(host.querySelector<HTMLInputElement>('.builder-save input')?.value).toBe('W')
  expect(host.textContent).toContain('No unsaved changes')
})

test('the archived toggle reads Show archived, then Hide archived', async () => {
  const host = await mount(world({ second: true }), true)
  const toggle = () =>
    [...host.querySelectorAll('button')].find((b) =>
      /(Show|Hide) archived/.test(b.textContent ?? '')
    )
  expect(toggle()?.textContent).toContain('Show archived')
  await act(async () => {
    toggle()?.click()
  })
  await settle()
  expect(toggle()?.textContent).toContain('Hide archived')
})

test('archiving the only Rite shows an empty state, not an unsaved my-rite draft', async () => {
  const host = await mount(world(), true)
  await click(host, 'Archive')
  await click(host, 'Yes')
  expect(host.textContent).toContain('No Rites yet')
  expect(host.textContent).not.toContain('my-rite')
  expect(host.textContent).not.toContain('Unsaved changes')
})

test('Show archived with no archived Rites shows an empty state and leaves the selected Rite untouched', async () => {
  const host = await mount(world(), true)
  const toggle = () =>
    [...host.querySelectorAll('button')].find((b) =>
      /(Show|Hide) archived/.test(b.textContent ?? '')
    )
  await act(async () => {
    toggle()?.click()
  })
  await settle()
  expect(host.textContent).toContain('No archived Rites')
  expect(host.textContent).not.toContain('(unsaved)')
  expect(host.textContent).not.toContain('Unsaved changes')
  await click(host, '▶Back to Rites')
  expect(host.textContent).not.toContain('No archived Rites')
  expect(host.querySelector<HTMLInputElement>('.builder-save input')?.value).toBe('W')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Rite"]')?.value).toBe('w')
  expect(host.textContent).toContain('Live')
})

test('outline buttons are named as steps so they differ from the action buttons', async () => {
  const host = await mount(world(), true)
  const outline = host.querySelector('[aria-label="Nodes"]')
  expect(outline?.querySelector('button')?.getAttribute('aria-label')).toBe('Step: start')
})

test('a pending version left under a newer active reads as stale', async () => {
  const history = [
    { ...stored, version: 2, status: 'active' },
    { ...stored, version: 1, status: 'pending', classification: 'widening' },
  ]
  const w = world({ history, active: 2 })
  const host = await mount(w, true)
  expect(host.textContent).toContain('stale')
  expect(host.textContent).not.toContain('widening, pending')
})

test('a legacy pending version above the active one is stale: no Pending chip, no Confirm button', async () => {
  const legacy = { ...stored, version: 3, status: 'pending', classification: 'widening' }
  const history = [legacy, { ...stored, version: 2, status: 'active' }]
  const host = await mount(world({ history, active: 2, latest: legacy }), true)
  expect(host.textContent).toContain('stale')
  expect(host.textContent).not.toContain('Confirm with passkey')
  expect(host.textContent).not.toContain('Pending')
})
