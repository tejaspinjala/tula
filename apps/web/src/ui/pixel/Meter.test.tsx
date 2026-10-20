import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { Meter } = await import('./Meter')
const { mount } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function show(value: number, max: number) {
  const m = await mount(<Meter label="Treasury" value={value} max={max} />)
  const meter = m.host.querySelector('meter')
  if (!meter) {
    throw new Error('no meter')
  }
  return { m, meter }
}

test('it is a meter with aria values and a name, and shows the number', async () => {
  const { m, meter } = await show(37, 52)
  expect(meter.getAttribute('aria-valuenow')).toBe('37')
  expect(meter.getAttribute('aria-valuemin')).toBe('0')
  expect(meter.getAttribute('aria-valuemax')).toBe('52')
  expect(meter.getAttribute('aria-label')).toBe('Treasury')
  expect(m.host.textContent).toContain('37/52')
  expect(m.host.textContent).toContain('Treasury')
  await m.unmount()
})

test('the fill level is grass above half, warn from 20 to 50 percent, danger below 20 percent', async () => {
  const levels: string[] = []
  for (const [value, max] of [
    [37, 52],
    [20, 52],
    [10, 52],
    [0, 52],
  ] as const) {
    const { m } = await show(value, max)
    levels.push(m.host.querySelector('.px-meter')?.getAttribute('data-level') ?? '')
    await m.unmount()
  }
  expect(levels).toEqual(['ok', 'warn', 'danger', 'danger'])
})

test('a value outside the range is clamped for the aria values and the fill', async () => {
  const { m, meter } = await show(80, 52)
  expect(meter.getAttribute('aria-valuenow')).toBe('52')
  await m.unmount()
  const low = await show(-3, 52)
  expect(low.meter.getAttribute('aria-valuenow')).toBe('0')
  await low.m.unmount()
})

test('the fill is sized through a custom property, through the CSSOM so the CSP needs no inline styles', async () => {
  const { m } = await show(26, 52)
  const fill = m.host.querySelector<HTMLElement>('.px-meter-fill')
  expect(fill?.style.getPropertyValue('--fill')).toBe('50')
  await m.unmount()
})

test('the track keeps a minimum width and the number its full width, so $9.93/$10.00 is never squeezed or clipped', async () => {
  const css = await Bun.file(new URL('./pixel.css', import.meta.url).pathname).text()
  const rule = css.match(/\.px-meter \{([^}]*)\}/)?.[1] ?? ''
  const columns = rule.match(/grid-template-columns:\s*([^;]+);/)?.[1] ?? ''
  expect(columns).toMatch(/^auto minmax\(calc\(var\(--px\) \* \d+\), 1fr\) max-content$/)
})
