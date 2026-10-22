import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { sampleCharter } from './fixtures'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const cfg = `/api/guilds/${guild}/config`
const charterUrl = `/api/guilds/${guild}/charter`

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { CharterPanel } = await import('./CharterPanel')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const hall = (id: string, name: string) => ({
  id,
  name,
  kind: 'work',
  locked: false,
  privateEligible: false,
  captain: null,
  members: [],
})
const current = {
  steward: { id: 'steward', name: 'Steward' },
  halls: [hall('heralds', 'Heralds Hall'), hall('health', 'Health')],
  sealPolicy: 'always',
  caps: { dailyTokens: 5, maxSpawnDepth: 2 },
  learningRepos: ['me/repo'],
}

interface World {
  calls: string[]
  imports: unknown[]
  downloads: { filename: string; text: string }[]
  host: HTMLElement
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
}

interface Options {
  preview?: { status: number; body: unknown }
  onConfigChanged?: () => void
}

async function mount(
  importResponse: { status: number; body: unknown },
  options: Options = {}
): Promise<World> {
  const previewResponse = options.preview ?? {
    status: 200,
    body: { change: 'widening', baseVersion: 3 },
  }
  const world: World = {
    calls: [],
    imports: [],
    downloads: [],
    host: document.createElement('div'),
  }
  document.body.append(world.host)
  const fetcher = async (url: string, init?: RequestInit) => {
    world.calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url === cfg) {
      return Response.json({ version: 3, config: current })
    }
    if (url === charterUrl) {
      return Response.json(sampleCharter)
    }
    if (url === `${charterUrl}/preview`) {
      return Response.json(previewResponse.body, { status: previewResponse.status })
    }
    if (url === `${charterUrl}/import`) {
      world.imports.push(JSON.parse(String(init?.body)))
      return Response.json(importResponse.body, { status: importResponse.status })
    }
    if (url.endsWith('/begin')) {
      return Response.json({ challengeId: 'c', options: { challenge: 'abc' } })
    }
    if (url.endsWith('/finish')) {
      return Response.json({ proof: 'p' })
    }
    if (url.endsWith('/confirm')) {
      return Response.json({ version: 4, status: 'applied' })
    }
    return Response.json({}, { status: 404 })
  }
  const browser = { create: async () => ({}), get: async () => ({ signed: 'abc' }) }
  await act(async () => {
    createRoot(world.host).render(
      <CharterPanel
        session={session}
        fetcher={fetcher}
        browser={browser}
        onConfigChanged={options.onConfigChanged}
        download={(filename, text) => world.downloads.push({ filename, text })}
      />
    )
  })
  await settle()
  return world
}

async function click(host: HTMLElement, name: string) {
  const found = [...host.querySelectorAll<HTMLElement>('button, [role="option"]')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name
  )
  if (!found) {
    throw new Error(`no button "${name}"`)
  }
  await act(async () => {
    found.click()
  })
  await settle()
}

