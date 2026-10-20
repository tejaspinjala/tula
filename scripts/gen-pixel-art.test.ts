import { expect, test } from 'bun:test'
import { ART_DIR, renderArt } from './gen-pixel-art'

function size(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

test('it draws the wood frame as a 24 by 24 PNG and the walker as a four-frame 16 high sheet', async () => {
  const art = await renderArt()
  const frame = art.get('wood-frame.png')
  const walker = art.get('walker.png')
  expect(frame && size(frame)).toEqual({ width: 24, height: 24 })
  expect(walker && size(walker)).toEqual({ width: 64, height: 16 })
  for (const png of art.values()) {
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  }
})

test('the committed art is exactly what the generator draws', async () => {
  const art = await renderArt()
  expect(art.size).toBeGreaterThan(0)
  for (const [name, png] of art) {
    const committed = new Uint8Array(await Bun.file(`${ART_DIR}/${name}`).arrayBuffer())
    expect(Buffer.from(committed).equals(Buffer.from(png))).toBe(true)
  }
})

test('it draws the title Hall silhouette as a 96 by 64 PNG', async () => {
  const art = await renderArt()
  const hall = art.get('title-hall.png')
  expect(hall && size(hall)).toEqual({ width: 96, height: 64 })
})
