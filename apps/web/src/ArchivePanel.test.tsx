import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { ArchivePanel } = await import('./ArchivePanel')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))

type Reply = {
  status: number
  error?: string
  counts?: unknown
  gate?: Promise<void>
  reauthFails?: boolean
}

async function mount(reply: Reply) {
  const host = document.createElement('div')
  document.body.append(host)
  const world = {
    host,
    urls: [] as string[],
    proofs: [] as Array<string | null>,
    reauths: 0,
    exports: 0,
    downloads: [] as Array<{ filename: string; size: number }>,
  }
  const fetcher = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/session/reauth/begin')) {
      world.reauths += 1
      if (reply.reauthFails) {
        return Response.json({ error: 'reauth_failed' }, { status: 500 })
      }
      return Response.json({ challengeId: 'c1', options: { challenge: 'x' } })
    }
    if (url.endsWith('/session/reauth/finish')) {
      return Response.json({ proof: 'proof-1' })
    }
    if (url.includes('/archive/export')) {
      world.exports += 1
      await reply.gate
      world.urls.push(url)
      world.proofs.push(new Headers(init?.headers).get('x-reauth-proof'))
      if (reply.status !== 200) {
        return Response.json({ error: reply.error }, { status: reply.status })
      }
      return new Response('zip', {
        headers: {
          'content-disposition': 'attachment; filename="Iron-archive.zip"',
          'x-archive-counts': JSON.stringify(reply.counts),
        },
      })
    }
    return Response.json({ notes: [], next: null })
  }
  const browser = {
    create: async (): Promise<unknown> => ({}),
    get: async (): Promise<unknown> => ({ signed: 'abc' }),
  }
  await act(async () => {
    createRoot(host).render(
      <ArchivePanel
        session={session}
        fetcher={fetcher}
        browser={browser}
        download={(filename, blob) => world.downloads.push({ filename, size: blob.size })}
      />
    )
  })
  await settle()
  return world
}

