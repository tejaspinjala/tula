import { afterAll, expect, test } from 'bun:test'
import { z } from 'zod'
import { foundViaApi } from './testing/found-via-api'
import { createHarness } from './testing/harness'

const harness = await createHarness({ devGuildHeader: false })
const clock = harness.adapters.clock
afterAll(() => harness.close())

const json = { 'content-type': 'application/json' }
const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const _founded = z.object({ id: z.string(), foundingToken: z.string() })
const session = z.object({ token: z.string(), guildId: z.string() })
const ticketBody = z.object({ ticket: z.string() })
const frame = z.object({
  type: z.string(),
  event: z
    .object({ type: z.string(), payload: z.object({ questId: z.string().optional() }) })
    .optional(),
})

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return harness.request(path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  })
}

async function signedIn() {
  const guild = await foundViaApi(harness, { name: 'Live', goal: 'g' })
  const key = guild.key
  const sign = ceremony.parse(await (await post(`/guilds/${guild.id}/sign-in/begin`, {})).json())
  const res = await post(`/guilds/${guild.id}/sign-in/finish`, {
    challengeId: sign.challengeId,
    response: await key.assert(sign.options),
  })
  return session.parse(await res.json())
}

const bearer = (token: string) => ({ ...json, authorization: `Bearer ${token}` })
const upgrade = { upgrade: 'websocket' }

async function ticketFor(guildId: string, token: string) {
  const res = await harness.request(`/guilds/${guildId}/events/ticket`, {
    method: 'POST',
    headers: bearer(token),
  })
  expect(res.status).toBe(200)
  return ticketBody.parse(await res.json()).ticket
}

test('a browser follows Quest events on the stream with a ticket, not its session token', async () => {
  const { token, guildId } = await signedIn()
  const base = harness.listen()
  const ticket = await ticketFor(guildId, token)
  const frames: Array<z.infer<typeof frame>> = []
  const ws = new WebSocket(`${base}/guilds/${guildId}/events?ticket=${ticket}`)
  const seen = new Promise<void>((resolve, reject) => {
    ws.onmessage = (m) => {
      frames.push(frame.parse(JSON.parse(String(m.data))))
      if (frames.some((f) => f.event?.type === 'quest.posted')) {
        resolve()
      }
    }
    ws.onerror = () => reject(new Error('socket error'))
  })
  const posted = await harness.request(`/guilds/${guildId}/quests`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ templateId: 'herald-brief', jobKey: 'live-1', title: 'Live' }),
  })
  expect(posted.status).toBe(201)
  await seen
  ws.close()
  const questId = z.object({ id: z.string() }).parse(await posted.json()).id
  expect(frames.find((f) => f.event?.type === 'quest.posted')?.event?.payload.questId).toBe(questId)
})

test('the session token in the query is refused; so is a ticket on a plain GET', async () => {
  const { token, guildId } = await signedIn()
  const url = `/guilds/${guildId}/events`
  expect((await harness.request(`${url}?access_token=${token}`, { headers: upgrade })).status).toBe(
    401
  )
  const ticket = await ticketFor(guildId, token)
  expect((await harness.request(`${url}?ticket=${ticket}`)).status).toBe(401)
  // The refused plain GET did not spend the ticket.
  expect(await harness.adapters.streamTickets.consume(guildId, ticket)).toBe(true)
})

test('a ticket works once; a second use is 401', async () => {
  const { token, guildId } = await signedIn()
  const ticket = await ticketFor(guildId, token)
  const url = `/guilds/${guildId}/events?ticket=${ticket}`
  expect((await harness.request(url, { headers: upgrade })).status).not.toBe(401)
  expect((await harness.request(url, { headers: upgrade })).status).toBe(401)
})

test('a ticket lapses after 30 seconds', async () => {
  const { token, guildId } = await signedIn()
  const ticket = await ticketFor(guildId, token)
  clock.advance(30_001)
  const res = await harness.request(`/guilds/${guildId}/events?ticket=${ticket}`, {
    headers: upgrade,
  })
  expect(res.status).toBe(401)
})

test('a ticket for one guild is refused for another, and issuing needs that guild`s session', async () => {
  const a = await signedIn()
  const b = await signedIn()
  const ticket = await ticketFor(a.guildId, a.token)
  const res = await harness.request(`/guilds/${b.guildId}/events?ticket=${ticket}`, {
    headers: upgrade,
  })
  expect(res.status).toBe(401)
  const cross = await harness.request(`/guilds/${b.guildId}/events/ticket`, {
    method: 'POST',
    headers: bearer(a.token),
  })
  expect(cross.status).toBe(404)
  const anon = await harness.request(`/guilds/${a.guildId}/events/ticket`, { method: 'POST' })
  expect(anon.status).toBe(401)
})
