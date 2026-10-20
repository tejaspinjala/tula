import { describe, expect, test } from 'bun:test'
import { loadEnv } from './env'
import { listenOptions } from './server-config'

const base = {
  APP_DATABASE_URL: 'postgres://app:pw@localhost:5432/db',
  OBJECT_STORE_ACCESS_KEY: 'access',
  OBJECT_STORE_SECRET_KEY: 'secret',
}

describe('HOST', () => {
  test('defaults to loopback so the unauthenticated routes are not exposed to the LAN', () => {
    expect(loadEnv(base).HOST).toBe('127.0.0.1')
  })

  test('the server binds the configured host', () => {
    expect(listenOptions(loadEnv(base), 10).hostname).toBe('127.0.0.1')
    expect(listenOptions({ PORT: 1, HOST: '0.0.0.0' }, 10).hostname).toBe('0.0.0.0')
  })

  test('an empty HOST fails at boot', () => {
    expect(() => loadEnv({ ...base, HOST: '' })).toThrow(/HOST/)
  })
})
