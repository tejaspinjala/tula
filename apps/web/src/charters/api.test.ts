import { expect, test } from 'bun:test'
import { CharterRefused, exportCharter, importCharter } from './api'
import { sampleCharter } from './fixtures'

const session = { token: 't1', guildId: 'g1' }

test('export reads the Charter from the guild route and parses it', async () => {
  const seen: string[] = []
  const charter = await exportCharter(session, async (url, init) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`)
    return Response.json(sampleCharter)
  })
  expect(seen).toEqual(['GET /api/guilds/g1/charter'])
  expect(charter.rites).toHaveLength(1)
})

test('export refuses a response that is not a Charter', async () => {
  await expect(exportCharter(session, async () => Response.json({ charter: 3 }))).rejects.toThrow()
})

test('import posts the charter, base version and import id, and parses the result', async () => {
  let body: unknown = null
  const result = await importCharter(
    session,
    { charter: sampleCharter, baseVersion: 4, importId: 'i-1' },
    async (url, init) => {
      expect(url).toBe('/api/guilds/g1/charter/import')
      expect(init?.method).toBe('POST')
      body = JSON.parse(String(init?.body))
      return Response.json({ config: { outcome: 'pending', version: 5 }, riteIds: ['r1'] })
    }
  )
  expect(result).toEqual({ config: { outcome: 'pending', version: 5 }, riteIds: ['r1'] })
  expect(body).toMatchObject({ baseVersion: 4, importId: 'i-1' })
})

test('import maps a refusal to its status and code', async () => {
  const refuse = (status: number, error: string) =>
    importCharter(session, { charter: sampleCharter, baseVersion: 1, importId: 'i' }, async () =>
      Response.json({ error }, { status })
    ).catch((e: unknown) => e)
  const stale = await refuse(409, 'stale')
  expect(stale).toBeInstanceOf(CharterRefused)
  expect(stale).toMatchObject({ status: 409, code: 'stale' })
  expect(await refuse(422, 'invalid_charter')).toMatchObject({
    status: 422,
    code: 'invalid_charter',
  })
  expect(await refuse(413, 'payload_too_large')).toMatchObject({ status: 413 })
})
