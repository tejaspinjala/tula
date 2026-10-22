import { expect, test } from 'bun:test'
import { Retained } from './retained'

function harness() {
  const created: string[] = []
  const destroyed: string[] = []
  const store = new Retained<string>((o) => {
    destroyed.push(o)
  })
  const pass = (groups: Record<string, string>) => {
    store.begin()
    for (const [key, sig] of Object.entries(groups)) {
      store.group(key, sig, () => {
        const o = `${key}:${sig}`
        created.push(o)
        return [o]
      })
    }
    store.end()
  }
  return { created, destroyed, pass }
}

test('changing one group creates and destroys no other display object', () => {
  const h = harness()
  h.pass({ a: '1', b: '1', c: '1' })
  h.created.length = 0
  h.pass({ a: '1', b: '2', c: '1' })
  expect(h.created).toEqual(['b:2'])
  expect(h.destroyed).toEqual(['b:1'])
})

test('an unchanged pass creates and destroys nothing; a dropped group is destroyed', () => {
  const h = harness()
  h.pass({ a: '1', b: '1' })
  h.created.length = 0
  h.pass({ a: '1', b: '1' })
  expect(h.created).toEqual([])
  expect(h.destroyed).toEqual([])
  h.pass({ a: '1' })
  expect(h.destroyed).toEqual(['b:1'])
})
