import { expect, test } from 'bun:test'

// A screen reader would read a CSS-drawn ▶ cursor into the row's name ("▶ Guild Map"). The glyph is
// decoration, so its `content` carries an empty alternative text: `content: "▶" / ""`.
const sheets = ['./pixel.css', '../../guildmap.css']

test('every ▶ cursor drawn in CSS has an empty alternative text, so it is not part of a name', async () => {
  for (const sheet of sheets) {
    const css = await Bun.file(new URL(sheet, import.meta.url)).text()
    const cursors = [...css.matchAll(/content:\s*"▶"[^;]*;/g)].map((m) => m[0])
    expect(cursors.length).toBeGreaterThan(0)
    for (const declaration of cursors) {
      expect(declaration).toMatch(/content:\s*"▶"\s*\/\s*"";/)
    }
  }
})
