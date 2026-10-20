import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { loadEnv } from './env'

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

  test('throws without object store credentials', () => {
    expect(() => loadEnv({ ...base, OBJECT_STORE_ACCESS_KEY: undefined })).toThrow()
    expect(() => loadEnv({ ...base, OBJECT_STORE_SECRET_KEY: undefined })).toThrow()
  })

  test('the app environment does not carry the owner DATABASE_URL', () => {
    expect('DATABASE_URL' in loadEnv({ ...base, DATABASE_URL: 'postgres://owner@x/y' })).toBe(false)
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
