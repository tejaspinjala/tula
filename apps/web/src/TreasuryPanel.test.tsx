import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { TreasuryPanel } = await import('./TreasuryPanel')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/entries')) {
        return Response.json({
          items: [{ seq: 1, kind: 'deposit', bucket: 'operating', amountCents: 5000 }],
          next: null,
        })
      }
      if (url.endsWith('/verify')) {
        return Response.json({ intact: true, entries: 1 })
      }
      return Response.json({
        mode: 'paper',
        balances: { operating: 4000, reserve: 1000, profit: 0 },
        spentTodayCents: 1507,
        day: '2026-03-01',
        limits: { dailyCapCents: 2000, treasurerLimitCents: 500 },
      })
    },
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

test('the Treasury shows the daily cap as a Meter in cents, beside the balances', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<TreasuryPanel session={session} />)
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const meter = host.querySelector('meter')
  expect(meter?.getAttribute('aria-valuenow')).toBe('493')
  expect(meter?.getAttribute('aria-valuemax')).toBe('2000')
  expect(meter?.getAttribute('aria-valuetext')).toBe('$4.93 of $20.00')
  expect(host.querySelector('.px-meter-number')?.textContent).toBe('$4.93/$20.00')
  expect(host.textContent).toContain('$40.00')
  expect(host.textContent).toContain('Ledger chain verified: 1 entries.')
  expect(host.querySelector('.card')).toBeNull()
  await act(async () => root.unmount())
})
