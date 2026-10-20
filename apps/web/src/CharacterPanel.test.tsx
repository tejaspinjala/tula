import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { LookChoice } from './game/look'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const saved: LookChoice = { body: 1, outfitStyle: 2, outfitColor: 3, hairStyle: 1, hairColor: 4 }

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { CharacterPanel } = await import('./CharacterPanel')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function mount(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const previews: LookChoice[] = []
  const savedLooks: LookChoice[] = []
  let cancelled = 0
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  await act(async () => {
    createRoot(host).render(
      <CharacterPanel
        session={session}
        fetcher={fetcher}
        saved={saved}
        onPreview={(look) => previews.push(look)}
        onSaved={(look) => savedLooks.push(look)}
        onCancel={() => {
          cancelled += 1
        }}
      />
    )
  })
  return { host, previews, savedLooks, cancelled: () => cancelled }
}

async function choose(host: HTMLElement, label: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  if (!select) {
    throw new Error(`no select "${label}"`)
  }
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function press(host: HTMLElement, name: string) {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
  if (!found) {
    throw new Error(`no button "${name}"`)
  }
  await act(async () => {
    found.click()
    await new Promise((r) => setTimeout(r, 10))
  })
}

test('the screen starts from the saved look, previews each change live and saves the draft', async () => {
  const puts: unknown[] = []
  const w = await mount(async (_url, init) => {
    puts.push(JSON.parse(String(init?.body)))
    return Response.json({ look: { ...saved, hairStyle: 0 } })
  })
  expect(w.host.querySelector<HTMLSelectElement>('select[aria-label="Hair style"]')?.value).toBe(
    '1'
  )
  expect(w.host.querySelector('[data-testid="look-preview"]')).not.toBeNull()
  await choose(w.host, 'Hair style', '0')
  expect(w.previews.at(-1)).toEqual({ ...saved, hairStyle: 0 })
  await press(w.host, 'Save character')
  expect(puts).toEqual([{ look: { ...saved, hairStyle: 0 } }])
  expect(w.savedLooks).toEqual([{ ...saved, hairStyle: 0 }])
})

test('a refused save is shown and nothing is reported as saved', async () => {
  const w = await mount(async () => Response.json({ error: 'invalid_look' }, { status: 400 }))
  await press(w.host, 'Save character')
  expect(w.host.querySelector('[role="alert"]')).not.toBeNull()
  expect(w.savedLooks).toEqual([])
})

test('cancel reverts the hall to the saved look and closes', async () => {
  const w = await mount(async () => Response.json({ look: saved }))
  await choose(w.host, 'Skin tone', '0')
  await press(w.host, 'Cancel')
  expect(w.previews.at(-1)).toEqual(saved)
  expect(w.cancelled()).toBe(1)
})