async function pick(host: HTMLElement, text: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) {
    throw new Error('no file input')
  }
  const file = new File([text], 'x.charter.json', { type: 'application/json' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

const applied = {
  status: 200,
  body: { config: { outcome: 'applied', version: 4 }, riteIds: ['r1'] },
}

test('Export downloads <name>.charter.json and lists what was left out', async () => {
  const w = await mount(applied)
  await click(w.host, 'Export Charter')
  expect(w.downloads).toHaveLength(1)
  expect(w.downloads[0]?.filename).toBe('Heralds Guild.charter.json')
  expect(w.host.textContent).toContain('touches a private Hall')
})

test('an unpublished Rite is left out with a reason that says what to do', async () => {
  const w = await mount(applied)
  await click(w.host, 'Export Charter')
  expect(w.host.textContent).toContain('Publish this Rite to include it')
  expect(w.host.textContent).not.toContain('rite draft: unpublished')
})

test('a bad file shows an error and sends nothing', async () => {
  const w = await mount(applied)
  await pick(w.host, '{nope')
  expect(w.host.querySelector('[role="alert"]')?.textContent).toMatch(/not a valid Charter/i)
  expect(w.calls.some((c) => c.includes('/import'))).toBe(false)
})

test('a picked Charter shows the preview before anything is sent', async () => {
  const w = await mount(applied)
  await pick(w.host, JSON.stringify(sampleCharter))
  const text = w.host.textContent ?? ''
  expect(text).toContain('Forge')
  expect(text).toContain('Health')
  expect(text).toContain('Morning digest')
  expect(text).toContain('learningRepos')
  expect(w.imports).toHaveLength(0)
})

test('the preview reads as grouped change lines, never raw JSON', async () => {
  const w = await mount(applied)
  await pick(w.host, JSON.stringify(sampleCharter))
  const lines = (label: string) =>
    Array.from(w.host.querySelectorAll(`[aria-label="${label}"] li`)).map((li) => li.textContent)
  expect(lines('Halls')).toContain('Hall Forge will be added')
  expect(lines('Halls')).toContain('Hall Health will be removed')
  expect(lines('Halls')).toContain('Hall heralds: Captain changes from none to Captain')
  expect(lines('Caps')).toContain('Daily tokens cap changes from 5 to 9')
  expect(lines('Seal Policy')).toContain('Seal Policy changes from always to strict')
  expect(lines('Rites')).toContain('Rite Morning digest will be added as a draft')
  const text = w.host.textContent ?? ''
  expect(text).not.toMatch(/[{}]/)
  expect(text).not.toContain('->')
  expect(text).not.toContain('caps.dailyTokens')
  expect(text).toContain('Widens authority: waits for your passkey')
})

test('confirming posts the version shown and a fresh import id, then reports applied', async () => {
  const w = await mount(applied)
  await pick(w.host, JSON.stringify(sampleCharter))
  await click(w.host, 'Import this Charter')
  await click(w.host, 'Yes')
  expect(w.imports).toHaveLength(1)
  expect(w.imports[0]).toMatchObject({ baseVersion: 3 })
  expect(String(Reflect.get(Object(w.imports[0]), 'importId')).length).toBeGreaterThan(8)
  expect(w.host.textContent).toContain('Imported')
})

test('declining sends nothing', async () => {
  const w = await mount(applied)
  await pick(w.host, JSON.stringify(sampleCharter))
  await click(w.host, 'Import this Charter')
  await click(w.host, 'No')
  expect(w.imports).toHaveLength(0)
})

test('a pending result reaches the passkey confirm', async () => {
  const w = await mount({
    status: 200,
    body: { config: { outcome: 'pending', version: 4 }, riteIds: ['r1'] },
  })
  await pick(w.host, JSON.stringify(sampleCharter))
  await click(w.host, 'Import this Charter')
  await click(w.host, 'Yes')
  await click(w.host, 'Confirm with passkey')
  expect(w.calls.some((c) => c.endsWith('/versions/4/confirm'))).toBe(true)
})

test('a stale result shows Reload, which reloads the config', async () => {
  const w = await mount({ status: 409, body: { error: 'stale' } })
  await pick(w.host, JSON.stringify(sampleCharter))
  await click(w.host, 'Import this Charter')
  await click(w.host, 'Yes')
  const before = w.calls.filter((c) => c === `GET ${cfg}`).length
  await click(w.host, 'Reload')
  expect(w.calls.filter((c) => c === `GET ${cfg}`).length).toBe(before + 1)
})

test('a 422 shows the reason and nothing changed', async () => {
  const w = await mount({ status: 422, body: { error: 'invalid_charter' } })
  await pick(w.host, JSON.stringify(sampleCharter))
  await click(w.host, 'Import this Charter')
  await click(w.host, 'Yes')
  expect(w.host.querySelector('[role="alert"]')?.textContent).toContain(
    'is not a Charter this guild can read'
  )
})

test.each([
  ['invalid_charter', 422, 'is not a Charter this guild can read'],
  ['subscription_disabled', 403, 'Subscription is off'],
  ['seal_policy_locked', 403, 'Seal Policy is locked'],
  ['invalid_request', 400, 'could not be understood'],
])('the refusal %s shows its own plain message', async (code, status, words) => {
  const w = await mount({ status, body: { error: code } })
  await pick(w.host, JSON.stringify(sampleCharter))
  await click(w.host, 'Import this Charter')
  await click(w.host, 'Yes')
  const text = w.host.querySelector('[role="alert"]')?.textContent ?? ''
  expect(text).toContain(words)
  expect(text).not.toContain(code)
})

test('two same-named Rites render without a duplicate-key warning', async () => {
  const rite = sampleCharter.rites[0]
  if (!rite) {
    throw new Error('fixture has no Rite')
  }
  const errors: unknown[][] = []
  const sink = Reflect.get(globalThis, 'console')
  const spy = spyOn(sink, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args)
  })
  try {
    const w = await mount(applied)
    await pick(w.host, JSON.stringify({ ...sampleCharter, rites: [rite, rite] }))
    expect(w.host.textContent?.split('Morning digest').length).toBe(3)
  } finally {
    spy.mockRestore()
  }
  expect(errors.filter((a) => String(a[0]).includes('same key'))).toEqual([])
})

