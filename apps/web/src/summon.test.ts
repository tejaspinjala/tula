import { expect, test } from 'bun:test'
import { PasskeyRequestError } from './passkeys'
import { describeSummon, loadSummon, type SummonStatus, startSummon } from './summon'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const idle: SummonStatus = {
  complete: false,
  steps: [
    { id: 'provider', done: true },
    { id: 'test_quest', done: false },
  ],
  quest: null,
}

function fakes(reply: { status?: number; body: unknown }) {
  const seen: Array<{ url: string; method: string; headers: Headers; body: unknown }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return Response.json(reply.body, { status: reply.status ?? 200 })
  }
  return { seen, fetcher }
}

test('the summon status is read with the session token', async () => {
  const { seen, fetcher } = fakes({ body: idle })
  expect(await loadSummon(session, fetcher)).toEqual(idle)
  expect(seen[0]?.url).toBe(`/api/guilds/${guild}/summon`)
  expect(seen[0]?.headers.get('authorization')).toBe('Bearer t1')
})

test('summoning posts the chosen profile and returns the new status', async () => {
  const { seen, fetcher } = fakes({
    status: 202,
    body: { ...idle, quest: { id: 'q1', state: 'active' } },
  })
  const status = await startSummon(session, 'cloud-mid', fetcher)
  expect(status.quest?.state).toBe('active')
  expect(seen[0]?.method).toBe('POST')
  expect(seen[0]?.body).toEqual({ profileId: 'cloud-mid' })
})

test('a refusal carries its code, such as the unsupported subscription path', async () => {
  const { fetcher } = fakes({
    status: 422,
    body: { error: 'subscription_unsupported_until_spike_15' },
  })
  const failure = await startSummon(session, 'max', fetcher).catch((e: unknown) => e)
  expect(failure).toBeInstanceOf(PasskeyRequestError)
  expect(failure instanceof PasskeyRequestError && failure.code).toBe(
    'subscription_unsupported_until_spike_15'
  )
})

test('the check reads incomplete until the test Quest has passed', () => {
  expect(describeSummon(idle)).toBe('Not summoned yet: the test Quest has not passed.')
  expect(describeSummon({ ...idle, quest: { id: 'q1', state: 'active' } })).toBe(
    'The test Quest is running on the worker.'
  )
  expect(
    describeSummon({
      complete: true,
      steps: [
        { id: 'provider', done: true },
        { id: 'test_quest', done: true },
      ],
      quest: { id: 'q1', state: 'done' },
    })
  ).toBe('Your first member is summoned: the test Quest passed on the worker.')
})
