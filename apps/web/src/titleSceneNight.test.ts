import { describe, expect, test } from 'bun:test'

const root = new URL('.', import.meta.url).pathname
const read = (path: string): Promise<string> => Bun.file(`${root}${path}`).text()

/** The declarations inside the first rule whose selector line matches `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('title scene night and day (#131)', () => {
  test('the hill and ground read scene tokens, never the text-oriented grass-700 that brightens at night', async () => {
    const css = await read('TitleScene.css')
    for (const sel of ['.title-hill', '.title-ground']) {
      expect(rule(css, sel)).not.toContain('--px-grass-700')
    }
  })

  test('night darkens the hill, ground and edge; stars and moon show only at night, sun only by day', async () => {
    const tokens = await read('styles/tokens.css')
    const night = rule(tokens, ':root[data-theme="night"]')
    for (const name of ['--scene-hill', '--scene-ground', '--scene-edge']) {
      expect(night).toContain(name)
    }
    const day = rule(tokens, ':root')
    expect(day).toContain('--scene-night-show: none')
    expect(day).toContain('--scene-day-show: block')
    expect(night).toContain('--scene-night-show: block')
    expect(night).toContain('--scene-day-show: none')
  })

  test('the sky is a stepped gradient of at least five bands with a sun and clouds by day', async () => {
    const css = await read('TitleScene.css')
    expect(css).toMatch(/\.title-band-5\b/)
    expect(css).toContain('.title-sun')
    expect(css).toContain('.title-cloud')
    expect(rule(css, '.title-star')).toContain('--scene-night-show')
    expect(rule(css, '.title-moon')).toContain('--scene-night-show')
    expect(rule(css, '.title-sun')).toContain('--scene-day-show')
  })
})
