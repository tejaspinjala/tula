import { expect, test } from 'bun:test'
import { ICON_PATH, renderDesktopIcon } from './gen-desktop-icon'

test('the desktop app icon is a 1024 square PNG', async () => {
  const png = await renderDesktopIcon()
  expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([1024, 1024])
})

test('the committed icon is exactly what the generator draws', async () => {
  const png = await renderDesktopIcon()
  const committed = new Uint8Array(await Bun.file(ICON_PATH).arrayBuffer())
  expect(Buffer.from(committed).equals(Buffer.from(png))).toBe(true)
})
