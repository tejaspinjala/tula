import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { SummonPanel } = await import('./SummonPanel')

const steps = (done: boolean) => [
  { id: 'provider', done: true },
  { id: 'test_quest', done },
]
let summonGets = 0
let started = false

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/summon') && init?.method === 'POST') {
        started = true
        return Response.json({
          complete: false,
          steps: steps(false),
          quest: { id: 'q', state: 'queued' },
        })
      }
      if (url.endsWith('/summon')) {
        summonGets += 1
        return started && summonGets > 2
          ? Response.json({ complete: true, steps: steps(true), quest: { id: 'q', state: 'done' } })
          : Response.json({
              complete: false,
              steps: steps(false),
              quest: started ? { id: 'q', state: 'active' } : null,
            })
      }
      if (url.endsWith('/config')) {
        return Response.json({
          version: 1,
          config: {
            routingProfiles: [
              { id: 'sub-mid', provider: 'claude-subscription', tier: 'mid' },
              { id: 'api-cheap', provider: 'anthropic', tier: 'cheap' },
            ],
          },
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

function field(host: HTMLElement): HTMLInputElement | HTMLSelectElement {
  const found = host.querySelector<HTMLInputElement | HTMLSelectElement>(
    'label input, label select'
  )
  if (!found) {
    throw new Error('no routing profile field')
  }
  return found
}

async function mount(pollMs: number) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<SummonPanel session={session} pollMs={pollMs} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return { host, root }
}

test('summoning refreshes the panel to complete without navigating away', async () => {
  const { host, root } = await mount(10)
  const control = field(host)
  await act(async () => {
    if (control instanceof HTMLSelectElement) {
      control.value = 'sub-mid'
      control.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        control,
        'sub-mid'
      )
      control.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  const submit = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Summon with')
  )
  await act(async () => {
    submit?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
  expect(host.textContent).toContain('Your first member is summoned')
  await act(async () => root.unmount())
})
