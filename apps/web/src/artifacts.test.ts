import { expect, test } from 'bun:test'
import { openArtifact } from './artifacts'

const guild = '11111111-1111-4111-8111-111111111111'

test('opens an artifact by hash, reading its class and decoded bytes', async () => {
  let seen: { url: string; guild: string | null } | undefined
  const fetcher = async (url: string, init?: RequestInit) => {
    seen = { url, guild: new Headers(init?.headers).get('x-guild-id') }
    return new Response('quarterly notes', { headers: { 'x-artifact-class': 'report' } })
  }

  const result = await openArtifact('abc123', { guildId: guild }, fetcher)

  expect(seen).toEqual({ url: '/api/artifacts/abc123', guild })
  expect(result).toEqual({
    kind: 'found',
    artifact: { hash: 'abc123', class: 'report', size: 15, text: 'quarterly notes' },
  })
})

test('a 404 is a clean not-found and other failures are errors', async () => {
  const reply = (status: number) => async () => new Response('', { status })
  expect(await openArtifact('x', { guildId: guild }, reply(404))).toEqual({ kind: 'not_found' })
  expect(await openArtifact('x', { guildId: guild }, reply(500))).toEqual({
    kind: 'error',
    status: 500,
  })
})

test('with a session it sends the bearer token and no dev guild header', async () => {
  let seen: Headers | undefined
  const fetcher = async (_url: string, init?: RequestInit) => {
    seen = new Headers(init?.headers)
    return new Response('x')
  }
  await openArtifact('abc', { token: 'tok-1' }, fetcher)
  expect(seen?.get('authorization')).toBe('Bearer tok-1')
  expect(seen?.get('x-guild-id')).toBeNull()
})
