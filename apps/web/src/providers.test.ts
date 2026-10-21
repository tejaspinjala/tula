import { expect, test } from 'bun:test'
import { parseConfig } from './builder/model'
import { describePrivateDestination, providersOf, withPrivateEligible } from './providers'

const self = { hosted: false }
const hosted = { hosted: true }

test('a subscription provider on this Mac names the vendor, the subscription and the Mac', () => {
  expect(
    describePrivateDestination(
      { id: 'anthropic', auth: 'subscription', privateEligible: true },
      self
    )
  ).toBe('Private Quests will be sent to Anthropic through your Claude subscription on this Mac.')
})

test('an API key provider names the vendor and the key, and does not mention this Mac', () => {
  expect(
    describePrivateDestination({ id: 'anthropic', auth: 'api_key', privateEligible: true }, self)
  ).toBe("Private Quests will be sent to Anthropic's API with your API key.")
})

test('an unknown vendor is named by its provider id, never guessed', () => {
  expect(
    describePrivateDestination({ id: 'acme', auth: 'api_key', privateEligible: false }, self)
  ).toBe("Private Quests will be sent to acme's API with your API key.")
})

test('hosted drops a subscription provider, so nothing private goes through it', () => {
  expect(
    describePrivateDestination(
      { id: 'anthropic', auth: 'subscription', privateEligible: true },
      hosted
    )
  ).toBe(
    'A subscription provider is not available on a hosted Guildhall: no Private Quest will go through it.'
  )
})

test('hosted still discloses an API key provider', () => {
  expect(
    describePrivateDestination({ id: 'anthropic', auth: 'api_key', privateEligible: true }, hosted)
  ).toBe("Private Quests will be sent to Anthropic's API with your API key.")
})

const doc = parseConfig({
  steward: { id: 's', name: 'S' },
  halls: [],
  providers: [
    { id: 'anthropic', auth: 'api_key', privateEligible: false },
    { id: 'home', auth: 'subscription', privateEligible: true },
  ],
  sealPolicy: 'always',
})

test('providersOf reads the providers and withPrivateEligible flips only the named one', () => {
  expect(providersOf(doc).map((p) => p.privateEligible)).toEqual([false, true])
  const next = withPrivateEligible(doc, 'anthropic', true)
  expect(providersOf(next).map((p) => p.privateEligible)).toEqual([true, true])
  expect(next.sealPolicy).toBe('always')
  expect(providersOf(doc)[0]?.privateEligible).toBe(false)
})

test('a config with no providers key has none', () => {
  expect(providersOf(parseConfig({ steward: { id: 's', name: 'S' }, halls: [] }))).toEqual([])
})
