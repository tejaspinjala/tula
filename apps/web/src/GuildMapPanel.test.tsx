import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import axe from 'axe-core'
import type { GuildMap } from './game/guildmap'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { GuildMapPanel } = await import('./GuildMapPanel')
const { mount, press, click, focus } = await import('./ui/pixel/testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const room = (
  id: GuildMap['rooms'][number]['id'],
  name: string,
  extra: Partial<GuildMap['rooms'][number]> = {}
): GuildMap['rooms'][number] => ({
  id,
  hallId: id.startsWith('hall:') ? id.slice(5) : null,
  name,
  kind: id === 'hall' ? 'great' : id.startsWith('hall:') ? 'work' : 'town',
  locked: false,
  private: false,
  memberCount: 0,
  bounds: { x: 0, y: 0, w: 10, h: 8 },
  links:
    id === 'hall'
      ? ['hall:w', 'hall:p', 'hall:l', 'plaza']
      : id === 'plaza'
        ? ['hall', 'archive', 'counting-house', 'trail']
        : id.startsWith('hall:')
          ? ['hall']
          : ['plaza'],
  ...extra,
})
const map: GuildMap = {
  current: 'hall',
  marks: [],
  rooms: [
    room('hall', 'Great Hall'),
    room('hall:w', 'Works', { memberCount: 3 }),
    room('hall:p', 'Health', { kind: 'private', private: true, memberCount: 1 }),
    room('hall:l', 'Vault', { locked: true, memberCount: 1 }),
    room('plaza', 'Plaza'),
    room('archive', 'Archive'),
    room('counting-house', 'Counting House'),
    room('trail', 'Trail'),
  ],
}

const nodes = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-room]')]
const ids = (host: HTMLElement) => nodes(host).map((n) => n.dataset.room)

test('the schematic labels every room with its name, badges and Member count', async () => {
  const m = await mount(<GuildMapPanel map={map} onTravel={() => {}} />)
  const text = Object.fromEntries(nodes(m.host).map((n) => [n.dataset.room, n.textContent]))
  expect(Object.keys(text)).toEqual([
    'hall',
    'hall:w',
    'hall:p',
    'hall:l',
    'plaza',
    'archive',
    'counting-house',
    'trail',
  ])
  expect(text['hall:w']).toContain('Works')
  expect(text['hall:w']).toContain('3 Members')
  expect(text['hall:p']).toContain('Private')
  expect(text['hall:p']).toContain('1 Member')
  expect(text['hall:l']).toContain('Locked')
  expect(text.archive).toContain('Archive')
  expect(text.archive).not.toContain('Member')
  await m.unmount()
})

test('arrow keys move the cursor between rooms, one room in the Tab order', async () => {
  const m = await mount(<GuildMapPanel map={map} onTravel={() => {}} />)
  const at = () => nodes(m.host).find((n) => n.tabIndex === 0)?.dataset.room
  expect(at()).toBe('hall')
  const node = (id: string) => nodes(m.host).find((n) => n.dataset.room === id) as HTMLElement
  await focus(node('hall'))
  await press(node('hall'), 'ArrowDown')
  expect(at()).toBe('hall:p')
  expect(document.activeElement).toBe(node('hall:p'))
  await press(node('hall:p'), 'ArrowRight')
  expect(at()).toBe('hall:l')
  await press(node('hall:l'), 'ArrowLeft')
  await press(node('hall:p'), 'ArrowLeft')
  expect(at()).toBe('hall:w')
  await m.unmount()
})

test('Enter travels to the room under the cursor; a locked room does not', async () => {
  const travelled: string[] = []
  const m = await mount(<GuildMapPanel map={map} onTravel={(id) => travelled.push(id)} />)
  const node = (id: string) => nodes(m.host).find((n) => n.dataset.room === id) as HTMLElement
  await press(node('hall'), 'ArrowDown')
  await press(node('hall:p'), 'Enter')
  expect(travelled).toEqual(['hall:p'])
  await click(node('hall:l'))
  expect(travelled).toEqual(['hall:p'])
  expect(m.host.textContent).toContain('Vault is locked')
  await m.unmount()
})

test('the list view holds the same rooms, labels and travel as the schematic', async () => {
  const travelled: string[] = []
  const m = await mount(<GuildMapPanel map={map} onTravel={(id) => travelled.push(id)} />)
  const schematic = nodes(m.host).map((n) => [n.dataset.room, n.textContent])
  const toggle = [...m.host.querySelectorAll('button')].find((b) =>
    /list view/i.test(b.textContent ?? '')
  )
  expect(toggle).toBeDefined()
  await click(toggle as Element)
  expect(m.host.querySelector('ul')).not.toBeNull()
  expect(nodes(m.host).map((n) => [n.dataset.room, n.textContent])).toEqual(schematic)
  await click(nodes(m.host)[1] as HTMLElement)
  expect(travelled).toEqual(['hall:w'])
  await m.unmount()
})

test('says so when the Guild Map has not loaded', async () => {
  const m = await mount(<GuildMapPanel map={null} onTravel={() => {}} />)
  expect(nodes(m.host)).toEqual([])
  expect(m.host.textContent).toContain('not drawn yet')
  await m.unmount()
})

test('axe finds no violations in either view', async () => {
  const m = await mount(<GuildMapPanel map={map} onTravel={() => {}} />)
  const check = async () => (await axe.run(m.host)).violations.map((v) => v.id)
  expect(await check()).toEqual([])
  const toggle = [...m.host.querySelectorAll('button')].find((b) =>
    /list view/i.test(b.textContent ?? '')
  )
  await click(toggle as Element)
  expect(await check()).toEqual([])
  expect(ids(m.host).length).toBe(8)
  await m.unmount()
})

test('arrow keys and Enter travel to each town map', async () => {
  const travelled: string[] = []
  const m = await mount(<GuildMapPanel map={map} onTravel={(id) => travelled.push(id)} />)
  const node = (id: string) => nodes(m.host).find((n) => n.dataset.room === id) as HTMLElement
  await focus(node('hall'))
  await press(node('hall'), 'ArrowRight')
  await press(node('plaza'), 'Enter')
  await press(node('plaza'), 'ArrowDown')
  await press(node('archive'), 'Enter')
  await press(node('archive'), 'ArrowDown')
  await press(node('counting-house'), 'Enter')
  await press(node('counting-house'), 'ArrowDown')
  await press(node('trail'), 'Enter')
  expect(travelled).toEqual(['plaza', 'archive', 'counting-house', 'trail'])
  await m.unmount()
})
