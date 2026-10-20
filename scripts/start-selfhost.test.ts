import { describe, expect, test } from 'bun:test'
import { isReachable, selfhostPlan } from './start-selfhost'

const source = {
  DATABASE_URL: 'postgres://owner:ownerpw@localhost:55432/guildhall',
  APP_DB_PASSWORD: 'app pw/1',
  OBJECT_STORE_ACCESS_KEY: 'access',
  OBJECT_STORE_SECRET_KEY: 'secret',
}

describe('selfhostPlan', () => {
  test('binds guildd to loopback explicitly', () => {
    expect(selfhostPlan(source, '/repo').guildd.HOST).toBe('127.0.0.1')
    expect(selfhostPlan({ ...source, HOST: '0.0.0.0' }, '/repo').guildd.HOST).toBe('127.0.0.1')
  })

  test('starts guildd on localhost:8787 with the built web app', () => {
    const plan = selfhostPlan(source, '/repo')
    expect(plan.guildd.WEB_DIST).toBe('/repo/apps/web/dist')
    expect(plan.guildd.WEBAUTHN_ORIGIN).toBe('http://localhost:8787')
    expect(plan.guildd.WEBAUTHN_RP_ID).toBe('localhost')
  })

  test('honours the DATABASE_URL port and derives the app connection from it', () => {
    const plan = selfhostPlan(source, '/repo')
    expect(plan.databaseHost).toEqual({ host: 'localhost', port: 55432 })
    const app = new URL(plan.guildd.APP_DATABASE_URL)
    expect(app.port).toBe('55432')
    expect(app.username).toBe('guildhall_app')
    expect(decodeURIComponent(app.password)).toBe('app pw/1')
    expect(app.pathname).toBe('/guildhall')
  })

  test('keeps the caller environment and holds no secret of its own', () => {
    const plan = selfhostPlan({ ...source, PORT: '9000', KEY_FILE: '/k' }, '/repo')
    expect(plan.guildd.KEY_FILE).toBe('/k')
    expect(plan.guildd.OBJECT_STORE_SECRET_KEY).toBe('secret')
    expect(plan.guildd.WEBAUTHN_ORIGIN).toBe('http://localhost:9000')
  })

  test('founds once unless the caller sets FOUNDING_MODE explicitly', () => {
    expect(selfhostPlan(source, '/repo').guildd.FOUNDING_MODE).toBe('once')
    expect(selfhostPlan({ ...source, FOUNDING_MODE: 'open' }, '/repo').guildd.FOUNDING_MODE).toBe(
      'open'
    )
    expect(selfhostPlan({ ...source, FOUNDING_MODE: 'closed' }, '/repo').guildd.FOUNDING_MODE).toBe(
      'closed'
    )
    expect(() => selfhostPlan({ ...source, FOUNDING_MODE: 'maybe' }, '/repo')).toThrow(
      /FOUNDING_MODE/
    )
  })

  test('PUBLIC_ORIGIN sets the passkey origin and RP ID, trusts the proxy and stays on loopback', () => {
    const plan = selfhostPlan(
      { ...source, PUBLIC_ORIGIN: 'https://guild.example.com', HOST: '0.0.0.0' },
      '/repo'
    )
    expect(plan.guildd.WEBAUTHN_ORIGIN).toBe('https://guild.example.com')
    expect(plan.guildd.WEBAUTHN_RP_ID).toBe('guild.example.com')
    expect(plan.guildd.TRUST_PROXY).toBe('true')
    expect(plan.guildd.HOST).toBe('127.0.0.1')
  })

  test('PUBLIC_ORIGIN forces the dev guild header off, so a public guildd never trusts x-guild-id', () => {
    const plan = selfhostPlan(
      { ...source, PUBLIC_ORIGIN: 'https://guild.example.com', DEV_GUILD_HEADER: 'true' },
      '/repo'
    )
    expect(plan.guildd.DEV_GUILD_HEADER).toBe('false')
  })

  test('without PUBLIC_ORIGIN the proxy is not trusted', () => {
    expect(selfhostPlan(source, '/repo').guildd.TRUST_PROXY).toBeUndefined()
  })

  test('PUBLIC_ORIGIN must be an https origin', () => {
    for (const bad of ['http://guild.example.com', 'guild.example.com', 'ftp://x.example.com']) {
      expect(() => selfhostPlan({ ...source, PUBLIC_ORIGIN: bad }, '/repo')).toThrow(
        /PUBLIC_ORIGIN/
      )
    }
  })

  test('names every missing setting instead of guessing a secret', () => {
    expect(() => selfhostPlan({}, '/repo')).toThrow(/DATABASE_URL/)
    expect(() => selfhostPlan({}, '/repo')).toThrow(/APP_DB_PASSWORD/)
    expect(() => selfhostPlan({}, '/repo')).toThrow(/OBJECT_STORE_SECRET_KEY/)
  })
})

describe('isReachable', () => {
  test('is true for a listening port and false for a closed one within the deadline', async () => {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {}, open() {} },
    })
    try {
      expect(await isReachable('127.0.0.1', server.port, 1000)).toBe(true)
    } finally {
      server.stop(true)
    }
    expect(await isReachable('127.0.0.1', server.port, 500)).toBe(false)
  })
})
