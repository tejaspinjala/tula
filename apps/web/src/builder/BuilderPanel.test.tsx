import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const cfg = `/api/guilds/${guild}/config`
const options = { challenge: 'abc' }

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { BuilderPanel } = await import('./BuilderPanel')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const hall = (
  id: string,
  name: string,
  members: { id: string; name: string }[],
  locked = false
) => ({
  id,
  name,
  kind: locked ? 'private' : 'work',
  locked,
  privateEligible: false,
  captain: locked ? null : { id: `${id}-captain`, name: `${name} Captain` },
  members: members.map((m) => ({ ...m, rank: 'apprentice' })),
})
const document = {
  steward: { id: 'steward', name: 'Steward' },
  halls: [
    { ...hall('heralds', 'Heralds Hall', [{ id: 'm1', name: 'Quill' }]), maxConcurrentMembers: 2 },
    hall('health', 'Health', [], true),
  ],
  sealPolicy: 'always',
  caps: { dailyTokens: 5, dailySpendCents: 5, maxSpawnDepth: 2 },
}
const quest = (id: string, hallId: string, state: string) => ({
  id,
  title: id,
  hallId,
  ownerId: 'm1',
  state,
  doneCondition: 'x',
  round: 0,
  roundLimit: 3,
  attempts: 1,
  lastError: null,
})

interface Put {
  body: {
    config: {
      halls: {
        id: string
        members: { id: string; look?: unknown }[]
        captain: unknown
        maxConcurrentMembers?: number
      }[]
      caps?: Record<string, number>
    }
  }
}

function world(
  put: { status: number; body: unknown } = {
    status: 200,
    body: { version: 2, status: 'applied', change: 'neutral' },
  }
) {
  const urls: string[] = []
  const puts: Put[] = []
  let proofHeader: string | null = null
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    urls.push(`${method} ${url}`)
    if (url === cfg && method === 'PUT') {
      puts.push({ body: JSON.parse(String(init?.body)) })
      return Response.json(put.body, { status: put.status })
    }
    if (url === cfg) {
      return Response.json({ version: 1, config: document })
    }
    if (url.startsWith(`${cfg}/versions?`)) {
      return Response.json({
        versions: [
          { version: 1, status: 'applied', kind: 'seed', change: 'neutral', createdAt: 'now' },
        ],
        next: null,
      })
    }
    if (url.endsWith('/begin')) {
      return Response.json({ challengeId: 'c', options })
    }
    if (url.endsWith('/finish')) {
      return Response.json({ proof: 'proof-1' })
    }
    if (url.endsWith('/confirm')) {
      proofHeader = new Headers(init?.headers).get('x-reauth-proof')
      return Response.json({ version: 2, status: 'applied' })
    }
    if (url.includes('/tripwires')) {
      return Response.json({
        thresholds: { tokenBurnMultiple: 1, gateDenialsPerHour: 1, loopRepeats: 1 },
        pauses: [
          {
            id: 'p1',
            hallId: 'heralds',
            tripwire: 'manual',
            observed: 0,
            threshold: 0,
            pausedAt: 'now',
          },
        ],
        next: null,
      })
    }
    if (url.includes('/quests')) {
      return Response.json({
        quests: [
          quest('q1', 'heralds', 'active'),
          quest('q2', 'heralds', 'queued'),
          quest('q3', 'health', 'done'),
        ],
        next: null,
        links: [],
      })
    }
    if (url.endsWith('/gates')) {
      return Response.json({ guild: true, global: false })
    }
    return Response.json({}, { status: 404 })
  }
  const browser = { create: async () => ({}), get: async () => ({ signed: 'abc' }) }
  return { urls, puts, fetcher, browser, proof: () => proofHeader }
}

