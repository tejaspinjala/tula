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

type Reply = { status: number; error?: string; counts?: unknown }

async function mount(reply: Reply) {
  const host = document.createElement('div')
  document.body.append(host)
  const world = {
    host,
    urls: [] as string[],
    proofs: [] as Array<string | null>,
    downloads: [] as Array<{ filename: string; size: number }>,
  }
  const fetcher = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/session/reauth/begin')) {
      return Response.json({ challengeId: 'c1', options: { challenge: 'x' } })
    }
    if (url.endsWith('/session/reauth/finish')) {
      return Response.json({ proof: 'proof-1' })
    }
    if (url.includes('/archive/export')) {
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
