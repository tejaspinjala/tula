import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'

const ownerUrl =
  process.env.DATABASE_URL ?? 'postgres://guildhall:guildhall@localhost:5432/guildhall'
const dbName = `guildhall_cli_${crypto.randomUUID().replaceAll('-', '')}`
const admin = postgres(ownerUrl, { max: 1, onnotice: () => {} })
const urlFor = (user?: string, password?: string) => {
  const url = new URL(ownerUrl)
  url.pathname = `/${dbName}`
  if (user && password) {
    url.username = user
    url.password = password
  }
  return url.toString()
}

beforeAll(async () => {
  await admin.unsafe(`create database ${dbName}`)
})

afterAll(async () => {
  await admin.unsafe(`drop database ${dbName} with (force)`)
  await admin.end()
})

async function runCli(env: Record<string, string>) {
  const proc = Bun.spawn(['bun', new URL('./migrate-cli.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  return { code, err: await new Response(proc.stderr).text() }
}

describe('db:migrate entry', () => {
  test('fails with a clear message when APP_DB_PASSWORD is missing', async () => {
    const { code, err } = await runCli({ DATABASE_URL: urlFor() })
    expect(code).not.toBe(0)
    expect(err).toContain('APP_DB_PASSWORD')
  })

  test('needs only DATABASE_URL and APP_DB_PASSWORD, and the app role can then log in', async () => {
    const { code, err } = await runCli({ DATABASE_URL: urlFor(), APP_DB_PASSWORD: 's3cret-pw' })
    expect(err).toBe('')
    expect(code).toBe(0)

    const app = postgres(urlFor('guildhall_app', 's3cret-pw'), { max: 1 })
    try {
      const [row] = await app`select current_user as u`
      expect(row?.u).toBe('guildhall_app')
    } finally {
      await app.end()
    }
  })
})
