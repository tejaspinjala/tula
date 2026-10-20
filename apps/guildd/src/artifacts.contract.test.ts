import { afterAll, describe, expect, test } from 'bun:test'
import { hashBytes } from './ports/object-store'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'

const harness = await createHarness()
afterAll(() => harness.close())

const enc = (text: string) => new TextEncoder().encode(text)

async function found(name: string): Promise<string> {
  return harness.adapters.db.foundGuild({ name, goal: `${name} goal` })
}

function store(guild: string, text: string, cls = 'report', method = 'PUT') {
  return harness.request(`/artifacts?class=${cls}`, {
    method,
    headers: { 'x-guild-id': guild },
    body: enc(text),
  })
}

describe('artifacts', () => {
  test('storing returns the hash; fetching by hash returns the bytes and class', async () => {
    const guild = await found('Ember')
    const res = await store(guild, 'quarterly notes')
    expect(res.status).toBe(201)
    const hash = hashBytes(enc('quarterly notes'))
    expect(await res.json()).toEqual({ hash, size: 15, class: 'report' })

    const got = await harness.request(`/artifacts/${hash}`, { headers: { 'x-guild-id': guild } })
    expect(got.status).toBe(200)
    expect(got.headers.get('x-artifact-class')).toBe('report')
    expect(await got.text()).toBe('quarterly notes')
  })

  test('storing the same bytes twice is idempotent: one row, one object', async () => {
    const guild = await found('Twice')
    const before = harness.adapters.memoryStore.size
    await store(guild, 'same')
    const again = await store(guild, 'same', 'report', 'POST')
    expect(again.status).toBe(201)
    expect(harness.adapters.memoryStore.size).toBe(before + 1)
    const rows = await harness.owner`select 1 from artifacts where guild_id = ${guild}`
    expect(rows.length).toBe(1)
  })

  test('storing appends one artifact.stored event, and a re-upload appends none', async () => {
    const guild = await found('Evented')
    await store(guild, 'evented bytes')
    await store(guild, 'evented bytes')
    const events = await harness.owner`
      select type, payload from events where guild_id = ${guild} and type = 'artifact.stored'`
    expect(events.length).toBe(1)
    expect(events[0]?.payload).toEqual({
      hash: hashBytes(enc('evented bytes')),
      class: 'report',
      size: 13,
    })
  })

  test('an unknown or malformed hash is a clean 404', async () => {
    const guild = await found('Missing')
    for (const hash of ['0'.repeat(64), 'nope']) {
      const res = await harness.request(`/artifacts/${hash}`, { headers: { 'x-guild-id': guild } })
      expect(res.status).toBe(404)
    }
  })

  test('requires a caller and a valid class', async () => {
    const guild = await found('Strict')
    const anon = await harness.request('/artifacts?class=report', { method: 'PUT', body: 'x' })
    expect(anon.status).toBe(401)
    expect((await store(guild, 'x', 'Bad Class')).status).toBe(400)
  })

  test('GET /artifacts/:hash is isolated between guilds', async () => {
    const secret = 'B-secret bytes'
    await expectGuildIsolation(harness, {
      build: (caller) => [
        `/artifacts/${hashBytes(enc(secret))}`,
        { headers: { 'x-guild-id': caller } },
      ],
      // Seeds the target guild's own artifact (idempotent) so there is something to steal.
      snapshot: async (guildId) => {
        await store(guildId, secret)
        return harness.owner`select hash, size, class from artifacts where guild_id = ${guildId}`
      },
    })
  })

  test('storing the same bytes as another guild neither reveals nor alters its artifact', async () => {
    const secret = 'B-secret twin'
    await expectGuildIsolation(harness, {
      build: (caller) => [
        '/artifacts?class=other',
        { method: 'PUT', headers: { 'x-guild-id': caller }, body: enc(secret) },
      ],
      snapshot: async (guildId) => {
        await store(guildId, secret)
        return harness.owner`select hash, size, class from artifacts where guild_id = ${guildId}`
      },
    })
  })
})

describe('artifact limits', () => {
  test('a chunked body over the cap without content-length gets 413', async () => {
    const capped = await createHarness({ app: { maxArtifactBytes: 1024 } })
    try {
      const guild = await capped.adapters.db.foundGuild({ name: 'Big', goal: 'g' })
      const chunk = new Uint8Array(400)
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk)
        },
      })
      const res = await capped.request('/artifacts?class=report', {
        method: 'PUT',
        headers: { 'x-guild-id': guild },
        body,
        duplex: 'half',
      } as RequestInit)
      expect(res.status).toBe(413)
      expect(capped.adapters.memoryStore.size).toBe(0)
    } finally {
      await capped.close()
    }
  })

  test('an object store that hangs yields 504 on store and on fetch, not a hung request', async () => {
    const hang = () => new Promise<never>(() => {})
    const hung = await createHarness({
      app: {
        objectStoreTimeoutMs: 50,
        objectStore: { put: hang, get: hang, head: hang },
      },
    })
    try {
      const guild = await hung.adapters.db.foundGuild({ name: 'Hang', goal: 'g' })
      const put = await hung.request('/artifacts?class=report', {
        method: 'PUT',
        headers: { 'x-guild-id': guild },
        body: enc('x'),
      })
      expect(put.status).toBe(504)
      // A row so the GET reaches the store.
      const hash = hashBytes(enc('x'))
      await hung.owner`insert into artifacts (guild_id, hash, size, class) values (${guild}, ${hash}, 1, 'report')`
      const got = await hung.request(`/artifacts/${hash}`, { headers: { 'x-guild-id': guild } })
      expect(got.status).toBe(504)
    } finally {
      await hung.close()
    }
  })
})

describe('artifact events reach live streams', () => {
  test('artifact.stored is pushed within a second even with a long fallback poll', async () => {
    const live = await createHarness({ app: { eventPollMs: 10_000 } })
    try {
      const guild = await live.adapters.db.foundGuild({ name: 'Live', goal: 'g' })
      const ws = new WebSocket(`${live.listen()}/guilds/${guild}/events`, {
        headers: { 'x-guild-id': guild },
      } as never)
      const types: string[] = []
      const seen = new Promise<void>((resolve) => {
        ws.onmessage = (m) => {
          const frame = JSON.parse(String(m.data))
          if (frame.type === 'event') {
            types.push(frame.event.type)
          }
          if (types.includes('artifact.stored')) {
            resolve()
          }
        }
      })
      await new Promise((r) => {
        ws.onopen = r
      })
      await Bun.sleep(300)
      const res = await live.request('/artifacts?class=report', {
        method: 'PUT',
        headers: { 'x-guild-id': guild },
        body: enc('live bytes'),
      })
      expect(res.status).toBe(201)
      const outcome = await Promise.race([
        seen.then(() => 'seen'),
        Bun.sleep(1000).then(() => 'late'),
      ])
      ws.close()
      expect(outcome).toBe('seen')
    } finally {
      await live.close()
    }
  })
})