async function click(host: HTMLElement, name: string) {
  const found = [...host.querySelectorAll<HTMLElement>('button')].find(
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

test('Export downloads the zip and says how many notes and private notes were left out', async () => {
  const w = await mount({
    status: 200,
    counts: { exported: 4, privateIncluded: 0, privateLeftOut: 2 },
  })
  await click(w.host, 'Export archive')
  expect(w.downloads).toEqual([{ filename: 'Iron-archive.zip', size: 3 }])
  expect(w.urls[0]).not.toContain('private=true')
  expect(w.host.textContent).toContain('Exported 4 notes; 2 private notes left out')
})

test('Include private notes starts off, and choosing it sends the re-auth proof', async () => {
  const w = await mount({
    status: 200,
    counts: { exported: 6, privateIncluded: 2, privateLeftOut: 0 },
  })
  const toggle = [...w.host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Include private notes'
  )
  expect(toggle?.getAttribute('aria-pressed')).toBe('false')
  await click(w.host, 'Include private notes')
  await click(w.host, 'Export archive')
  expect(w.urls[0]).toContain('private=true')
  expect(w.proofs[0]).toBe('proof-1')
  expect(w.host.textContent).toContain('Exported 6 notes, 2 of them private')
})

test('a refused re-auth and a too-large archive each get a plain message', async () => {
  const refused = await mount({ status: 403, error: 'reauth_required' })
  await click(refused.host, 'Export archive')
  expect(refused.host.textContent).toContain('Confirm with your passkey')
  expect(refused.downloads).toHaveLength(0)

  const big = await mount({ status: 413, error: 'archive_too_large' })
  await click(big.host, 'Export archive')
  expect(big.host.textContent).toContain('too large to export')
})

test('an expired sign-in and a rate limit each get a plain message', async () => {
  const out = await mount({ status: 401, error: 'unauthorized' })
  await click(out.host, 'Export archive')
  expect(out.host.textContent).toContain('Sign in again')

  const slow = await mount({ status: 429, error: 'rate_limited' })
  await click(slow.host, 'Export archive')
  expect(slow.host.textContent).toContain('Too many exports')
})

const pressed = (host: HTMLElement) =>
  [...host.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === 'Include private notes')
    ?.getAttribute('aria-pressed')

test('a double click on Export runs one export, one re-auth and one download', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const w = await mount({
    status: 200,
    counts: { exported: 1, privateIncluded: 1, privateLeftOut: 0 },
    gate,
  })
  await click(w.host, 'Include private notes')
  const button = [...w.host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Export archive'
  )
  await act(async () => {
    button?.click()
    button?.click()
  })
  expect(button?.disabled).toBe(true)
  release()
  await settle()
  expect(w.reauths).toBe(1)
  expect(w.exports).toBe(1)
  expect(w.downloads).toHaveLength(1)
  expect(button?.disabled).toBe(false)
})

test('private notes go back to off after a failed re-auth and after a success', async () => {
  const failed = await mount({ status: 200, reauthFails: true })
  await click(failed.host, 'Include private notes')
  expect(pressed(failed.host)).toBe('true')
  await click(failed.host, 'Export archive')
  expect(pressed(failed.host)).toBe('false')
  expect(failed.downloads).toHaveLength(0)

  const ok = await mount({
    status: 200,
    counts: { exported: 1, privateIncluded: 1, privateLeftOut: 0 },
  })
  await click(ok.host, 'Include private notes')
  await click(ok.host, 'Export archive')
  expect(ok.downloads).toHaveLength(1)
  expect(pressed(ok.host)).toBe('false')
})

test('the export outcome is a polite status line and is scrolled into view', async () => {
  const scrolled: string[] = []
  Reflect.set(Element.prototype, 'scrollIntoView', function (this: Element) {
    scrolled.push(this.textContent ?? '')
  })
  const w = await mount({
    status: 200,
    counts: { exported: 2, privateIncluded: 0, privateLeftOut: 0 },
  })
  await click(w.host, 'Export archive')
  const line = w.host.querySelector('[role="status"]')
  expect(line?.getAttribute('aria-live')).toBe('polite')
  expect(line?.textContent).toContain('Exported 2 notes')
  expect(scrolled.some((t) => t.includes('Exported 2 notes'))).toBe(true)
})

function noteOf(id: string, title: string, body: string, dataClass: string) {
  return {
    id,
    kind: 'text',
    version: 1,
    title,
    body,
    trust: 'fact',
    evidence: 'seen',
    dataClass,
  }
}

async function mountNotes() {
  const all = [
    noteOf('a', 'Alpha', 'See [[Beta]] and [[Ghost]].', 'internal'),
    noteOf('b', 'Beta', 'Secret plans.', 'private'),
  ]
  const realFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      const hit = all.find((n) => url.endsWith(`/notes/${n.id}`))
      if (hit) {
        const backlinks = hit.id === 'b' ? [{ id: 'a', title: 'Alpha' }] : []
        return Response.json({ note: hit, versions: [], backlinks })
      }
      return Response.json({ notes: all, next: null })
    },
    { preconnect: realFetch.preconnect }
  )
  const w = await mount({ status: 200 })
  await click(w.host, 'Search')
  return { w, restore: () => (globalThis.fetch = realFetch) }
}

const detail = (host: HTMLElement) => host.querySelector('[aria-label="Note detail"]')

test('a [[link]] to a known note opens it, and a backlink opens its note', async () => {
  const { w, restore } = await mountNotes()
  await click(w.host, 'Alpha')
  expect(detail(w.host)?.querySelector('h3')?.textContent).toContain('Alpha')
  await click(w.host, 'Beta')
  expect(detail(w.host)?.querySelector('h3')?.textContent).toContain('Beta')
  const backlink = detail(w.host)?.querySelector('[aria-label="Backlinks"] button')
  expect(backlink?.textContent).toBe('Alpha')
  await act(async () => (backlink as HTMLElement).click())
  await settle()
  expect(detail(w.host)?.querySelector('h3')?.textContent).toContain('Alpha')
  restore()
})

test('a [[link]] to a missing note stays plain text', async () => {
  const { w, restore } = await mountNotes()
  await click(w.host, 'Alpha')
  const body = detail(w.host)?.textContent ?? ''
  expect(body).toContain('Ghost')
  const buttons = [...(detail(w.host)?.querySelectorAll('button') ?? [])].map((b) => b.textContent)
  expect(buttons).toContain('Beta')
  expect(buttons).not.toContain('Ghost')
  restore()
})

test('only a private note carries the PRIVATE badge, in the list and the header', async () => {
  const { w, restore } = await mountNotes()
  const items = [...w.host.querySelectorAll('[aria-label="Notes"] li')]
  expect(items.map((li) => li.textContent?.includes('PRIVATE'))).toEqual([false, true])
  await click(w.host, 'Alpha')
  expect(detail(w.host)?.textContent).not.toContain('PRIVATE')
  await click(w.host, 'Beta')
  expect(detail(w.host)?.querySelector('h3')?.textContent).toContain('PRIVATE')
  restore()
})
