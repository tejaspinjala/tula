import { expect, test } from 'bun:test'
import { PasskeyRequestError } from './passkeys'
import { listProposals } from './proposals'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const hash = 'a'.repeat(64)
const proposal = {
  id: '22222222-2222-4222-8222-222222222222',
  questId: '33333333-3333-4333-8333-333333333333',
  author: 'herald-1',
  kind: 'post',
  content: 'Hello guild',
  hash,
  createdAt: '2026-01-01T00:00:00.000Z',
  verdict: {
    proposalHash: hash,
    passed: false,
    findings: [
      { check: 'private_data', passed: false, detail: 'private-data marker: email address' },
    ],
    checkedAt: '2026-01-01T00:00:00.000Z',
  },
}

test('lists Proposals with their Verdict findings, sending the session token', async () => {
  const seen: Array<{ url: string; auth: string | null }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
    return Response.json({ proposals: [proposal], next: null })
  }
  const page = await listProposals(session, fetcher, 10)
  expect(seen).toEqual([{ url: `/api/guilds/${guild}/proposals?limit=10`, auth: 'Bearer t1' }])
  expect(page.proposals[0]?.verdict.findings[0]?.detail).toContain('email')
})

test('a refused request surfaces the server error code', async () => {
  const fetcher = async () => Response.json({ error: 'unauthenticated' }, { status: 401 })
  const error = await listProposals(session, fetcher).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PasskeyRequestError)
})