async function mount(w: ReturnType<typeof world>, desktop: boolean) {
  const host = document_.createElement('div')
  document_.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <BuilderPanel session={session} fetcher={w.fetcher} browser={w.browser} desktop={desktop} />
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
  return host
}
const document_ = globalThis.document

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
  if (!found) {
    throw new Error(`no button "${name}"`)
  }
  return found
}
async function click(host: HTMLElement, name: string) {
  await act(async () => {
    button(host, name).click()
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}
async function choose(host: HTMLElement, label: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  if (!select) {
    throw new Error(`no select "${label}"`)
  }
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

test('on a phone the hierarchy is a read-only tree: no palette, no editing, no save', async () => {
  const host = await mount(world(), false)
  expect(host.textContent).toContain('Steward')
  expect(host.textContent).toContain('Heralds Hall')
  expect(host.textContent).toContain('Quill')
  expect(host.textContent).toContain('Locked')
  expect(host.textContent).toContain('paused')
  expect(host.querySelector('button')).toBeNull()
  expect(host.querySelector('input')).toBeNull()
})

test('moving a Member to another Hall from the keyboard menu, then saving, PUTs the new config', async () => {
  const w = world()
  const host = await mount(w, true)
  expect(host.textContent).not.toContain('Unsaved changes')
  await click(host, 'Quill')
  await choose(host, 'Move to Hall', 'health')
  expect(host.textContent).toContain('Unsaved changes')
  await click(host, 'Save')
  const put = w.puts[0]
  expect(put?.body.config.halls.map((h) => h.members.map((m) => m.id))).toEqual([[], ['m1']])
  expect(host.textContent).not.toContain('Unsaved changes')
})

test('changing a Member look in the inspector saves it with the Member as a neutral change', async () => {
  const w = world()
  const host = await mount(w, true)
  await click(host, 'Quill')
  await choose(host, 'Outfit style', '7')
  await choose(host, 'Hair colour', '3')
  expect(host.querySelector('[data-testid="look-preview"]')).not.toBeNull()
  await click(host, 'Save')
  const saved = w.puts[0]?.body.config.halls[0]?.members[0]
  expect(saved?.look).toMatchObject({ outfitStyle: 7, hairColor: 3 })
  expect(host.textContent).not.toContain('widening')
})

test('dropping a prebuilt Research Hall adds its Captain and two Members to the saved config', async () => {
  const w = world()
  const host = await mount(w, true)
  await click(host, 'Add Research')
  await click(host, 'Save')
  const added = w.puts[0]?.body.config.halls.at(-1)
  expect(added?.id).toBe('research')
  expect(added?.captain).not.toBeNull()
  expect(added?.members).toHaveLength(2)
})

test('adding a blank Hall from the palette shows it and discard takes it back out', async () => {
  const w = world()
  const host = await mount(w, true)
  await click(host, 'Add blank Hall')
  expect(host.textContent).toContain('New Hall')
  expect(host.textContent).toContain('Unsaved changes')
  await click(host, 'Discard')
  expect(host.textContent).not.toContain('New Hall')
  expect(host.textContent).not.toContain('Unsaved changes')
  expect(w.puts).toHaveLength(0)
})

test('a widening save shows the server classification and confirms only after a passkey re-auth', async () => {
  const w = world({ status: 202, body: { version: 2, status: 'pending', change: 'widening' } })
  const host = await mount(w, true)
  await click(host, 'Add Review')
  await click(host, 'Save')
  expect(host.textContent).toContain('widening')
  expect(w.urls.some((u) => u.endsWith('/confirm'))).toBe(false)
  await click(host, 'Confirm with passkey')
  expect(w.urls.filter((u) => u.includes('/session/reauth/'))).toHaveLength(2)
  expect(w.urls.some((u) => u.includes('/versions/2/confirm'))).toBe(true)
  expect(w.proof()).toBe('proof-1')
})

test('a server validation error is shown on the node it names', async () => {
  const w = world({
    status: 400,
    body: {
      error: 'invalid_config',
      issues: [{ path: ['halls', 0, 'name'], message: 'too long' }],
    },
  })
  const host = await mount(w, true)
  await click(host, 'Add Review')
  await click(host, 'Save')
  const item = host.querySelector('[data-node-id="heralds"]')
  expect(item?.textContent).toContain('too long')
  expect(host.querySelector('[data-node-id="review"]')?.textContent).not.toContain('too long')
})

function field(host: HTMLElement, label: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) {
    throw new Error(`no field "${label}"`)
  }
  return input
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('each Hall node shows claimed over cap from the active Quests of that Hall', async () => {
  const host = await mount(world(), true)
  expect(host.querySelector('[data-node-id="heralds"]')?.textContent).toContain('1 / 2')
  expect(host.querySelector('[data-node-id="health"]')?.textContent).toContain('0 / no cap')
})

test('the Hall inspector edits the member cap, shows its bounds, and saves it in the config', async () => {
  const w = world()
  const host = await mount(w, true)
  await click(host, 'Heralds Hall')
  expect(host.textContent).toContain('1 to 1000')
  await type(field(host, 'Member cap'), '1')
  expect(host.textContent).not.toContain('Widening')
  await click(host, 'Save')
  expect(w.puts[0]?.body.config.halls[0]?.maxConcurrentMembers).toBe(1)
})

test('raising a cap is marked widening before save; the server answer decides the passkey prompt', async () => {
  const w = world({ status: 202, body: { version: 2, status: 'pending', change: 'widening' } })
  const host = await mount(w, true)
  await click(host, 'Heralds Hall')
  await type(field(host, 'Member cap'), '6')
  expect(host.textContent).toContain('Widening')
  await click(host, 'Save')
  expect(w.puts[0]?.body.config.halls[0]?.maxConcurrentMembers).toBe(6)
  expect(host.textContent).toContain('Confirm with passkey')
})

test('with nothing selected the guild caps are edited and saved under caps', async () => {
  const w = world()
  const host = await mount(w, true)
  expect(host.textContent).toContain('0 to 20')
  await type(field(host, 'Sub-Quests per Quest'), '5')
  expect(host.textContent).toContain('Widening')
  await type(field(host, 'Spawn depth'), '1')
  await click(host, 'Save')
  expect(w.puts[0]?.body.config.caps).toEqual({
    dailyTokens: 5,
    dailySpendCents: 5,
    maxSpawnDepth: 1,
    maxChildrenPerQuest: 5,
  })
})