test('Export downloads compact JSON', async () => {
  const w = await mount(applied)
  await click(w.host, 'Export Charter')
  const text = w.downloads[0]?.text ?? ''
  expect(text).not.toContain('\n')
  expect(text).toBe(JSON.stringify(JSON.parse(text)))
})

test('a reused import id shows a plain message and not the raw code', async () => {
  const w = await mount({ status: 409, body: { error: 'import_id_reused' } })
  await pick(w.host, JSON.stringify(sampleCharter))
  await click(w.host, 'Import this Charter')
  await click(w.host, 'Yes')
  const text = w.host.querySelector('[role="alert"]')?.textContent ?? ''
  expect(text).toContain('already used for a different Charter')
  expect(text).not.toContain('import_id_reused')
})

test('a widening preview shows the badge and the matching question', async () => {
  const w = await mount(applied)
  await pick(w.host, JSON.stringify(sampleCharter))
  expect(w.host.textContent).toContain('Widens authority: waits for your passkey')
  expect(w.host.textContent).not.toContain('A change that widens')
  await click(w.host, 'Import this Charter')
  expect(w.host.textContent).toContain('Widens authority: waits for your passkey')
})

test('an internal preview says it applies at once', async () => {
  const w = await mount(applied, {
    preview: { status: 200, body: { change: 'internal', baseVersion: 3 } },
  })
  await pick(w.host, JSON.stringify(sampleCharter))
  expect(w.host.textContent).toContain('Applies at once')
})

test('an unchanged preview says only Rites are added', async () => {
  const w = await mount(applied, {
    preview: { status: 200, body: { change: 'unchanged', baseVersion: 3 } },
  })
  await pick(w.host, JSON.stringify(sampleCharter))
  expect(w.host.textContent).toContain('Config already matches; only Rites are added')
})

test('a failed preview shows the reason and disables Import', async () => {
  const w = await mount(applied, {
    preview: { status: 422, body: { error: 'invalid_charter' } },
  })
  await pick(w.host, JSON.stringify(sampleCharter))
  expect(w.host.querySelector('[role="alert"]')?.textContent).toMatch(/does not accept/i)
  const button = [...w.host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Import this Charter'
  )
  expect(button?.disabled).toBe(true)
})

test('an applied import refreshes the Hall', async () => {
  let refreshed = 0
  const w = await mount(applied, { onConfigChanged: () => void refreshed++ })
  await pick(w.host, JSON.stringify(sampleCharter))
  await click(w.host, 'Import this Charter')
  await click(w.host, 'Yes')
  expect(refreshed).toBe(1)
})

test('a confirmed pending import refreshes the Hall', async () => {
  let refreshed = 0
  const w = await mount(
    { status: 200, body: { config: { outcome: 'pending', version: 4 }, riteIds: [] } },
    { onConfigChanged: () => void refreshed++ }
  )
  await pick(w.host, JSON.stringify(sampleCharter))
  await click(w.host, 'Import this Charter')
  await click(w.host, 'Yes')
  expect(refreshed).toBe(0)
  await click(w.host, 'Confirm with passkey')
  expect(refreshed).toBe(1)
})

test('while stale, Import this Charter is disabled until Reload', async () => {
  const w = await mount({ status: 409, body: { error: 'stale' } })
  await pick(w.host, JSON.stringify(sampleCharter))
  await click(w.host, 'Import this Charter')
  await click(w.host, 'Yes')
  const importButton = () =>
    [...w.host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Import this Charter'
    )
  expect(importButton()?.disabled).toBe(true)
  await click(w.host, 'Reload')
  expect(importButton()?.disabled).toBe(false)
})
