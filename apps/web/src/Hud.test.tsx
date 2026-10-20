import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { Hud } = await import('./Hud')
const { mount, click, tick } = await import('./ui/pixel/testing')

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch
let waiting = 0
let treasuryUp = true

function seal(i: number) {
  return {
    id: `s${i}`,
    questId: 'q',
    requestedBy: 'm',
    kind: 'post',
    text: 't',
    evidence: 'e',
    actionHash: 'h',
    stale: false,
    status: 'requested',
    requestedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-03-02T00:00:00.000Z',
    decidedAt: null,
    decisionNote: null,
  }
}

beforeAll(() => {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/treasury') && treasuryUp) {
        return Response.json({
          mode: 'paper',
          balances: { operating: 5000, reserve: 0, profit: 0 },
          spentTodayCents: 1500,
          day: '2026-10-20',
          limits: { dailyCapCents: 5000, treasurerLimitCents: 1000 },
        })
      }
      if (url.includes('/seals')) {
        return Response.json({
          seals: Array.from({ length: waiting }, (_, i) => seal(i)),
          next: null,
        })
      }
      return Response.json({ error: 'down' }, { status: 503 })
    },
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

function hud(
  extra: { onOpenBag?: () => void; onOpenSeals?: () => void; status?: 'ok' | 'down' } = {}
) {
  return (
    <Hud
      session={session}
      guildName="Ember Guild"
      status={extra.status ?? 'ok'}
      refresh={0}
      onOpenBag={extra.onOpenBag ?? (() => {})}
      onOpenSeals={extra.onOpenSeals ?? (() => {})}
    />
  )
}

test('the plate names the guild as the page heading', async () => {
  const m = await mount(hud())
  expect(m.host.querySelector('h1')?.textContent).toBe('Ember Guild')
  await m.unmount()
})

test('the HUD shows the day and a Treasury Meter of what is left to spend today', async () => {
  const m = await mount(hud())
  await tick(20)
  expect(m.host.textContent).toContain('Day 2026-10-20')
  const meter = m.host.querySelector('meter')
  expect(meter?.getAttribute('aria-label')).toBe('Treasury left today')
  expect(meter?.getAttribute('aria-valuenow')).toBe('35')
  expect(meter?.getAttribute('aria-valuemax')).toBe('50')
  await m.unmount()
})

test('the Seal badge counts the Seals waiting and opens the Seals page', async () => {
  waiting = 3
  let opened = 0
  const m = await mount(
    hud({
      onOpenSeals: () => {
        opened += 1
      },
    })
  )
  await tick(20)
  const badge = [...m.host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === 'Seals: 3 waiting'
  )
  expect(badge?.textContent).toContain('3')
  await click(badge as HTMLElement)
  expect(opened).toBe(1)
  waiting = 0
  await m.unmount()
})

test('with no Seal waiting the badge says so', async () => {
  waiting = 0
  const m = await mount(hud())
  await tick(20)
  expect(m.host.querySelector('[aria-label="Seals: none waiting"]')).not.toBeNull()
  await m.unmount()
})

test('the Bag button opens the Bag', async () => {
  let opened = 0
  const m = await mount(
    hud({
      onOpenBag: () => {
        opened += 1
      },
    })
  )
  const bag = [...m.host.querySelectorAll('button')].find((b) => b.textContent === 'Bag (B)')
  await click(bag as HTMLElement)
  expect(opened).toBe(1)
  await m.unmount()
})

test('when the Treasury cannot be read the HUD still draws, without a meter', async () => {
  treasuryUp = false
  const m = await mount(hud())
  await tick(20)
  expect(m.host.querySelector('meter')).toBeNull()
  expect(m.host.querySelector('h1')?.textContent).toBe('Ember Guild')
  treasuryUp = true
  await m.unmount()
})

test('guildd shows as an alert only while it is down', async () => {
  const ok = await mount(hud({ status: 'ok' }))
  expect(ok.host.textContent).not.toContain('guildd: down')
  await ok.unmount()
  const down = await mount(hud({ status: 'down' }))
  expect(down.host.querySelector('[role="alert"]')?.textContent).toBe('guildd: down')
  await down.unmount()
})
