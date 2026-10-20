import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ReactNode } from 'react'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { Bag } = await import('./Bag')
const { BAG_PAGES } = await import('./router')
const { mount, press, click } = await import('./ui/pixel/testing')

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = Object.assign(async () => Response.json({ error: 'down' }, { status: 503 }), {
    preconnect: realFetch.preconnect,
  })
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

type Calls = { paths: string[]; menu: number; close: number; signOut: number; focus: number }

function bag(
  props: { visible?: boolean; page?: (typeof BAG_PAGES)[number]['id'] | null },
  c: Calls
) {
  const element: ReactNode = (
    <Bag
      session={session}
      onSession={() => {}}
      visible={props.visible ?? true}
      page={props.page ?? null}
      hallControls={<p>Hall tools body</p>}
      onOpenPath={(path) => c.paths.push(path)}
      onMenu={() => {
        c.menu += 1
      }}
      onClose={() => {
        c.close += 1
      }}
      onSignOut={() => {
        c.signOut += 1
      }}
      focusWorld={() => {
        c.focus += 1
      }}
    />
  )
  return element
}

const calls = (): Calls => ({ paths: [], menu: 0, close: 0, signOut: 0, focus: 0 })
const options = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="option"]')]

test('the Bag menu lists every page, the Hall tools and Sign out, as a modal dialog', async () => {
  const m = await mount(bag({}, calls()))
  const dialog = m.host.querySelector('dialog')
  expect(dialog?.open).toBe(true)
  expect(options(m.host).map((o) => o.textContent)).toEqual([
    'Quest Board',
    'Seals',
    'Treasury',
    'Ledger of Deeds',
    'Guild builder',
    'Workflows',
    'Guild chat',
    'Gates',
    'Settings',
    'Hall tools',
    'Sign out',
  ])
  await m.unmount()
})

test('hidden, the Bag is a closed dialog', async () => {
  const m = await mount(bag({ visible: false }, calls()))
  expect(m.host.querySelector('dialog')?.open).toBe(false)
  await m.unmount()
})

test('Enter on a row opens that page, by keyboard', async () => {
  const c = calls()
  const m = await mount(bag({}, c))
  const rows = options(m.host)
  await press(rows[0] as HTMLElement, 'ArrowDown')
  await press(options(m.host)[1] as HTMLElement, 'Enter')
  expect(c.paths).toEqual(['/seals'])
  await m.unmount()
})

test('tapping a row opens that page, by touch', async () => {
  const c = calls()
  const m = await mount(bag({}, c))
  await click(options(m.host)[2] as HTMLElement)
  expect(c.paths).toEqual(['/treasury'])
  await m.unmount()
})

test('Sign out is the last row', async () => {
  const c = calls()
  const m = await mount(bag({}, c))
  await click(options(m.host)[10] as HTMLElement)
  expect(c.signOut).toBe(1)
  await m.unmount()
})

test('Esc closes the Bag from the menu', async () => {
  const c = calls()
  const m = await mount(bag({}, c))
  await press(options(m.host)[0] as HTMLElement, 'Escape')
  expect(c.close).toBeGreaterThan(0)
  await m.unmount()
})

test.each(BAG_PAGES.map((p) => [p.id, p.label] as const))(
  'the %s page opens framed with its title',
  async (id, label) => {
    const m = await mount(bag({ page: id }, calls()))
    expect(m.host.querySelector(`#${id}-title`)?.textContent).toBe(label)
    expect(m.host.querySelector('.px-frame')).not.toBeNull()
    await m.unmount()
  }
)

test('Esc on a page closes the Bag and returns to the walk', async () => {
  const c = calls()
  const m = await mount(bag({ page: 'gates' }, c))
  const dialog = m.host.querySelector('dialog') as HTMLElement
  await press(dialog, 'Escape')
  expect(c.close).toBeGreaterThan(0)
  await m.unmount()
})

test('a page has a Back to the Bag button', async () => {
  const c = calls()
  const m = await mount(bag({ page: 'seals' }, c))
  const back = [...m.host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Back to the Bag'
  )
  await click(back as HTMLElement)
  expect(c.menu).toBe(1)
  await m.unmount()
})

test('Settings holds the Hall lighting controls', async () => {
  const m = await mount(bag({ page: 'settings' }, calls()))
  expect(m.host.textContent).toContain('Hall lighting')
  await m.unmount()
})

test('the Hall tools page shows the zoom and teleport controls', async () => {
  const c = calls()
  const m = await mount(bag({}, c))
  await click(options(m.host)[9] as HTMLElement)
  expect(m.host.textContent).toContain('Hall tools body')
  await m.unmount()
})

test('closing the Bag hands keyboard focus back to the world', async () => {
  const c = calls()
  const m = await mount(bag({ visible: true }, c))
  expect(c.focus).toBe(0)
  await m.rerender(bag({ visible: false }, c))
  expect(c.focus).toBe(1)
  await m.unmount()
})

test('opening the Bag puts the ▶ cursor on the first row, not on the Close button', async () => {
  const m = await mount(bag({ visible: false }, calls()))
  await m.rerender(bag({ visible: true }, calls()))
  expect(document.activeElement).toBe(options(m.host)[0] as HTMLElement)
  await m.unmount()
})

test('a page inside the Bag has one wood border: its sections are flat, not framed again', async () => {
  const m = await mount(bag({ page: 'treasury' }, calls()))
  const body = m.host.querySelector('.bag-body')
  expect(body?.querySelector('section.work.work-flat')).not.toBeNull()
  expect(body?.querySelector('[data-variant="paper"]')).toBeNull()
  await m.unmount()
})
