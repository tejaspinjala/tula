import { expect, test } from 'bun:test'

const css = await Bun.file(new URL('./index.css', import.meta.url).pathname).text()

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start))
}

test('a long option or label never pushes a control past a 320 px screen (200% zoom)', () => {
  expect(rule('input,\nselect,\ntextarea')).toContain('max-width: 100%')
  expect(rule('label')).toContain('max-width: 100%')
})

test('cost tables wrap inside their cells rather than scrolling where a keyboard cannot reach', () => {
  expect(css).not.toMatch(/\.table-scroll table\s*\{[^}]*min-width/)
  expect(css).not.toMatch(/\.table-scroll th\s*\{[^}]*nowrap/)
})
