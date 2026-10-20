import { describe, expect, test } from 'bun:test'
import { createECDH } from 'node:crypto'
import { Glob } from 'bun'
import { loadEnv, loadVapidEnv, loadWebauthnEnv } from './env'

const vapidPair = createECDH('prime256v1')
vapidPair.generateKeys()
const vapid = {
  VAPID_PUBLIC_KEY: vapidPair.getPublicKey().toString('base64url'),
  VAPID_PRIVATE_KEY: vapidPair.getPrivateKey().toString('base64url'),
  VAPID_SUBJECT: 'mailto:ops@guild.example',
}

const base = {
  APP_DATABASE_URL: 'postgres://app:pw@localhost:5432/db',
  OBJECT_STORE_ACCESS_KEY: 'access',
  OBJECT_STORE_SECRET_KEY: 'secret',
}

describe('loadEnv', () => {
  test('accepts a complete environment', () => {
    const env = loadEnv(base)
    expect(env.OBJECT_STORE_ACCESS_KEY).toBe('access')
    expect(env.OBJECT_STORE_CREATE_BUCKET).toBe(false)
  })

  test('TRUST_PROXY defaults to false and rejects values that are not true or false', () => {
    expect(loadEnv(base).TRUST_PROXY).toBe(false)
    expect(loadEnv({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true)
    expect(() => loadEnv({ ...base, TRUST_PROXY: 'yes' })).toThrow()
  })

  test('throws without object store credentials', () => {
    expect(() => loadEnv({ ...base, OBJECT_STORE_ACCESS_KEY: undefined })).toThrow()
    expect(() => loadEnv({ ...base, OBJECT_STORE_SECRET_KEY: undefined })).toThrow()
  })

  test('the app environment does not carry the owner DATABASE_URL', () => {
    expect('DATABASE_URL' in loadEnv({ ...base, DATABASE_URL: 'postgres://owner@x/y' })).toBe(false)
  })

  test('production requires explicit WebAuthn settings and rejects the dev guild header', () => {
    const prod = { ...base, NODE_ENV: 'production' }
    const rp = { WEBAUTHN_RP_ID: 'guild.example', WEBAUTHN_ORIGIN: 'https://guild.example' }
    expect(() => loadEnv(prod)).toThrow()
    expect(() => loadEnv({ ...prod, WEBAUTHN_RP_ID: 'guild.example' })).toThrow()
    expect(() => loadEnv({ ...prod, ...rp, DEV_GUILD_HEADER: 'true' })).toThrow()
    expect(
      loadEnv({ ...prod, ...rp, ...vapid, KEY_FILE: '/k', CHECKPOINT_DIR: '/c' }).WEBAUTHN_ORIGIN
    ).toBe('https://guild.example')
    expect(() => loadWebauthnEnv(prod)).toThrow()
    expect(loadWebauthnEnv({ NODE_ENV: 'development' }).WEBAUTHN_RP_ID).toBe('localhost')
  })

  test('production requires an explicit KEY_FILE; development defaults it', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      WEBAUTHN_RP_ID: 'guild.example',
      WEBAUTHN_ORIGIN: 'https://guild.example',
    }
    expect(() => loadEnv(prod)).toThrow(/KEY_FILE/)
    expect(
      loadEnv({ ...prod, ...vapid, KEY_FILE: '/run/keys/master.key', CHECKPOINT_DIR: '/c' })
        .KEY_FILE
    ).toBe('/run/keys/master.key')
    expect(loadEnv(base).KEY_FILE).toBe('.guildhall/master.key')
  })

  test('production requires an explicit CHECKPOINT_DIR; development defaults it', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      WEBAUTHN_RP_ID: 'guild.example',
      WEBAUTHN_ORIGIN: 'https://guild.example',
      KEY_FILE: '/k',
    }
    expect(() => loadEnv(prod)).toThrow(/CHECKPOINT_DIR/)
    expect(loadEnv({ ...prod, ...vapid, CHECKPOINT_DIR: '/mnt/anchor' }).CHECKPOINT_DIR).toBe(
      '/mnt/anchor'
    )
    expect(loadEnv(base).CHECKPOINT_DIR).toBe('.guildhall/checkpoints')
  })

  test('production requires the VAPID keys and subject; development may omit all three', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      WEBAUTHN_RP_ID: 'guild.example',
      WEBAUTHN_ORIGIN: 'https://guild.example',
      KEY_FILE: '/k',
      CHECKPOINT_DIR: '/c',
    }
    expect(() => loadEnv(prod)).toThrow(/VAPID_PUBLIC_KEY/)
    expect(() => loadEnv({ ...prod, ...vapid, VAPID_SUBJECT: undefined })).toThrow(/VAPID_SUBJECT/)
    expect(loadEnv({ ...prod, ...vapid }).VAPID_PUBLIC_KEY).toBe(vapid.VAPID_PUBLIC_KEY)
    expect(loadEnv(base).VAPID_PUBLIC_KEY).toBeUndefined()
  })

  test('loadVapidEnv returns the three settings, or nothing when push is unconfigured', () => {
    expect(loadVapidEnv({ NODE_ENV: 'development' })).toBeUndefined()
    expect(loadVapidEnv({ NODE_ENV: 'development', ...vapid })).toEqual({
      publicKey: vapid.VAPID_PUBLIC_KEY,
      privateKey: vapid.VAPID_PRIVATE_KEY,
      subject: vapid.VAPID_SUBJECT,
    })
    expect(() => loadVapidEnv({ NODE_ENV: 'production' })).toThrow(/VAPID_PUBLIC_KEY/)
  })

  test('VAPID keys must be well-formed P-256 keys and are all-or-none', () => {
    expect(() => loadEnv({ ...base, ...vapid, VAPID_PUBLIC_KEY: 'short' })).toThrow()
    expect(() => loadEnv({ ...base, ...vapid, VAPID_PRIVATE_KEY: 'short' })).toThrow()
    expect(() => loadEnv({ ...base, ...vapid, VAPID_SUBJECT: 'not-a-contact' })).toThrow()
    expect(() => loadEnv({ ...base, VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY })).toThrow()
    expect(loadEnv({ ...base, ...vapid }).VAPID_PRIVATE_KEY).toBe(vapid.VAPID_PRIVATE_KEY)
  })

  test('no dev credentials are baked into production source', async () => {
    const offenders: string[] = []
    for await (const file of new Glob('**/*.ts').scan({ cwd: import.meta.dir })) {
      if (file.startsWith('testing/') || file.endsWith('.test.ts')) {
        continue
      }
      const text = await Bun.file(`${import.meta.dir}/${file}`).text()
      if (text.includes('guildhall-dev-secret') || text.includes('guildhall:guildhall')) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
