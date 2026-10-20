import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

const SEAL = '22222222-2222-4222-8222-222222222222'
const GUILD = '11111111-1111-4111-8111-111111111111'

type Listener = (event: unknown) => void

interface Shown {
  title: string
  options: { body?: string; tag?: string; data?: unknown }
}

/** Runs public/sw.js against a fake service worker scope and returns what it did. */
async function load() {
  const listeners = new Map<string, Listener>()
  const shown: Shown[] = []
  const opened: string[] = []
  const navigated: string[] = []
  const focused: string[] = []
  let windows: Array<{
    url: string
    focus: () => Promise<void>
    navigate: (u: string) => Promise<void>
  }> = []
  const self = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    registration: {
      showNotification: async (title: string, options: Shown['options']) => {
        shown.push({ title, options })
      },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url)
      },
    },
    location: { origin: 'https://guild.example' },
    skipWaiting: () => undefined,
  }
  const source = await Bun.file(new URL('../public/sw.js', import.meta.url)).text()
  runInNewContext(source, { self, caches: {}, URL, fetch, Promise })
  const settle = async (event: unknown, type: string) => {
    let pending: Promise<unknown> = Promise.resolve()
    listeners.get(type)?.({
      ...(typeof event === 'object' ? event : {}),
      waitUntil: (p: Promise<unknown>) => {
        pending = p
      },
    })
    await pending
  }
  return {
    shown,
    opened,
    navigated,
    focused,
    showWindow(url: string) {
      windows = [
        {
          url,
          focus: async () => {
            focused.push(url)
          },
          navigate: async (u) => {
            navigated.push(u)
          },
        },
      ]
    },
    push: (payload: unknown) => settle({ data: { json: () => payload } }, 'push'),
    click: (data: unknown) => {
      let closed = false
      return settle(
        {
          notification: {
            data,
            close: () => {
              closed = true
            },
          },
        },
        'notificationclick'
      ).then(() => closed)
    },
  }
}

test('a push shows a notification built from ids only, never Seal text', async () => {
  const sw = await load()
  await sw.push({ sealId: SEAL, guildId: GUILD, text: 'secret text that must not be shown' })
  expect(sw.shown).toHaveLength(1)
  const [note] = sw.shown
  expect(note?.options.tag).toBe(SEAL)
  expect(note?.options.data).toEqual({ sealId: SEAL, guildId: GUILD })
  expect(JSON.stringify(note)).not.toContain('secret text')
})

test('a push that is not a Seal id payload shows nothing', async () => {
  const sw = await load()
  await sw.push({ sealId: 'not-a-uuid', guildId: GUILD })
  await sw.push(null)
  expect(sw.shown).toEqual([])
})

test('tapping the notification opens the matching Seal in the ledger view', async () => {
  const sw = await load()
  const closed = await sw.click({ sealId: SEAL, guildId: GUILD })
  expect(closed).toBe(true)
  expect(sw.opened).toEqual([`/?seal=${SEAL}#seals-heading`])
})

test('tapping with the ledger already open navigates and focuses that window', async () => {
  const sw = await load()
  sw.showWindow('https://guild.example/')
  await sw.click({ sealId: SEAL, guildId: GUILD })
  expect(sw.navigated).toEqual([`/?seal=${SEAL}#seals-heading`])
  expect(sw.focused).toEqual(['https://guild.example/'])
  expect(sw.opened).toEqual([])
})

test('a notification with tampered data opens the ledger without a Seal', async () => {
  const sw = await load()
  await sw.click({ sealId: '"><script>', guildId: GUILD })
  expect(sw.opened).toEqual(['/'])
})
