import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { useRoomAnnouncement } = await import('./announcement')
const { mount } = await import('../ui/pixel/testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function Probe(props: { room: string; ready: boolean; text: string }) {
  const spoken = useRoomAnnouncement(props.room, props.ready, props.text)
  return <p data-testid="spoken">{spoken}</p>
}
const said = (host: HTMLElement) => host.querySelector('[data-testid="spoken"]')?.textContent

test('a room change is spoken once, when the map has caught up, not with the old room summary', async () => {
  const seen: Array<string | null | undefined> = []
  const m = await mount(<Probe room="hall" ready text="Great Hall. Doors lead to Heralds." />)
  seen.push(said(m.host))
  // Entering the Heralds Hall: the room changed, the map still describes the Great Hall.
  await m.rerender(
    <Probe room="hall:heralds" ready={false} text="Heralds Hall. Great Hall summary." />
  )
  seen.push(said(m.host))
  await m.rerender(
    <Probe room="hall:heralds" ready text="Heralds Hall. Doors lead to Great Hall." />
  )
  seen.push(said(m.host))
  expect(seen).toEqual([
    'Great Hall. Doors lead to Heralds.',
    'Great Hall. Doors lead to Heralds.',
    'Heralds Hall. Doors lead to Great Hall.',
  ])
  await m.unmount()
})

test('a count that changes inside the same room does not repeat the room announcement', async () => {
  const m = await mount(<Probe room="hall" ready text="Great Hall. 3 unread." />)
  await m.rerender(<Probe room="hall" ready text="Great Hall. 4 unread." />)
  expect(said(m.host)).toBe('Great Hall. 3 unread.')
  await m.unmount()
})
