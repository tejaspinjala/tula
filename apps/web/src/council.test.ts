import { expect, test } from 'bun:test'
import {
  councilCostText,
  councilOpenNow,
  councilSessionLabel,
  councilStatusLabel,
  councilVoteLabel,
  loadCouncilSessions,
  proposalPrefix,
} from './council'
import { PasskeyRequestError } from './passkeys'

const session = { token: 't1', guildId: 'g1' }
const hash = 'ab12cd34'.repeat(8)
const row = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  questId: 'q1',
  proposalHash: hash,
  day: '2026-10-20',
  status: 'escalated',
  reason: 'block',
  createdAt: '2026-10-20T10:00:00.000Z',
  sealId: 'seal1',
  questTitle: 'Announce market day',
  halted: false,
  costMicros: 42,
  votes: [{ voice: 'skeptic', vote: 'block', reasons: ['risky'], abstainCode: null }],
  ...over,
})
const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))

test('loadCouncilSessions asks for one page with the Guild Master token and parses it', async () => {
  const calls: { url: string; auth: string | null }[] = []
  const page = await loadCouncilSessions(
    session,
    (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
      return reply({ sessions: [row()], next: 's1' })
    },
    { limit: 5, after: 'prev' }
  )
  expect(calls).toEqual([
    { url: '/api/guilds/g1/council/sessions?limit=5&after=prev', auth: 'Bearer t1' },
  ])
  expect(page.next).toBe('s1')
  expect(page.sessions[0]?.votes[0]?.reasons).toEqual(['risky'])
})

test('statuses #150 adds parse, and an unknown one still parses and reads safely', async () => {
  const page = await loadCouncilSessions(
    session,
    () =>
      reply({
        sessions: [
          row({ status: 'approved' }),
          row({ status: 'halted' }),
          row({ status: 'weird' }),
        ],
        next: null,
      }),
    { limit: 5 }
  )
  expect(page.sessions.map((s) => councilStatusLabel(s.status))).toEqual([
    'Approved',
    'Halted',
    'Unknown',
  ])
  expect(councilStatusLabel('open')).toBe('Conferring')
  expect(councilStatusLabel('escalated')).toBe('Sent to the Seal desk')
})

test('a refusal or a malformed page throws', async () => {
  await expect(
    loadCouncilSessions(session, () => reply({ error: 'unauthorized' }, 401), { limit: 5 })
  ).rejects.toBeInstanceOf(PasskeyRequestError)
  await expect(
    loadCouncilSessions(session, () => reply({ sessions: [{ id: 1 }], next: null }), { limit: 5 })
  ).rejects.toThrow()
})

test('display helpers: hash prefix, cost, vote label, and whether a session is open', () => {
  expect(proposalPrefix(hash)).toBe('ab12cd34')
  expect(councilCostText(null)).toBe('not metered')
  expect(councilCostText(42)).toBe('$0.000042')
  expect(councilVoteLabel('approve')).toBe('Approve')
  expect(councilVoteLabel('block')).toBe('Block')
  expect(councilVoteLabel('abstain')).toBe('Abstain')
  expect(councilVoteLabel('<b>x</b>')).toBe('Unknown')
  expect(
    councilOpenNow([
      { status: 'escalated', halted: false },
      { status: 'open', halted: false },
    ])
  ).toBe(true)
  expect(
    councilOpenNow([
      { status: 'approved', halted: false },
      { status: 'weird', halted: false },
    ])
  ).toBe(false)
})

test('an open session halted by Bar the Gates reads as halted and does not make the elders confer', () => {
  expect(councilSessionLabel({ status: 'open', halted: true })).toBe('Halted: the Gates are barred')
  expect(councilSessionLabel({ status: 'open', halted: false })).toBe('Conferring')
  expect(councilSessionLabel({ status: 'approved', halted: false })).toBe('Approved')
  expect(councilOpenNow([{ status: 'open', halted: true }])).toBe(false)
  expect(
    councilOpenNow([
      { status: 'open', halted: true },
      { status: 'open', halted: false },
    ])
  ).toBe(true)
})

test('the Quest title and the halted flag parse from a session', async () => {
  const page = await loadCouncilSessions(
    session,
    () => reply({ sessions: [row({ halted: true, status: 'open' })], next: null }),
    { limit: 5 }
  )
  expect(page.sessions[0]).toMatchObject({ questTitle: 'Announce market day', halted: true })
})
