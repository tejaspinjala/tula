import { expect, test } from 'bun:test'
import { assignQuest, templatesFor } from './assign'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const input = { templateId: 'herald-brief', title: 'Brief', ownerId: 'ana', jobKey: 'talk-1' }

test('assigning posts to the governed Quest route with the session token and the Member as owner', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const result = await assignQuest(
    session,
    async (url, init) => {
      calls.push({ url, init })
      return Response.json({ id: 'q9' }, { status: 201 })
    },
    input
  )
  expect(result).toEqual({ ok: true, questId: 'q9' })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe(`/api/guilds/${session.guildId}/quests`)
  expect(calls[0]?.init?.method).toBe('POST')
  expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer t1')
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    templateId: 'herald-brief',
    title: 'Brief',
    ownerId: 'ana',
    jobKey: 'talk-1',
  })
})

test('a refused post says why in words and posts nothing more', async () => {
  const refuse = (status: number, error: string) => async () => Response.json({ error }, { status })
  const locked = await assignQuest(session, refuse(422, 'hall_locked'), input)
  expect(locked).toEqual({ ok: false, message: 'That Hall is locked.' })
  const paused = await assignQuest(session, refuse(422, 'hall_paused'), input)
  expect(paused).toEqual({ ok: false, message: 'That Hall is paused.' })
  const limited = await assignQuest(session, refuse(429, 'rate_limited'), input)
  expect(limited.ok).toBe(false)
  const down = await assignQuest(
    session,
    async () => {
      throw new Error('offline')
    },
    input
  )
  expect(down).toEqual({ ok: false, message: 'The Quest could not be posted. Try again.' })
})

test('only the Heralds Hall has Quest templates today', () => {
  expect(templatesFor('heralds').map((t) => t.id)).toEqual(['herald-brief', 'herald-announcement'])
  expect(templatesFor('research')).toEqual([])
})
