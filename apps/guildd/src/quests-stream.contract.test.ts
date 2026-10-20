import { afterAll, expect, test } from 'bun:test'
import { z } from 'zod'
import { createHarness } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())

const json = { 'content-type': 'application/json' }
const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const founded = z.object({ id: z.string(), foundingToken: z.string() })
const session = z.object({ token: z.string(), guildId: z.string() })
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
  const guild = founded.parse(await (await post('/guilds', { name: 'Live', goal: 'g' })).json())
  const key = await SoftwareAuthenticator.create('localhost', 'http://localhost:5173')
  const begin = ceremony.parse(
    await (
      await post(
        `/guilds/${guild.id}/passkeys/begin`,
        {},
        { 'x-founding-token': guild.foundingToken }
      )
    ).json()
  )
  await post(`/guilds/${guild.id}/passkeys/finish`, {
    challengeId: begin.challengeId,
    response: await key.register(begin.options),
  })
  const sign = ceremony.parse(await (await post(`/guilds/${guild.id}/sign-in/begin`, {})).json())
  const res = await post(`/guilds/${guild.id}/sign-in/finish`, {
    challengeId: sign.challengeId,
    response: await key.assert(sign.options),
  })
  return session.parse(await res.json())
}

test('a browser can follow Quest events on the stream with its session token in the query', async () => {
  const { token, guildId } = await signedIn()
  const base = harness.listen()
  const frames: Array<z.infer<typeof frame>> = []
  const ws = new WebSocket(`${base}/guilds/${guildId}/events?access_token=${token}`)
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
    headers: { ...json, authorization: `Bearer ${token}` },
    body: JSON.stringify({ templateId: 'herald-brief', jobKey: 'live-1', title: 'Live' }),
  })
  expect(posted.status).toBe(201)
  await seen
  ws.close()
  const questId = z.object({ id: z.string() }).parse(await posted.json()).id
  expect(frames.find((f) => f.event?.type === 'quest.posted')?.event?.payload.questId).toBe(questId)
  const refused = await harness.request(`/guilds/${guildId}/events?access_token=nope`)
  expect(refused.status).toBe(401)
})
