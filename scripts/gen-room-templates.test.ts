import { expect, test } from 'bun:test'
import {
  buildRoomTemplates,
  ROOM_STYLES,
  ROOM_TEMPLATES_PATH,
  renderRoomTemplates,
} from './gen-room-templates'

test('the committed room templates are what the generator writes', async () => {
  expect(await Bun.file(ROOM_TEMPLATES_PATH).text()).toBe(renderRoomTemplates())
})

test('there is a template per style and size, plus the Great Hall', () => {
  const names = Object.keys(buildRoomTemplates()).sort()
  const sizes = ['S', 'M', 'L'] as const
  const expected = ['great-hall', ...ROOM_STYLES.flatMap((s) => sizes.map((z) => `${s}-${z}`))]
  expect(names).toEqual(expected.sort())
})

test('the web room styles and the guildd roomStyle enum match the generator', async () => {
  const web = await import('../apps/web/src/game/room')
  const guildd = await import('../apps/guildd/src/guild-config')
  expect([...web.ROOM_STYLES]).toEqual([...ROOM_STYLES])
  expect([...guildd.ROOM_STYLES]).toEqual([...ROOM_STYLES])
})
